import { describe, it, expect, vi } from 'vitest';
import { CacheDecision, createHttpCache } from '../index';
import {
  AgeAwareStore,
  Clock,
  TestExecutionCtx,
  cc,
  serve,
} from './cacheHarness';

/** End-to-end RFC 9111 compliance suite. Unlike the unit-y `httpCache` tests, freshness here is
 * aged with a virtual clock so real fresh→stale→expired transitions are exercised. */

const url = 'https://origin.test/resource';

/** A cache over an age-aware store, plus a call-counting origin scripted by `handler`. */
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

describe('freshness lifecycle (aged with a virtual clock)', () => {
  it('serves a fresh entry then re-fetches once it ages past s-maxage', async () => {
    const { cache, clock, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('s-maxage=100'))
    );

    expect(await (await serve(cache.handle(req(), origin))).text()).toBe('v1');

    clock.advance(50);
    const fresh = await serve(cache.handle(req(), origin));
    expect(fresh.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await fresh.text()).toBe('v1');
    expect(origin).toHaveBeenCalledTimes(1);

    clock.advance(60); // now age 110 > 100
    const stale = await serve(cache.handle(req(), origin));
    expect(stale.cacheStatus.hit).toBe(false);
    expect(await stale.text()).toBe('v2');
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("counts the origin's initial Age header toward the freshness lifetime", async () => {
    const { cache, clock, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { 'cache-control': 's-maxage=100', age: '80' },
        })
    );

    await serve(cache.handle(req(), origin)); // stored with base age 80

    clock.advance(10); // effective age 90 < 100
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);

    clock.advance(20); // effective age 110 > 100
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });

  it('treats immutable entries as fresh indefinitely', async () => {
    const { cache, clock, origin, req } = setup(
      () => new Response('img', cc('public, max-age=60, immutable'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(60 * 60 * 24 * 400); // > 1 year
    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    // immutable wins even over a client no-cache
    const stillHit = await serve(
      cache.handle(req({ headers: { 'cache-control': 'no-cache' } }), origin)
    );
    expect(stillHit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('treats a negative max-age as immediately stale', async () => {
    const { cache, origin, req } = setup(
      () => new Response('x', cc('s-maxage=-5'))
    );
    await serve(cache.handle(req(), origin));
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });
});

describe('freshness precedence (shared cache)', () => {
  it('prefers s-maxage over max-age', async () => {
    const { cache, clock, origin, req } = setup(
      () => new Response('body', cc('s-maxage=10, max-age=1000'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(20); // past s-maxage (10) though within max-age (1000)
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });

  it('does not shared-cache a bare max-age by default (requireSharedDirective)', async () => {
    // Treated as private by default, so it is never stored.
    const { cache, store, origin, req } = setup(
      () => new Response('body', cc('max-age=3600'))
    );
    await serve(cache.handle(req(), origin));
    expect(store.urlCount).toBe(0);
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it('serves a bare max-age with requireSharedDirective: false (RFC 9111 §4.2.1)', async () => {
    // requireSharedDirective: false opts into RFC §4.2.1 — a bare max-age is served while fresh.
    const { cache, clock, store, origin, req } = setup(
      () => new Response('body', cc('max-age=3600')),
      { requireSharedDirective: false }
    );
    await serve(cache.handle(req(), origin));
    expect(store.urlCount).toBe(1);

    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await hit.text()).toBe('body');
    expect(origin).toHaveBeenCalledTimes(1);

    clock.advance(3601); // past max-age
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });

  it('shared-caches an Expires-only response by default', async () => {
    const expires = () =>
      new Response('body', {
        headers: { expires: new Date(Date.now() + 3600_000).toUTCString() },
      });
    const { cache, origin, req } = setup(expires);
    await serve(cache.handle(req(), origin));
    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('serves a public max-age', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('public, max-age=3600'))
    );
    await serve(cache.handle(req(), origin));
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });
});

describe('freshness lifecycle (private cache)', () => {
  it('serves a bare max-age like a browser, then ages out', async () => {
    const { cache, clock, origin, req } = setup(
      () => new Response('body', cc('max-age=100')),
      { shared: false }
    );
    await serve(cache.handle(req(), origin));

    clock.advance(50);
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);

    clock.advance(60);
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });
});

describe('client request directives', () => {
  it('honors no-cache by forcing revalidation of a fresh entry', async () => {
    const { cache, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('s-maxage=3600'))
    );
    await serve(cache.handle(req(), origin));

    const res = await serve(
      cache.handle(req({ headers: { 'cache-control': 'no-cache' } }), origin)
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
    expect(await res.text()).toBe('v2');
  });

  it('honors no-store by forcing a miss', async () => {
    const { cache, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('s-maxage=3600'))
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(req({ headers: { 'cache-control': 'no-store' } }), origin)
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
  });

  it('honors a client max-age smaller than the entry age', async () => {
    const { cache, clock, origin, req } = setup(
      () => new Response('body', cc('s-maxage=1000'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(60);
    // fresh by the server (1000) but the client only accepts age <= 30
    const forced = await serve(
      cache.handle(req({ headers: { 'cache-control': 'max-age=30' } }), origin)
    );
    expect(forced.cacheStatus.hit).toBe(false);
    const same = await serve(
      cache.handle(req({ headers: { 'cache-control': 'max-age=120' } }), origin)
    );
    expect(same.cacheStatus.decision).toBe(CacheDecision.HIT);
  });

  it('honors max-age=0 as a forced revalidation', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(req({ headers: { 'cache-control': 'max-age=0' } }), origin)
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
  });

  it('honors min-fresh (remaining freshness must exceed the ask)', async () => {
    const { cache, clock, origin, req } = setup(
      () => new Response('body', cc('s-maxage=100'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(60); // 40s of freshness remain
    expect(
      (
        await serve(
          cache.handle(
            req({ headers: { 'cache-control': 'min-fresh=50' } }),
            origin
          )
        )
      ).cacheStatus.hit
    ).toBe(false); // 40 < 50 → revalidate
    expect(
      (
        await serve(
          cache.handle(
            req({ headers: { 'cache-control': 'min-fresh=30' } }),
            origin
          )
        )
      ).cacheStatus.decision
    ).toBe(CacheDecision.HIT); // 40 >= 30 → hit
  });

  it('honors max-stale within the stale-while-revalidate window', async () => {
    const seed = () =>
      setup(
        () =>
          new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
      );

    // 50s stale, staler than the client tolerates → revalidate
    {
      const { cache, clock, origin, req } = seed();
      await serve(cache.handle(req(), origin));
      clock.advance(50);
      const res = await serve(
        cache.handle(
          req({ headers: { 'cache-control': 'max-stale=30' } }),
          origin
        )
      );
      expect(res.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
    }

    // 50s stale, within the client's tolerance → served stale
    {
      const { cache, clock, origin, req } = seed();
      await serve(cache.handle(req(), origin));
      clock.advance(50);
      const res = await serve(
        cache.handle(
          req({ headers: { 'cache-control': 'max-stale=80' } }),
          origin
        )
      );
      expect(res.cacheStatus.decision).toBe(
        CacheDecision.STALE_WHILE_REVALIDATE
      );
    }
  });

  it('returns a 504 for only-if-cached on a cold cache without touching the origin', async () => {
    const { cache, origin, req } = setup(() => new Response('origin'));
    const res = await serve(
      cache.handle(
        req({ headers: { 'cache-control': 'only-if-cached' } }),
        origin
      )
    );
    expect(res.status).toBe(504);
    expect(res.body).toBe(null);
    expect(origin).not.toHaveBeenCalled();
  });

  it('serves a stale-while-revalidate entry for only-if-cached without contacting the origin', async () => {
    const { cache, origin, req } = setup(
      (_r, n) =>
        new Response(`v${n}`, cc('s-maxage=0, stale-while-revalidate=1000'))
    );
    await serve(cache.handle(req(), origin)); // seed (origin call 1)
    expect(origin).toHaveBeenCalledTimes(1);

    const res = await serve(
      cache.handle(
        req({ headers: { 'cache-control': 'only-if-cached' } }),
        origin
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
    expect(await res.text()).toBe('v1');
    // No background revalidation — only-if-cached must not reach the origin.
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('serves a stale-if-error entry for only-if-cached without contacting the origin', async () => {
    const { cache, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('s-maxage=0, stale-if-error=1000'))
    );
    await serve(cache.handle(req(), origin)); // seed (origin call 1)

    const res = await serve(
      cache.handle(
        req({ headers: { 'cache-control': 'only-if-cached' } }),
        origin
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await res.text()).toBe('v1');
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('ignores client cache-busting when clientCacheBypass is disabled', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600')),
      {
        clientCacheBypass: false,
      }
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(req({ headers: { 'cache-control': 'no-cache' } }), origin)
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledTimes(1);
  });
});

describe('storability rules', () => {
  const expectNotStored = async (init: ResponseInit) => {
    const { cache, store, origin, req } = setup(
      () => new Response('body', init)
    );
    await serve(cache.handle(req(), origin));
    expect(store.urlCount).toBe(0);
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  };

  it('does not store no-store responses', () =>
    expectNotStored(cc('no-store')));
  it('stores no-cache responses for mandatory validation', async () => {
    const { cache, store, origin, req } = setup(
      () =>
        new Response('body', {
          ...cc('public, no-cache'),
          headers: { ...cc('public, no-cache').headers, etag: '"v1"' },
        })
    );
    await serve(cache.handle(req(), origin));
    expect(store.urlCount).toBe(1);
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });
  it('does not store responses with Set-Cookie', () =>
    expectNotStored({
      headers: { 'cache-control': 's-maxage=3600', 'set-cookie': 'a=1' },
    }));
  it('does not store Vary:* responses', () =>
    expectNotStored({
      headers: { 'cache-control': 's-maxage=3600', vary: '*' },
    }));
  it('does not store 504 gateway timeouts', () =>
    expectNotStored({ ...cc('s-maxage=3600'), status: 504 } as ResponseInit));
  it('does not store 206 partial responses', () =>
    expectNotStored({ ...cc('s-maxage=3600'), status: 206 } as ResponseInit));

  it('does not store private responses in a shared cache', () =>
    expectNotStored(cc('private, s-maxage=3600')));

  it('stores and serves private responses in a private cache', async () => {
    const { cache, origin, req } = setup(
      () => new Response('secret', cc('private, max-age=3600')),
      {
        shared: false,
      }
    );
    await serve(cache.handle(req(), origin));
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });
});

describe('Authorization gating (shared cache)', () => {
  it('caches an authorized request when s-maxage explicitly marks it shared', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    const auth = { headers: { authorization: 'Bearer t' } };
    await serve(cache.handle(req(auth), origin));
    expect(
      (await serve(cache.handle(req(auth), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });

  it('does not cache an authorized request that is only bare-max-age cacheable', async () => {
    const { cache, store, origin, req } = setup(
      () => new Response('body', cc('max-age=3600'))
    );
    const auth = { headers: { authorization: 'Bearer t' } };
    await serve(cache.handle(req(auth), origin));
    expect(store.urlCount).toBe(0);
  });

  it('does not shared-cache an authorized Expires-only response', async () => {
    // The Expires exemption must not bypass §3.5: an authorized request still needs an
    // explicit shared directive (public/s-maxage/…), which Expires is not.
    const { cache, store, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { expires: new Date(Date.now() + 3600_000).toUTCString() },
        })
    );
    const auth = { headers: { authorization: 'Bearer t' } };
    await serve(cache.handle(req(auth), origin));
    expect(store.urlCount).toBe(0);
  });
});

describe('stale-while-revalidate', () => {
  it('serves stale then refreshes as part of handling', async () => {
    let mode: 'seed' | 'fresh' = 'seed';
    const { cache, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
        : new Response('fresh', cc('s-maxage=100'))
    );
    await serve(cache.handle(req(), origin));
    mode = 'fresh';

    const res = await serve(cache.handle(req(), origin));
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
    expect(await res.text()).toBe('stale');

    // Revalidation ran as part of handling, so the entry is now refreshed.
    expect(await (await serve(cache.handle(req(), origin))).text()).toBe(
      'fresh'
    );
  });

  it('deletes the entry when the revalidation is no longer storable', async () => {
    let mode: 'seed' | 'gone' = 'seed';
    const { cache, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-while-revalidate=100'))
        : new Response('gone', cc('no-store'))
    );
    await serve(cache.handle(req(), origin));
    mode = 'gone';

    const stale = await serve(cache.handle(req(), origin));
    expect(stale.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );

    // The entry was deleted during revalidation, so the next request is a fresh miss.
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });

  it('falls out of the SWR window into a hard miss', async () => {
    const { cache, clock, origin, req } = setup(
      (_r, n) =>
        new Response(`v${n}`, cc('s-maxage=10, stale-while-revalidate=20'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(15); // stale but within SWR (10+20)
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.STALE_WHILE_REVALIDATE);

    clock.advance(30); // now past 10+20 → plain stale
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });
});

describe('stale-if-error', () => {
  const seedThen = (errorInit: ResponseInit | 'throw') => {
    let mode: 'seed' | 'err' = 'seed';
    const s = setup(() => {
      if (mode === 'seed')
        return new Response('stale', cc('s-maxage=0, stale-if-error=100'));
      if (errorInit === 'throw') throw new Error('origin down');
      return new Response('boom', errorInit);
    });
    return { ...s, fail: () => (mode = 'err') };
  };

  for (const status of [500, 502, 503, 504, 429]) {
    it(`masks a ${status} origin error with the stale entry`, async () => {
      const h = seedThen({ status });
      await serve(h.cache.handle(h.req(), h.origin));
      h.fail();
      const res = await serve(h.cache.handle(h.req(), h.origin));
      expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
      expect(await res.text()).toBe('stale');
    });
  }

  it('masks an origin exception', async () => {
    const h = seedThen('throw');
    await serve(h.cache.handle(h.req(), h.origin));
    h.fail();
    const res = await serve(h.cache.handle(h.req(), h.origin));
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await res.text()).toBe('stale');
  });

  it('does not mask a 501 Not Implemented (not a transient error)', async () => {
    const h = seedThen({ status: 501 });
    await serve(h.cache.handle(h.req(), h.origin));
    h.fail();
    const res = await serve(h.cache.handle(h.req(), h.origin));
    expect(res.status).toBe(501);
    expect(await res.text()).toBe('boom');
  });

  it('stops masking once the stale-if-error window has elapsed', async () => {
    let mode: 'seed' | 'err' = 'seed';
    const { cache, clock, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=10, stale-if-error=20'))
        : new Response('boom', { status: 500 })
    );
    await serve(cache.handle(req(), origin));
    mode = 'err';

    clock.advance(60); // past 10 + 20
    const res = await serve(cache.handle(req(), origin));
    expect(res.status).toBe(500);
  });

  it('prefers stale-while-revalidate over stale-if-error when both apply', async () => {
    const { cache, clock, origin, req } = setup(
      (_r, n) =>
        new Response(
          `v${n}`,
          cc('s-maxage=0, stale-while-revalidate=100, stale-if-error=100')
        )
    );
    await serve(cache.handle(req(), origin));
    clock.advance(10);
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
  });

  it('reports a miss (not a stale hit) when the origin recovers within the window', async () => {
    let mode: 'seed' | 'ok' = 'seed';
    const { cache, origin, req } = setup(() =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-if-error=1000'))
        : new Response('fresh', cc('s-maxage=0, stale-if-error=1000'))
    );
    await serve(cache.handle(req(), origin));
    mode = 'ok';

    const res = await serve(cache.handle(req(), origin));
    expect(await res.text()).toBe('fresh');
    expect(res.cacheStatus.decision).toBe(CacheDecision.MISS);
    expect(res.cacheStatus.hit).toBe(false);
  });
});

describe('must-revalidate', () => {
  it('turns a stale entry into a hard miss even with an SWR window', async () => {
    const { cache, origin, req } = setup(
      (_r, n) =>
        new Response(
          `v${n}`,
          cc('public, s-maxage=0, must-revalidate, stale-while-revalidate=100')
        )
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(cache.handle(req(), origin));
    expect(res.cacheStatus.decision).toBe(CacheDecision.MISS);
  });

  it('serves a shared entry fresh under bare max-age + must-revalidate, then misses when stale', async () => {
    // `must-revalidate` makes the response shared-cacheable, so its `max-age` is honored while
    // fresh (a bare `max-age` alone is treated as private by default).
    const { cache, clock, origin, req } = setup(
      (_r, n) => new Response(`v${n}`, cc('max-age=100, must-revalidate'))
    );
    await serve(cache.handle(req(), origin));

    clock.advance(50);
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);

    clock.advance(60); // age 110 > 100 → must revalidate
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
    expect(origin).toHaveBeenCalledTimes(2);
  });
});

describe('client max-age vs a stale-serving grant', () => {
  it('revalidates instead of serving SWR-stale when a client max-age forbids the staleness', async () => {
    const { cache, clock, origin, req } = setup(
      (_r, n) =>
        new Response(`v${n}`, cc('s-maxage=100, stale-while-revalidate=1000'))
    );
    await serve(cache.handle(req(), origin));
    clock.advance(80); // age 80: within the SWR window, but...

    // client demands age <= 50 with no max-stale → the entry is too stale to serve
    const forced = await serve(
      cache.handle(req({ headers: { 'cache-control': 'max-age=50' } }), origin)
    );
    expect(forced.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
    expect(await forced.text()).toBe('v2');
  });

  it('still serves SWR-stale when the client pairs max-age with a permissive max-stale', async () => {
    const { cache, clock, origin, req } = setup(
      (_r, n) =>
        new Response(`v${n}`, cc('s-maxage=100, stale-while-revalidate=1000'))
    );
    await serve(cache.handle(req(), origin));
    clock.advance(80); // age 80, staleness beyond max-age=50 is 30

    const res = await serve(
      cache.handle(
        req({ headers: { 'cache-control': 'max-age=50, max-stale=100' } }),
        origin
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
    expect(await res.text()).toBe('v1');
  });
});

describe('Expires fallback', () => {
  it('caches a future Expires in a private cache and ages it out', async () => {
    const expires = new Date(Date.now() + 100_000).toUTCString();
    const { cache, clock, origin, req } = setup(
      () => new Response('body', { headers: { expires } }),
      {
        shared: false,
      }
    );
    await serve(cache.handle(req(), origin));
    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);

    clock.advance(200); // past the ~100s Expires window
    expect((await serve(cache.handle(req(), origin))).cacheStatus.hit).toBe(
      false
    );
  });

  it('does not cache a past Expires', async () => {
    const expires = new Date(Date.now() - 100_000).toUTCString();
    const { cache, store, origin, req } = setup(
      () => new Response('body', { headers: { expires } }),
      { shared: false }
    );
    await serve(cache.handle(req(), origin));
    expect(store.urlCount).toBe(0);
  });
});

describe('cache keying', () => {
  it('caches different paths independently', async () => {
    const clock = new Clock();
    const store = new AgeAwareStore(clock);
    const cache = createHttpCache(store);
    let n = 0;
    const origin = vi.fn(
      async (r: Request) =>
        new Response(`${new URL(r.url).pathname}#${++n}`, cc('s-maxage=3600'))
    );

    await serve(cache.handle(new Request('https://origin.test/a'), origin));
    await serve(cache.handle(new Request('https://origin.test/b'), origin));
    expect(store.urlCount).toBe(2);
    expect(
      (await serve(cache.handle(new Request('https://origin.test/a'), origin)))
        .cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });

  it('does not let request Cache-Control vary the key', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    await serve(
      cache.handle(req({ headers: { 'cache-control': 'max-age=999' } }), origin)
    );
    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
  });

  it('keys POST bodies separately by content hash (cacheNonGetMethods)', async () => {
    const { cache, origin } = setup(
      (r, n) => new Response(`${r.method}#${n}`, cc('s-maxage=3600')),
      {
        cacheNonGetMethods: true,
      }
    );
    const post = (body: string) =>
      new Request(url, {
        method: 'POST',
        body,
        headers: { 'content-length': String(body.length) },
      });

    expect(await (await serve(cache.handle(post('one'), origin))).text()).toBe(
      'POST#1'
    );
    // different body → separate entry (cold miss)
    expect(await (await serve(cache.handle(post('two'), origin))).text()).toBe(
      'POST#2'
    );
    // same body as the first → hit
    expect(
      (await serve(cache.handle(post('one'), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
  });

  it('does not cache a POST whose body exceeds the hashing cap', async () => {
    const { cache, store, origin } = setup(
      () => new Response('body', cc('s-maxage=3600')),
      {
        cacheNonGetMethods: true,
      }
    );
    const big = new Request(url, {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': String(2_000_000) },
    });
    const res = await serve(cache.handle(big, origin));
    expect(res.cacheStatus.decision).toBe(CacheDecision.BYPASS);
    expect(store.urlCount).toBe(0);
  });
});

describe('Vary variant selection', () => {
  it('serves the matching variant and misses on a different one', async () => {
    const { cache, origin } = setup(
      (r, n) =>
        new Response(`enc=${r.headers.get('accept-encoding')}#${n}`, {
          headers: {
            'cache-control': 's-maxage=3600',
            vary: 'accept-encoding',
          },
        })
    );
    const withEnc = (enc: string) =>
      new Request(url, { headers: { 'accept-encoding': enc } });

    await serve(cache.handle(withEnc('gzip'), origin));
    // same variant → hit
    expect(
      (await serve(cache.handle(withEnc('gzip'), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
    // different variant → miss (fetches a second representation)
    const other = await serve(cache.handle(withEnc('br'), origin));
    expect(other.cacheStatus.hit).toBe(false);
    expect(await other.text()).toBe('enc=br#2');
  });

  it('varies a stored OPTIONS preflight on the CORS request headers', async () => {
    const { cache, origin } = setup(
      () =>
        new Response(null, { headers: { 'access-control-max-age': '3600' } }),
      { cacheNonGetMethods: true }
    );
    const preflight = (method: string) =>
      new Request(url, {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': method },
      });

    await serve(cache.handle(preflight('GET'), origin));
    expect(
      (await serve(cache.handle(preflight('GET'), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
    // a preflight for a different method is a different variant → miss
    expect(
      (await serve(cache.handle(preflight('DELETE'), origin))).cacheStatus.hit
    ).toBe(false);
  });
});

describe('conditional client requests (304)', () => {
  it('answers 304 to a matching If-None-Match on a fresh entry', async () => {
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
        })
    );
    await serve(cache.handle(req(), origin));

    const res = await serve(
      cache.handle(req({ headers: { 'if-none-match': '"v1"' } }), origin)
    );
    expect(res.status).toBe(304);
    expect(res.body).toBe(null);
    expect(res.headers.get('etag')).toBe('"v1"');
  });

  it('matches If-None-Match weakly and against a list', async () => {
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
        })
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(req({ headers: { 'if-none-match': 'W/"x", "v1"' } }), origin)
    );
    expect(res.status).toBe(304);
  });

  it('answers 304 to a matching If-Modified-Since', async () => {
    const lastModified = new Date(Date.now() - 100_000).toUTCString();
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: {
            'cache-control': 's-maxage=3600',
            'last-modified': lastModified,
          },
        })
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(
        req({ headers: { 'if-modified-since': new Date().toUTCString() } }),
        origin
      )
    );
    expect(res.status).toBe(304);
  });

  it('serves the full body when the conditional does not match', async () => {
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
        })
    );
    await serve(cache.handle(req(), origin));
    const res = await serve(
      cache.handle(req({ headers: { 'if-none-match': '"other"' } }), origin)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body');
  });
});

describe('background writes via waitUntil', () => {
  it('defers the cold-miss store to ctx.waitUntil and still persists it', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600'))
    );
    const ctx = new TestExecutionCtx();

    const miss = await serve(cache.handle(req(), origin, ctx));
    expect(miss.cacheStatus.hit).toBe(false);
    await ctx.settle(); // flush the deferred store write

    expect(
      (await serve(cache.handle(req(), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledTimes(1);
  });
});

describe('response hygiene', () => {
  it('restores the origin Cache-Control and strips internal bookkeeping on serve', async () => {
    const { cache, origin, req } = setup(
      () =>
        new Response('body', {
          headers: {
            'cdn-cache-control': 's-maxage=3600',
            'cache-control': 'max-age=60',
          },
        })
    );
    const miss = await serve(cache.handle(req(), origin));
    expect(miss.headers.get('cache-control')).toBe('max-age=60');
    expect(miss.headers.has('cdn-cache-control')).toBe(false);

    const hit = await serve(cache.handle(req(), origin));
    expect(hit.headers.get('cache-control')).toBe('max-age=60');
    expect(hit.headers.has('x-cache-internal-control')).toBe(false);
    expect(hit.headers.has('x-cache-original-control')).toBe(false);
  });

  it('never leaks an internal directive for an origin that sent no Cache-Control (301)', async () => {
    const { cache, origin, req } = setup(
      () => new Response('moved', { status: 301 })
    );
    await serve(cache.handle(req(), origin));
    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(hit.headers.has('cache-control')).toBe(false);
    expect(hit.headers.has('x-cache-internal-control')).toBe(false);
  });
});

describe('no-transform round-trip', () => {
  it('preserves no-transform on the client-facing response across a hit', async () => {
    const { cache, origin, req } = setup(
      () => new Response('body', cc('s-maxage=3600, no-transform'))
    );
    const miss = await serve(cache.handle(req(), origin));
    expect(miss.headers.get('cache-control')).toContain('no-transform');

    const hit = await serve(cache.handle(req(), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    // The origin's client-facing directive is restored verbatim on serve, no-transform included.
    expect(hit.headers.get('cache-control')).toContain('no-transform');
  });
});

describe('HEAD requests', () => {
  it('serves a cold-miss HEAD with headers but no body', async () => {
    const { cache, origin } = setup(
      () =>
        new Response('the-body', {
          headers: { 'cache-control': 's-maxage=3600', 'content-length': '8' },
        })
    );
    const res = await serve(
      cache.handle(new Request(url, { method: 'HEAD' }), origin)
    );
    expect(res.cacheStatus.hit).toBe(false);
    expect(await res.text()).toBe('');
    // Content-Length still describes the GET representation the HEAD stands in for.
    expect(res.headers.get('content-length')).toBe('8');
  });
});

describe('method eligibility', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    it(`bypasses ${method} without consulting the cache`, async () => {
      const { cache, origin } = setup(
        () => new Response('ok', cc('s-maxage=3600')),
        {
          cacheNonGetMethods: true,
        }
      );
      const res = await serve(
        cache.handle(new Request(url, { method }), origin)
      );
      expect(res.cacheStatus.decision).toBe(CacheDecision.BYPASS);
    });
  }
});
