import { describe, it, expect } from 'vitest';
import { createStreamingDigest } from '../cacheKey';

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

/** Reference digest using the platform WebCrypto implementation. */
async function reference(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return base64Url(digest);
}

const encoder = new TextEncoder();

describe('createStreamingDigest', () => {
  it('matches the platform digest for known inputs', async () => {
    const inputs = ['', 'abc', 'The quick brown fox jumps over the lazy dog'];
    for (const input of inputs) {
      const bytes = encoder.encode(input);
      const digest = createStreamingDigest();
      digest.update(bytes);
      expect(await digest.digest()).toBe(await reference(bytes));
    }
  });

  it('is agnostic to chunk boundaries', async () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const expected = await reference(bytes);

    for (const chunkSize of [1, 7, 55, 56, 63, 64, 65, 128, 300]) {
      const digest = createStreamingDigest();
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        digest.update(bytes.subarray(offset, offset + chunkSize));
      expect(await digest.digest()).toBe(expected);
    }
  });

  it('handles a range of input lengths', async () => {
    for (const length of [55, 56, 64, 119, 120, 128]) {
      const bytes = new Uint8Array(length).fill(0xab);
      const digest = createStreamingDigest();
      digest.update(bytes);
      expect(await digest.digest()).toBe(await reference(bytes));
    }
  });
});
