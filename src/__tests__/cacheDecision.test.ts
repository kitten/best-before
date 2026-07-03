import { describe, it, expect } from 'vitest';
import { parseCacheControl } from '../cacheControl';
import { CacheControl, CacheDecisionOptions } from '../types';
import {
  CacheDecision,
  computeCacheDecision,
  isErrorResponse,
  isRequestCacheable,
} from '../cacheDecision';

/** Mirrors the orchestrator's plumbing: parse the client directives, and derive the entry's
 * governing Cache-Control + age from what would be a stored response. */
const decide = (
  clientHeader: string | null,
  entryHeader: string | null,
  age = 0,
  options: CacheDecisionOptions = {}
): CacheDecision => {
  const client: CacheControl = parseCacheControl(clientHeader);
  const cacheControl: CacheControl = parseCacheControl(entryHeader);
  return computeCacheDecision(client, cacheControl, age, options);
};

describe('computeCacheDecision', () => {
  it('misses on private / no-store / no-cache entries', () => {
    for (const directive of ['private', 'no-store', 'no-cache']) {
      expect(decide(null, directive)).toBe(CacheDecision.MISS);
    }
  });

  it('misses (request) on no-store / no-cache client directives', () => {
    for (const directive of ['no-store', 'no-cache']) {
      expect(decide(directive, 'public, max-age=3600')).toBe(
        CacheDecision.MISS_REQUEST
      );
    }
  });

  it('regards immutable responses as cache hits', () => {
    expect(decide(null, 'immutable')).toBe(CacheDecision.HIT);
  });

  it('returns MISS_TIMEOUT on a cache miss when only-if-cached is set', () => {
    expect(decide('only-if-cached', 'immutable')).toBe(CacheDecision.HIT);
    expect(decide('only-if-cached', null)).toBe(CacheDecision.MISS_TIMEOUT);
  });

  it('prefers s-maxage over max-age', () => {
    expect(decide(null, 'public, s-maxage=3000, max-age=4200', 3600)).toBe(
      CacheDecision.MISS
    );
    expect(decide(null, 'public, s-maxage=4200', 3600)).toBe(CacheDecision.HIT);
  });

  it('uses max-age only when public is set', () => {
    expect(decide(null, 'max-age=4200', 3600)).toBe(CacheDecision.MISS);
    expect(decide(null, 'public, max-age=4200', 3600)).toBe(CacheDecision.HIT);
  });

  it('handles negative max-age values as a MISS immediately', () => {
    expect(decide(null, 'public, max-age=-1', 3600)).toBe(CacheDecision.MISS);
  });

  it('respects min-fresh request directive', () => {
    expect(decide('min-fresh=1800', 'public, max-age=4200', 3600)).toBe(
      CacheDecision.MISS_REQUEST
    );
  });

  it('applies min-fresh against remaining freshness, not elapsed age (fixed semantics)', () => {
    // These cases distinguish the fix (`max-age - age < min-fresh`) from the original bug
    // (`age > min-fresh`), which diverge when age is between min-fresh and max-age - min-fresh.

    // Remaining freshness = 4200 - 2000 = 2200 >= 1800 → acceptable → HIT.
    // (Buggy `age > min-fresh` would be 2000 > 1800 → MISS_REQUEST.)
    expect(decide('min-fresh=1800', 'public, max-age=4200', 2000)).toBe(
      CacheDecision.HIT
    );

    // Remaining freshness = 2000 - 1000 = 1000 < 1500 → unacceptable → MISS_REQUEST.
    // (Buggy `age > min-fresh` would be 1000 > 1500 → HIT, wrongly serving it.)
    expect(decide('min-fresh=1500', 'public, max-age=2000', 1000)).toBe(
      CacheDecision.MISS_REQUEST
    );
  });

  it('respects max-age request client directive', () => {
    expect(decide('max-age=1800', 'max-age=4200', 3600)).toBe(
      CacheDecision.MISS
    );
  });

  it('respects max-age request client directive set to zero', () => {
    expect(decide('max-age=0', 'max-age=4200', 3600)).toBe(
      CacheDecision.MISS_REQUEST
    );
  });

  it('applies stale-if-error time', () => {
    expect(decide(null, 's-maxage=120, stale-if-error=4200', 3600)).toBe(
      CacheDecision.STALE_IF_ERROR
    );
  });

  it('applies stale-if-error request directive', () => {
    expect(
      decide('stale-if-error=1800', 's-maxage=120, stale-if-error=4200', 3600)
    ).toBe(CacheDecision.MISS_REQUEST);
  });

  it('keeps stale-if-error resilience when the client only sends max-age', () => {
    // A client `max-age` forfeits proactive SWR staleness (see the SWR tests), but must
    // not disable error masking: stale-if-error only kicks in when the origin errors.
    expect(
      decide('max-age=200', 's-maxage=120, stale-if-error=4200', 3600)
    ).toBe(CacheDecision.STALE_IF_ERROR);
  });

  it('measures the stale-if-error window from the entry, not a small client max-age', () => {
    // Entry SIE window is s-maxage(100) + stale-if-error(100) = 200; age 150 is inside it.
    // A client `max-age=50` must not re-base the window to 50+100=150 and collapse it — the
    // client only narrows what is *fresh*, not the entry's error grant.
    const entry = 's-maxage=100, stale-if-error=100';
    expect(decide(null, entry, 150)).toBe(CacheDecision.STALE_IF_ERROR);
    expect(decide('max-age=50', entry, 150)).toBe(CacheDecision.STALE_IF_ERROR);
    // A client stale-if-error still bounds it (150 > 100 + 40).
    expect(decide('max-age=50, stale-if-error=40', entry, 150)).toBe(
      CacheDecision.MISS_REQUEST
    );
  });

  it('measures the stale-while-revalidate window from the entry, not a client max-age', () => {
    // Entry SWR window is s-maxage(100) + swr(100) = 200; age 150 is inside it. A permissive
    // client max-stale keeps it servable, measured from the entry's lifetime (not client max-age).
    const entry = 's-maxage=100, stale-while-revalidate=100';
    expect(decide('max-age=50, max-stale=100', entry, 150)).toBe(
      CacheDecision.STALE_WHILE_REVALIDATE
    );
    // ...but a tight client max-stale (150 > 100 + 30) still forces revalidation.
    expect(decide('max-age=50, max-stale=30', entry, 150)).toBe(
      CacheDecision.MISS_REQUEST
    );
  });

  it('applies stale-while-revalidate directive', () => {
    expect(
      decide(null, 's-maxage=120, stale-while-revalidate=4200', 3600)
    ).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
  });

  it('overrides stale-while-revalidate directive with must-revalidate', () => {
    expect(
      decide(
        null,
        's-maxage=120, stale-while-revalidate=4200, proxy-revalidate',
        3600
      )
    ).toBe(CacheDecision.MISS);
  });

  it('applies stale-while-revalidate over stale-if-error if both are present', () => {
    expect(
      decide(null, 'stale-while-revalidate=1600, stale-if-error=1800', 1400)
    ).toBe(CacheDecision.STALE_WHILE_REVALIDATE);
  });

  it('respects max-stale request directive', () => {
    expect(
      decide(
        'max-stale=1',
        'public, s-maxage=120, stale-while-revalidate=4200',
        3600
      )
    ).toBe(CacheDecision.MISS_REQUEST);
  });

  it('returns a miss by default', () => {
    expect(
      decide(
        null,
        'public, s-maxage=120, stale-if-error=60, stale-while-revalidate=120',
        3600
      )
    ).toBe(CacheDecision.MISS);
  });

  describe('option gating', () => {
    it('ignores client cache-busting when clientCacheBypass is false', () => {
      expect(
        decide('max-age=0', 'public, max-age=4200', 0, {
          clientCacheBypass: false,
        })
      ).toBe(CacheDecision.HIT);
      expect(
        decide('no-cache', 'public, max-age=4200', 0, {
          clientCacheBypass: false,
        })
      ).toBe(CacheDecision.HIT);
    });

    it('degrades stale-while-revalidate to a miss when disabled', () => {
      expect(
        decide(null, 's-maxage=120, stale-while-revalidate=4200', 3600, {
          staleWhileRevalidate: false,
        })
      ).toBe(CacheDecision.MISS);
    });

    it('degrades stale-if-error to a miss when disabled', () => {
      expect(
        decide(null, 's-maxage=120, stale-if-error=4200', 3600, {
          staleIfError: false,
        })
      ).toBe(CacheDecision.MISS);
    });

    it('ignores only-if-cached when disabled', () => {
      expect(decide('only-if-cached', null, 0, { onlyIfCached: false })).toBe(
        CacheDecision.MISS
      );
    });
  });
});

describe('isErrorResponse', () => {
  it('treats 429 and 5xx (except 501) as errors', () => {
    for (const status of [429, 500, 502, 503, 504, 521, 599]) {
      expect(isErrorResponse(new Response(null, { status }))).toBe(true);
    }
    for (const status of [200, 400, 404, 501]) {
      expect(isErrorResponse(new Response(null, { status }))).toBe(false);
    }
  });
});

describe('isRequestCacheable', () => {
  it('bypasses mutating methods', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        isRequestCacheable(new Request('https://x.test', { method }))
      ).toBe(false);
    }
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      expect(
        isRequestCacheable(new Request('https://x.test', { method }))
      ).toBe(true);
    }
  });
});
