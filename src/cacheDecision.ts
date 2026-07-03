import type { CacheControl, CacheDecisionOptions } from './types';

/** The freshness/staleness verdict for a cached entry against a client request */
export enum CacheDecision {
  MISS_TIMEOUT = 1,
  MISS_REQUEST,
  MISS,
  HIT,
  BYPASS,
  STALE_IF_ERROR,
  STALE_WHILE_REVALIDATE,
}

export function isRequestCacheable(request: Request): boolean {
  switch (request.method) {
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'CONNECT':
    case 'TRACE':
      return false;
    default:
      return true;
  }
}

export function isErrorResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  } else if (response.status === 501) {
    return false;
  } else {
    return response.status >= 500 && response.status <= 599;
  }
}

/** Computes the freshness/staleness decision for a stored entry */
export function computeCacheDecision(
  client: CacheControl,
  cacheControl: CacheControl,
  age: number,
  options: CacheDecisionOptions
): CacheDecision {
  const honorBypass = options.clientCacheBypass !== false;
  const shared = options.shared !== false;

  let miss: CacheDecision.MISS_TIMEOUT | null = null;
  if (options.onlyIfCached !== false && client.onlyIfCached) {
    // With `only-if-cached`, an otherwise-miss becomes a 504 timeout
    miss = CacheDecision.MISS_TIMEOUT;
  }

  if (
    (shared && cacheControl.private) ||
    cacheControl.noStore ||
    cacheControl.noCache
  ) {
    // A private cache may still serve `private`
    return miss || CacheDecision.MISS;
  } else if (cacheControl.immutable) {
    return CacheDecision.HIT;
  } else if (honorBypass && (client.noStore || client.noCache)) {
    return miss || CacheDecision.MISS_REQUEST;
  }

  let maxAge: number;
  if (shared) {
    const sharedCacheable =
      cacheControl.public ||
      cacheControl.mustRevalidate ||
      cacheControl.proxyRevalidate;
    const serverMaxAge = cacheControl.serverMaxAge;
    if (serverMaxAge != null) {
      maxAge = serverMaxAge;
    } else if (sharedCacheable && cacheControl.maxAge) {
      maxAge = cacheControl.maxAge;
    } else {
      maxAge = 0;
    }
  } else {
    maxAge = cacheControl.maxAge != null ? cacheControl.maxAge : 0;
  }

  // Preserved to calculate against the entry's freshness
  const entryMaxAge = maxAge;

  let clientMaxAge = false;
  if (honorBypass && client.maxAge != null && client.maxAge > -1) {
    maxAge = client.maxAge;
    clientMaxAge = true;
    if (client.maxAge <= 0) {
      return miss || CacheDecision.MISS_REQUEST;
    }
  }

  if (maxAge < 0) {
    return miss || CacheDecision.MISS;
  } else if (maxAge != null && age < maxAge) {
    if (honorBypass && client.minFresh && maxAge - age < client.minFresh) {
      return miss || CacheDecision.MISS_REQUEST;
    }
    return CacheDecision.HIT;
  } else if (
    shared
      ? cacheControl.mustRevalidate || cacheControl.proxyRevalidate
      : cacheControl.mustRevalidate
  ) {
    return miss || CacheDecision.MISS;
  } else if (
    options.staleWhileRevalidate !== false &&
    cacheControl.staleWhileRevalidate != null &&
    age < entryMaxAge + cacheControl.staleWhileRevalidate
  ) {
    if (honorBypass && clientMaxAge && client.maxStale == null) {
      return miss || CacheDecision.MISS_REQUEST;
    } else if (
      honorBypass &&
      client.maxStale &&
      age > entryMaxAge + client.maxStale
    ) {
      return miss || CacheDecision.MISS_REQUEST;
    }

    return CacheDecision.STALE_WHILE_REVALIDATE;
  } else if (
    options.staleIfError !== false &&
    cacheControl.staleIfError != null &&
    age < entryMaxAge + cacheControl.staleIfError
  ) {
    // client max-age doesn't forfeit stale-if-error, but its stale-if-error bounds it
    if (
      honorBypass &&
      client.staleIfError &&
      age > entryMaxAge + client.staleIfError
    ) {
      return miss || CacheDecision.MISS_REQUEST;
    }

    return CacheDecision.STALE_IF_ERROR;
  }

  return miss || CacheDecision.MISS;
}
