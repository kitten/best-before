import type { CacheControl } from './types';

export function makeDefaultCacheControl(): CacheControl {
  return {
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
}

function cacheControlToCommonHeader(
  cacheControl: Partial<CacheControl>
): string {
  let out = '';
  if (cacheControl.maxAge != null) out += `max-age=${cacheControl.maxAge}, `;
  if (cacheControl.staleIfError)
    out += `stale-if-error=${cacheControl.staleIfError}, `;
  if (cacheControl.noCache) out += 'no-cache, ';
  if (cacheControl.noStore) out += 'no-store, ';
  if (cacheControl.noTransform) out += 'no-transform, ';
  return out.slice(0, -2);
}

export function cacheControlToRequestHeader(
  cacheControl: Partial<CacheControl>
): string {
  let out = '';
  if (cacheControl.maxStale != null)
    out += `max-stale=${cacheControl.maxStale}, `;
  if (cacheControl.minFresh != null)
    out += `min-fresh=${cacheControl.minFresh}, `;
  if (cacheControl.onlyIfCached) out += 'only-if-cached, ';
  const common = cacheControlToCommonHeader(cacheControl);
  return common ? out + common : out.slice(0, -2);
}

export function cacheControlToResponseHeader(
  cacheControl: Partial<CacheControl>
): string {
  let out = '';
  if (cacheControl.serverMaxAge != null)
    out += `s-maxage=${cacheControl.serverMaxAge}, `;
  if (cacheControl.staleWhileRevalidate != null)
    out += `stale-while-revalidate=${cacheControl.staleWhileRevalidate}, `;
  if (cacheControl.mustRevalidate) out += 'must-revalidate, ';
  if (cacheControl.proxyRevalidate) out += 'proxy-revalidate, ';
  if (cacheControl.mustUnderstand) out += 'must-understand, ';
  if (cacheControl.private) out += 'private, ';
  if (cacheControl.public) out += 'public, ';
  if (cacheControl.immutable) out += 'immutable, ';
  if (cacheControl.unrecognized) out += `${cacheControl.unrecognized}, `;
  let common = cacheControlToCommonHeader(cacheControl);
  return common ? out + common : out.slice(0, -2);
}

let input: string;
let idx: number;

function skipIgnored(): void {
  for (
    let char = input.charCodeAt(idx++) | 0;
    char === 9 /*'\t'*/ ||
    char === 10 /*'\n'*/ ||
    char === 13 /*'\r'*/ ||
    char === 32 /*' '*/ ||
    char === 65279 /*'\ufeff'*/;
    char = input.charCodeAt(idx++) | 0
  );
  idx--;
}

function nextDirective(): void {
  for (
    let char = input.charCodeAt(idx++) | 0;
    char && char !== 44 /*','*/;
    char = input.charCodeAt(idx++) | 0
  ) {
    // An unterminated quote runs to end-of-input (charCodeAt is NaN past the end)
    if (char === 34 /*'"'*/)
      while ((char = input.charCodeAt(idx++) | 0) && char !== 34);
  }
}

const nameRe = /[a-z-]+/y;

const valueRe = new RegExp(
  '(?:' +
    // Numbers, starting with an integer part then optionally followed by a floating part
    '(-?\\d+)(\\.\\d+)?|' +
    // Strings, start and end with a quote and must be on one line
    '("(?:"|[^\\r\\n]*?[^\\\\]"))|' +
    // Any other token value
    `(${nameRe.source})` +
    ')',
  'y'
);

// NOTE: Each of the groups above end up in the RegExpExecArray at the specified indices (starting with 1)
const enum ValueGroup {
  Int = 1,
  Float,
  String,
  Token,
}

type ValueExec = RegExpExecArray & {
  [Prop in ValueGroup]: string | undefined;
};

function parseValue(): number | null {
  let exec: ValueExec | null;
  let match: string | undefined;
  let value: number | null = null;
  valueRe.lastIndex = idx;
  if ((exec = valueRe.exec(input) as ValueExec) != null) {
    idx = valueRe.lastIndex;
    if (exec[ValueGroup.Int] != null) {
      if (exec[ValueGroup.Float] != null) {
        match = exec[ValueGroup.Int] + exec[ValueGroup.Float];
        value = Math.floor(parseFloat(match));
        if (!Number.isSafeInteger(value)) value = null;
      } else {
        match = exec[ValueGroup.Int];
        value = parseInt(match, 10);
        if (value > Number.MAX_SAFE_INTEGER) {
          value = Number.MAX_SAFE_INTEGER;
        } else if (value < 0) {
          value = -1;
        }
      }
    } else if ((match = exec[ValueGroup.String]) != null) {
      // NOTE: Unused since there's no Cache-Control directives with values that aren't number currently
    } else if (exec[ValueGroup.Token] != null) {
      // NOTE: Unused since there's no Cache-Control directives with values that aren't number currently
    }
    skipIgnored();
  }
  return value;
}

interface DirectiveNode {
  name: string;
  value: number | null;
}

function parseDirective(): DirectiveNode | undefined {
  skipIgnored();
  let name: string | undefined;
  let value: number | null = null;
  nameRe.lastIndex = idx;
  if (nameRe.test(input)) {
    name = input.slice(idx, (idx = nameRe.lastIndex));
    skipIgnored();
    if (input.charCodeAt(idx++) !== 61 /*'='*/) {
      idx--;
      value = null;
    } else {
      skipIgnored();
      value = parseValue();
    }
    return { name, value };
  }
}

export function parseCacheControl(headerValue: string | null): CacheControl {
  const cacheControl = makeDefaultCacheControl();
  if (!headerValue) {
    return cacheControl;
  }

  let directive: DirectiveNode | undefined;
  input = headerValue.toLowerCase();
  idx = 0;
  while (idx < input.length) {
    if ((directive = parseDirective()) != null) {
      switch (directive.name) {
        case 's-maxage':
          cacheControl.serverMaxAge = directive.value;
          break;
        case 'max-age':
          cacheControl.maxAge = directive.value;
          break;
        case 'stale-while-revalidate':
          if (directive.value != null && directive.value > 0)
            cacheControl.staleWhileRevalidate = directive.value;
          break;
        case 'stale-if-error':
          if (directive.value != null && directive.value > 0)
            cacheControl.staleIfError = directive.value;
          break;
        case 'max-stale':
          if (directive.value != null && directive.value > 0)
            cacheControl.maxStale = directive.value;
          break;
        case 'min-fresh':
          if (directive.value != null && directive.value > 0)
            cacheControl.minFresh = directive.value;
          break;
        case 'no-cache':
          cacheControl.noCache = true;
          break;
        case 'no-store':
          cacheControl.noStore = true;
          break;
        case 'no-transform':
          cacheControl.noTransform = true;
          break;
        case 'only-if-cached':
          cacheControl.onlyIfCached = true;
          break;
        case 'must-revalidate':
          cacheControl.mustRevalidate = true;
          break;
        case 'proxy-revalidate':
          cacheControl.proxyRevalidate = true;
          break;
        case 'must-understand':
          cacheControl.mustUnderstand = true;
          break;
        case 'public':
          cacheControl.public = true;
          break;
        case 'private':
          cacheControl.private = true;
          break;
        case 'immutable':
          cacheControl.immutable = true;
          break;

        default:
          if (!directive.name) {
            break;
          } else if (!cacheControl.unrecognized) {
            cacheControl.unrecognized = '';
          } else {
            cacheControl.unrecognized += ', ';
          }
          cacheControl.unrecognized +=
            directive.value != null
              ? `${directive.name.trim()}=${directive.value}`
              : directive.name;
      }
    }
    nextDirective();
  }

  if (cacheControl.private) cacheControl.public = false;

  return cacheControl;
}
