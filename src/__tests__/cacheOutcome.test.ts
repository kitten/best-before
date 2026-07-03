import { describe, it, expect, vi } from 'vitest';
import { CacheDecision, createHttpCache } from '../index';
import { AgeAwareStore, Clock, cc } from './cacheHarness';

/** Exercises the `CacheOutcome` shape returned by `handle()`: the eager `response` peek, the lazy
 * `resolve()`, its idempotency, automatic revalidation, and the eager-read / lazy-fetch split that
 * lets a caller race the cache against another source. */

const url = 'https://origin.test/resource';

const setup = (
  handler: (request: Request, count: number) => Response | Promise<Response>,
  options?: Parameters<typeof createHttpCache>[1]
) => {
  const clock = new Clock();
  const store = new AgeAwareStore(clock);
  const cache = createHttpCache(store, options);
  let count = 0;
  const origin = vi.fn(async (request: Request) => handler(request, ++count));
  return {
    cache,
    store,
    clock,
    origin,
    req: (init?: RequestInit) => new Request(url, init),
  };
};

describe('CacheOutcome — eager response', () => {
  it('exposes a hit as an eager response that resolve() returns without the origin', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed

    const outcome = await cache.handle(req(), origin);
    expect(outcome.response).toBeDefined();
    expect(outcome.response!.cacheStatus.decision).toBe(CacheDecision.HIT);

    const served = await outcome.resolve();
    expect(await served.text()).toBe('body');
    expect(origin).toHaveBeenCalledTimes(1); // resolve() did not touch the origin
  });

  it('exposes an only-if-cached 504 eagerly', async () => {
    const { cache, origin, req } = setup(() => new Response('origin'));
    const outcome = await cache.handle(
      req({ headers: { 'cache-control': 'only-if-cached' } }),
      origin
    );
    expect(outcome.response?.status).toBe(504);
    expect(outcome.response?.cacheStatus.hit).toBe(false);
    expect(origin).not.toHaveBeenCalled();
  });

  it('exposes a matching conditional as an eager 304', async () => {
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
        })
    );
    await (await cache.handle(req(), origin)).resolve();

    const outcome = await cache.handle(
      req({ headers: { 'if-none-match': '"v1"' } }),
      origin
    );
    expect(outcome.response?.status).toBe(304);
  });

  it('leaves response undefined when the origin must be consulted (miss)', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    const outcome = await cache.handle(req(), origin);
    expect(outcome.response).toBeUndefined();
    expect(origin).not.toHaveBeenCalled(); // probing did not fetch
  });

  it('leaves response undefined for a stale-if-error candidate (needs the origin first)', async () => {
    let mode: 'seed' | 'err' = 'seed';
    const { cache, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-if-error=100'))
        : new Response('boom', { status: 500 })
    );
    await (await cache.handle(req(), origin)).resolve();
    mode = 'err';

    const outcome = await cache.handle(req(), origin);
    expect(outcome.response).toBeUndefined(); // can't know it's an error until the origin answers
    const served = await outcome.resolve();
    expect(served.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await served.text()).toBe('stale');
  });
});

describe('CacheOutcome — resolve()', () => {
  it('runs the passthrough on a miss and stores the result', async () => {
    const { cache, store, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    const served = await (await cache.handle(req(), origin)).resolve();
    expect(await served.text()).toBe('body');
    expect(origin).toHaveBeenCalledTimes(1);
    expect(store.urlCount).toBe(1);
    // a subsequent probe is now an eager hit
    expect(
      (await cache.handle(req(), origin)).response?.cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });

  it('is idempotent — the passthrough runs at most once across repeated calls', async () => {
    const { cache, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('s-maxage=3600'))
    );
    const outcome = await cache.handle(req(), origin);
    const [a, b] = await Promise.all([outcome.resolve(), outcome.resolve()]);
    expect(a).toBe(b); // same in-flight execution shared
    expect(origin).toHaveBeenCalledTimes(1);
    expect(await a.text()).toBe('v1');
  });
});

describe('CacheOutcome — deferred stale-while-revalidate', () => {
  it('revalidates when resolve() is called, then refreshes the entry', async () => {
    let mode: 'seed' | 'fresh' = 'seed';
    const { cache, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
        : new Response('fresh', cc('s-maxage=100'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed a stale-immediately entry
    mode = 'fresh';

    const outcome = await cache.handle(req(), origin);
    const served = await outcome.resolve();
    expect(served.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    expect(await served.text()).toBe('stale');
    // resolve() triggered the refresh, and (no ctx) awaited it before returning.
    expect(origin).toHaveBeenCalledTimes(2);

    // the entry is now refreshed
    expect(
      await (await cache.handle(req(), origin)).resolve().then(r => r.text())
    ).toBe('fresh');
  });

  it('triggers the background refresh when the eager response is read', async () => {
    const { cache, origin, req } = setup(
      () => new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed → origin call #1

    const outcome = await cache.handle(req(), origin);
    // Reading `response` engages the outcome, which kicks off revalidation.
    expect(outcome.response!.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it('does not revalidate when the outcome is discarded (never read, never resolved)', async () => {
    const { cache, origin, req } = setup(
      () => new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed → origin call #1

    // Probe the cache, but serve another source; the stale outcome is never engaged.
    const outcome = await cache.handle(req(), origin);
    const asset: Response | null = new Response('asset');
    const served = asset ?? (await outcome.resolve());
    expect(await served.text()).toBe('asset');

    // No wasted origin revalidation: neither `response` nor `resolve()` was touched.
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('fires the refresh at most once across response + resolve()', async () => {
    const { cache, origin, req } = setup(
      () => new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed → origin call #1

    const outcome = await cache.handle(req(), origin);
    void outcome.response; // engage via the getter
    await outcome.resolve(); // and via resolve()
    await outcome.resolve();
    expect(origin).toHaveBeenCalledTimes(2); // one seed + one revalidation
  });
});

describe('CacheOutcome — eager-read / lazy-fetch split (dispatcher-style race)', () => {
  it('never calls the passthrough when another source wins the race', async () => {
    const { cache, origin, req } = setup(
      () => new Response('worker', cc('s-maxage=3600'))
    );

    // Probe the cache eagerly; the worker fetch is deferred behind resolve().
    const outcome = await cache.handle(req(), origin);

    // An asset pipeline resolves first and satisfies the request.
    const asset: Response | null = new Response('asset');
    const served = asset ?? (await outcome.resolve());

    expect(await served.text()).toBe('asset');
    expect(origin).not.toHaveBeenCalled(); // the deferred worker fetch never ran
  });

  it('falls back to resolve() (and the origin) when the other source misses', async () => {
    const { cache, origin, req } = setup(
      () => new Response('worker', cc('s-maxage=3600'))
    );
    const outcome = await cache.handle(req(), origin);

    const asset: Response | null = null; // asset pipeline finds nothing
    const served = asset ?? (await outcome.resolve());

    expect(await served.text()).toBe('worker');
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('serves an eager cache hit without ever consulting the deferred origin', async () => {
    const { cache, origin, req } = setup(
      () => new Response('cached', cc('s-maxage=3600'))
    );
    await (await cache.handle(req(), origin)).resolve(); // seed

    const outcome = await cache.handle(req(), origin);
    // A hit is available eagerly; a racing caller can serve it and skip resolve() entirely.
    expect(outcome.response).toBeDefined();
    expect(await outcome.response!.text()).toBe('cached');
    expect(origin).toHaveBeenCalledTimes(1);
  });
});
