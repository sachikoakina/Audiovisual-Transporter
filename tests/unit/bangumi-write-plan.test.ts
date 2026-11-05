/**
 * Douban → Bangumi comment/rating merge.
 * 豆瓣 → Bangumi 短评/评分合并。
 */
import { describe, expect, it } from 'vitest';
import { resolveBangumiCollectionWrite } from '../../src/rules/bangumi-neodb';

const existing = (
  overrides: Partial<{
    type: 2;
    rate: number;
    comment: string;
  }> = {},
) => ({
  type: 2 as const,
  rate: 8,
  comment: 'Bangumi comment',
  ...overrides,
});

describe('resolveBangumiCollectionWrite', () => {
  it('keeps a non-empty Bangumi comment by default', () => {
    const plan = resolveBangumiCollectionWrite({
      desiredType: 2,
      desiredRate: 8,
      desiredComment: 'Douban comment',
      existing: existing(),
    });

    expect(plan.comment).toBe('Bangumi comment');
    expect(plan.keepExistingComment).toBe(true);
    expect(plan.unchanged).toBe(true);
  });

  it('fills an empty Bangumi comment', () => {
    const plan = resolveBangumiCollectionWrite({
      desiredType: 2,
      desiredRate: 8,
      desiredComment: 'Douban comment',
      existing: existing({ comment: '' }),
    });

    expect(plan.comment).toBe('Douban comment');
    expect(plan.keepExistingComment).toBe(false);
    expect(plan.unchanged).toBe(false);
  });

  it('does not let an empty source clear a non-empty Bangumi comment', () => {
    const plan = resolveBangumiCollectionWrite({
      desiredType: 2,
      desiredRate: 8,
      desiredComment: '',
      existing: existing(),
    });

    expect(plan.comment).toBe('Bangumi comment');
    expect(plan.unchanged).toBe(true);
  });

  it('lets overwrite clear a non-empty comment', () => {
    const plan = resolveBangumiCollectionWrite({
      desiredType: 2,
      desiredRate: 8,
      desiredComment: '',
      mergeProfile: 'overwrite',
      existing: existing(),
    });

    expect(plan.comment).toBe('');
    expect(plan.keepExistingComment).toBe(false);
    expect(plan.unchanged).toBe(false);
  });

  it('keeps a non-zero Bangumi rating even when the comment changes', () => {
    const plan = resolveBangumiCollectionWrite({
      desiredType: 2,
      desiredRate: 6,
      desiredComment: 'Douban comment',
      mergeProfile: 'overwrite',
      existing: existing({ rate: 9, comment: '' }),
    });

    expect(plan.rate).toBe(9);
    expect(plan.keepExistingRate).toBe(true);
    expect(plan.comment).toBe('Douban comment');
  });
});
