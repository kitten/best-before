import type { CacheDecision } from './cacheDecision';
import { CacheResponse } from './cacheStatus';
import {
  make304Response,
  makeServeResponse,
  buildServeHeaders,
} from './responses';
import { matchesClientConditional } from './conditional';

export const MAX_RANGE_HEADER_LENGTH = 8192;
export const MAX_RANGE_MEMBERS = 16;

export type ByteRange =
  | { type: 'bounded'; start: number; end: number }
  | { type: 'open'; start: number }
  | { type: 'suffix'; length: number };

export type RangeParseResult =
  | { type: 'single'; range: ByteRange }
  | { type: 'multiple' }
  | { type: 'unsupported' }
  | { type: 'malformed' };

export type ResolvedRange =
  | { type: 'satisfied'; start: number; end: number }
  | { type: 'unsatisfied' };

const STRONG_ETAG_RE = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseRangeMember(memberValue: string): ByteRange | null {
  const member = memberValue.trim();
  const dash = member.indexOf('-');
  if (!member || dash < 0 || member.indexOf('-', dash + 1) >= 0) return null;

  const first = member.slice(0, dash).trim();
  const last = member.slice(dash + 1).trim();
  if (!first) {
    const length = parseInteger(last);
    return length == null ? null : { type: 'suffix', length };
  }

  const start = parseInteger(first);
  if (start == null) return null;
  if (!last) return { type: 'open', start };

  const end = parseInteger(last);
  return end == null || start > end ? null : { type: 'bounded', start, end };
}

export function parseRangeHeader(value: string): RangeParseResult {
  if (value.length > MAX_RANGE_HEADER_LENGTH) return { type: 'unsupported' };
  const equals = value.indexOf('=');
  if (equals < 0) return { type: 'malformed' };
  const unit = value.slice(0, equals).trim().toLowerCase();
  if (unit !== 'bytes') return { type: 'unsupported' };

  const members = value.slice(equals + 1).split(',');
  if (members.length > MAX_RANGE_MEMBERS) return { type: 'unsupported' };
  const range = parseRangeMember(members[0]);
  if (range == null) return { type: 'malformed' };
  for (let index = 1; index < members.length; index++) {
    if (parseRangeMember(members[index]) == null) return { type: 'malformed' };
  }
  return members.length === 1
    ? { type: 'single', range }
    : { type: 'multiple' };
}

export function resolveByteRange(
  range: ByteRange,
  length: number
): ResolvedRange {
  if (length === 0) return { type: 'unsatisfied' };
  if (range.type === 'suffix') {
    if (range.length === 0) return { type: 'unsatisfied' };
    return {
      type: 'satisfied',
      start: Math.max(0, length - range.length),
      end: length - 1,
    };
  }
  if (range.start >= length) return { type: 'unsatisfied' };
  return {
    type: 'satisfied',
    start: range.start,
    end: range.type === 'open' ? length - 1 : Math.min(range.end, length - 1),
  };
}

export function matchesIfRange(request: Request, response: Response): boolean {
  const value = request.headers.get('if-range');
  if (value == null) return true;
  const candidate = value.trim();
  if (STRONG_ETAG_RE.test(candidate)) {
    const etag = response.headers.get('etag')?.trim();
    return !!etag && STRONG_ETAG_RE.test(etag) && etag === candidate;
  }
  if (candidate.startsWith('W/') || candidate.startsWith('"')) return false;
  const validatorDate = parseHttpDate(candidate);
  const lastModified = parseHttpDate(
    response.headers.get('last-modified') || ''
  );
  const responseDate = parseHttpDate(response.headers.get('date') || '');
  return (
    validatorDate != null &&
    lastModified != null &&
    responseDate != null &&
    responseDate - lastModified >= 60_000 &&
    validatorDate === lastModified
  );
}

function parseHttpDate(value: string): number | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toUTCString() === value.trim() ? timestamp : null;
}

function representationLength(response: Response): number | null {
  if (
    response.status !== 200 ||
    response.body == null ||
    response.headers.has('content-range')
  ) {
    return null;
  }
  const raw = response.headers.get('content-length');
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const encoding = response.headers.get('content-encoding');
  return encoding == null || encoding.trim().toLowerCase() === 'identity'
    ? length
    : null;
}

function sliceBody(
  body: ReadableStream<Uint8Array>,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let position = 0;
  let remaining = end - start + 1;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (remaining > 0) {
          const result = await reader.read();
          if (result.done) {
            controller.error(
              new TypeError(
                'Cached response ended before its declared Content-Length'
              )
            );
            return;
          }
          const chunk = result.value;
          const from = Math.max(0, start - position);
          position += chunk.byteLength;
          if (position <= start) continue;
          const selected = chunk.subarray(from, from + remaining);
          if (selected.byteLength > 0) {
            remaining -= selected.byteLength;
            controller.enqueue(selected);
          }
        }
        // Cleanup failure cannot invalidate bytes that have already been selected.
        await reader.cancel().catch(() => {});
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function selectCachedResponse(
  request: Request,
  response: Response,
  decision: CacheDecision,
  head = false
): CacheResponse | undefined {
  if (
    (request.method === 'GET' || head) &&
    matchesClientConditional(request, response)
  ) {
    return make304Response(response, decision);
  }
  const rangeValue =
    request.method === 'GET' ? request.headers.get('range') : null;
  if (rangeValue == null) return makeServeResponse(response, decision, head);
  const parsed = parseRangeHeader(rangeValue);
  if (parsed.type !== 'single') return undefined;
  if (response.status === 206 && response.headers.has('content-range'))
    return matchesIfRange(request, response)
      ? makeServeResponse(response, decision)
      : undefined;
  const length = representationLength(response);
  if (length == null) return undefined;
  if (!matchesIfRange(request, response))
    return makeServeResponse(response, decision);
  const resolved = resolveByteRange(parsed.range, length);
  const headers = buildServeHeaders(response);
  headers.delete('transfer-encoding');
  headers.delete('content-range');
  if (resolved.type === 'unsatisfied') {
    headers.delete('content-length');
    headers.set('content-range', `bytes */${length}`);
    return new CacheResponse(null, { status: 416, headers }, decision);
  }
  const selectedLength = resolved.end - resolved.start + 1;
  headers.set('accept-ranges', 'bytes');
  headers.set(
    'content-range',
    `bytes ${resolved.start}-${resolved.end}/${length}`
  );
  headers.set('content-length', String(selectedLength));
  return new CacheResponse(
    sliceBody(response.body!, resolved.start, resolved.end),
    { status: 206, headers },
    decision
  );
}
