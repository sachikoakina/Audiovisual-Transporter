/**
 * The category vocabularies live in several modules for good reasons (env aliases, API types,
 * review labels). This test pins the places where they must agree, so a rename cannot silently
 * send a drama to TMDB or a book to Bangumi's anime type.
 *
 * 分类词表分散在多个模块（env 别名、API 类型、展示词表）。这里锁定它们必须一致的部分，
 * 防止一次改名把话剧送进 TMDB，或把书当成 Bangumi 动画。
 */
import { describe, expect, it } from 'vitest';
import {
  BANGUMI_TO_NEODB_STATUS,
  CATEGORY_TO_BANGUMI_TYPES,
  NEODB_TO_BANGUMI_COLLECTION,
} from '../../src/rules/bangumi-neodb';
import { NEODB_TO_TMDB_MEDIA_TYPE } from '../../src/rules/tmdb-mapping';
import { ItemCategory } from '../../src/types';
import { normalizeReviewCategory } from '../../src/rules/review-vocab';

describe('category vocabulary consistency', () => {
  it('maps Douban drama to performance, not tv', () => {
    expect(normalizeReviewCategory('drama')).toBe('performance');
    expect(normalizeReviewCategory('real')).toBe('tv');
  });

  it('keeps movie/tv as the only TMDB media types', () => {
    expect(NEODB_TO_TMDB_MEDIA_TYPE).toEqual({ movie: 'movie', tv: 'tv' });
  });

  it('keeps Bangumi subject types and NeoDB status mappings aligned', () => {
    expect(CATEGORY_TO_BANGUMI_TYPES[ItemCategory.Book]).toEqual([1]);
    expect(CATEGORY_TO_BANGUMI_TYPES[ItemCategory.Movie]).toEqual([2, 6]);
    expect(NEODB_TO_BANGUMI_COLLECTION.wishlist).toBe(1);
    expect(NEODB_TO_BANGUMI_COLLECTION.complete).toBe(2);
    expect(NEODB_TO_BANGUMI_COLLECTION.progress).toBe(3);
    expect(BANGUMI_TO_NEODB_STATUS[1]).toBe('wishlist');
    expect(BANGUMI_TO_NEODB_STATUS[2]).toBe('complete');
    expect(BANGUMI_TO_NEODB_STATUS[3]).toBe('progress');
  });
});
