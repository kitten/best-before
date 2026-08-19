export const IMMUTABLE_MAX_AGE = 31536000;
export const REVALIDATION_MAX_AGE = 86400;

export const MAX_CACHEABLE_BODY_SIZE = 1e6; // 1MB

export const INTERNAL_CACHE_CONTROL = 'x-cache-internal-control';
export const ORIGINAL_CACHE_CONTROL = 'x-cache-original-control';

export const DATE_HEADER = 'date';

export const PUBLIC_CACHE_CONTROL = 'cache-control';
export const CDN_CACHE_CONTROL = 'cdn-cache-control';
export const EXPIRES_HEADER = 'expires';
export const AGE_HEADER = 'age';
export const VARY_HEADER = 'vary';
export const SET_COOKIE_HEADER = 'set-cookie';
export const CORS_MAX_AGE_HEADER = 'access-control-max-age';

export const CDN_CACHE_CONTROL_HEADERS = [
  CDN_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
] as const;

export const CDN_ONLY_CACHE_CONTROL_HEADERS = [CDN_CACHE_CONTROL] as const;

export const CORS_HEADERS = [
  'access-control-request-headers',
  'access-control-request-method',
] as const;

/** Request fields evaluated by the library rather than by `CacheStore.match`. */
export const CACHE_LOOKUP_IGNORED_HEADERS = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
] as const;
