import { describe, it, expect } from 'vitest';
import { cacheControlToResponseHeader } from '../cacheControl';
import {
  computeStoreDecision,
  getResponseCacheControl,
} from '../storeDecision';

const url = new URL('https://test.com/my/test/route');

describe('getResponseCacheControl', () => {
  it('ignores gateway timeouts', () => {
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, { status: 504 })
      )
    ).toBe(null);
  });

  it('marks permanent redirects as immutably cached', () => {
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, { status: 301 })
      )
    ).toMatchObject({ public: false, immutable: true });
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, { status: 308 })
      )
    ).toMatchObject({ public: false, immutable: true });
  });

  it('parses Cache-Control from header', () => {
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'Cache-Control': 'private' },
        })
      )
    ).toMatchObject({ public: false, private: true });
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, { status: 200 })
      )
    ).toBe(null);
  });

  it('forces public flag on CDN-Cache-Control headers', () => {
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'CDN-Cache-Control': 'must-revalidate' },
        })
      )
    ).toMatchObject({ public: true, mustRevalidate: true });
  });

  it('falls back to Expires header', () => {
    const futureDate = new Date(Date.now() + 10_000);
    expect(
      getResponseCacheControl(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { Expires: futureDate.toISOString() },
        })
      )
    ).toMatchObject({ maxAge: expect.any(Number) });
  });

  it('falls back to CORS Max-Age for OPTIONS requests', () => {
    expect(
      getResponseCacheControl(
        new Request(url, { method: 'OPTIONS' }),
        new Response(null, {
          status: 200,
          headers: { 'Access-Control-Max-Age': '3600' },
        })
      )
    ).toMatchObject({ maxAge: 3600 });
  });
});

describe('computeStoreDecision', () => {
  const _computeStoreDecision = (
    request: Request,
    response: Response,
    options: { shared?: boolean; requireSharedDirective?: boolean } = {}
  ) => {
    const output = computeStoreDecision(request, response, options);
    return {
      input: output?.input ? cacheControlToResponseHeader(output.input) : null,
      output: output?.output
        ? cacheControlToResponseHeader(output.output)
        : null,
    };
  };

  it('does not shared-cache a bare max-age by default (requireSharedDirective)', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'max-age=3600' },
        })
      ).output
    ).toBe(null);
  });

  it('defaults a bare-max-age GET to public with requireSharedDirective: false', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'max-age=3600' },
        }),
        { requireSharedDirective: false }
      ).output
    ).toBe('s-maxage=3600, public, max-age=3600');

    // Authorization is never shared-cached on a bare max-age, either way.
    expect(
      _computeStoreDecision(
        new Request(url, { headers: { Authorization: 'something' } }),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'max-age=3600' },
        }),
        { requireSharedDirective: false }
      ).output
    ).toBe(null);
  });

  it('does not cache on 304 Not Modified responses', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 304,
          headers: { 'cache-control': 's-maxage=3600' },
        })
      ).output
    ).toBe(null);
  });

  it('does not cache 206 Partial Content responses', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response('partial', {
          status: 206,
          headers: { 'cache-control': 's-maxage=3600' },
        })
      ).output
    ).toBe(null);
  });

  it('does not cache responses with Vary: *', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 's-maxage=3600', vary: '*' },
        })
      ).output
    ).toBe(null);
  });

  it.each([
    'Range',
    'If-Range',
    'If-None-Match',
    'If-Modified-Since',
    'Accept-Language, IF-NONE-MATCH',
  ])('does not cache responses varying on normalized lookup field %s', vary => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 's-maxage=3600', vary },
        })
      ).output
    ).toBeNull();
  });

  it('does not cache responses that set cookies', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: {
            'cache-control': 's-maxage=3600',
            'set-cookie': 'session=abc',
          },
        })
      ).output
    ).toBe(null);
  });

  it('does not cache on private or no-store', () => {
    for (const directive of ['private', 'no-store']) {
      expect(
        _computeStoreDecision(
          new Request(url),
          new Response(null, {
            status: 200,
            headers: { 'cache-control': 's-maxage=3600, ' + directive },
          })
        ).output
      ).toBe(null);
    }
  });

  it('requires a shared directive before storing no-cache by default', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-cache' },
        })
      ).output
    ).toBe(null);

    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'public, no-cache' },
        })
      )
    ).toEqual({
      input: 'public, no-cache',
      output: 's-maxage=86400, public, max-age=86400',
    });

    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-cache' },
        }),
        { requireSharedDirective: false }
      )
    ).toEqual({
      input: 'public, no-cache',
      output: 's-maxage=86400, public, max-age=86400',
    });

    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-cache' },
        }),
        { shared: false }
      )
    ).toEqual({ input: 'no-cache', output: 'max-age=86400' });
  });

  it('does not shared-cache bare no-cache for an authorized request', () => {
    expect(
      _computeStoreDecision(
        new Request(url, { headers: { authorization: 'Bearer secret' } }),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'no-cache' },
        })
      ).output
    ).toBe(null);
  });

  it('overrides max-age for immutable output', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'immutable' },
        })
      ).output
    ).toBe('s-maxage=31536000, public, max-age=31536000');
  });

  it('respects s-maxage', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 's-maxage=3600' },
        })
      ).output
    ).toBe('s-maxage=3600, public, max-age=3600');
  });

  it('adds must-revalidate directive', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'max-age=3600, must-revalidate' },
        })
      ).output
    ).toBe('s-maxage=3600, must-revalidate, public, max-age=3600');
  });

  it('adds stale-if-error time', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 's-maxage=3600, stale-if-error=5' },
        })
      ).output
    ).toBe('s-maxage=3605, public, max-age=3605');
  });

  it('adds stale-while-revalidate time', () => {
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: {
            'cache-control': 's-maxage=3600, stale-while-revalidate=5',
          },
        })
      ).output
    ).toBe('s-maxage=3605, public, max-age=3605');
  });

  it('preserves no-transform on the stored entry', () => {
    // best-before never transforms bodies, but must carry no-transform through so the
    // underlying store (and any downstream cache) still honors it.
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 's-maxage=3600, no-transform' },
        })
      ).output
    ).toBe('s-maxage=3600, public, max-age=3600, no-transform');
  });

  it('does not store a bare must-understand response (no freshness signal)', () => {
    // must-understand alone grants no cacheability; without a freshness directive there is
    // nothing to store.
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: { 'cache-control': 'must-understand' },
        })
      ).output
    ).toBe(null);
  });

  it('does not store no-store even when paired with must-understand (conservative)', () => {
    // RFC 9111 §5.2.2.3 lets must-understand relax no-store for understood status codes.
    // best-before does not implement that relaxation, so it stays on the safe side and never
    // stores a no-store response — it can only under-cache here, never over-cache.
    expect(
      _computeStoreDecision(
        new Request(url),
        new Response(null, {
          status: 200,
          headers: {
            'cache-control': 'no-store, must-understand, max-age=3600',
          },
        })
      ).output
    ).toBe(null);
  });
});
