/**
 * The sweep rule: an entry may only be removed if this run actually examined it.
 * 淘汰规则：只有本轮真的检查过的条目，才可能被移除。
 *
 * The old rule read "absent from the log" as "fixed". That was true only while every run walked
 * everything; once a run is capped at 200 items, absence mostly means "never reached". These
 * claims pin the replacement: the coverage set comes from `PathReport.scannedIds`, an uncovered
 * entry is frozen (and its miss streak reset), and a run without a report sweeps nothing.
 * 旧规则把「日志里没有」读成「修好了」。这只在每轮都走完全部条目时成立；一旦单轮被 200 条
 * 截断，缺席多半只是「没走到」。这里钉住替代方案：覆盖集合来自 `PathReport.scannedIds`，
 * 未覆盖的条目被冻结（缺席计数清零），而没有报表的一轮一条都不淘汰。
 *
 * ⑤'s fixtures are keyed by its absolutized NeoDB URL — the identity the path records into
 * `scannedIds`. That pairing is the regression pin: when ⑤'s coverage was title-based while its
 * entries could be URL-keyed, a URL-keyed entry could never be covered and froze forever.
 * ⑤ 的 fixture 一律按绝对化后的 NeoDB URL 建 key —— 与链路写进 `scannedIds` 的身份相同。
 * 这组配对本身就是回归钉：过去覆盖集合按标题记、而条目可能按 URL 建 key，URL key 的条目
 * 永远无法被覆盖、会被永久冻结。
 */
import { describe, expect, it } from 'vitest';
import {
  coverageFromReport,
  dropLegacyTmdbTitleKeys,
  merge,
  type ReviewItem,
} from '../../scripts/review-queue.mjs';

const RUN_AT = '2026-10-28T08:00:00.000Z';
const TMDB_URL = 'https://neodb.social/movie/1';
const TMDB_URL_2 = 'https://neodb.social/movie/2';

/** One entry as `state.json` carries it, already past its observation window. / 一条已过观察期的名单条目。 */
function entry(over: Partial<ReviewItem>): ReviewItem {
  return {
    key: `neodb→tmdb::${TMDB_URL}`,
    kind: 'unresolved',
    source: 'neodb→tmdb',
    reason: 'no-tmdb-match',
    title: '沙丘',
    url: TMDB_URL,
    id: '',
    firstSeenAt: RUN_AT,
    lastSeenAt: RUN_AT,
    missedRuns: 0,
    seenCount: 2,
    ...over,
  };
}

/** Coverage as `coverageFromReport` would build it from one path's report. / 按一条链路的报表构造覆盖集合。 */
function coverage(
  ids: string[],
  over: { capped?: boolean; aborted?: boolean; unresolved?: number } = {},
) {
  return coverageFromReport({
    version: 1,
    paths: [
      {
        label: 'NeoDB → TMDB',
        scannedIds: ids,
        capped: over.capped ?? false,
        aborted: over.aborted ?? false,
        unresolved: over.unresolved ?? 0,
      },
    ],
  });
}

describe('coverageFromReport', () => {
  it('joins the report label back to the list source and keeps the scanned identities', () => {
    const map = coverage([TMDB_URL, TMDB_URL_2]);

    expect(map.get('neodb→tmdb')?.ids).toEqual(new Set([TMDB_URL, TMDB_URL_2]));
    expect(map.get('neodb→tmdb')?.complete).toBe(true);
  });

  it('marks a capped or aborted path as incomplete', () => {
    expect(coverage([], { capped: true }).get('neodb→tmdb')?.complete).toBe(false);
    expect(coverage([], { aborted: true }).get('neodb→tmdb')?.complete).toBe(false);
  });

  it('ignores a report path that is not a review-list source', () => {
    const map = coverageFromReport({
      version: 1,
      paths: [{ label: 'Douban RSS', scannedIds: [] }],
    });

    expect(map.size).toBe(0);
  });
});

describe('merge — covered absences', () => {
  it('counts one miss, then removes on the second covered absence', () => {
    const first = merge([entry({})], [], RUN_AT, coverage([TMDB_URL]));

    expect(first.removed).toHaveLength(0);
    expect(first.uncovered).toHaveLength(0);
    expect(first.items[0]?.missedRuns).toBe(1);

    const second = merge(first.items, [], RUN_AT, coverage([TMDB_URL]));

    expect(second.removed.map((item) => item.key)).toEqual([`neodb→tmdb::${TMDB_URL}`]);
    expect(second.items).toHaveLength(0);
  });

  it('treats an empty observed set as genuine only when the report counted no unresolved items', () => {
    // A parser break: the report says 1 unresolved, the log yielded none. Freeze.
    // 解析器失效：报表计了 1 条未匹配，日志一条都没解析到。冻结。
    const broken = merge(
      [entry({ missedRuns: 1 })],
      [],
      RUN_AT,
      coverage([TMDB_URL], { unresolved: 1 }),
    );

    expect(broken.degraded).not.toBe('');
    expect(broken.removed).toHaveLength(0);
    expect(broken.items[0]?.missedRuns).toBe(1);

    // Genuine zero: the report also counted nothing, so the silence can be trusted.
    // 真正的 0 条：报表也计了 0，这份沉默可信。
    const fixed = merge(
      [entry({})],
      [],
      RUN_AT,
      coverage([TMDB_URL], { unresolved: 0 }),
    );

    expect(fixed.degraded).toBe('');
    expect(fixed.items[0]?.missedRuns).toBe(1);
  });
});

describe('merge — uncovered absences', () => {
  it('freezes an entry the run never examined, even after a previous miss', () => {
    const previous = entry({ missedRuns: 1 });
    const result = merge([previous], [], RUN_AT, coverage([TMDB_URL_2]));

    expect(result.removed).toHaveLength(0);
    expect(result.uncovered.map((item) => item.key)).toEqual([previous.key]);
    // The streak is broken: "two consecutive rounds" only means anything while every round
    // actually looked at the item.
    // 连续两轮只有在每一轮都真的看过该条目时才有意义，因此这里清零。
    expect(result.items[0]?.missedRuns).toBe(0);
    expect(result.items[0]?.lastSeenAt).toBe(RUN_AT);
  });

  it('sweeps nothing when there is no run report at all', () => {
    const previous = entry({ missedRuns: 1 });
    const result = merge([previous], [], RUN_AT, null);

    expect(result.removed).toHaveLength(0);
    expect(result.uncovered).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  it('treats a report without scannedIds as empty coverage, not as "nothing scanned"', () => {
    const map = coverageFromReport({
      version: 1,
      paths: [{ label: 'NeoDB → TMDB' }],
    });
    const result = merge([entry({})], [], RUN_AT, map);

    expect(result.removed).toHaveLength(0);
    expect(result.uncovered).toHaveLength(1);
  });

  it('matches a title-keyed entry too — the fallback for a mark whose url came back empty', () => {
    // ⑤ falls back to the label as identity when `item.url` is empty, so the title-keyed form
    // stays a legal shape; the report's bare title (no `title:` marker) must still match it.
    // `item.url` 为空时 ⑤ 回退到标签作身份，因此按标题建 key 仍是合法形态；报表里的裸标题
    // （不带 `title:` 标记）必须仍能与它对上。
    const previous = entry({ key: 'neodb→tmdb::title:沙丘', url: '' });
    const result = merge([previous], [], RUN_AT, coverage(['沙丘']));

    expect(result.uncovered).toHaveLength(0);
    expect(result.items[0]?.missedRuns).toBe(1);
  });
});

describe('merge — observed entries', () => {
  it('refreshes a covered entry that was reported again, without counting a miss', () => {
    const previous = entry({ missedRuns: 1 });
    const observed = entry({ kind: 'unresolved', reason: 'no-tmdb-match' });
    const result = merge([previous], [observed], RUN_AT, coverage([TMDB_URL]));

    expect(result.removed).toHaveLength(0);
    expect(result.uncovered).toHaveLength(0);
    expect(result.items[0]?.missedRuns).toBe(0);
    expect(result.items[0]?.seenCount).toBe(3);
  });
});

describe('dropLegacyTmdbTitleKeys — one-time ⑤ re-baseline', () => {
  it('drops only ⑤ entries keyed by title, keeping every other path untouched', () => {
    const legacy = entry({ key: 'neodb→tmdb::title:流浪地球3(下)', url: '' });
    const otherPath = entry({
      key: 'douban→neodb::https://book.douban.com/subject/2/',
      source: 'douban→neodb',
      title: '天仙配',
      url: 'https://book.douban.com/subject/2/',
    });
    const current = entry({});

    const kept = dropLegacyTmdbTitleKeys([legacy, otherPath, current]);

    expect(kept).toEqual([otherPath, current]);
  });

  it('returns the same array when there is nothing to drop', () => {
    const items = [
      entry({}),
      entry({ key: `neodb→tmdb::${TMDB_URL_2}`, url: TMDB_URL_2 }),
    ];

    expect(dropLegacyTmdbTitleKeys(items)).toBe(items);
  });
});
