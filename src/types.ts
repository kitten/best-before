import type { CacheDecision } from './cacheDecision';
import type { CacheResponse } from './cacheStatus';

/** A parsed Cache-Control header value */
export interface CacheControl {
  /** Only for proxies, the maximum age in seconds after which a cached response is considered stale */
  serverMaxAge: number | null;
  /** The maximum age in seconds after which a cached response is considered stale */
  maxAge: number | null;
  /** Seconds past staleness the response may be served while revalidating in the background */
  staleWhileRevalidate: number | null;
  /** Seconds past staleness the response may be served when the origin errors */
  staleIfError: number | null;
  /** The response can be cached but must always be revalidated */
  noCache: boolean;
  /** The response must never be stored or cached */
  noStore: boolean;
  /** The response must not be modified */
  noTransform: boolean;
  /** Only return a response if it's cached (otherwise return a 504) */
  onlyIfCached: boolean;
  /** Clients must revalidate stale responses, even if offline */
  mustRevalidate: boolean;
  /** Proxies must revalidate stale responses, even if offline */
  proxyRevalidate: boolean;
  /** Only cache the response, if the status code can be validated and understood to allow caching */
  mustUnderstand: boolean;
  /** Cache the response as a non-personalized response */
  public: boolean;
  /** Cache the response only in user-personalized cached */
  private: boolean;
  /** Treat the response as never changing */
  immutable: boolean;

  /** @remarks Best-effort: not respected by all clients (e.g. Chrome) */
  maxStale: number | null;
  /** @remarks Best-effort: not respected by all clients (e.g. Chrome) */
  minFresh: number | null;

  unrecognized?: string;
}

/** A structured description of how a request was served */
export interface CacheStatus {
  /** The underlying freshness/staleness decision. */
  readonly decision: CacheDecision;
  /** Whether a cached entry satisfied the request (fully or as a stale fallback). */
  readonly hit: boolean;
  /** How the request was forwarded, when it wasn't a hit. */
  readonly forward?: 'request' | 'miss' | 'bypass';
  /** A human-readable qualifier: `revalidate`, `error`, or `only-if-cached`. */
  readonly detail?: string;
}

/** The subset of a `Response` that storability decisions read; any `Response` satisfies it */
export interface ResponseLike {
  readonly status: number;
  readonly headers: Headers;
}

/** Whether/how an origin response should be stored */
export interface StoreDecision {
  /** The Cache-Control that governs how the stored entry is later evaluated. */
  readonly input: CacheControl;
  /** The (transformed) Cache-Control to persist on the stored response. */
  readonly output: CacheControl;
}

/** The minimal storage surface the library needs
 * @remarks
 * The native `Cache` satisfies this structurally, so `caches.open(name)` can be passed
 * directly. Wrap it to transform what's stored/read, instrument puts/hits, namespace keys,
 * or back it with an alternate store.
 *
 * **`match` must honor `Vary`.** Secondary-key (`Vary`) selection is delegated to the store —
 * the library stores the `Vary` header and rejects `Vary: *`, but does not itself compare
 * varied request headers. The native `Cache` does this; a from-scratch store (KV/R2/etc.)
 * keyed only by URL will serve the wrong variant unless it implements `Vary` matching too.
 *
 * `delete` accepts an optional `ignoreVary` (used for RFC 9111 §4.4 invalidation) so every
 * stored variant of a URL can be removed at once; a store that only keys by URL may ignore it.
 * `match` may honor a single `Range` request or client conditional and return `206`/`304`; otherwise
 * the library retrieves and transforms the complete response itself. Native transformed responses
 * are verified by the library. For local slicing, the exposed body bytes must match a valid
 * `Content-Length` and the representation must be unencoded/identity.
 */
export interface CacheStore {
  match(
    request: Request,
    options?: { ignoreMethod?: boolean }
  ): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(
    request: Request,
    options?: { ignoreVary?: boolean }
  ): Promise<boolean>;
}

/** A function that fetches a request from the origin (the operation the cache wraps) */
export type Passthrough = (request: Request) => Promise<Response>;

/** The ambient runtime capability used to extend background work past the response */
export interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/** The result of probing the cache
 * @remarks
 * A `stale-while-revalidate` revalidation is deferred until either `response` is read or `resolve()` called.
 */
export interface CacheOutcome {
  /** A cached response, if any, without contacting the origin, which is set on a cache hit */
  readonly response: CacheResponse | undefined;
  /** Resolves to the response to serve, falling through to a passthrough to the origin if needed */
  resolve(): Promise<CacheResponse>;
}

/** The cache returned by `createHttpCache`
 * @remarks
 * Probe it with `handle()`, which never calls `passthrough` itself — the returned
 * {@link CacheOutcome} decides when the origin is consulted.
 */
export interface HttpCache {
  handle(
    request: Request,
    passthrough: Passthrough,
    ctx?: ExecutionCtx
  ): Promise<CacheOutcome>;
}

/** Toggles for the directive-gated behaviors the cache honors. All default to `true`. */
export interface CacheDecisionOptions {
  /** Honor `stale-while-revalidate` (serve stale, revalidate in the background). Default `true`. */
  staleWhileRevalidate?: boolean;
  /** Honor `stale-if-error` (serve stale when the origin errors). Default `true`. */
  staleIfError?: boolean;
  /** Honor the client's `only-if-cached` directive (a miss becomes a `504`). Default `true`. */
  onlyIfCached?: boolean;
  /** Honor client directives that bypass/force-revalidate the cache. Default `true`. */
  clientCacheBypass?: boolean;
  /** Shared cache (`true`, default) or private/client-side cache (`false`)
   * @remarks
   * In private mode you must partition the store per user, or one user's data can be
   * served to another.
   */
  shared?: boolean;
}

/** Options governing storability */
export interface StoreDecisionOptions {
  /** Shared cache (`true`, default) or private/client-side cache (`false`) */
  shared?: boolean;
  /** Require an explicit shared directive before a shared cache stores a bare-`max-age` response.
   * Default `true`.
   * @remarks
   * Only applies to a shared cache (`shared: true`). When `true`, a response whose only freshness
   * signal is a bare `Cache-Control: max-age` is treated as private and not stored; it is
   * shared-cached only with an explicit shared signal — `public`, `s-maxage`, a `cdn-cache-control`
   * tier, or `must-revalidate`/`proxy-revalidate`. A server-set cache expiration that isn't a
   * `Cache-Control` directive — an `Expires` header, a CORS `Access-Control-Max-Age`, or an
   * immutable 301/308 — is always shared-cached (like Cloudflare's default cache behavior). Set
   * `false` to also assume `public` for a bare `max-age` on an unauthenticated `GET`/`HEAD`
   * (RFC 9111 §4.2.1). No effect on a private cache.
   */
  requireSharedDirective?: boolean;
}

/** Feature flags for `createHttpCache`: the decision toggles plus orchestration-only options */
export interface HttpCacheOptions extends CacheDecisionOptions {
  /** Cache non-GET/HEAD methods by remapping them to synthetic GET keys. Default `false`. */
  cacheNonGetMethods?: boolean;
  /** Revalidate stale entries with a conditional request instead of a full re-fetch. Default `false`. */
  conditionalRevalidation?: boolean;
  /** Require an explicit shared directive (`public`/`s-maxage`/…) before shared-caching a bare
   * `max-age` response, treating it as private. `Expires`/CORS/301-308 are still shared-cached.
   * Default `true`. Shared cache only.
   * @see {@link StoreDecisionOptions.requireSharedDirective}
   */
  requireSharedDirective?: boolean;
}
