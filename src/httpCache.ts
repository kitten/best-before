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
import {
  makeServeResponse,
  makeStoreResponse,
  make504Response,
  freshenStoredResponse,
  deriveAge,
} from './responses';
import { INTERNAL_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from './constants';
import { matchesClientConditional } from './conditional';
import {
  matchesIfRange,
  parseRangeHeader,
  selectCachedResponse as select,
} from './range';

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
  validateWith?: Response,
  internalRevalidation = false
): Request {
  // A Range miss is an untouched passthrough: the origin must see every client precondition.
  if (
    !internalRevalidation &&
    request.method === 'GET' &&
    request.headers.has('range')
  )
    return new Request(request);
  const headers = new Headers(request.headers);
  for (const headerName of CONDITIONAL_HEADERS) headers.delete(headerName);
  if (internalRevalidation) {
    headers.delete('range');
    headers.delete('if-range');
  }
  if (validateWith) {
    const etag = validateWith.headers.get('etag');
    const lastModified = validateWith.headers.get('last-modified');
    if (etag) headers.set('if-none-match', etag);
    if (lastModified) headers.set('if-modified-since', lastModified);
  }
  if (request.method === 'HEAD') {
    headers.delete('range');
    headers.delete('if-range');
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
    if (!storeDecision) {
      // A partial refresh must not evict the retained complete representation.
      return originResponse.status === 206
        ? Promise.resolve()
        : store.delete(cacheRequest);
    }
    return store.put(
      cacheRequest,
      makeStoreResponse(
        request,
        originResponse.clone(),
        storeDecision.input,
        storeDecision.output
      )
    );
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
        makeForwardedRequest(request, staleResponse, true)
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
    mustValidate: boolean,
    storable: boolean,
    passthrough: Passthrough,
    ctx: ExecutionCtx | undefined
  ): Promise<CacheResponse> {
    // Send the entry's validators so the origin may answer 304
    // Response `no-cache` requires successful validation before reuse, so its validators are
    // mandatory even when conditional revalidation is otherwise disabled as an optimization.
    const validateWith =
      cacheResponse && (conditionalRevalidation || mustValidate)
        ? cacheResponse
        : undefined;
    const head = request.method === 'HEAD';
    try {
      const originResponse = await passthrough(
        makeForwardedRequest(request, validateWith, !!cacheResponse)
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
        return (
          select(request, response, CacheDecision.HIT, head) ||
          makeServeResponse(response, CacheDecision.HIT, head)
        );
      }

      if (!validateWith && originResponse.status === 304 && cacheResponse) {
        // Unsolicited 304 (no validators were sent): serve the stored entry, not a bare 304.
        return (
          select(request, cacheResponse, CacheDecision.HIT, head) ||
          makeServeResponse(cacheResponse, CacheDecision.HIT, head)
        );
      } else if (
        cacheResponse &&
        decision === CacheDecision.STALE_IF_ERROR &&
        isErrorResponse(originResponse)
      ) {
        const selected = select(request, cacheResponse, decision, head);
        return (
          selected ||
          makeServeResponse(originResponse, CacheDecision.MISS, head)
        );
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
      // Internal revalidation fetched a complete replacement; apply the client's Range now.
      if (cacheResponse && originResponse.status === 200) {
        const selected = select(request, originResponse, served, head);
        if (selected) return selected;
      }
      return makeServeResponse(originResponse, served, head);
    } catch (error) {
      if (cacheResponse && decision === CacheDecision.STALE_IF_ERROR) {
        const selected = select(request, cacheResponse, decision, head);
        if (selected) return selected;
      }
      throw error;
    }
  }

  async function handle(
    request: Request,
    passthrough: Passthrough,
    ctx?: ExecutionCtx
  ): Promise<CacheOutcome> {
    const rangeValue =
      request.method === 'GET' ? request.headers.get('range') : null;
    const rangeUnsupported =
      rangeValue != null && parseRangeHeader(rangeValue).type !== 'single';
    if (rangeUnsupported) {
      const client = parseCacheControl(
        request.headers.get(PUBLIC_CACHE_CONTROL)
      );
      if ((options.onlyIfCached ?? true) && client.onlyIfCached) {
        return outcome(make504Response(CacheDecision.MISS_TIMEOUT));
      }
      return outcome(undefined, async () =>
        makeServeResponse(await passthrough(request), CacheDecision.BYPASS)
      );
    }
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
    let mustValidate = false;

    if (cacheRequest) {
      const decide = (
        response: Response | undefined
      ): { decision: CacheDecision; mustValidate: boolean } => {
        if (!response) {
          return {
            decision: onlyIfCached
              ? CacheDecision.MISS_TIMEOUT
              : CacheDecision.MISS,
            mustValidate: false,
          };
        }
        const storedPolicy = parseCacheControl(
          response.headers.get(INTERNAL_CACHE_CONTROL)
        );
        return {
          decision: computeCacheDecision(
            client,
            storedPolicy,
            deriveAge(response.headers),
            options
          ),
          mustValidate: storedPolicy.noCache,
        };
      };
      let matchRequest = cacheRequest;
      const ifNoneMatch = request.headers.get('if-none-match');
      const ifModifiedSince = request.headers.get('if-modified-since');
      if (
        rangeValue != null ||
        ((request.method === 'GET' || head) &&
          (ifNoneMatch != null || ifModifiedSince != null))
      ) {
        const headers = new Headers(cacheRequest.headers);
        if (rangeValue != null) headers.set('range', rangeValue);
        if (ifNoneMatch != null) {
          headers.set('if-none-match', ifNoneMatch);
        } else if (ifModifiedSince != null) {
          headers.set('if-modified-since', ifModifiedSince);
        }
        matchRequest = new Request(cacheRequest, { headers });
      }
      cacheResponse = await store.match(matchRequest, { ignoreMethod: true });
      ({ decision, mustValidate } = decide(cacheResponse));

      // A stale or unverifiable native response cannot replace the complete stored response.
      const nativeResponseMatches =
        cacheResponse?.status === 206
          ? matchesIfRange(request, cacheResponse)
          : cacheResponse?.status === 304
            ? matchesClientConditional(request, cacheResponse)
            : true;
      if (
        (cacheResponse?.status === 206 || cacheResponse?.status === 304) &&
        (decision !== CacheDecision.HIT || !nativeResponseMatches)
      ) {
        cacheResponse = await store.match(cacheRequest, { ignoreMethod: true });
        ({ decision, mustValidate } = decide(cacheResponse));
      }

      if (decision === CacheDecision.MISS_TIMEOUT) {
        return outcome(make504Response(decision));
      } else if (cacheResponse && decision === CacheDecision.HIT) {
        const selected = select(request, cacheResponse, decision, head);
        if (selected) return outcome(selected);
        if (onlyIfCached)
          return outcome(make504Response(CacheDecision.MISS_TIMEOUT));
        // The cached representation cannot safely be sliced. This is an untouched Range miss.
        cacheResponse = undefined;
        decision = CacheDecision.MISS;
      } else if (
        cacheResponse &&
        onlyIfCached &&
        (decision === CacheDecision.STALE_WHILE_REVALIDATE ||
          decision === CacheDecision.STALE_IF_ERROR)
      ) {
        // `only-if-cached` forbids contacting the origin, so serve the stored entry as-is.
        const selected = select(request, cacheResponse, decision, head);
        return outcome(selected || make504Response(CacheDecision.MISS_TIMEOUT));
      } else if (
        cacheResponse &&
        decision === CacheDecision.STALE_WHILE_REVALIDATE
      ) {
        // Cloned before serving consumes the body, so the refresh can still read the stale entry.
        const staleForRevalidate = conditionalRevalidation
          ? cacheResponse.clone()
          : undefined;
        const served = select(request, cacheResponse, decision, head);
        if (!served) {
          return outcome(undefined, () =>
            consultOrigin(
              cacheRequest,
              request,
              undefined,
              CacheDecision.MISS,
              false,
              storable,
              passthrough,
              ctx
            )
          );
        }
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
        mustValidate,
        storable,
        passthrough,
        ctx
      )
    );
  }

  return { handle };
}
