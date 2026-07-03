const IF_NONE_MATCH = 'if-none-match';
const IF_MODIFIED_SINCE = 'if-modified-since';
const ETAG = 'etag';
const LAST_MODIFIED = 'last-modified';

function normalizeETag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

/** Splits a header field list on commas, ignoring commas inside quoted strings */
function splitFieldList(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let idx = 0; idx < value.length; idx++) {
    const char = value.charCodeAt(idx);
    if (char === 34 /*'"'*/) {
      quoted = !quoted;
    } else if (char === 44 /*','*/ && !quoted) {
      out.push(value.slice(start, idx));
      start = idx + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

export function matchesClientConditional(
  request: Request,
  response: Response
): boolean {
  const ifNoneMatch = request.headers.get(IF_NONE_MATCH);
  if (ifNoneMatch != null) {
    const value = ifNoneMatch.trim();
    if (value === '*') {
      return true;
    }

    const etag = response.headers.get(ETAG);
    if (etag) {
      const target = normalizeETag(etag);
      for (const candidate of splitFieldList(value)) {
        if (candidate && normalizeETag(candidate) === target) {
          return true;
        }
      }
    }
    return false;
  }

  const ifModifiedSince = request.headers.get(IF_MODIFIED_SINCE);
  if (ifModifiedSince == null) {
    return false;
  }

  const lastModified = response.headers.get(LAST_MODIFIED);
  if (!lastModified) return false;
  const since = Date.parse(ifModifiedSince);
  const modified = Date.parse(lastModified);
  if (Number.isNaN(since) || Number.isNaN(modified)) {
    return false;
  } else {
    return modified <= since;
  }
}
