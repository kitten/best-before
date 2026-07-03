import { CacheDecision } from './cacheDecision';
import type { CacheStatus } from './types';

export class CacheResponse extends Response {
  readonly decision: CacheDecision;
  readonly cacheStatus: CacheStatus;

  constructor(
    body: BodyInit | null | undefined,
    init: ResponseInit | undefined,
    decision: CacheDecision
  ) {
    super(body, init);
    this.decision = decision;
    this.cacheStatus = cacheDecisionToStatus(decision);
  }
}

function cacheDecisionToStatus(decision: CacheDecision): CacheStatus {
  switch (decision) {
    case CacheDecision.MISS_TIMEOUT:
      return { decision, hit: false, detail: 'only-if-cached' };
    case CacheDecision.MISS_REQUEST:
      return { decision, hit: false, forward: 'request' };
    case CacheDecision.MISS:
      return { decision, hit: false, forward: 'miss' };
    case CacheDecision.STALE_IF_ERROR:
      return { decision, hit: true, detail: 'error' };
    case CacheDecision.STALE_WHILE_REVALIDATE:
      return { decision, hit: true, detail: 'revalidate' };
    case CacheDecision.BYPASS:
      return { decision, hit: false, forward: 'bypass' };
    case CacheDecision.HIT:
      return { decision, hit: true };
  }
}
