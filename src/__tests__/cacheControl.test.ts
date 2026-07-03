import { describe, it, expect } from 'vitest';
import {
  parseCacheControl,
  cacheControlToRequestHeader,
  cacheControlToResponseHeader,
} from '../cacheControl';
import { CacheControl } from '../types';

const EMPTY_CACHE_CONTROL: CacheControl = {
  serverMaxAge: null,
  maxAge: null,
  staleWhileRevalidate: null,
  staleIfError: null,
  noCache: false,
  noStore: false,
  noTransform: false,
  onlyIfCached: false,
  mustRevalidate: false,
  proxyRevalidate: false,
  mustUnderstand: false,
  public: false,
  private: false,
  immutable: false,
  maxStale: null,
  minFresh: null,
};

describe('parseCacheControl', () => {
  it('parses empty header values', () => {
    expect(parseCacheControl('')).toEqual(EMPTY_CACHE_CONTROL);
    expect(parseCacheControl(' ')).toEqual(EMPTY_CACHE_CONTROL);
  });

  it('parses flag directives', () => {
    expect(parseCacheControl('no-cache')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
    expect(parseCacheControl(' no-cache ')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
    expect(
      parseCacheControl(
        'no-store, no-transform, only-if-cached, must-revalidate, must-understand, public, private, immutable'
      )
    ).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noStore: true,
      noTransform: true,
      onlyIfCached: true,
      mustRevalidate: true,
      mustUnderstand: true,
      public: false,
      private: true,
      immutable: true,
    });
  });

  it('differentiates between flag directives correctly', () => {
    const pairings = [
      ['no-cache', 'noCache'],
      ['no-store', 'noStore'],
      ['no-transform', 'noTransform'],
      ['only-if-cached', 'onlyIfCached'],
      ['must-revalidate', 'mustRevalidate'],
      ['proxy-revalidate', 'proxyRevalidate'],
      ['must-understand', 'mustUnderstand'],
      ['public', 'public'],
      ['private', 'private'],
      ['immutable', 'immutable'],
    ] as const;
    for (const [input, output] of pairings) {
      expect(parseCacheControl(input)).toEqual({
        ...EMPTY_CACHE_CONTROL,
        [output]: true,
      });
    }

    // Check that the above pairings are exhaustive
    expect(
      (Object.keys(EMPTY_CACHE_CONTROL) as (keyof typeof EMPTY_CACHE_CONTROL)[])
        .filter(key => typeof EMPTY_CACHE_CONTROL[key] === 'boolean')
        .sort()
    ).toEqual(pairings.map(entry => entry[1]).sort());
  });

  it('parses a single number directive', () => {
    expect(parseCacheControl('max-age=100')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: 100,
    });
    expect(parseCacheControl(' max-age=100 ')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: 100,
    });
    expect(parseCacheControl(' max-age = 100 ')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: 100,
    });
    expect(
      parseCacheControl(
        's-maxage=10, stale-while-revalidate=11, stale-if-error=12, min-fresh=13, max-stale=14'
      )
    ).toEqual({
      ...EMPTY_CACHE_CONTROL,
      serverMaxAge: 10,
      staleWhileRevalidate: 11,
      staleIfError: 12,
      minFresh: 13,
      maxStale: 14,
    });
  });

  it('tolerates a floating point number directive', () => {
    expect(parseCacheControl('max-age=100.5')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: 100,
    });
    // NOTE: Floating point numbers above max safe range are ignored
    expect(
      parseCacheControl(`max-age=${Number.MAX_SAFE_INTEGER + 1}.5`)
    ).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: null,
    });
  });

  it('tolerates a number above MAX_SAFE_INTEGER directive', () => {
    expect(parseCacheControl(`max-age=${Number.MAX_SAFE_INTEGER + 1}`)).toEqual(
      {
        ...EMPTY_CACHE_CONTROL,
        maxAge: Number.MAX_SAFE_INTEGER,
      }
    );
  });

  it('tolerates negative number directives', () => {
    expect(parseCacheControl('max-age=-123')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: -1,
    });
  });

  it('parses a flag directive even if it has a number attached to it', () => {
    expect(parseCacheControl('no-cache=bogus')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
    expect(parseCacheControl('no-cache=10')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
    expect(parseCacheControl('no-cache="test"')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
    expect(parseCacheControl('no-cache=')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
  });

  it('parses flag directives without carrying over parsed values', () => {
    expect(parseCacheControl('max-age=10, s-maxage')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      maxAge: 10,
    });
  });

  it('skips over invalid directives', () => {
    expect(parseCacheControl('!, no-cache')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
    });
  });

  it('stores invalid directives in "unrecognized" property', () => {
    expect(parseCacheControl(', , test, no-cache')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
      unrecognized: 'test',
    });
    expect(parseCacheControl(', , test, bogus=10, no-cache')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
      unrecognized: 'test, bogus=10',
    });
    expect(
      parseCacheControl(', , test, bogus=10, custom = "str", no-cache')
    ).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
      unrecognized: 'test, bogus=10, custom',
    });
    expect(parseCacheControl(', , test, bogus=10, "str", no-cache')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
      unrecognized: 'test, bogus=10',
    });
  });

  it('terminates on an unterminated quoted string', () => {
    // The quote runs to end-of-input; everything after it is consumed.
    expect(parseCacheControl('foo="bar')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      unrecognized: 'foo',
    });
    expect(parseCacheControl('no-cache, foo="bar, max-age=60')).toEqual({
      ...EMPTY_CACHE_CONTROL,
      noCache: true,
      unrecognized: 'foo',
    });
    expect(parseCacheControl('"')).toEqual(EMPTY_CACHE_CONTROL);
  });
});

describe('cacheControlToRequestHeader', () => {
  it('prints only request directives', () => {
    expect(
      cacheControlToRequestHeader({
        serverMaxAge: 10,
        maxAge: 11,
        staleWhileRevalidate: 12,
        staleIfError: 13,
        noCache: true,
        noStore: true,
        noTransform: true,
        onlyIfCached: true,
        mustRevalidate: true,
        proxyRevalidate: true,
        mustUnderstand: true,
        public: true,
        private: true,
        immutable: true,
        maxStale: 14,
        minFresh: 15,
      })
    ).toMatchInlineSnapshot(
      `"max-stale=14, min-fresh=15, only-if-cached, max-age=11, stale-if-error=13, no-cache, no-store, no-transform"`
    );
  });

  it('accepts partial objects to print', () => {
    expect(
      cacheControlToRequestHeader({
        staleIfError: 13,
        noCache: true,
      })
    ).toMatchInlineSnapshot(`"stale-if-error=13, no-cache"`);
  });

  it('prints a single or no directive correctly', () => {
    expect(cacheControlToRequestHeader({ noCache: true })).toBe('no-cache');
    expect(cacheControlToRequestHeader({})).toBe('');
  });
});

describe('cacheControlToResponseHeader', () => {
  it('prints only request directives', () => {
    expect(
      cacheControlToResponseHeader({
        serverMaxAge: 10,
        maxAge: 11,
        staleWhileRevalidate: 12,
        staleIfError: 13,
        noCache: true,
        noStore: true,
        noTransform: true,
        onlyIfCached: true,
        mustRevalidate: true,
        proxyRevalidate: true,
        mustUnderstand: true,
        public: true,
        private: true,
        immutable: true,
        maxStale: 14,
        minFresh: 15,
      })
    ).toMatchInlineSnapshot(
      `"s-maxage=10, stale-while-revalidate=12, must-revalidate, proxy-revalidate, must-understand, private, public, immutable, max-age=11, stale-if-error=13, no-cache, no-store, no-transform"`
    );
  });

  it('prints unrecognized part', () => {
    expect(
      cacheControlToResponseHeader({
        serverMaxAge: 10,
        maxAge: 11,
        unrecognized: 'test',
      })
    ).toMatchInlineSnapshot(`"s-maxage=10, test, max-age=11"`);
  });

  it('accepts partial objects to print', () => {
    expect(
      cacheControlToResponseHeader({
        staleWhileRevalidate: 12,
        mustRevalidate: true,
      })
    ).toMatchInlineSnapshot(`"stale-while-revalidate=12, must-revalidate"`);
  });

  it('prints a single or no directive correctly', () => {
    expect(cacheControlToResponseHeader({ private: true })).toBe('private');
    expect(cacheControlToRequestHeader({})).toBe('');
  });
});
