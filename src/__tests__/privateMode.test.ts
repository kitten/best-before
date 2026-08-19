import { describe, it, expect } from 'vitest';
import {
  parseCacheControl,
  cacheControlToResponseHeader,
} from '../cacheControl';
import { CacheControl } from '../types';
import { CacheDecision, computeCacheDecision } from '../cacheDecision';
import { computeStoreDecision } from '../storeDecision';

const url = new URL('https://test.com/x');

const decide = (
  clientHeader: string | null,
  entryHeader: string | null,
  age = 0,
  shared = true
): CacheDecision => {
  const client: CacheControl = parseCacheControl(clientHeader);
  const cacheControl: CacheControl = parseCacheControl(entryHeader);
  return computeCacheDecision(client, cacheControl, age, { shared });
};

const storeOutput = (
  request: Request,
  response: Response,
  shared = true,
  requireSharedDirective = true
): string | null => {
  const decision = computeStoreDecision(request, response, {
    shared,
    requireSharedDirective,
  });
  return decision ? cacheControlToResponseHeader(decision.output) : null;
};

describe('private cache mode — computeCacheDecision', () => {
  it('serves a bare max-age (no public/s-maxage) that shared mode would miss', () => {
    // A bare max-age entry is a miss in shared mode (not shared-cacheable), a hit in private.
    expect(decide(null, 'max-age=4200', 1000, true)).toBe(CacheDecision.MISS);
    expect(decide(null, 'max-age=4200', 1000, false)).toBe(CacheDecision.HIT);
  });

  it('ignores s-maxage in private mode (max-age governs)', () => {
    // shared: s-maxage=0 → stale → MISS; private: ignores s-maxage, max-age=3600 → HIT.
    expect(decide(null, 's-maxage=0, max-age=3600', 100, true)).toBe(
      CacheDecision.MISS
    );
    expect(decide(null, 's-maxage=0, max-age=3600', 100, false)).toBe(
      CacheDecision.HIT
    );
  });

  it('serves private responses in private mode but not shared', () => {
    expect(decide(null, 'private, max-age=3600', 100, true)).toBe(
      CacheDecision.MISS
    );
    expect(decide(null, 'private, max-age=3600', 100, false)).toBe(
      CacheDecision.HIT
    );
  });

  it('ignores proxy-revalidate in private mode', () => {
    // shared: stale + proxy-revalidate → MISS. private: proxy-revalidate ignored, and with no
    // stale window the stale entry still misses — so use an swr window to show it is honored.
    expect(
      decide(
        null,
        'max-age=0, stale-while-revalidate=100, proxy-revalidate',
        10,
        true
      )
    ).toBe(CacheDecision.MISS);
    expect(
      decide(
        null,
        'max-age=0, stale-while-revalidate=100, proxy-revalidate',
        10,
        false
      )
    ).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
  });

  it('still honors must-revalidate in private mode', () => {
    expect(decide(null, 'max-age=0, must-revalidate', 10, false)).toBe(
      CacheDecision.MISS
    );
  });

  it('treats a private entry without max-age as immediately stale', () => {
    // No max-age → lifetime 0; the swr window still applies from age 0.
    expect(decide(null, 'stale-while-revalidate=100', 50, false)).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
  });
});

describe('private cache mode — computeStoreDecision', () => {
  it('stores a bare max-age response as a plain private entry', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=3600' },
    });
    // Shared default: not stored (requireSharedDirective treats a bare max-age as private).
    expect(storeOutput(request, response, true)).toBe(null);
    // Shared with requireSharedDirective off: promoted to public/s-maxage.
    expect(storeOutput(request, response, true, false)).toBe(
      's-maxage=3600, public, max-age=3600'
    );
    // Private: keeps a plain browser-style max-age (the flag is a no-op here).
    expect(storeOutput(request, response, false)).toBe('max-age=3600');
  });

  it('stores private responses only in private mode', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'private, max-age=3600' },
    });
    expect(storeOutput(request, response, true)).toBe(null);
    expect(storeOutput(request, response, false)).toBe('max-age=3600');
  });

  it('caches Authorization requests in private mode (single-user store)', () => {
    const request = new Request(url, {
      headers: { authorization: 'Bearer x' },
    });
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=3600' },
    });
    expect(storeOutput(request, response, true)).toBe(null);
    expect(storeOutput(request, response, false)).toBe('max-age=3600');
  });

  it('does not store an s-maxage-only response in private mode', () => {
    // Private caches ignore s-maxage; without max-age there is nothing to store.
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 's-maxage=3600' },
    });
    expect(storeOutput(request, response, true)).toBe(
      's-maxage=3600, public, max-age=3600'
    );
    expect(storeOutput(request, response, false)).toBe(null);
  });

  it('never stores no-store in either mode', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=3600, no-store' },
    });
    expect(storeOutput(request, response, true)).toBe(null);
    expect(storeOutput(request, response, false)).toBe(null);
  });

  it('stores no-cache in private mode and eligible shared mode', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=3600, no-cache', etag: '"v1"' },
    });
    expect(storeOutput(request, response, true)).toBe(null);
    expect(storeOutput(request, response, true, false)).toBe(null);
    expect(storeOutput(request, response, false)).toBe('max-age=86400');
  });

  it('keeps must-revalidate on a private entry', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=100, must-revalidate' },
    });
    expect(storeOutput(request, response, false)).toBe(
      'must-revalidate, max-age=100'
    );
  });

  it('stores an immutable private entry with the immutable window', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'immutable' },
    });
    expect(storeOutput(request, response, false)).toBe(
      'immutable, max-age=31536000'
    );
  });

  it('folds the stale-while-revalidate window into a private entry max-age', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=100, stale-while-revalidate=50' },
    });
    expect(storeOutput(request, response, false)).toBe('max-age=150');
  });

  it('folds the stale-if-error window into a private entry max-age', () => {
    const request = new Request(url);
    const response = new Response('body', {
      headers: { 'cache-control': 'max-age=100, stale-if-error=50' },
    });
    expect(storeOutput(request, response, false)).toBe('max-age=150');
  });
});
