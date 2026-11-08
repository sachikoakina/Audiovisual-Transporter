/**
 * Douban complete → Bangumi progress planning.
 * 豆瓣 complete → Bangumi 进度规划。
 */
import { describe, expect, it } from 'vitest';
import {
  planBookProgress,
  planEpisodeProgress,
} from '../../src/rules/bangumi-progress';
import type {
  BangumiCollection,
  BangumiEpisode,
  BangumiEpisodeState,
  BangumiSubject,
} from '../../src/clients/bangumi';

const episode = (id: number, type: number, sort = id): BangumiEpisode => ({
  id,
  type,
  sort,
});
const state = (type: number, updatedAt = 1): BangumiEpisodeState => ({
  type,
  updatedAt,
});
const book = (overrides: Partial<BangumiCollection>): BangumiCollection =>
  ({
    subject_id: 1,
    subject_type: 1,
    rate: 0,
    type: 2,
    updated_at: '',
    private: false,
    ...overrides,
  }) as BangumiCollection;
const subject = (overrides: Partial<BangumiSubject>): BangumiSubject =>
  ({ id: 1, type: 1, name: '', name_cn: '', ...overrides }) as BangumiSubject;

describe('planEpisodeProgress', () => {
  const main = [episode(1, 0), episode(2, 0), episode(3, 0)];

  it('marks only the first main episode for a movie', () => {
    const plan = planEpisodeProgress(main, new Map(), {
      isMovie: true,
      includeSp: true,
      collected: true,
    });
    expect(plan.target).toEqual([1]);
    expect(plan.missing).toEqual([1]);
  });

  it('fills only missing main episodes for TV', () => {
    const plan = planEpisodeProgress(main, new Map([[1, state(2)]]), {
      isMovie: false,
      includeSp: false,
      collected: true,
    });
    expect(plan.target).toEqual([1, 2, 3]);
    expect(plan.missing).toEqual([2, 3]);
  });

  it('ignores SP/OP/ED unless their switches are set', () => {
    const episodes = [...main, episode(4, 1), episode(5, 2), episode(6, 3)];
    const withoutExtras = planEpisodeProgress(episodes, new Map(), {
      isMovie: false,
      includeSp: false,
      includeOpEd: false,
      collected: true,
    });
    expect(withoutExtras.target).toEqual([1, 2, 3]);
    const withSp = planEpisodeProgress(episodes, new Map(), {
      isMovie: false,
      includeSp: true,
      includeOpEd: false,
      collected: true,
    });
    expect(withSp.target).toEqual([1, 2, 3, 4]);
    const withOpEd = planEpisodeProgress(episodes, new Map(), {
      isMovie: false,
      includeSp: false,
      includeOpEd: true,
      collected: true,
    });
    expect(withOpEd.target).toEqual([1, 2, 3, 5, 6]);
  });

  it('never includes OP/ED for a movie, even when includeOpEd is set', () => {
    const episodes = [...main, episode(5, 2), episode(6, 3)];
    const plan = planEpisodeProgress(episodes, new Map(), {
      isMovie: true,
      includeSp: true,
      includeOpEd: true,
      collected: true,
    });
    expect(plan.target).toEqual([1]);
  });

  it('skips OP/ED that are already marked watched', () => {
    const episodes = [...main, episode(5, 2), episode(6, 3)];
    const states = new Map([
      [1, state(2)],
      [5, state(2)],
    ]);
    const plan = planEpisodeProgress(episodes, states, {
      isMovie: false,
      includeSp: false,
      includeOpEd: true,
      collected: true,
    });
    expect(plan.target).toEqual([1, 2, 3, 5, 6]);
    expect(plan.missing).toEqual([2, 3, 6]);
  });

  it('returns unchanged missing when every target episode is watched', () => {
    const states = new Map([
      [1, state(2)],
      [2, state(2)],
      [3, state(2)],
    ]);
    const plan = planEpisodeProgress(main, states, {
      isMovie: false,
      includeSp: false,
      collected: true,
    });
    expect(plan.missing).toEqual([]);
  });

  it('reports not-collected and no-episodes without inventing writes', () => {
    expect(
      planEpisodeProgress(main, new Map(), {
        isMovie: false,
        includeSp: false,
        collected: false,
      }).reason,
    ).toBe('not-collected');
    expect(
      planEpisodeProgress([], new Map(), {
        isMovie: true,
        includeSp: false,
        collected: true,
      }).reason,
    ).toBe('no-episodes');
  });
});

describe('planBookProgress', () => {
  it('skips when both dimensions are unknown', () => {
    expect(
      planBookProgress(book({ ep_status: 0, vol_status: 0 }), subject({})),
    ).toMatchObject({
      skip: true,
      reason: 'both-unknown',
    });
  });

  it('maxes only the known chapter dimension', () => {
    expect(
      planBookProgress(book({ ep_status: 4, vol_status: 0 }), subject({ eps: 32 })),
    ).toEqual({ epStatus: 32, volStatus: undefined, skip: false });
  });

  it('maxes only the known volume dimension', () => {
    expect(
      planBookProgress(book({ ep_status: 0, vol_status: 2 }), subject({ volumes: 8 })),
    ).toEqual({ epStatus: undefined, volStatus: 8, skip: false });
  });

  it('maxes both dimensions when both are known', () => {
    expect(
      planBookProgress(
        book({ ep_status: 4, vol_status: 2 }),
        subject({ eps: 32, volumes: 8 }),
      ),
    ).toEqual({ epStatus: 32, volStatus: 8, skip: false });
  });

  it('skips a known dimension when its total is missing', () => {
    expect(
      planBookProgress(book({ ep_status: 4, vol_status: 0 }), subject({ eps: 0 })),
    ).toMatchObject({ skip: true, reason: 'no-totals' });
  });

  it('does not rewrite an already maxed dimension', () => {
    expect(
      planBookProgress(book({ ep_status: 32, vol_status: 0 }), subject({ eps: 32 })),
    ).toMatchObject({ skip: true, reason: 'nothing-to-write' });
  });
});
