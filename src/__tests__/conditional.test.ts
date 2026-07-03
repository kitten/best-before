import { describe, it, expect } from 'vitest';
import { matchesClientConditional } from '../conditional';

const req = (headers: Record<string, string>) =>
  new Request('https://test.com/x', { headers });
const res = (headers: Record<string, string>) =>
  new Response('body', { headers });

describe('matchesClientConditional', () => {
  it('matches a strong ETag exactly', () => {
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"abc"' }),
        res({ etag: '"abc"' })
      )
    ).toBe(true);
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"abc"' }),
        res({ etag: '"xyz"' })
      )
    ).toBe(false);
  });

  it('matches with weak comparison (W/ prefix on either side)', () => {
    expect(
      matchesClientConditional(
        req({ 'if-none-match': 'W/"abc"' }),
        res({ etag: '"abc"' })
      )
    ).toBe(true);
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"abc"' }),
        res({ etag: 'W/"abc"' })
      )
    ).toBe(true);
  });

  it('matches * against any current representation', () => {
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '*' }),
        res({ etag: '"abc"' })
      )
    ).toBe(true);
    // Even without an ETag, * matches a present representation.
    expect(
      matchesClientConditional(req({ 'if-none-match': '*' }), res({}))
    ).toBe(true);
  });

  it('matches an ETag within a comma-separated list', () => {
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"a", "b", "abc"' }),
        res({ etag: '"abc"' })
      )
    ).toBe(true);
  });

  it('matches ETags containing commas within a list', () => {
    // A comma is a legal `etagc`; the list must be split on unquoted commas only.
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"a,b", "c"' }),
        res({ etag: '"a,b"' })
      )
    ).toBe(true);
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"a", W/"b,c"' }),
        res({ etag: '"b,c"' })
      )
    ).toBe(true);
    expect(
      matchesClientConditional(
        req({ 'if-none-match': '"a,b"' }),
        res({ etag: '"b"' })
      )
    ).toBe(false);
  });

  it('returns false when If-None-Match is set but the entry has no ETag', () => {
    expect(
      matchesClientConditional(req({ 'if-none-match': '"abc"' }), res({}))
    ).toBe(false);
  });

  it('honors If-Modified-Since when the entry is not newer', () => {
    const date = 'Tue, 01 Jul 2025 00:00:00 GMT';
    expect(
      matchesClientConditional(
        req({ 'if-modified-since': date }),
        res({ 'last-modified': 'Mon, 30 Jun 2025 00:00:00 GMT' })
      )
    ).toBe(true);
    expect(
      matchesClientConditional(
        req({ 'if-modified-since': date }),
        res({ 'last-modified': 'Wed, 02 Jul 2025 00:00:00 GMT' })
      )
    ).toBe(false);
  });

  it('gives If-None-Match precedence over If-Modified-Since', () => {
    // INM does not match → false, even though IMS alone would be not-modified.
    expect(
      matchesClientConditional(
        req({
          'if-none-match': '"different"',
          'if-modified-since': 'Tue, 01 Jul 2025 00:00:00 GMT',
        }),
        res({
          etag: '"abc"',
          'last-modified': 'Mon, 30 Jun 2025 00:00:00 GMT',
        })
      )
    ).toBe(false);
  });

  it('returns false on invalid dates or no conditional headers', () => {
    expect(
      matchesClientConditional(
        req({ 'if-modified-since': 'not-a-date' }),
        res({ 'last-modified': 'Mon, 30 Jun 2025 00:00:00 GMT' })
      )
    ).toBe(false);
    expect(matchesClientConditional(req({}), res({ etag: '"abc"' }))).toBe(
      false
    );
  });

  it('returns false for If-Modified-Since when the entry has no Last-Modified', () => {
    expect(
      matchesClientConditional(
        req({ 'if-modified-since': 'Tue, 01 Jul 2025 00:00:00 GMT' }),
        res({})
      )
    ).toBe(false);
  });
});
