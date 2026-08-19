import { describe, expect, it, vi } from 'vitest';
import { CacheDecision, createHttpCache } from '../index';
import {
  MAX_RANGE_HEADER_LENGTH,
  MAX_RANGE_MEMBERS,
  parseRangeHeader,
  resolveByteRange,
} from '../range';
import { computeStoreDecision } from '../storeDecision';
import { AgeAwareStore, Clock, TestExecutionCtx, serve } from './cacheHarness';
import type { CacheStore } from '../types';

const url = 'https://test.com/range';
const body = '0123456789';
const full = (extra: HeadersInit = {}) =>
  new Response(body, {
    headers: {
      'cache-control': 's-maxage=3600',
      'content-length': String(body.length),
      etag: '"v1"',
      ...extra,
    },
  });

describe('byte Range parsing and resolution', () => {
  it.each([
    ['bytes=0-4', { type: 'bounded', start: 0, end: 4 }],
    [' Bytes = 5- ', { type: 'open', start: 5 }],
    ['bytes=-3', { type: 'suffix', length: 3 }],
  ])('parses %s', (value, range) => {
    expect(parseRangeHeader(value)).toEqual({ type: 'single', range });
  });

  it('classifies unsupported, multiple, malformed, unsafe, and bounded-work input', () => {
    expect(parseRangeHeader('items=0-1').type).toBe('unsupported');
    expect(parseRangeHeader('bytes=0-1, 3-4').type).toBe('multiple');
    for (const value of [
      'bytes=',
      'bytes=2-1',
      'bytes=-',
      'bytes=-1.5',
      'bytes=-1x',
      'bytes=9007199254740992-',
      'bytes=-1-2',
      'bytes=0-1,',
      'bytes=broken,also-broken',
    ])
      expect(parseRangeHeader(value).type).toBe('malformed');
    expect(
      parseRangeHeader(`bytes=0-${'0'.repeat(MAX_RANGE_HEADER_LENGTH)}`).type
    ).toBe('unsupported');
    expect(
      parseRangeHeader(
        `bytes=${Array(MAX_RANGE_MEMBERS + 1)
          .fill('0-1')
          .join(',')}`
      ).type
    ).toBe('unsupported');
  });

  it('resolves clamped, open, suffix, zero suffix, and empty representations', () => {
    expect(
      resolveByteRange({ type: 'bounded', start: 0, end: 99 }, 10)
    ).toEqual({ type: 'satisfied', start: 0, end: 9 });
    expect(resolveByteRange({ type: 'open', start: 9 }, 10)).toEqual({
      type: 'satisfied',
      start: 9,
      end: 9,
    });
    expect(resolveByteRange({ type: 'suffix', length: 99 }, 10)).toEqual({
      type: 'satisfied',
      start: 0,
      end: 9,
    });
    expect(resolveByteRange({ type: 'suffix', length: 0 }, 10)).toEqual({
      type: 'unsatisfied',
    });
    expect(resolveByteRange({ type: 'open', start: 0 }, 0)).toEqual({
      type: 'unsatisfied',
    });
    expect(
      resolveByteRange({ type: 'bounded', start: 10, end: 12 }, 10)
    ).toEqual({ type: 'unsatisfied' });
  });
});

describe('cached Range responses', () => {
  const seed = async (
    cache: ReturnType<typeof createHttpCache>,
    origin = vi.fn(async () => full())
  ) => {
    await serve(cache.handle(new Request(url), origin));
    return origin;
  };

  it.each([
    ['bytes=0-0', '0', 'bytes 0-0/10'],
    ['bytes=4-', '456789', 'bytes 4-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=0-99', body, 'bytes 0-9/10'],
  ])('serves %s locally', async (range, expected, contentRange) => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(new Request(url, { headers: { range } }), origin)
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(expected);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(
      String(expected.length)
    );
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('returns 416 for a valid unsatisfied range without a body', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=10-' } }),
        origin
      )
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(response.headers.has('content-length')).toBe(false);
    expect(await response.text()).toBe('');
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('returns 416 for every range form over a zero-length representation', async () => {
    for (const range of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-0']) {
      const cache = createHttpCache(new AgeAwareStore());
      const origin = vi.fn(
        async () =>
          new Response('', {
            headers: {
              'cache-control': 's-maxage=3600',
              'content-length': '0',
            },
          })
      );
      await serve(cache.handle(new Request(`${url}?range=${range}`), origin));
      const response = await serve(
        cache.handle(
          new Request(`${url}?range=${range}`, { headers: { range } }),
          origin
        )
      );
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */0');
    }
  });

  it('serves supported ranges under only-if-cached', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: {
            range: 'bytes=1-2',
            'cache-control': 'only-if-cached',
          },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('12');
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('leaves the complete entry intact for later ranges and ordinary GETs', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    expect(
      await (
        await serve(
          cache.handle(
            new Request(url, { headers: { range: 'bytes=2-4' } }),
            origin
          )
        )
      ).text()
    ).toBe('234');
    const complete = await serve(cache.handle(new Request(url), origin));
    expect(complete.status).toBe(200);
    expect(await complete.text()).toBe(body);
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it('evaluates client preconditions before Range', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1', 'if-none-match': 'W/"v1"' },
        }),
        origin
      )
    );
    expect(response.status).toBe(304);
  });

  it('evaluates If-Modified-Since before Range when If-None-Match is absent', async () => {
    const modified = new Date(Date.now() - 120_000).toUTCString();
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async () => full({ 'last-modified': modified }));
    await serve(cache.handle(new Request(url), origin));
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1', 'if-modified-since': modified },
        }),
        origin
      )
    );
    expect(response.status).toBe(304);
  });

  it.each([
    ['"v1"', 206],
    ['W/"v1"', 200],
    ['"other"', 200],
    ['not a date', 200],
  ])('applies strong If-Range %s', async (ifRange, status) => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1', 'if-range': ifRange },
        }),
        origin
      )
    );
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(status === 206 ? '01' : body);
  });

  it('accepts an exactly matching, demonstrably strong If-Range date', async () => {
    const modified = new Date(Date.now() - 120_000).toUTCString();
    const responseDate = new Date(Date.now()).toUTCString();
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async () =>
      full({ 'last-modified': modified, date: responseDate })
    );
    await serve(cache.handle(new Request(url), origin));
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1', 'if-range': modified },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
  });

  it('rejects a non-HTTP If-Range date even when Date.parse accepts it', async () => {
    const invalidHttpDate = new Date(Date.now() - 120_000).toISOString();
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async () =>
      full({
        'last-modified': invalidHttpDate,
        date: new Date().toUTCString(),
      })
    );
    await serve(cache.handle(new Request(url), origin));
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1', 'if-range': invalidHttpDate },
        }),
        origin
      )
    );
    expect(response.status).toBe(200);
  });

  it('forwards unsupported ranges untouched, or returns 504 under only-if-cached', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store);
    const seedOrigin = await seed(cache);
    const origin = vi.fn(async (request: Request) => {
      expect(request.headers.get('range')).toBe('bytes=0-1,4-5');
      expect(request.headers.get('if-range')).toBe('"v1"');
      return new Response('partial', { status: 206 });
    });
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=0-1,4-5', 'if-range': '"v1"' },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
    expect(response.cacheStatus.decision).toBe(CacheDecision.BYPASS);
    const timeout = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'items=0-1', 'cache-control': 'only-if-cached' },
        }),
        origin
      )
    );
    expect(timeout.status).toBe(504);
    expect(origin).toHaveBeenCalledTimes(1);
    expect(seedOrigin).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, true],
    [{ 'content-encoding': 'identity' }, true],
    [{ 'content-encoding': 'gzip' }, false],
    [{ 'content-length': '' }, false],
  ])('requires eligible body metadata %#', async (extra, eligible) => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async () => full(extra));
    await serve(cache.handle(new Request(url), origin));
    const response = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=0-1' } }),
        origin
      )
    );
    expect(response.status).toBe(eligible ? 206 : 200);
    expect(origin).toHaveBeenCalledTimes(eligible ? 1 : 2);
  });

  it('preserves all Range miss preconditions', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async (request: Request) => {
      for (const name of [
        'range',
        'if-range',
        'if-match',
        'if-none-match',
        'if-unmodified-since',
        'if-modified-since',
      ])
        expect(request.headers.has(name)).toBe(true);
      return new Response('part', { status: 206 });
    });
    const headers = new Headers({
      range: 'bytes=0-1',
      'if-range': '"v1"',
      'if-match': '*',
      'if-none-match': '"x"',
      'if-unmodified-since': 'Wed, 01 Jan 2020 00:00:00 GMT',
      'if-modified-since': 'Wed, 01 Jan 2019 00:00:00 GMT',
    });
    expect(
      (await serve(cache.handle(new Request(url, { headers }), origin))).status
    ).toBe(206);
    expect(origin).toHaveBeenCalledOnce();
  });

  it('does not store a partial origin response', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const partial = vi.fn(async () => new Response('01', { status: 206 }));
    await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=0-1' } }),
        partial
      )
    );
    const complete = vi.fn(async () => full());
    expect(
      await (await serve(cache.handle(new Request(url), complete))).text()
    ).toBe(body);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('stores a complete 200 returned on a supported Range miss', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    const origin = vi.fn(async () => full());
    const ignored = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=0-1' } }),
        origin
      )
    );
    expect(ignored.status).toBe(200);
    const hit = await serve(cache.handle(new Request(url), origin));
    expect(await hit.text()).toBe(body);
    expect(hit.cacheStatus.decision).toBe(CacheDecision.HIT);
    expect(origin).toHaveBeenCalledOnce();
  });

  it('revalidates the complete entry and then slices a 304-freshened response', async () => {
    const store = new AgeAwareStore(new Clock());
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    await seed(cache);
    const origin = vi.fn(async (request: Request) => {
      expect(request.headers.has('range')).toBe(false);
      expect(request.headers.get('if-none-match')).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=2-4', 'cache-control': 'no-cache' },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('234');
  });

  it('slices an eligible full replacement after revalidation', async () => {
    const cache = createHttpCache(new AgeAwareStore(), {
      conditionalRevalidation: true,
    });
    await seed(cache);
    const origin = vi.fn(async (request: Request) => {
      expect(request.headers.has('range')).toBe(false);
      return new Response('abcdefghij', {
        headers: {
          'cache-control': 's-maxage=3600',
          'content-length': '10',
          etag: '"v2"',
        },
      });
    });
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: { range: 'bytes=2-4', 'cache-control': 'no-cache' },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('cde');
  });

  it('removes Range for unconditional complete-entry revalidation too', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    await seed(cache);
    const origin = vi.fn(async (request: Request) => {
      expect(request.headers.has('range')).toBe(false);
      expect(request.headers.has('if-range')).toBe(false);
      return full();
    });
    const response = await serve(
      cache.handle(
        new Request(url, {
          headers: {
            range: 'bytes=5-6',
            'if-range': '"v1"',
            'cache-control': 'no-cache',
          },
        }),
        origin
      )
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('56');
  });

  it('serves stale-while-revalidate ranges while refreshing the complete entry', async () => {
    const store = new AgeAwareStore();
    const cache = createHttpCache(store, { conditionalRevalidation: true });
    const initial = vi.fn(async () =>
      full({ 'cache-control': 's-maxage=0, stale-while-revalidate=100' })
    );
    await serve(cache.handle(new Request(url), initial));
    const ctx = new TestExecutionCtx();
    const refresh = vi.fn(async (request: Request) => {
      expect(request.headers.has('range')).toBe(false);
      return new Response(null, {
        status: 304,
        headers: { 'cache-control': 's-maxage=3600' },
      });
    });
    const response = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=-2' } }),
        refresh,
        ctx
      )
    );
    expect(response.cacheStatus.decision).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    expect(await response.text()).toBe('89');
    await ctx.settle();
  });

  it('serves a stale-if-error range after an origin failure', async () => {
    const cache = createHttpCache(new AgeAwareStore());
    await seed(
      cache,
      vi.fn(async () =>
        full({ 'cache-control': 's-maxage=0, stale-if-error=100' })
      )
    );
    const response = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=7-' } }),
        vi.fn(async () => new Response('failure', { status: 500 }))
      )
    );
    expect(response.status).toBe(206);
    expect(response.cacheStatus.decision).toBe(CacheDecision.STALE_IF_ERROR);
    expect(await response.text()).toBe('789');
  });

  it('neutralizes a range-aware store by removing lookup Range headers', async () => {
    const backing = new AgeAwareStore();
    let lookupRange: string | null | undefined;
    const store: CacheStore = {
      async match(request) {
        lookupRange = request.headers.get('range');
        return backing.match(request);
      },
      put: (request, response) => backing.put(request, response),
      delete: request => backing.delete(request),
    };
    const cache = createHttpCache(store);
    const origin = await seed(cache);
    const response = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=3-4' } }),
        origin
      )
    );
    expect(lookupRange).toBeNull();
    expect(await response.text()).toBe('34');
  });

  it('cancels after the selected end and errors on premature EOF', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('01'));
        controller.enqueue(new TextEncoder().encode('2345'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, {
      headers: {
        'content-length': '10',
        'x-cache-internal-control': 's-maxage=3600, public',
      },
    });
    const store: CacheStore = {
      match: async () => response,
      put: async () => {},
      delete: async () => false,
    };
    const cache = createHttpCache(store);
    const selected = await serve(
      cache.handle(
        new Request(url, { headers: { range: 'bytes=1-3' } }),
        async () => full()
      )
    );
    expect(await selected.text()).toBe('123');
    expect(cancelled).toBe(true);

    const shortStore: CacheStore = {
      match: async () =>
        new Response('01', {
          headers: {
            'content-length': '10',
            'x-cache-internal-control': 's-maxage=3600, public',
          },
        }),
      put: async () => {},
      delete: async () => false,
    };
    const truncated = await serve(
      createHttpCache(shortStore).handle(
        new Request(url, { headers: { range: 'bytes=1-4' } }),
        async () => full()
      )
    );
    await expect(truncated.text()).rejects.toThrow(/Content-Length/);
  });
});

describe('Range storage safety', () => {
  it.each(['Range', 'rAnGe', 'If-Range', 'accept-language, RANGE'])(
    'rejects Vary: %s',
    vary => {
      expect(
        computeStoreDecision(new Request(url), full({ vary }), {})
      ).toBeNull();
    }
  );
});
