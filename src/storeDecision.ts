import { makeDefaultCacheControl, parseCacheControl } from './cacheControl';
import {
  CDN_CACHE_CONTROL_HEADERS,
  CORS_MAX_AGE_HEADER,
  EXPIRES_HEADER,
  IMMUTABLE_MAX_AGE,
  PUBLIC_CACHE_CONTROL,
  SET_COOKIE_HEADER,
  VARY_HEADER,
} from './constants';
import type {
  CacheControl,
  ResponseLike,
  StoreDecision,
  StoreDecisionOptions,
} from './types';

const getResponseCORSMaxAge = (response: ResponseLike): number =>
  parseInt(response.headers.get(CORS_MAX_AGE_HEADER) || '0', 10) || 0;

function getResponseExpires(response: ResponseLike): number {
  const expires = response.headers.get(EXPIRES_HEADER)?.trim() || '0';
  if (!expires || expires === '0') {
    return 0;
  }
  const delta = Math.floor((new Date(expires).valueOf() - Date.now()) / 1000);
  return Math.max(Math.min(IMMUTABLE_MAX_AGE, delta), 0);
}

/** Whether the response carries any caching-policy header */
export function hasResponseCachePolicy(
  request: Request,
  response: ResponseLike
): boolean {
  for (const headerName of CDN_CACHE_CONTROL_HEADERS) {
    if (response.headers.has(headerName)) return true;
  }
  return request.method === 'OPTIONS'
    ? response.headers.has(CORS_MAX_AGE_HEADER)
    : response.headers.has(EXPIRES_HEADER);
}

export function getResponseCacheControl(
  request: Request,
  response: ResponseLike
): CacheControl | null {
  if (response.status === 504) {
    return null;
  } else if (response.status === 301 || response.status === 308) {
    // Permanent redirects are immutable
    const result = makeDefaultCacheControl();
    result.immutable = true;
    return result;
  }

  let forcePublic = false;
  let cacheControl: string | null = null;
  for (const headerName of CDN_CACHE_CONTROL_HEADERS) {
    if ((cacheControl = response.headers.get(headerName)) != null) {
      forcePublic = headerName !== PUBLIC_CACHE_CONTROL;
      break;
    }
  }

  if (cacheControl) {
    const parsed = parseCacheControl(cacheControl);
    // A CDN-specific caching header forces public
    parsed.public = parsed.public || forcePublic;
    return parsed;
  } else if (request.method === 'OPTIONS') {
    const maxAge = getResponseCORSMaxAge(response);
    if (maxAge) {
      const result = makeDefaultCacheControl();
      result.maxAge = maxAge;
      result.public = true;
      return result;
    }
  } else {
    const expires = getResponseExpires(response);
    if (expires) {
      const result = makeDefaultCacheControl();
      result.maxAge = expires;
      return result;
    }
  }

  return null;
}

/** Computes whether an origin response is storable and the Cache-Control to persist
 * @remarks
 * Pure over `(request, response)`. Returns `null` for non-storable responses, including
 * `304`/`206`, `Vary: *`, and responses carrying `Set-Cookie` (none of which the Web Cache
 * API can or should retain). Pass `{ shared: false }` for private/client-side cache
 * semantics.
 */
export function computeStoreDecision(
  request: Request,
  response: ResponseLike,
  options: StoreDecisionOptions
): StoreDecision | null {
  if (response.status === 304 || response.status === 206) {
    return null;
  } else if (
    (response.headers.get(VARY_HEADER) || '').split(',').some(name => {
      const normalized = name.trim().toLowerCase();
      return (
        normalized === '*' ||
        normalized === 'range' ||
        normalized === 'if-range'
      );
    })
  ) {
    return null;
  } else if (response.headers.has(SET_COOKIE_HEADER)) {
    return null;
  }

  const shared = options?.shared ?? true;
  const cacheControl = getResponseCacheControl(request, response);
  const decision = makeDefaultCacheControl();
  if (!cacheControl) {
    return null;
  }

  // A shared cache must not store `private`; a private cache may.
  if (
    (shared && cacheControl.private) ||
    cacheControl.noStore ||
    cacheControl.noCache
  ) {
    return null;
  }

  let isImmutable = false;
  let maxAge = 0;
  let maxStale = 0;

  if (shared) {
    // Immutable and non-Cache-Control sources are shareable regardless of shared directive
    const inherentlyShareable =
      cacheControl.immutable ||
      !CDN_CACHE_CONTROL_HEADERS.some(name => response.headers.has(name));
    // A bare `Cache-Control: max-age` may be browser-intended, so `requireSharedDirective` treats it as private
    let isPublic =
      (options.requireSharedDirective === false || inherentlyShareable) &&
      !request.headers.has('Authorization') &&
      (request.method === 'GET' || request.method === 'HEAD');

    if (cacheControl.public) {
      isPublic = true;
    }

    if (cacheControl.mustRevalidate || cacheControl.proxyRevalidate) {
      decision.mustRevalidate = true;
      isPublic = true;
    }

    if (cacheControl.serverMaxAge !== null) {
      maxAge = cacheControl.serverMaxAge;
      isPublic = true;
    }

    if (isPublic && !maxAge && cacheControl.maxAge) {
      maxAge = cacheControl.maxAge;
    }

    if (isPublic && cacheControl.immutable) {
      isImmutable = true;
      maxAge = IMMUTABLE_MAX_AGE;
    }

    if (isPublic && !isImmutable && cacheControl.staleWhileRevalidate) {
      if (cacheControl.staleWhileRevalidate > maxStale)
        maxStale = cacheControl.staleWhileRevalidate;
    }

    if (isPublic && !isImmutable && cacheControl.staleIfError) {
      if (cacheControl.staleIfError > maxStale)
        maxStale = cacheControl.staleIfError;
    }

    decision.noTransform = cacheControl.noTransform;

    if (!isImmutable && maxAge <= 0 && maxStale <= 0) {
      return null;
    }

    decision.public = isImmutable || isPublic;
    if (!isImmutable) {
      decision.maxAge = maxAge + maxStale;
      if (isPublic && maxAge) {
        decision.serverMaxAge = maxAge + maxStale;
      }
    } else {
      decision.serverMaxAge = IMMUTABLE_MAX_AGE;
      decision.maxAge = IMMUTABLE_MAX_AGE;
    }

    cacheControl.public = true;
    return { input: cacheControl, output: decision };
  }

  if (cacheControl.mustRevalidate) {
    decision.mustRevalidate = true;
  }

  if (cacheControl.maxAge && cacheControl.maxAge > 0) {
    maxAge = cacheControl.maxAge;
  }

  if (cacheControl.immutable) {
    isImmutable = true;
    decision.immutable = true;
    maxAge = IMMUTABLE_MAX_AGE;
  }

  if (!isImmutable && cacheControl.staleWhileRevalidate) {
    if (cacheControl.staleWhileRevalidate > maxStale)
      maxStale = cacheControl.staleWhileRevalidate;
  }

  if (!isImmutable && cacheControl.staleIfError) {
    if (cacheControl.staleIfError > maxStale)
      maxStale = cacheControl.staleIfError;
  }

  decision.noTransform = cacheControl.noTransform;

  if (!isImmutable && maxAge <= 0 && maxStale <= 0) {
    return null;
  }

  decision.maxAge = maxAge + maxStale;
  return { input: cacheControl, output: decision };
}
