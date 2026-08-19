# best-before

`best-before` is a minimal RFC 9111 HTTP caching semantics layer on top of the [**Web Cache API**](https://developer.mozilla.org/en-US/docs/Web/API/Cache).

## Implementation

The goal of `best-before` is to layer RFC 9111 semantics on top of any runtime implementation that
can provide a Web Cache API store. Specifically, it accepts as store (`caches.open(name)`) and layers
`Cache-Control` client and server semantics, non-GET request remapping, `stale-while-revalidate`, and
`stale-if-error` behaviour on top. The goal is to be as accurate as possible, without adding all CDN-level
request collapsing and strictness guarantees.

- **Runtime-agnostic across Web Cache API runtimes**: Works against runtimes that support `Request`, `Response`, and `Cache`
- **Partial body hashing**: Creates a max-1MB hash for request body caching
- **Eager read, lazy fetch**: Splits cache response from execution, to encourage racing cache retrieval then execute fetches lazily

Standards referenced:

- [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) (freshness/staleness),
- [RFC 9211](https://www.rfc-editor.org/rfc/rfc9211) (`Cache-Status`),
- [RFC 9213](https://www.rfc-editor.org/rfc/rfc9213) (targeted `cdn-cache-control`),
- [RFC 5861](https://www.rfc-editor.org/rfc/rfc5861) (`stale-if-error`/`stale-while-revalidate`).
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) (byte ranges and conditional requests).

The underlying implementation assumes that `Vary` can only be supported when `Cache#match` honours `Vary`.
If the Web Cache store does not support `Vary`, related functionality and invalidation won't work as expected.

## Quick start

In a Cloudflare Worker, usage may involve invoking `createHttpCache` and passing it a Cache.

```ts
import { createHttpCache } from 'best-before';

export default {
  async fetch(request, env, ctx) {
    const cache = createHttpCache(await caches.open('http'));

    const outcome = await cache.handle(
      request,
      // passthrough function calling the origin fetch the cache wraps
      req => fetch(req),
      // accepts ctx.waitUntil for deferred revalidation
      ctx
    );

    // outcome.response may deliver a cached Response,
    // while outcome.resolve falls through to the passthrough
    return outcome.resolve();
  },
};
```

## Behavior

### Eager read, lazy fetch

`handle()` probes the cache and returns a `CacheOutcome`. The common path is to call `resolve` immediately (`(await cache.handle(...).resolve()`). `resolve()` handles resolution of uncached responses. When an `ExecutionContext` is passed, `waitUntil` is called when a passthrough is for background revalidation.

The `response` property is used when the cache is raced against another source, which may skip the origin. Read `response` first to see if the cache had an available response, without paying the cost of calling the origin via `resolve()`, then only call `resolve()` when the actual response is needed.

A `stale-while-revalidate` revalidation is deferred until either `response` is ready or `resolve()` is called.

```ts
// Probes the cache and may deliver a cached response early
const outcome = await cache.handle(request, callOrigin, ctx);
// `outcome.response` may be populated, but `tryAsset` takes precedence and the passthrough can be deferred
return (await tryAsset(request)) ?? (await outcome.resolve());
```

### Shared vs. private cache

`shared` (default `true`) selects RFC 9111 **shared**-cache semantics. Set `shared: false` for a
**private / client-side** cache (browser-like):

|                                                          | shared (default)       | private                    |
| -------------------------------------------------------- | ---------------------- | -------------------------- |
| bare `Cache-Control: max-age=…` (no `public`/`s-maxage`) | not stored             | cached & served            |
| `Expires` (no `Cache-Control`)                           | cached & served        | cached & served            |
| `s-maxage`                                               | governs freshness      | ignored (shared-only)      |
| `private` responses                                      | not stored             | stored & served            |
| `Authorization` on request                               | not publicly cacheable | cached (single-user store) |
| `proxy-revalidate`                                       | forces revalidation    | ignored (shared-only)      |

By default a shared cache treats a plain `Cache-Control: max-age` directive (without proxy-specific `public`, `s-max-age`, `cdn-cache-control`, `must-revalidate`, or `proxy-revalidate`) as private and does not store it. A server-set expiration, that isn't `Cache-Control`, such as `Expires`, `Access-Control-Max-Age` for CORS, or a permanent 301/308 redirect, is always shared-cached.

Setting `requireSharedDirective: false` bypasses this and treats unauthenticated `GET` and `HEAD` as cacheable by default.
Either way, `s-maxage` takes precedence, and `Authorization` or `private` responses are never shared-cached.

Isolating caches per user is your responsibility with `shared: false`, and user-specific responses will be cached. If a single shared store is used, one user's data may leak to another, if the store isn't partitioned. The `CacheStore` interface should be wrapped or partitioned before passing it to `best-before` with `shared: false`.

### Conditional requests

On a fresh cache hit, if the client's `If-None-Match` or `If-Modified-Since` already match the stored entry, the library returns an empty `304 Not Modified` (weak ETag comparison, `*` and comma-lists, `If-None-Match` taking precedence over `If-Modified-Since`; GET/HEAD only)

However, origin revalidation defaults to re-fetching a full 200 response by stripping conditional headers. Set `conditionalRevalidation: true` to instead send the stored entry's validator headers when revalidating a stale entry. On a 304, the retained body is re-served and re-stored with refreshed metadata. This is normally an opt-in efficiency optimization. A storable response carrying `no-cache` is the exception: it is retained for up to one day, but its validators are always sent because successful origin validation is required before every reuse. In a shared cache, `no-cache` follows `requireSharedDirective`; in a private cache it is stored without a shared directive. `no-store` responses are never stored.

For GET and HEAD, the effective `If-None-Match` or `If-Modified-Since` may be passed to `CacheStore.match` so a fresh, verifiable native `304` can be used directly. A stale or unverifiable native `304` is looked up again without conditionals so the library retains the complete representation for freshness handling. Responses varying on either field are not stored.

### Range requests

Single `bytes` ranges over eligible, complete cached `200` responses are served locally as `206`; valid unsatisfied ranges produce `416`. Bounded (`bytes=0-99`), open-ended (`bytes=100-`), and suffix (`bytes=-500`) forms are supported. Client preconditions are evaluated first, and `If-Range` uses strong validator semantics (unlike the weak ETag comparison used by `If-None-Match`).

An eligible stored response must have a reliable nonnegative `Content-Length`, an available body containing exactly those representation bytes, and no `Content-Encoding` other than `identity`. Multiple or malformed ranges, unknown units, encoded/unknown-length representations, and range misses are forwarded unchanged. `206` responses are never stored. An honored `only-if-cached` request returns `504` when the range cannot be served locally.

Stores retain complete responses. For a single range, the library lets `CacheStore.match` return a native `206`; otherwise it slices the selected complete representation itself. A stale native slice or one rejected by `If-Range` is looked up again without `Range` so revalidation, full-response fallback, and stale fallback retain the complete body. `If-Range` is evaluated by the library and is not passed to the store. Responses with `Vary: Range` or `Vary: If-Range` are not stored. Multipart ranges, incomplete-response storage, and encoded-representation slicing are not supported.

### Pure decision engine

The RFC 9111 decision logic is exported as standalone, pure-over-arguments functions, so you can build custom orchestration or use the library purely as a decision engine.

```ts
import {
  computeStoreDecision,
  computeCacheDecision,
  parseCacheControl,
} from 'best-before';

// Should this origin response be stored, and with what Cache-Control?
const store = computeStoreDecision(request, response, { shared: true });

// Given a stored entry, is it a hit / stale / miss / timeout?
const decision = computeCacheDecision(
  parseCacheControl(request.headers.get('cache-control')),
  store.input,
  age,
  { staleWhileRevalidate: true, shared: true }
);
```

## API Reference

### `createHttpCache(store: CacheStore, options?: HttpCacheOptions) => HttpCache`

- Accepts a `CacheStore` (the native `Cache` from `caches.open(name)` works directly)
- **Parameters**
  - `options?: HttpCacheOptions`: feature toggles (all default on-by-default; see below)

Returns an `HttpCache` that layers RFC 9111 freshness/staleness semantics over the store.

### `interface HttpCache`

```ts
interface HttpCache {
  handle(
    request: Request,
    passthrough: Passthrough,
    ctx?: ExecutionCtx
  ): Promise<CacheOutcome>;
}
```

- `handle` probes the store for `request` and returns a `CacheOutcome`. It never calls `passthrough` itself.
- **Parameters**
  - `passthrough`: the origin fetch the cache wraps, run at most once and only when the origin is needed
  - `ctx?`: when given, background revalidations use `ctx.waitUntil`

### `interface CacheOutcome`

```ts
interface CacheOutcome {
  readonly response: CacheResponse | undefined;
  resolve(): Promise<CacheResponse>;
}
```

- `response`: the answer the cache has ready **without** the origin (a hit, an SWR-stale entry, a
  `304`, or an `only-if-cached` `504`), or `undefined` on a miss. Reading it never calls `passthrough`.
- `resolve()`: the response to serve, always. Returns `response` when the cache can answer; otherwise
  runs `passthrough` and stores the result. Runs at most once.

### `class CacheResponse extends Response`

A `Response` (return it directly) with two extra own properties:

- **Properties**
  - `decision: CacheDecision`: the freshness/staleness verdict
  - `cacheStatus: CacheStatus`: an RFC 9211-shaped description of how the request was served

The library never emits a `Cache-Status` header, but once can be derived by formatting `cacheStatus`.

### `type Passthrough = (request: Request) => Promise<Response>`

The origin fetch the cache wraps. Called by `resolve()` (or a deferred `stale-while-revalidate` revalidation)
with a request that may be rewritten
(conditional headers stripped, `HEAD` remapped to `GET`, the stored entry's validators added under `conditionalRevalidation`).

### `interface ExecutionCtx`

```ts
interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}
```

### `interface CacheStore`

```ts
interface CacheStore {
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
```

The minimal storage surface the library needs. The native `Cache` satisfies it structurally, so `caches.open(name)` can be passed directly.
Namespacing should be done by cache _name_ (`caches.open('http-v2')`), not a key prefix.
Wrap the store to transform what's stored/read, instrument hits/puts, scope keys, attach `Cache-Tag`, or back it with an alternate store.

> [!IMPORTANT]
> **A from-scratch store must implement `Vary` matching.**
> The library stores the `Vary` header and rejects `Vary: *`, but delegates secondary-key selection to `match`.
> It does not compare varied request headers itself. If your `CacheStore` does not support `Vary`, it won't function.

`match` does not need to implement Range semantics. For responses eligible for local byte slicing, it must expose the same complete representation bytes counted by `Content-Length`; runtimes that transparently decode bodies while retaining encoded headers are not eligible.

### `interface HttpCacheOptions`

The options accepted by `createHttpCache` — all optional.

| Option                    | Default | Description                                                                                                                                                                |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staleWhileRevalidate`    | `true`  | Honor `stale-while-revalidate` (serve stale, revalidate in the background)                                                                                                 |
| `staleIfError`            | `true`  | Honor `stale-if-error` (serve stale when the origin errors)                                                                                                                |
| `onlyIfCached`            | `true`  | Honor the client's `only-if-cached` (a miss becomes a `504`)                                                                                                               |
| `clientCacheBypass`       | `true`  | Honor client cache-busting (`no-cache`, `max-age=0`, etc); set `false` to ignore it and protect the origin                                                                 |
| `shared`                  | `true`  | Shared cache (`true`) vs private/client-side cache (`false`)                                                                                                               |
| `requireSharedDirective`  | `true`  | Require an explicit shared directive (`public`, `s-maxage`, etc) before shared-caching a bare `max-age`, treating it as private; `Expires`/CORS/301-308 stay shared-cached |
| `cacheNonGetMethods`      | `false` | Cache non-GET/HEAD methods (`POST`, `OPTIONS`, etc) via method+body-hashed synthetic GET keys                                                                              |
| `conditionalRevalidation` | `false` | Revalidate a stale entry with a conditional request instead of a full re-fetch                                                                                             |

The `min-fresh` and `max-stale` request directives are only partially honored (some clients, e.g. Chrome, don't send them)

### `computeStoreDecision(request: Request, response: ResponseLike, options: StoreDecisionOptions) => StoreDecision | null`

Pure over `(request, response)`. Accepts `options`:

- `shared` (default `true`): shared vs private cache semantics
- `requireSharedDirective` (default `true`): shared cache only — treat a bare `max-age` as private

Returns `null` when the response isn't storable, otherwise a `StoreDecision` of two `Cache-Control`s:
`input` and `output`.

```ts
interface StoreDecision {
  readonly input: CacheControl;
  readonly output: CacheControl;
}
```

- `input`: the `Cache-Control` that governs how the stored entry is later evaluated (feed it to
  `computeCacheDecision` as `entry.cacheControl`)
- `output`: the transformed `Cache-Control` persisted onto the stored response

### `computeCacheDecision(client: CacheControl, cacheControl: CacheControl, age: number, options: CacheDecisionOptions) => CacheDecision`

Pure over its arguments. `client` is the parsed request directives, `cacheControl` the stored entry's
governing directive (`computeStoreDecision(...).input`), and `age` its age in seconds. Accepts `options`:

- `staleWhileRevalidate`
- `staleIfError`
- `onlyIfCached`
- `clientCacheBypass`
- `shared`

Returns a `CacheDecision` verdict.

```ts
enum CacheDecision {
  /** only-if-cached with no cached response, return 504 */
  MISS_TIMEOUT,
  /** a client directive forces revalidation */
  MISS_REQUEST,
  /** no cached response, origin consulted */
  MISS,
  /** fresh cached response served */
  HIT,
  /** request is not cacheable */
  BYPASS,
  /** origin errored and a stale entry may be served */
  STALE_IF_ERROR,
  /** stale entry served while revalidating in the background */
  STALE_WHILE_REVALIDATE,
}
```

### `parseCacheControl(headerValue: string | null) => CacheControl`

- Accepts a raw `Cache-Control` header value (or `null`)

Returns a parsed `CacheControl`. Fault-tolerant: unknown directives are collected into `unrecognized`
and malformed values are skipped rather than throwing.
