import { describe, it, expect, vi } from 'vitest';
import { CacheDecision, CacheStore, createHttpCache } from '../index';
import { AgeAwareStore, Clock, serve, TestExecutionCtx } from './cacheHarness';

/** An in-memory {@link CacheStore} that mirrors the Web Cache API closely enough for tests:
 * it stores response bytes and hands back a fresh `Response` on every `match`. Keys are the
 * (always-GET) cache-request URL the library derives. */
class MemoryStore implements CacheStore {
  private map = new Map<
    string,
    {
      body: ArrayBuffer;
      status: number;
      statusText: string;
      headers: [string, string][];
    }
  >();

  async match(
    request: Request,
    _options?: { ignoreMethod?: boolean }
  ): Promise<Response | undefined> {
    const entry = this.map.get(request.url);
    if (!entry) return undefined;
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers: new Headers(entry.headers),
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    const body = await response.arrayBuffer();
    this.map.set(request.url, {
      body,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers] as [string, string][],
    });
  }

  async delete(
    request: Request,
    _options?: { ignoreVary?: boolean }
  ): Promise<boolean> {
    return this.map.delete(request.url);
  }
}

const url = 'https://test.com/my/route';

const cc = (value: string) => ({ headers: { 'cache-control': value } });

describe('createHttpCache (EAS-style config: cacheNonGetMethods)', () => {
  const makeCache = () =>
    createHttpCache(new MemoryStore(), { cacheNonGetMethods: true });

  it('misses then hits, serving the cached body without a second origin call', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = vi.fn(
      async () => new Response(`response ${++count}`, cc('s-maxage=3600'))
    );

    const first = await serve(cache.handle(new Request(url), passthrough));
    expect(first.cacheStatus.hit).toBe(false);
    expect(await first.text()).toBe('response 1');

    const second = await serve(cache.handle(new Request(url), passthrough));
    expect(second.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await second.text()).toBe('response 1');
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it('restores the origin Cache-Control and strips internal bookkeeping headers on serve', async () => {
    const cache = makeCache();
    const passthrough = async () => new Response('body', cc('s-maxage=3600'));

    await serve(cache.handle(new Request(url), passthrough));
    const hit = await serve(cache.handle(new Request(url), passthrough));
    expect(hit.headers.get('cache-control')).toBe('s-maxage=3600');
    expect(hit.headers.has('x-cache-internal-control')).toBe(false);
    expect(hit.headers.has('x-cache-original-control')).toBe(false);
  });

  it('answers 304 to a conditional request that matches a fresh cached entry', async () => {
    const cache = makeCache();
    const passthrough = async () =>
      new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-none-match': '"v1"' } }),
        passthrough
      )
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
  });

  it('uses a fresh native 304 from a conditional-aware store', async () => {
    const backing = new MemoryStore();
    const lookups: Array<string | null> = [];
    const store: CacheStore = {
      async match(request, options) {
        const ifNoneMatch = request.headers.get('if-none-match');
        lookups.push(ifNoneMatch);
        expect(request.headers.has('if-modified-since')).toBe(false);
        const response = await backing.match(request, options);
        return response && ifNoneMatch === '"v1"'
          ? new Response(null, { status: 304, headers: response.headers })
          : response;
      },
      put: (request, response) => backing.put(request, response),
      delete: (request, options) => backing.delete(request, options),
    };
    const cache = createHttpCache(store);
    const passthrough = async () =>
      new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    await serve(cache.handle(new Request(url), passthrough));
    lookups.length = 0;

    const response = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-none-match': '"v1"' } }),
        passthrough
      )
    );
    expect(lookups).toEqual(['"v1"']);
    expect(response.status).toBe(304);
  });

  it('uses a fresh native 304 for If-Modified-Since', async () => {
    const backing = new MemoryStore();
    const modified = 'Tue, 01 Jul 2025 00:00:00 GMT';
    const lookups: Array<string | null> = [];
    const store: CacheStore = {
      async match(request, options) {
        const ifModifiedSince = request.headers.get('if-modified-since');
        lookups.push(ifModifiedSince);
        const response = await backing.match(request, options);
        return response && ifModifiedSince === modified
          ? new Response(null, { status: 304, headers: response.headers })
          : response;
      },
      put: (request, response) => backing.put(request, response),
      delete: (request, options) => backing.delete(request, options),
    };
    const cache = createHttpCache(store);
    const passthrough = async () =>
      new Response('body', {
        headers: {
          'cache-control': 's-maxage=3600',
          'last-modified': modified,
        },
      });
    await serve(cache.handle(new Request(url), passthrough));
    lookups.length = 0;

    const response = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-modified-since': modified } }),
        passthrough
      )
    );
    expect(lookups).toEqual([modified]);
    expect(response.status).toBe(304);
  });

  it('re-reads a stale native 304 as a complete response', async () => {
    const backing = new AgeAwareStore();
    const lookups: Array<string | null> = [];
    const store: CacheStore = {
      async match(request) {
        const ifNoneMatch = request.headers.get('if-none-match');
        lookups.push(ifNoneMatch);
        const response = await backing.match(request);
        return response && ifNoneMatch === '"v1"'
          ? new Response(null, { status: 304, headers: response.headers })
          : response;
      },
      put: (request, response) => backing.put(request, response),
      delete: request => backing.delete(request),
    };
    const cache = createHttpCache(store);
    const passthrough = vi.fn(
      async () =>
        new Response('body', {
          headers: {
            'cache-control': 's-maxage=0, stale-if-error=100',
            etag: '"v1"',
          },
        })
    );
    await serve(cache.handle(new Request(url), passthrough));
    lookups.length = 0;

    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: {
            'if-none-match': '"v1"',
            'cache-control': 'only-if-cached',
          },
        }),
        passthrough
      )
    );
    expect(lookups).toEqual(['"v1"', null]);
    expect(response.status).toBe(304);
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it('rejects a native 304 that does not match the client conditional', async () => {
    const backing = new MemoryStore();
    const lookups: Array<string | null> = [];
    const store: CacheStore = {
      async match(request, options) {
        const ifNoneMatch = request.headers.get('if-none-match');
        lookups.push(ifNoneMatch);
        const response = await backing.match(request, options);
        return response && ifNoneMatch
          ? new Response(null, { status: 304, headers: response.headers })
          : response;
      },
      put: (request, response) => backing.put(request, response),
      delete: (request, options) => backing.delete(request, options),
    };
    const cache = createHttpCache(store);
    const passthrough = async () =>
      new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    await serve(cache.handle(new Request(url), passthrough));
    lookups.length = 0;

    const response = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-none-match': '"other"' } }),
        passthrough
      )
    );
    expect(lookups).toEqual(['"other"', null]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('body');
  });

  it('serves the full body on a hit when the conditional does not match', async () => {
    const cache = makeCache();
    const passthrough = async () =>
      new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-none-match': '"v2"' } }),
        passthrough
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body');
  });

  it('returns an eager empty 504 for only-if-cached on an empty cache', async () => {
    const cache = makeCache();
    const passthrough = vi.fn(async () => new Response('origin'));
    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'only-if-cached' } }),
        passthrough
      )
    );
    expect(res.status).toBe(504);
    expect(await res.text()).toBe('');
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('serves a fresh entry for only-if-cached without contacting the origin', async () => {
    const cache = makeCache();
    const passthrough = vi.fn(
      async () => new Response('cached', cc('s-maxage=3600'))
    );
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'only-if-cached' } }),
        passthrough
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await res.text()).toBe('cached');
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it('returns a 504 for only-if-cached when the client forces a miss (max-age=0)', async () => {
    const cache = makeCache();
    const passthrough = async () => new Response('cached', cc('s-maxage=3600'));
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, {
          headers: { 'cache-control': 'only-if-cached, max-age=0' },
        }),
        passthrough
      )
    );
    expect(res.status).toBe(504);
  });

  it('ignores a cache hit when the client sends no-cache', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = async () =>
      new Response(`response ${++count}`, cc('s-maxage=3600'));
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.cacheStatus.hit).toBe(false);
    expect(await res.text()).toBe('response 2');
  });

  it('caches separate methods on the same pathname independently', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = async (request: Request) =>
      new Response(
        `response ${request.method} ${++count}`,
        cc('s-maxage=3600')
      );

    const post1 = await serve(
      cache.handle(new Request(url, { method: 'POST' }), passthrough)
    );
    expect(await post1.text()).toBe('response POST 1');

    const get1 = await serve(cache.handle(new Request(url), passthrough));
    expect(await get1.text()).toBe('response GET 2');

    const post2 = await serve(
      cache.handle(new Request(url, { method: 'POST' }), passthrough)
    );
    expect(post2.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await post2.text()).toBe('response POST 1');
  });

  it('rewrites HEAD to GET for the origin and shares its cache entry (no body on the HEAD)', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = vi.fn(
      async (request: Request) =>
        new Response(
          `response ${request.method} ${++count}`,
          cc('s-maxage=3600')
        )
    );

    const head = await serve(
      cache.handle(new Request(url, { method: 'HEAD' }), passthrough)
    );
    // A HEAD must not carry a body, even though it is served from the stored GET.
    expect(await head.text()).toBe('');
    expect((passthrough.mock.calls[0][0] as Request).method).toBe('GET');

    // The stored GET representation is shared: a following GET is a hit with the full body.
    const get = await serve(cache.handle(new Request(url), passthrough));
    expect(get.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await get.text()).toBe('response GET 1');

    // A HEAD hit still reports no body, but reflects the stored entry (a fresh hit).
    const headHit = await serve(
      cache.handle(new Request(url, { method: 'HEAD' }), passthrough)
    );
    expect(headHit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await headHit.text()).toBe('');
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it('serves stale-while-revalidate then refreshes for the next request', async () => {
    const cache = makeCache();
    let mode: 'seed' | 'fresh' = 'seed';
    const passthrough = async () =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-while-revalidate=1'))
        : new Response('fresh', cc('s-maxage=1'));

    // Seed a stale-immediately entry.
    await serve(cache.handle(new Request(url), passthrough));
    mode = 'fresh';

    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
    expect(await res.text()).toBe('stale');

    // Revalidation ran as part of handling, so the entry is now refreshed.
    const refreshed = await serve(cache.handle(new Request(url), passthrough));
    expect(await refreshed.text()).toBe('fresh');
  });

  it('invalidates the entry if revalidation is no longer storable', async () => {
    const cache = makeCache();
    let mode: 'seed' | 'gone' = 'seed';
    const passthrough = async () =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-while-revalidate=1'))
        : new Response('gone', cc('no-store'));

    await serve(cache.handle(new Request(url), passthrough));
    mode = 'gone';

    const stale = await serve(cache.handle(new Request(url), passthrough));
    expect(stale.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );

    // The entry was deleted during revalidation, so the next request is a fresh miss.
    const next = await serve(cache.handle(new Request(url), passthrough));
    expect(next.cacheStatus.hit).toBe(false);
  });

  it('serves stale-if-error to mask origin error statuses', async () => {
    const cache = makeCache();
    let mode: 'seed' | 'error' = 'seed';
    const passthrough = async () =>
      mode === 'seed'
        ? new Response('stale', cc('s-maxage=0, stale-if-error=1'))
        : new Response('boom', { status: 500 });

    await serve(cache.handle(new Request(url), passthrough));
    mode = 'error';

    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await res.text()).toBe('stale');
  });

  it('serves stale-if-error to mask origin crashes', async () => {
    const cache = makeCache();
    let mode: 'seed' | 'crash' = 'seed';
    const passthrough = async () => {
      if (mode === 'seed')
        return new Response('stale', cc('s-maxage=0, stale-if-error=1'));
      throw new Error('origin crashed');
    };

    await serve(cache.handle(new Request(url), passthrough));
    mode = 'crash';

    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await res.text()).toBe('stale');
  });

  it('caches OPTIONS responses by Access-Control-Max-Age', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = async () =>
      new Response(`response ${++count}`, {
        headers: { 'access-control-max-age': '3600' },
      });

    const first = await serve(
      cache.handle(new Request(url, { method: 'OPTIONS' }), passthrough)
    );
    expect(await first.text()).toBe('response 1');

    const second = await serve(
      cache.handle(new Request(url, { method: 'OPTIONS' }), passthrough)
    );
    expect(second.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await second.text()).toBe('response 1');
  });

  it('caches 301 responses immutably', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = async () =>
      new Response(`response ${++count}`, { status: 301 });

    const first = await serve(cache.handle(new Request(url), passthrough));
    expect(first.status).toBe(301);

    const second = await serve(cache.handle(new Request(url), passthrough));
    expect(second.cacheStatus.decision).toBe(CacheDecision.HIT);
    // The origin sent no Cache-Control, so the internal (munged) directive must not leak.
    expect(second.headers.has('cache-control')).toBe(false);
    expect(second.headers.has('x-cache-internal-control')).toBe(false);
    expect(second.headers.has('x-cache-original-control')).toBe(false);
  });

  it('leaves 302 responses uncached', async () => {
    const cache = makeCache();
    let count = 0;
    const passthrough = async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://test.com/${++count}` },
      });

    await serve(cache.handle(new Request(url), passthrough));
    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.hit).toBe(false);
    expect(res.headers.get('location')).toBe('https://test.com/2');
  });

  it('bypasses uncacheable methods', async () => {
    const cache = makeCache();
    const passthrough = async () => new Response(null, { status: 204 });
    const res = await serve(
      cache.handle(new Request(url, { method: 'PUT' }), passthrough)
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.BYPASS);
    expect(res.status).toBe(204);
  });
});

describe('createHttpCache (browser defaults)', () => {
  it('does not cache non-GET methods by default', async () => {
    const cache = createHttpCache(new MemoryStore());
    let count = 0;
    const passthrough = async () =>
      new Response(`response ${++count}`, cc('s-maxage=3600'));

    const first = await serve(
      cache.handle(new Request(url, { method: 'POST' }), passthrough)
    );
    expect(first.cacheStatus.decision).toBe(CacheDecision.BYPASS);

    const second = await serve(
      cache.handle(new Request(url, { method: 'POST' }), passthrough)
    );
    expect(second.cacheStatus.decision).toBe(CacheDecision.BYPASS);
    expect(await second.text()).toBe('response 2');
  });

  it('honors clientCacheBypass=false by ignoring client no-cache', async () => {
    const cache = createHttpCache(new MemoryStore(), {
      clientCacheBypass: false,
    });
    let count = 0;
    const passthrough = async () =>
      new Response(`response ${++count}`, cc('s-maxage=3600'));
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await res.text()).toBe('response 1');
  });

  it('shared-caches a bare max-age only with requireSharedDirective: false; always in private mode', async () => {
    const passthrough = () =>
      Promise.resolve(new Response('body', cc('max-age=3600')));

    // Shared, default: a bare `max-age` is private, so every request misses.
    const sharedDefault = createHttpCache(new MemoryStore());
    await serve(sharedDefault.handle(new Request(url), passthrough));
    const sharedMiss = await serve(
      sharedDefault.handle(new Request(url), passthrough)
    );
    expect(sharedMiss.cacheStatus.hit).toBe(false);

    // Shared, requireSharedDirective: false: RFC §4.2.1 — served while fresh.
    const sharedRfc = createHttpCache(new MemoryStore(), {
      requireSharedDirective: false,
    });
    await serve(sharedRfc.handle(new Request(url), passthrough));
    const sharedHit = await serve(
      sharedRfc.handle(new Request(url), passthrough)
    );
    expect(sharedHit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await sharedHit.text()).toBe('body');

    // Private: cached and served like a browser regardless (the flag is shared-only).
    const priv = createHttpCache(new MemoryStore(), { shared: false });
    await serve(priv.handle(new Request(url), passthrough));
    const privHit = await serve(priv.handle(new Request(url), passthrough));
    expect(privHit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await privHit.text()).toBe('body');
  });

  it('uses the native Cache shape structurally (GET/HEAD only)', async () => {
    const cache = createHttpCache(new MemoryStore());
    const passthrough = async () => new Response('ok', cc('s-maxage=3600'));
    await serve(cache.handle(new Request(url), passthrough));
    const hit = await serve(cache.handle(new Request(url), passthrough));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
  });
});

describe('createHttpCache (header handling)', () => {
  const makeCache = () => createHttpCache(new MemoryStore());

  it('serves the client-facing Cache-Control and strips the CDN tier when they differ', async () => {
    // Origin governs the CDN edge with `cdn-cache-control` but tells the client `max-age=60`.
    const cache = makeCache();
    const passthrough = async () =>
      new Response('body', {
        headers: {
          'cdn-cache-control': 's-maxage=3600',
          'cache-control': 'max-age=60',
        },
      });

    // Cold miss: the CDN-only tier is stripped, the client keeps its own directive.
    const miss = await serve(cache.handle(new Request(url), passthrough));
    expect(miss.headers.get('cache-control')).toBe('max-age=60');
    expect(miss.headers.has('cdn-cache-control')).toBe(false);

    // Hit: served from the store, still shows the origin's client-facing directive — never
    // the internal s-maxage the CDN tier was promoted into.
    const hit = await serve(cache.handle(new Request(url), passthrough));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(hit.headers.get('cache-control')).toBe('max-age=60');
    expect(hit.headers.has('cdn-cache-control')).toBe(false);
    expect(hit.headers.has('x-cache-internal-control')).toBe(false);
  });

  it('answers 304 to a conditional HEAD request that matches a fresh entry', async () => {
    const cache = makeCache();
    const passthrough = async () =>
      new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    await serve(cache.handle(new Request(url), passthrough));

    const res = await serve(
      cache.handle(
        new Request(url, {
          method: 'HEAD',
          headers: { 'if-none-match': '"v1"' },
        }),
        passthrough
      )
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('never deletes a still-usable stale entry on a client-forced miss (cold path only stores)', async () => {
    // A client `no-cache` forces MISS_REQUEST; if the origin answers with a non-storable
    // response, the existing stale entry must survive (unlike a background revalidation, which
    // deletes). A later origin error can then still be masked by stale-if-error.
    const cache = makeCache();
    let mode: 'seed' | 'nostore' | 'error' = 'seed';
    const passthrough = async () => {
      if (mode === 'seed')
        return new Response('cached', cc('s-maxage=0, stale-if-error=1000'));
      if (mode === 'nostore') return new Response('live', cc('no-store'));
      return new Response('boom', { status: 500 });
    };

    await serve(cache.handle(new Request(url), passthrough));

    mode = 'nostore';
    const forcedRes = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(forcedRes.cacheStatus.decision).toBe(CacheDecision.MISS_REQUEST);
    expect(await forcedRes.text()).toBe('live');

    // The stale entry was NOT deleted: a subsequent origin error is masked by stale-if-error.
    mode = 'error';
    const masked = await serve(cache.handle(new Request(url), passthrough));
    expect(masked.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await masked.text()).toBe('cached');
  });
});

describe('store failure isolation (best-effort writes)', () => {
  class FlakyStore implements CacheStore {
    failPuts = false;
    constructor(private inner: CacheStore = new MemoryStore()) {}
    match(
      request: Request,
      options?: { ignoreMethod?: boolean }
    ): Promise<Response | undefined> {
      return this.inner.match(request, options);
    }
    put(request: Request, response: Response): Promise<void> {
      return this.failPuts
        ? Promise.reject(new Error('store write failed'))
        : this.inner.put(request, response);
    }
    delete(request: Request): Promise<boolean> {
      return this.inner.delete(request);
    }
  }

  it('serves the origin response when the miss-path store write fails (no ctx)', async () => {
    const store = new FlakyStore();
    store.failPuts = true;
    const cache = createHttpCache(store);
    const passthrough = vi.fn(
      async () => new Response('fresh', cc('s-maxage=3600'))
    );

    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh');

    const next = await serve(cache.handle(new Request(url), passthrough));
    expect(await next.text()).toBe('fresh');
    expect(passthrough).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to stale-if-error when only the store write fails', async () => {
    const store = new FlakyStore();
    const cache = createHttpCache(store);
    const passthrough = async () =>
      new Response('cached', cc('s-maxage=0, stale-if-error=1000'));

    await serve(cache.handle(new Request(url), passthrough)); // seed a stale-if-error entry

    store.failPuts = true;
    const healthy = async () => new Response('fresh', cc('s-maxage=3600'));
    const res = await serve(cache.handle(new Request(url), healthy));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh');
  });

  it('surfaces the write failure through waitUntil when a ctx is given', async () => {
    const store = new FlakyStore();
    store.failPuts = true;
    const cache = createHttpCache(store);
    const ctx = new TestExecutionCtx();
    const passthrough = async () => new Response('fresh', cc('s-maxage=3600'));

    const res = await (
      await cache.handle(new Request(url), passthrough, ctx)
    ).resolve();
    expect(await res.text()).toBe('fresh');
    await expect(ctx.settle()).rejects.toThrow('store write failed');
  });
});

describe('request no-store', () => {
  it('does not store the response to a no-store request', async () => {
    const cache = createHttpCache(new MemoryStore());
    const passthrough = vi.fn(
      async () => new Response('body', cc('s-maxage=3600'))
    );

    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-store' } }),
        passthrough
      )
    );
    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.hit).toBe(false);
    expect(passthrough).toHaveBeenCalledTimes(2);
  });

  it('stores it when clientCacheBypass is disabled', async () => {
    const cache = createHttpCache(new MemoryStore(), {
      clientCacheBypass: false,
    });
    const passthrough = vi.fn(
      async () => new Response('body', cc('s-maxage=3600'))
    );

    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-store' } }),
        passthrough
      )
    );
    const res = await serve(cache.handle(new Request(url), passthrough));
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(passthrough).toHaveBeenCalledTimes(1);
  });
});

describe('misbehaving origins', () => {
  it('keeps the stale entry when a revalidation gets a spurious 304', async () => {
    const cache = createHttpCache(new MemoryStore());
    let mode: 'seed' | '304' = 'seed';
    const passthrough = async () =>
      mode === 'seed'
        ? new Response('cached', cc('s-maxage=0, stale-while-revalidate=100'))
        : new Response(null, { status: 304 });

    await serve(cache.handle(new Request(url), passthrough));

    // The revalidation is answered by an unconditional 304 (an origin bug).
    mode = '304';
    const first = await serve(cache.handle(new Request(url), passthrough));
    expect(first.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    expect(await first.text()).toBe('cached');

    const second = await serve(cache.handle(new Request(url), passthrough));
    expect(second.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    expect(await second.text()).toBe('cached');
  });

  it('serves the stored entry (not a bare 304) when a forced revalidation gets a spurious 304', async () => {
    // conditionalRevalidation is off, so the cache forwards an unconditional request. A client
    // `no-cache` forces MISS_REQUEST; if the origin answers 304 anyway (a bug — no validator was
    // sent), the empty 304 must not be forwarded. The stored entry is re-served instead.
    const cache = createHttpCache(new MemoryStore());
    let mode: 'seed' | '304' = 'seed';
    const passthrough = async () =>
      mode === 'seed'
        ? new Response('cached', cc('s-maxage=3600'))
        : new Response(null, { status: 304, headers: { etag: '"v9"' } });

    await serve(cache.handle(new Request(url), passthrough)); // seed a fresh entry
    mode = '304';

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('cached');
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
  });

  it('propagates an origin error on a cold miss with no entry to fall back to', async () => {
    const cache = createHttpCache(new MemoryStore());
    const passthrough = async () => {
      throw new Error('origin down');
    };
    await expect(
      serve(cache.handle(new Request(url), passthrough))
    ).rejects.toThrow('origin down');
  });
});

describe('only-if-cached without a cache key', () => {
  it('returns a 504 for a cacheable request that cannot be keyed', async () => {
    const cache = createHttpCache(new MemoryStore()); // cacheNonGetMethods off
    const passthrough = vi.fn(async () => new Response('origin'));

    const res = await serve(
      cache.handle(
        new Request(url, {
          method: 'POST',
          headers: { 'cache-control': 'only-if-cached' },
        }),
        passthrough
      )
    );
    expect(res.status).toBe(504);
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('still bypasses for methods the cache does not handle', async () => {
    const cache = createHttpCache(new MemoryStore());
    const passthrough = vi.fn(async () => new Response('origin'));

    const res = await serve(
      cache.handle(
        new Request(url, {
          method: 'DELETE',
          headers: { 'cache-control': 'only-if-cached' },
        }),
        passthrough
      )
    );
    expect(res.status).toBe(200);
    expect(passthrough).toHaveBeenCalledTimes(1);
  });
});

/** A store that persists bytes verbatim and does NOT stamp its own `Age` on `match`
 * (unlike Cloudflare's Cache API) — exercises the `Date`-based age derivation. */
class VerbatimStore implements CacheStore {
  private map = new Map<
    string,
    { body: ArrayBuffer; status: number; headers: [string, string][] }
  >();
  async match(request: Request): Promise<Response | undefined> {
    const entry = this.map.get(request.url);
    if (!entry) return undefined;
    return new Response(entry.body, {
      status: entry.status,
      headers: new Headers(entry.headers),
    });
  }
  async put(request: Request, response: Response): Promise<void> {
    this.map.set(request.url, {
      body: await response.arrayBuffer(),
      status: response.status,
      headers: [...response.headers] as [string, string][],
    });
  }
  async delete(request: Request): Promise<boolean> {
    return this.map.delete(request.url);
  }
  get size(): number {
    return this.map.size;
  }
}

describe('age derivation without a store-stamped Age (RFC 9111 §4.2.3)', () => {
  it('ages a verbatim-store entry out via the Date header', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const cache = createHttpCache(new VerbatimStore());
      const origin = vi.fn(
        async () => new Response('v', cc('public, max-age=100'))
      );

      await serve(cache.handle(new Request(url), origin));

      vi.setSystemTime(50_000); // 50s: still fresh
      expect(
        (await serve(cache.handle(new Request(url), origin))).cacheStatus
          .decision
      ).toBe(CacheDecision.HIT);

      vi.setSystemTime(150_000); // 150s: past max-age=100
      expect(
        (await serve(cache.handle(new Request(url), origin))).cacheStatus.hit
      ).toBe(false);
      expect(origin).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('folds an origin-reported Age into the stored Date so it still counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const cache = createHttpCache(new VerbatimStore());
      // Arrives already 80s old, no Date header of its own.
      const origin = vi.fn(
        async () =>
          new Response('v', {
            headers: { 'cache-control': 's-maxage=100', age: '80' },
          })
      );
      await serve(cache.handle(new Request(url), origin));

      vi.setSystemTime(10_000); // effective age 90 < 100
      expect(
        (await serve(cache.handle(new Request(url), origin))).cacheStatus
          .decision
      ).toBe(CacheDecision.HIT);

      vi.setSystemTime(30_000); // effective age 110 > 100
      expect(
        (await serve(cache.handle(new Request(url), origin))).cacheStatus.hit
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('invalidation on unsafe methods (RFC 9111 §4.4)', () => {
  it('evicts the cached GET after a successful unsafe request to the same URI', async () => {
    const cache = createHttpCache(new MemoryStore());
    const origin = vi.fn(async (r: Request) =>
      r.method === 'GET'
        ? new Response('cached', cc('public, max-age=3600'))
        : new Response('done', { status: 200 })
    );

    // Seed a fresh GET entry.
    await serve(cache.handle(new Request(url), origin));
    expect(
      (await serve(cache.handle(new Request(url), origin))).cacheStatus.decision
    ).toBe(CacheDecision.HIT);

    // A successful DELETE must invalidate it.
    await serve(cache.handle(new Request(url, { method: 'DELETE' }), origin));

    const after = await serve(cache.handle(new Request(url), origin));
    expect(after.cacheStatus.hit).toBe(false);
  });

  it('does not invalidate when the unsafe request errors', async () => {
    const cache = createHttpCache(new MemoryStore());
    const origin = vi.fn(async (r: Request) =>
      r.method === 'GET'
        ? new Response('cached', cc('public, max-age=3600'))
        : new Response('nope', { status: 500 })
    );
    await serve(cache.handle(new Request(url), origin));
    await serve(cache.handle(new Request(url, { method: 'POST' }), origin));

    const after = await serve(cache.handle(new Request(url), origin));
    expect(after.cacheStatus.decision).toBe(CacheDecision.HIT);
  });
});

describe('Age on served responses (RFC 9111 §5.1)', () => {
  it('emits an Age header on a cache-served hit when the store did not stamp one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const cache = createHttpCache(new VerbatimStore());
      const origin = vi.fn(
        async () => new Response('v', cc('public, max-age=1000'))
      );
      await serve(cache.handle(new Request(url), origin));

      vi.setSystemTime(120_000); // 120s later, still fresh
      const hit = await serve(cache.handle(new Request(url), origin));
      expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
      expect(hit.headers.get('age')).toBe('120');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overwrite an Age the store already stamped', async () => {
    const clock = new Clock();
    const cache = createHttpCache(new AgeAwareStore(clock));
    const origin = vi.fn(
      async () => new Response('v', cc('public, max-age=1000'))
    );
    await serve(cache.handle(new Request(url), origin));

    clock.advance(42);
    const hit = await serve(cache.handle(new Request(url), origin));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(hit.headers.get('age')).toBe('42');
  });

  it('leaves a miss/bypass origin response Age untouched', async () => {
    const cache = createHttpCache(new VerbatimStore());
    const origin = vi.fn(
      async () => new Response('v', { headers: { age: '7' } })
    );
    const miss = await serve(cache.handle(new Request(url), origin));
    expect(miss.cacheStatus.hit).toBe(false);
    expect(miss.headers.get('age')).toBe('7');
  });
});

describe('unsafe-method invalidation targets (RFC 9111 §4.4)', () => {
  class RecordingStore implements CacheStore {
    inner = new MemoryStore();
    deletes: { url: string; ignoreVary?: boolean }[] = [];
    match(request: Request, options?: { ignoreMethod?: boolean }) {
      return this.inner.match(request, options);
    }
    put(request: Request, response: Response) {
      return this.inner.put(request, response);
    }
    delete(request: Request, options?: { ignoreVary?: boolean }) {
      this.deletes.push({ url: request.url, ignoreVary: options?.ignoreVary });
      return this.inner.delete(request, options);
    }
  }

  it('invalidates the target URI and same-origin Location, with ignoreVary', async () => {
    const store = new RecordingStore();
    const cache = createHttpCache(store);
    const origin = vi.fn(
      async () =>
        new Response('created', {
          status: 201,
          headers: { location: 'https://test.com/other' },
        })
    );

    await serve(cache.handle(new Request(url, { method: 'POST' }), origin));

    const urls = store.deletes.map(d => d.url).sort();
    expect(urls).toEqual([
      'https://test.com/my/route',
      'https://test.com/other',
    ]);
    expect(store.deletes.every(d => d.ignoreVary === true)).toBe(true);
  });

  it('does not invalidate a cross-origin Location', async () => {
    const store = new RecordingStore();
    const cache = createHttpCache(store);
    const origin = vi.fn(
      async () =>
        new Response('ok', {
          status: 200,
          headers: { location: 'https://evil.example/elsewhere' },
        })
    );

    await serve(cache.handle(new Request(url, { method: 'DELETE' }), origin));

    expect(store.deletes.map(d => d.url)).toEqual([
      'https://test.com/my/route',
    ]);
  });
});
