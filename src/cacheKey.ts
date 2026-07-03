import {
  CDN_CACHE_CONTROL_HEADERS,
  MAX_CACHEABLE_BODY_SIZE,
} from './constants';

const CONTENT_LENGTH_HEADER = 'content-length';

function getRequestBodyLength(request: Request): number | null {
  if (request.body === null) {
    return 0;
  } else {
    return (
      parseInt(request.headers.get(CONTENT_LENGTH_HEADER) || '0', 10) || null
    );
  }
}

async function getRequestBodyHash(
  request: Request,
  maxBodySize: number
): Promise<string | null> {
  const length = getRequestBodyLength(request);
  if (!request.body || !length || length > maxBodySize) {
    return null;
  }
  const digest = createStreamingDigest();
  const body = request.clone().body as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  let byteLength = 0;
  let result: ReadableStreamReadResult<Uint8Array>;
  while (!(result = await reader.read()).done) {
    if (result.value) {
      if ((byteLength += result.value.byteLength) > maxBodySize) {
        await reader.cancel();
        return null;
      }
      digest.update(result.value);
    }
  }
  return digest.digest();
}

export interface CacheKeyOptions {
  cacheNonGetMethods: boolean;
  maxBodySize?: number;
}

export async function getCacheRequest(
  request: Request,
  options: CacheKeyOptions
): Promise<Request | null> {
  const url = new URL(request.url);
  const method = request.method;
  let prefix = '';

  if (method !== 'GET' && method !== 'HEAD') {
    if (!options.cacheNonGetMethods) return null;
    prefix += `/${method.toUpperCase()}`;
    if (request.body && method !== 'OPTIONS') {
      const bodyHash = await getRequestBodyHash(
        request,
        options.maxBodySize ?? MAX_CACHEABLE_BODY_SIZE
      );
      if (!bodyHash) return null;
      prefix += `/${bodyHash}`;
    }
  }

  if (prefix) url.pathname = prefix + url.pathname;

  // Cache-control headers are dropped so they don't vary the key
  const headers = new Headers(request.headers);
  for (const headerName of CDN_CACHE_CONTROL_HEADERS) {
    headers.delete(headerName);
  }

  return new Request(url, { headers, method: 'GET' });
}

export interface StreamingDigest {
  update(chunk: Uint8Array): void;
  digest(): Promise<string>;
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createStreamingDigest(): StreamingDigest {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  return {
    update(chunk) {
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    },
    async digest() {
      const buffer = new Uint8Array(byteLength);
      for (
        let chunkIndex = 0, byteIndex = 0;
        chunkIndex < chunks.length;
        chunkIndex++
      ) {
        buffer.set(chunks[chunkIndex], byteIndex);
        byteIndex += chunks[chunkIndex].byteLength;
      }
      return base64Url(await crypto.subtle.digest('SHA-256', buffer));
    },
  };
}
