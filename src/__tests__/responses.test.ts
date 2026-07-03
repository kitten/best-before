import { describe, it, expect } from 'vitest';
import { parseCacheControl } from '../cacheControl';
import {
  makeStoreResponse,
  makeServeResponse,
  make304Response,
  deriveAge,
} from '../responses';
import { CacheDecision } from '../cacheDecision';

const url = 'https://test.com/x';
const decision = CacheDecision.HIT;

describe('deriveAge', () => {
  it('prefers the Age header, else derives from Date, and clamps to >= 0', () => {
    expect(deriveAge(new Headers({ age: '42' }))).toBe(42);

    const past = new Date(Date.now() - 100_000).toUTCString();
    expect(deriveAge(new Headers({ date: past }))).toBeGreaterThanOrEqual(99);

    // Unparseable Date is ignored; a negative Age clamps to 0.
    expect(deriveAge(new Headers({ date: 'not-a-date' }))).toBe(0);
    expect(deriveAge(new Headers({ age: '-5' }))).toBe(0);
  });
});

describe('makeStoreResponse', () => {
  it('persists output as Cache-Control and input as the internal directive', () => {
    const stored = makeStoreResponse(
      new Request(url),
      new Response('body', { headers: { 'cache-control': 'max-age=60' } }),
      parseCacheControl('public, max-age=60'),
      parseCacheControl('s-maxage=60, public, max-age=60')
    );
    expect(stored.headers.get('cache-control')).toBe(
      's-maxage=60, public, max-age=60'
    );
    expect(stored.headers.get('x-cache-internal-control')).toBe(
      'public, max-age=60'
    );
    // The origin's client-facing Cache-Control is preserved for later restoration on serve.
    expect(stored.headers.get('x-cache-original-control')).toBe('max-age=60');
  });

  it('drops the CDN tiers and Expires from the stored entry', () => {
    const stored = makeStoreResponse(
      new Request(url),
      new Response('body', {
        headers: {
          'cdn-cache-control': 's-maxage=3600',
          'cache-control': 'max-age=60',
          expires: 'Wed, 02 Jul 2025 00:00:00 GMT',
        },
      }),
      parseCacheControl('public, s-maxage=3600'),
      parseCacheControl('s-maxage=3600, public, max-age=3600')
    );
    expect(stored.headers.has('cdn-cache-control')).toBe(false);
    expect(stored.headers.has('expires')).toBe(false);
    // The client-facing `cache-control` the origin sent is retained as the "original".
    expect(stored.headers.get('x-cache-original-control')).toBe('max-age=60');
  });

  it('varies a stored OPTIONS preflight on the CORS request headers', () => {
    const stored = makeStoreResponse(
      new Request(url, { method: 'OPTIONS' }),
      new Response(null, {
        status: 204,
        headers: { 'access-control-max-age': '3600' },
      }),
      parseCacheControl('public, max-age=3600'),
      parseCacheControl('s-maxage=3600, public, max-age=3600')
    );
    expect(stored.headers.get('vary')).toBe(
      'access-control-request-headers, access-control-request-method'
    );
  });

  it('does not duplicate CORS Vary values already present (re-store of a freshened entry)', () => {
    const stored = makeStoreResponse(
      new Request(url, { method: 'OPTIONS' }),
      new Response(null, {
        status: 204,
        headers: {
          'access-control-max-age': '3600',
          vary: 'Access-Control-Request-Headers, access-control-request-method',
        },
      }),
      parseCacheControl('public, max-age=3600'),
      parseCacheControl('s-maxage=3600, public, max-age=3600')
    );
    expect(stored.headers.get('vary')).toBe(
      'Access-Control-Request-Headers, access-control-request-method'
    );
  });

  it('does not add a CORS Vary for non-OPTIONS requests', () => {
    const stored = makeStoreResponse(
      new Request(url),
      new Response('body', { headers: { 'cache-control': 'max-age=60' } }),
      parseCacheControl('public, max-age=60'),
      parseCacheControl('s-maxage=60, public, max-age=60')
    );
    expect(stored.headers.has('vary')).toBe(false);
  });
});

describe('makeServeResponse', () => {
  it('restores the origin Cache-Control and strips internal + CDN-only headers on a stored entry', () => {
    // A stored entry carries the internal bookkeeping headers and a munged `cache-control`.
    const storedEntry = new Response('body', {
      headers: {
        'cache-control': 's-maxage=3600, public, max-age=3600',
        'x-cache-internal-control': 'public, s-maxage=3600',
        'x-cache-original-control': 'max-age=60',
        'cdn-cache-control': 's-maxage=3600',
      },
    });
    const served = makeServeResponse(storedEntry, decision);
    // Restored to the origin's client-facing value — never the internal directive.
    expect(served.headers.get('cache-control')).toBe('max-age=60');
    expect(served.headers.has('x-cache-internal-control')).toBe(false);
    expect(served.headers.has('x-cache-original-control')).toBe(false);
    expect(served.headers.has('cdn-cache-control')).toBe(false);
  });

  it('drops Cache-Control entirely for a stored entry whose origin sent none (leak fix)', () => {
    // e.g. an immutable 301 or an Expires/CORS-derived entry: no original to restore.
    const storedEntry = new Response('body', {
      headers: {
        'cache-control': 's-maxage=31536000, public, max-age=31536000',
        'x-cache-internal-control': 'immutable',
      },
    });
    const served = makeServeResponse(storedEntry, decision);
    expect(served.headers.has('cache-control')).toBe(false);
    expect(served.headers.has('x-cache-internal-control')).toBe(false);
  });

  it('leaves a fresh origin response Cache-Control untouched but still strips the CDN-only tier', () => {
    const fresh = new Response('body', {
      headers: {
        'cache-control': 'max-age=60',
        'cdn-cache-control': 's-maxage=3600',
      },
    });
    const served = makeServeResponse(fresh, decision);
    expect(served.headers.get('cache-control')).toBe('max-age=60');
    expect(served.headers.has('cdn-cache-control')).toBe(false);
  });
});

describe('make304Response', () => {
  it('produces an empty 304 with validators but no body or Content-Length', async () => {
    const storedEntry = new Response('cached-body', {
      status: 200,
      headers: {
        'cache-control': 's-maxage=3600, public, max-age=3600',
        'x-cache-internal-control': 'public, s-maxage=3600',
        'x-cache-original-control': 'max-age=60',
        'content-length': '11',
        etag: '"v1"',
      },
    });
    const notModified = make304Response(storedEntry, decision);
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(notModified.headers.has('content-length')).toBe(false);
    expect(notModified.headers.get('etag')).toBe('"v1"');
    // Internal bookkeeping stripped, original restored — the 304 must not leak internals either.
    expect(notModified.headers.has('x-cache-internal-control')).toBe(false);
    expect(notModified.headers.get('cache-control')).toBe('max-age=60');
  });
});
