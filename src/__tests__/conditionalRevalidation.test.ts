import { describe, it, expect, vi } from 'vitest';
import { CacheDecision, CacheStore, createHttpCache } from '../index';
import { freshenStoredResponse } from '../responses';
import { AgeAwareStore, Clock, serve } from './cacheHarness';

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
  async match(request: Request): Promise<Response | undefined> {
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
  async delete(request: Request): Promise<boolean> {
    return this.map.delete(request.url);
  }
}

const url = 'https://test.com/x';

describe('freshenStoredResponse', () => {
  it('retains the stored body and overlays the 304 header fields', async () => {
    const stored = new Response('cached-body', {
      status: 200,
      headers: { 'cache-control': 's-maxage=0', etag: '"v1"', age: '500' },
    });
    const notModified = new Response(null, {
      status: 304,
      headers: { 'cache-control': 's-maxage=3600', 'content-length': '0' },
    });

    const freshened = freshenStoredResponse(stored, notModified);
    expect(freshened.status).toBe(200);
    expect(await freshened.text()).toBe('cached-body'); // body retained, not re-downloaded
    expect(freshened.headers.get('cache-control')).toBe('s-maxage=3600'); // overlaid
    expect(freshened.headers.get('etag')).toBe('"v1"'); // preserved
    expect(freshened.headers.get('age')).toBe('0'); // reset (recomputed; no Date here → 0)
    // The 304's Content-Length (for its empty body) must not overwrite the retained body's.
    expect(freshened.headers.get('content-length')).not.toBe('0');
  });
});

describe('conditional revalidation (opt-in)', () => {
  it('revalidates a client-forced miss with a 304 and serves the retained body', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const seen: (string | null)[] = [];
    const passthrough = vi.fn(async (req: Request) => {
      const inm = req.headers.get('if-none-match');
      seen.push(inm);
      return inm
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', {
            headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
          });
    });

    await serve(cache.handle(new Request(url), passthrough)); // seed a fresh entry

    // `no-cache` forces revalidation; with a validator the origin answers 304.
    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );

    // Retained body served as a full 200 (NOT the bodyless 304 forwarded to the client).
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body1');
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT); // validated → hit
    expect(seen[1]).toBe('"v1"'); // the stored entry's validator was sent
    expect(res.headers.has('age')).toBe(true); // §5.1: served cache response carries Age
  });

  it('resets Age when a 304 freshens an aged entry (not carried over)', async () => {
    const store = new AgeAwareStore(new Clock());
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const passthrough = vi.fn(async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body', {
            headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
          })
    );

    await serve(cache.handle(new Request(url), passthrough)); // seed
    store.clock.advance(1000); // age the entry well past any real elapsed time

    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    // Reset from the refreshed Date (~0), not the stale 1000 the entry had aged to.
    expect(Number(res.headers.get('age'))).toBeLessThan(10);
  });

  it('answers 304 to a client conditional that matches the validated entry', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const passthrough = async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', {
            headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
          });

    await serve(cache.handle(new Request(url), passthrough));

    const matching = await serve(
      cache.handle(
        new Request(url, {
          headers: { 'cache-control': 'no-cache', 'if-none-match': '"v1"' },
        }),
        passthrough
      )
    );
    expect(matching.status).toBe(304);
    expect(await matching.text()).toBe('');
    expect(matching.cacheStatus.decision).toBe(CacheDecision.HIT);

    const differing = await serve(
      cache.handle(
        new Request(url, {
          headers: { 'cache-control': 'no-cache', 'if-none-match': '"v0"' },
        }),
        passthrough
      )
    );
    expect(differing.status).toBe(200);
    expect(await differing.text()).toBe('body1');
  });

  it('replaces the entry when the origin returns a full 200', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    let n = 0;
    const passthrough = async () =>
      new Response(`body${++n}`, {
        headers: { 'cache-control': 's-maxage=3600', etag: `"v${n}"` },
      });

    await serve(cache.handle(new Request(url), passthrough)); // body1
    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(await res.text()).toBe('body2'); // origin changed → replaced
  });

  it('freshens a stale-while-revalidate entry via 304 without re-downloading', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const seen: (string | null)[] = [];
    const passthrough = async (req: Request) => {
      const inm = req.headers.get('if-none-match');
      seen.push(inm);
      return inm
        ? new Response(null, {
            status: 304,
            headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
          })
        : new Response('v1-body', {
            headers: {
              'cache-control': 's-maxage=0, stale-while-revalidate=100',
              etag: '"v1"',
            },
          });
    };

    await serve(cache.handle(new Request(url), passthrough)); // seed stale-immediately entry

    const swr = await serve(cache.handle(new Request(url), passthrough));
    expect(swr.cacheStatus.decision).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
    expect(await swr.text()).toBe('v1-body');
    // Revalidation ran as part of handling: it sent the validator and got a 304.
    expect(seen[1]).toBe('"v1"');

    // The freshened entry (s-maxage=3600) is now a fresh hit, still serving the retained body.
    const hit = await serve(cache.handle(new Request(url), passthrough));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await hit.text()).toBe('v1-body');
  });

  it('falls back to a full re-fetch when the stored entry has no validator', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const seen: (string | null)[] = [];
    const passthrough = async (req: Request) => {
      seen.push(req.headers.get('if-none-match'));
      return new Response('body', {
        headers: { 'cache-control': 's-maxage=3600' },
      });
    };

    await serve(cache.handle(new Request(url), passthrough)); // no ETag/Last-Modified
    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(seen[1]).toBe(null); // no validator to send → full re-fetch, no conditional header
  });

  it('freshens a private-mode bare-max-age entry via 304', async () => {
    // Private mode caches a bare `max-age` (no public/s-maxage). Conditional revalidation must
    // work the same way there: a 304 re-serves the retained body and refreshes the entry.
    const store = new MemoryStore();
    const cache = createHttpCache(store, {
      shared: false,
      conditionalRevalidation: true,
    });
    const seen: (string | null)[] = [];
    const passthrough = async (req: Request) => {
      const inm = req.headers.get('if-none-match');
      seen.push(inm);
      return inm
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('priv-body', {
            headers: { 'cache-control': 'max-age=3600', etag: '"v1"' },
          });
    };

    await serve(cache.handle(new Request(url), passthrough)); // seed private entry
    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('priv-body');
    expect(res.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(seen[1]).toBe('"v1"');
  });

  it('retains a cdn-cache-control-sourced entry across a 304 with no caching headers', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const passthrough = vi.fn(async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', {
            headers: { 'cdn-cache-control': 'max-age=3600', etag: '"v1"' },
          })
    );

    await serve(cache.handle(new Request(url), passthrough)); // seed via cdn-cache-control
    const res = await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body1');
    expect(store.urlCount).toBe(1);

    const hit = await serve(cache.handle(new Request(url), passthrough));
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(await hit.text()).toBe('body1');
    expect(passthrough).toHaveBeenCalledTimes(2);
  });

  it('retains an Expires-sourced entry across a 304 with no caching headers', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const expires = new Date(Date.now() + 3600_000).toUTCString();
    const passthrough = async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', { headers: { expires, etag: '"v1"' } });

    await serve(cache.handle(new Request(url), passthrough)); // seed via Expires
    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(store.urlCount).toBe(1);
  });

  it('drops the entry when the 304 updates the policy to uncacheable', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const passthrough = async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, {
            status: 304,
            headers: { 'cache-control': 'no-store', etag: '"v1"' },
          })
        : new Response('body1', {
            headers: { 'cdn-cache-control': 'max-age=3600', etag: '"v1"' },
          });

    await serve(cache.handle(new Request(url), passthrough));
    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(store.urlCount).toBe(0);
  });

  it('drops the entry when the 304 carries an already-expired policy', async () => {
    // An `Expires` in the past is an updated policy, not an absent one.
    const store = new AgeAwareStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const expired = new Date(Date.now() - 1000).toUTCString();
    const passthrough = async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, {
            status: 304,
            headers: { expires: expired, etag: '"v1"' },
          })
        : new Response('body1', {
            headers: { 'cdn-cache-control': 'max-age=3600', etag: '"v1"' },
          });

    await serve(cache.handle(new Request(url), passthrough));
    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(store.urlCount).toBe(0);
  });

  it('always validates a stored no-cache response and reuses its body on 304', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store); // conditional revalidation is otherwise off
    const seen: (string | null)[] = [];
    const passthrough = vi.fn(async (req: Request) => {
      const validator = req.headers.get('if-none-match');
      seen.push(validator);
      return validator
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', {
            headers: { 'cache-control': 'public, no-cache', etag: '"v1"' },
          });
    });

    const first = await serve(cache.handle(new Request(url), passthrough));
    expect(await first.text()).toBe('body1');
    expect(store.urlCount).toBe(1);

    const validated = await serve(cache.handle(new Request(url), passthrough));
    expect(validated.status).toBe(200);
    expect(await validated.text()).toBe('body1');
    expect(validated.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(seen).toEqual([null, '"v1"']);
    expect(store.urlCount).toBe(1);
  });

  it('returns 304 for a matching client conditional after validating no-cache', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store);
    const passthrough = async (req: Request) =>
      req.headers.get('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response('body1', {
            headers: { 'cache-control': 'public, no-cache', etag: '"v1"' },
          });

    await serve(cache.handle(new Request(url), passthrough));
    const validated = await serve(
      cache.handle(
        new Request(url, { headers: { 'if-none-match': '"v1"' } }),
        passthrough
      )
    );
    expect(validated.status).toBe(304);
    expect(await validated.text()).toBe('');
  });

  it('does not send validators when conditionalRevalidation is off (default)', async () => {
    const store = new MemoryStore();
    const cache = createHttpCache(store); // default: off
    const seen: (string | null)[] = [];
    const passthrough = async (req: Request) => {
      seen.push(req.headers.get('if-none-match'));
      return new Response('body', {
        headers: { 'cache-control': 's-maxage=3600', etag: '"v1"' },
      });
    };

    await serve(cache.handle(new Request(url), passthrough));
    await serve(
      cache.handle(
        new Request(url, { headers: { 'cache-control': 'no-cache' } }),
        passthrough
      )
    );
    expect(seen[1]).toBe(null); // validator never sent when the feature is off
  });
});
