import {
  CacheStore,
  CacheOutcome,
  CacheResponse,
  ExecutionCtx,
} from '../index';

/** A virtual clock the store reads to stamp `Age`, so freshness lifetimes advance deterministically
 * without real time or fake timers (the library derives age from the `Age` header). */
export class Clock {
  seconds = 0;
  advance(bySeconds: number): void {
    this.seconds += bySeconds;
  }
}

interface Variant {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
  vary: string;
  varied: Record<string, string | null>;
  storedAt: number;
  baseAge: number;
}

const variedHeaders = (
  vary: string,
  headers: Headers
): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const raw of vary.split(',')) {
    const name = raw.trim().toLowerCase();
    if (name) out[name] = headers.get(name);
  }
  return out;
};

const matchesVariant = (variant: Variant, request: Request): boolean => {
  if (variant.vary === '*') return false;
  const current = variedHeaders(variant.vary, request.headers);
  for (const name in variant.varied) {
    if (variant.varied[name] !== current[name]) return false;
  }
  return true;
};

/** In-memory {@link CacheStore} that emulates the Web Cache API closely enough for compliance
 * tests: it honors `Vary` variant selection and stamps an `Age` header from a virtual {@link Clock}
 * so an entry's freshness can be aged deterministically. */
export class AgeAwareStore implements CacheStore {
  private map = new Map<string, Variant[]>();

  constructor(readonly clock: Clock = new Clock()) {}

  async match(request: Request): Promise<Response | undefined> {
    const variant = this.map
      .get(request.url)
      ?.find(v => matchesVariant(v, request));
    if (!variant) return undefined;
    const headers = new Headers(variant.headers);
    headers.set(
      'age',
      String(variant.baseAge + (this.clock.seconds - variant.storedAt))
    );
    return new Response(variant.body, {
      status: variant.status,
      statusText: variant.statusText,
      headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    const headers = new Headers(response.headers);
    const baseAge = parseInt(headers.get('age') || '0', 10) || 0;
    headers.delete('age');
    const vary = headers.get('vary') || '';
    const variant: Variant = {
      body: await response.arrayBuffer(),
      status: response.status,
      statusText: response.statusText,
      headers: [...headers] as [string, string][],
      vary,
      varied: variedHeaders(vary, request.headers),
      storedAt: this.clock.seconds,
      baseAge,
    };
    const key = JSON.stringify([variant.vary, variant.varied]);
    const kept = (this.map.get(request.url) || []).filter(
      v => JSON.stringify([v.vary, v.varied]) !== key
    );
    this.map.set(request.url, [variant, ...kept]);
  }

  async delete(request: Request): Promise<boolean> {
    return this.map.delete(request.url);
  }

  /** Number of distinct cache-key URLs currently stored. */
  get urlCount(): number {
    return this.map.size;
  }
}

/** Collects `waitUntil` promises so a test can flush background work (the SWR/put path). */
export class TestExecutionCtx implements ExecutionCtx {
  private pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }
  async settle(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
  }
}

/** Drives a `handle()` outcome to the served response — the common `(await handle).resolve()`. */
export const serve = async (
  outcome: Promise<CacheOutcome>
): Promise<CacheResponse> => (await outcome).resolve();

/** Shorthand for a `Cache-Control` response init. */
export const cc = (value: string): ResponseInit => ({
  headers: { 'cache-control': value },
});
