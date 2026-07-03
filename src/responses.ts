import { cacheControlToResponseHeader } from './cacheControl';
import type { CacheDecision } from './cacheDecision';
import { CacheResponse } from './cacheStatus';
import type { CacheControl } from './types';
import {
  AGE_HEADER,
  CDN_CACHE_CONTROL_HEADERS,
  CDN_ONLY_CACHE_CONTROL_HEADERS,
  CORS_HEADERS,
  DATE_HEADER,
  EXPIRES_HEADER,
  INTERNAL_CACHE_CONTROL,
  ORIGINAL_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  VARY_HEADER,
} from './constants';

export function deriveAge(headers: Headers): number {
  let age = 0;
  const ageHeader = headers.get(AGE_HEADER);
  if (ageHeader != null && ageHeader.trim() !== '') {
    age = parseInt(ageHeader, 10) || 0;
  }
  // Also derive an age from the Date header then use the maximum of the two
  // This protects against implementations that fail to deliver a fresh Age
  const date = headers.get(DATE_HEADER);
  if (date != null) {
    const dateMs = Date.parse(date);
    if (!Number.isNaN(dateMs)) {
      const sinceDate = Math.floor((Date.now() - dateMs) / 1000);
      if (sinceDate > age) age = sinceDate;
    }
  }
  return age < 0 ? 0 : age;
}

export function makeStoreResponse(
  request: Request,
  response: Response,
  input: CacheControl,
  output: CacheControl
): Response {
  const headers = new Headers(response.headers);
  for (const headerName of CDN_CACHE_CONTROL_HEADERS) {
    headers.delete(headerName);
  }
  // Expires is folded into the computed Cache-Control (see `getResponseCacheControl`)
  headers.delete(EXPIRES_HEADER);
  headers.set(PUBLIC_CACHE_CONTROL, cacheControlToResponseHeader(output));
  headers.set(INTERNAL_CACHE_CONTROL, cacheControlToResponseHeader(input));

  const originalCacheControl = response.headers.get(PUBLIC_CACHE_CONTROL);
  if (originalCacheControl) {
    headers.set(ORIGINAL_CACHE_CONTROL, originalCacheControl);
  }

  // Guarantee a Date, see `deriveAge`
  if (!headers.has(DATE_HEADER)) {
    const ageValue = parseInt(headers.get(AGE_HEADER) || '0', 10) || 0;
    headers.set(
      DATE_HEADER,
      new Date(Date.now() - ageValue * 1000).toUTCString()
    );
  }

  // A stored CORS preflight must vary on the CORS request headers
  if (request.method === 'OPTIONS') {
    const vary = new Set(
      (headers.get(VARY_HEADER) || '')
        .toLowerCase()
        .split(',')
        .map(name => name.trim())
    );
    for (const headerName of CORS_HEADERS) {
      if (!vary.has(headerName)) {
        headers.append(VARY_HEADER, headerName);
      }
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildServeHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  const isStored = headers.has(INTERNAL_CACHE_CONTROL);
  headers.delete(INTERNAL_CACHE_CONTROL);

  for (const headerName of CDN_ONLY_CACHE_CONTROL_HEADERS) {
    headers.delete(headerName);
  }

  if (isStored) {
    // Restore the origin's client-facing Cache-Control so the internal directive never leaks
    const originalCacheControl = headers.get(ORIGINAL_CACHE_CONTROL);
    headers.delete(ORIGINAL_CACHE_CONTROL);
    if (originalCacheControl != null) {
      headers.set(PUBLIC_CACHE_CONTROL, originalCacheControl);
    } else {
      headers.delete(PUBLIC_CACHE_CONTROL);
    }

    // Emit Age header when the store didn't add it
    if (!headers.has(AGE_HEADER)) {
      headers.set(AGE_HEADER, `${deriveAge(headers)}`);
    }
  }

  return headers;
}

export function makeServeResponse(
  response: Response,
  decision: CacheDecision,
  head = false
): CacheResponse {
  return new CacheResponse(
    head ? null : response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: buildServeHeaders(response),
    },
    decision
  );
}

export function make304Response(
  response: Response,
  decision: CacheDecision
): CacheResponse {
  const headers = buildServeHeaders(response);
  headers.delete('content-length');
  return new CacheResponse(
    null,
    { status: 304, statusText: response.statusText, headers },
    decision
  );
}

export function freshenStoredResponse(
  stored: Response,
  notModified: Response
): Response {
  const headers = buildServeHeaders(stored);
  headers.delete(AGE_HEADER);
  notModified.headers.forEach((value, key) => {
    // Content-Length describes the retained body, not the empty 304
    if (key !== 'content-length') headers.set(key, value);
  });
  headers.set(AGE_HEADER, `${deriveAge(headers)}`);
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers,
  });
}

export function make504Response(decision: CacheDecision): CacheResponse {
  return new CacheResponse(
    null,
    { status: 504, headers: { 'cache-control': 'must-revalidate' } },
    decision
  );
}
