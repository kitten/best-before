import { parseCacheControl } from './cacheControl';
import {
  CacheDecision,
  computeCacheDecision,
  isErrorResponse,
  isRequestCacheable,
} from './cacheDecision';
import { computeStoreDecision, hasResponseCachePolicy } from './storeDecision';
import type {
  CacheOutcome,
  CacheStore,
  ExecutionCtx,
  HttpCache,
  HttpCacheOptions,
  Passthrough,
  ResponseLike,
} from './types';
import { getCacheRequest } from './cacheKey';
import { CacheResponse } from './cacheStatus';
import { matchesClientConditional } from './conditional';
import {
  makeServeResponse,
  makeStoreResponse,
  make504Response,
  make304Response,
  freshenStoredResponse,
  deriveAge,
} from './responses';
import { INTERNAL_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from './constants';

function outcome(response: CacheResponse): CacheOutcome;
function outcome(
  response: CacheResponse | undefined,
  resolve: () => Promise<CacheResponse>
): CacheOutcome;
function outcome(
  response: CacheResponse | undefined,
  resolve?: () => Promise<CacheResponse>
): CacheOutcome {
  let promise: Promise<CacheResponse> | undefined;
  return {
    response,
    resolve: () =>
      (promise ??= resolve
        ? resolve()
        : Promise.resolve(response as CacheResponse)),
  };
}

// Runs background work so its failure never surfaces into the served response.
async function settle(
  ctx: ExecutionCtx | undefined,
  work: () => Promise<unknown>
): Promise<void> {
  let promise: Promise<unknown>;
  try {
    promise = work();
  } catch (error) {
    promise = Promise.reject(error);
  }
  if (ctx) {
    ctx.waitUntil(promise);
  } else {
    await promise.catch(() => {});
  }
}

const CONDITIONAL_HEADERS = [
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'if-modified-since',
] as const;

function makeForwardedRequest(
  request: Request,
  validateWith?: Response
): Request {
  const headers = new Headers(request.headers);
  for (const headerName of CONDITIONAL_HEADERS) headers.delete(headerName);
  if (validateWith) {
    const etag = validateWith.headers.get('etag');
    const lastModified = validateWith.headers.get('last-modified');
    if (etag) headers.set('if-none-match', etag);
    if (lastModified) headers.set('if-modified-since', lastModified);
  }
  if (request.method === 'HEAD') {
    return new Request(request, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
  }
  return new Request(request, { headers });
}

/** Creates an HTTP cache layering RFC 9111 freshness/staleness semantics on a {@link CacheStore}
 * @remarks
 * `handle()` probes the cache and returns a {@link CacheOutcome}: its eager `response` is
 * whatever the cache can serve without the origin, and `resolve()` produces the final
 * response, calling `passthrough` only on a miss.
 */
export function createHttpCache(
  store: CacheStore,
  options: HttpCacheOptions = {}
): HttpCache {
  const cacheNonGetMethods = options.cacheNonGetMethods ?? false;
  const conditionalRevalidation = options.conditionalRevalidation ?? false;

  function invalidateForUnsafe(
    request: Request,
    response: Response,
    ctx: ExecutionCtx | undefined
  ): Promise<void> {
    if (
      response.status >= 400 ||
      request.method === 'GET' ||
      request.method === 'HEAD' ||
      request.method === 'OPTIONS' ||
      request.method === 'TRACE'
    ) {
      return Promise.resolve();
    }
    // RFC 9111 §4.4: also invalidate same-origin Location/Content-Location.
    const requestUrl = new URL(request.url);
    const targets = new Set([requestUrl.href]);
    for (const headerName of ['location', 'content-location']) {
      const value = response.headers.get(headerName);
      if (!value) continue;
      try {
        const resolved = new URL(value, requestUrl);
        if (resolved.origin === requestUrl.origin) targets.add(resolved.href);
      } catch {
        // Ignore an unparseable Location/Content-Location
      }
    }
    // `ignoreVary` clears every stored variant, not just the one this request would select.
    return settle(ctx, () =>
      Promise.all(
        [...targets].map(href =>
          store.delete(new Request(href, { method: 'GET' }), {
            ignoreVary: true,
          })
        )
      )
    );
  }

  function putOrigin(
    cacheRequest: Request,
    request: Request,
    originResponse: Response
  ): Promise<unknown> {
    const storeDecision = computeStoreDecision(
      request,
      originResponse,
      options
    );
    return storeDecision
      ? store.put(
          cacheRequest,
          makeStoreResponse(
            request,
            originResponse.clone(),
            storeDecision.input,
            storeDecision.output
          )
        )
      : store.delete(cacheRequest);
  }

  function freshen(
    cacheRequest: Request,
    request: Request,
    staleResponse: Response,
    notModified: Response
  ): { response: Response; commit: () => Promise<unknown> } {
    const storedPolicy = staleResponse.headers.get(INTERNAL_CACHE_CONTROL);
    const freshened = freshenStoredResponse(staleResponse, notModified);
    let policySource: ResponseLike = freshened;
    if (storedPolicy && !hasResponseCachePolicy(request, notModified)) {
      const headers = new Headers(freshened.headers);
      headers.set(PUBLIC_CACHE_CONTROL, storedPolicy);
      policySource = { status: freshened.status, headers };
    }
    const storeDecision = computeStoreDecision(request, policySource, options);
    const commit = () =>
      storeDecision
        ? store.put(
            cacheRequest,
            makeStoreResponse(
              request,
              freshened.clone(),
              storeDecision.input,
              storeDecision.output
            )
          )
        : store.delete(cacheRequest);
    return { response: freshened, commit };
  }

  function revalidate(
    cacheRequest: Request,
    request: Request,
    passthrough: Passthrough,
    ctx: ExecutionCtx | undefined,
    staleResponse?: Response
  ): Promise<void> {
    return settle(ctx, async () => {
      const originResponse = await passthrough(
        makeForwardedRequest(request, staleResponse)
      );
      if (staleResponse && originResponse.status === 304) {
        await freshen(
          cacheRequest,
          request,
          staleResponse,
          originResponse
        ).commit();
      } else if (
        originResponse.status !== 304 &&
        !isErrorResponse(originResponse)
      ) {
        await putOrigin(cacheRequest, request, originResponse);
      }
    });
  }

  async function consultOrigin(
    cacheRequest: Request | null,
    request: Request,
    cacheResponse: Response | undefined,
    decision: CacheDecision,
    storable: boolean,
    passthrough: Passthrough,
    ctx: ExecutionCtx | undefined
  ): Promise<CacheResponse> {
    // Send the entry's validators so the origin may answer 304
    const validateWith = conditionalRevalidation ? cacheResponse : undefined;
    const head = request.method === 'HEAD';
    try {
      const originResponse = await passthrough(
        makeForwardedRequest(request, validateWith)
      );
      await invalidateForUnsafe(request, originResponse, ctx);

      if (validateWith && originResponse.status === 304) {
        const { response, commit } = freshen(
          cacheRequest!,
          request,
          validateWith,
          originResponse
        );
        if (storable) await settle(ctx, commit);
        // The freshened entry is served like a hit, so the client conditional applies to it too
        const notModified =
          (request.method === 'GET' || head) &&
          matchesClientConditional(request, response);
        return notModified
          ? make304Response(response, CacheDecision.HIT)
          : makeServeResponse(response, CacheDecision.HIT, head);
      }

      if (!validateWith && originResponse.status === 304 && cacheResponse) {
        // Unsolicited 304 (no validators were sent): serve the stored entry, not a bare 304.
        return makeServeResponse(cacheResponse, CacheDecision.HIT, head);
      } else if (
        cacheResponse &&
        decision === CacheDecision.STALE_IF_ERROR &&
        isErrorResponse(originResponse)
      ) {
        return makeServeResponse(cacheResponse, decision, head);
      } else if (cacheRequest && storable) {
        const storeDecision = computeStoreDecision(
          request,
          originResponse,
          options
        );
        if (storeDecision) {
          // Not deleting on a non-storable revalidation keeps the entry's stale-if-error grant.
          await settle(ctx, async () => {
            await store.put(
              cacheRequest,
              makeStoreResponse(
                request,
                originResponse.clone(),
                storeDecision.input,
                storeDecision.output
              )
            );
          });
        }
      }

      const served =
        decision === CacheDecision.STALE_IF_ERROR
          ? CacheDecision.MISS
          : decision;
      return makeServeResponse(originResponse, served, head);
    } catch (error) {
      if (cacheResponse && decision === CacheDecision.STALE_IF_ERROR) {
        return makeServeResponse(cacheResponse, decision, head);
      }
      throw error;
    }
  }

  async function handle(
    request: Request,
    passthrough: Passthrough,
    ctx?: ExecutionCtx
  ): Promise<CacheOutcome> {
    if (!isRequestCacheable(request)) {
      return outcome(undefined, async () => {
        const response = await passthrough(request);
        await invalidateForUnsafe(request, response, ctx);
        return makeServeResponse(response, CacheDecision.BYPASS);
      });
    }

    const cacheRequest = await getCacheRequest(request, { cacheNonGetMethods });
    const client = parseCacheControl(request.headers.get(PUBLIC_CACHE_CONTROL));
    const honorBypass = options.clientCacheBypass ?? true;
    const onlyIfCached = (options.onlyIfCached ?? true) && client.onlyIfCached;
    const storable = !honorBypass || !client.noStore;
    const head = request.method === 'HEAD';

    if (!cacheRequest && onlyIfCached) {
      return outcome(make504Response(CacheDecision.MISS_TIMEOUT));
    }

    let decision: CacheDecision = CacheDecision.BYPASS;
    let cacheResponse: Response | undefined;

    if (cacheRequest) {
      cacheResponse = await store.match(cacheRequest, { ignoreMethod: true });
      if (!cacheResponse) {
        decision = onlyIfCached
          ? CacheDecision.MISS_TIMEOUT
          : CacheDecision.MISS;
      } else {
        decision = computeCacheDecision(
          client,
          parseCacheControl(cacheResponse.headers.get(INTERNAL_CACHE_CONTROL)),
          deriveAge(cacheResponse.headers),
          options
        );
      }

      if (decision === CacheDecision.MISS_TIMEOUT) {
        return outcome(make504Response(decision));
      } else if (cacheResponse && decision === CacheDecision.HIT) {
        const notModified =
          (request.method === 'GET' || head) &&
          matchesClientConditional(request, cacheResponse);
        return outcome(
          notModified
            ? make304Response(cacheResponse, decision)
            : makeServeResponse(cacheResponse, decision, head)
        );
      } else if (
        cacheResponse &&
        onlyIfCached &&
        (decision === CacheDecision.STALE_WHILE_REVALIDATE ||
          decision === CacheDecision.STALE_IF_ERROR)
      ) {
        // `only-if-cached` forbids contacting the origin, so serve the stored entry as-is.
        return outcome(makeServeResponse(cacheResponse, decision, head));
      } else if (
        cacheResponse &&
        decision === CacheDecision.STALE_WHILE_REVALIDATE
      ) {
        // Cloned before serving consumes the body, so the refresh can still read the stale entry.
        const staleForRevalidate = conditionalRevalidation
          ? cacheResponse.clone()
          : undefined;
        const served = makeServeResponse(cacheResponse, decision, head);
        // Deferred to first engagement, so an outcome discarded for another source skips the origin.
        let refresh: Promise<void> | undefined;
        const kickoff = () =>
          (refresh ??= revalidate(
            cacheRequest,
            request,
            passthrough,
            ctx,
            staleForRevalidate
          ));
        return {
          get response() {
            kickoff();
            return served;
          },
          resolve: async () => {
            await kickoff();
            return served;
          },
        };
      }
    }

    return outcome(undefined, () =>
      consultOrigin(
        cacheRequest,
        request,
        cacheResponse,
        decision,
        storable,
        passthrough,
        ctx
      )
    );
  }

  return { handle };
}
