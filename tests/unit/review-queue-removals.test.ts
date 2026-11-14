import { describe, expect, it } from 'vitest';
import { removalRecord, type ReviewItem } from '../../scripts/review-queue.mjs';

const RUN_AT = '2026-11-14T08:00:00.000Z';
const RUN_URL = 'https://github.com/example/actions/runs/1';

function removed(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    key: 'neodb→tmdb::https://neodb.social/movie/1',
    kind: 'unresolved',
    source: 'neodb→tmdb',
    reason: 'tmdb-search-empty',
    title: '沙丘',
    url: 'https://neodb.social/movie/1',
    id: '',
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-11-10T00:00:00.000Z',
    missedRuns: 2,
    seenCount: 3,
    removedReason: 'two-covered-misses',
    ...over,
  };
}

describe('removalRecord', () => {
  it('keeps the evidence needed to audit a removal', () => {
    expect(removalRecord(removed(), RUN_AT, RUN_URL)).toMatchObject({
      removedAt: RUN_AT,
      key: 'neodb→tmdb::https://neodb.social/movie/1',
      source: 'neodb→tmdb',
      title: '沙丘',
      url: 'https://neodb.social/movie/1',
      reason: 'tmdb-search-empty',
      removedReason: 'two-covered-misses',
      missedRuns: 2,
      seenCount: 3,
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-11-10T00:00:00.000Z',
      runUrl: RUN_URL,
    });
  });

  it('defaults legacy snapshots to two-covered-misses', () => {
    const legacy = removed();
    delete legacy.removedReason;

    expect(removalRecord(legacy, RUN_AT).removedReason).toBe('two-covered-misses');
  });

  it('records verified removals with their own reason', () => {
    expect(
      removalRecord(removed({ removedReason: 'verified-resolved' }), RUN_AT)
        .removedReason,
    ).toBe('verified-resolved');
  });
});
