/**
 * TMDB rating conflict policy: a non-zero target rating wins by default.
 * TMDB 评分冲突策略：默认保留目标非 0 分。
 */
import { describe, expect, it } from 'vitest';
import { planTmdbWrites } from '../../src/rules/tmdb-write-plan';
import type { TmdbAccountStates } from '../../src/types';

const states = (rating: number | null): TmdbAccountStates => ({
  id: 1,
  favorite: false,
  rated: rating == null ? false : { value: rating },
  watchlist: false,
});

const plan = {
  skip: false,
  watchlist: null,
  rating: 6,
  reason: 'test',
};

describe('planTmdbWrites rating profile', () => {
  it('keeps a non-zero TMDB rating by default', () => {
    const patch = planTmdbWrites(states(9), plan, 'tmdb_prefer');
    expect(patch.setRating).toBeNull();
    expect(patch.shouldWrite).toBe(false);
  });

  it('fills an empty TMDB rating', () => {
    const patch = planTmdbWrites(states(null), plan, 'tmdb_prefer');
    expect(patch.setRating).toBe(6);
  });

  it('treats zero as empty rather than a protected target rating', () => {
    const patch = planTmdbWrites(states(0), plan, 'tmdb_prefer');
    expect(patch.setRating).toBe(6);
  });

  it('overwrites a non-zero TMDB rating only with overwrite', () => {
    const patch = planTmdbWrites(states(9), plan, 'overwrite');
    expect(patch.setRating).toBe(6);
  });
});
