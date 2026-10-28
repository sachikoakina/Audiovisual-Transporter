/**
 * Path ③'s year soft filter: only anime (2) and real-action (6), only when both sides have a year.
 * 链路③ 的年份软过滤：只对动画（2）与真人（6）启用，且只在双方都有年份时比较。
 *
 * The rule exists because exact-title matching can collide with a remake. The important half is
 * what happens when the data is missing: a missing year must **pass**, never reject. These tests
 * pin that three-valued behaviour, the type gate, and the fact that "no source year" is exactly
 * the old first-exact-title path.
 * 这条规则是为了处理「精确同名撞上翻拍」。更重要的是缺数据时怎么办：缺年份必须**放行**，绝不拒绝。
 * 下面这些用例钉住三态行为、类型门控，以及「没有源年份就完全等于旧的第一个精确同名」。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  bangumiSubjectYear,
  exactBangumiCandidates,
  pickExactBangumiMatch,
  pickExactBangumiMatchByYear,
  type BangumiSubject,
} from '../../src/clients/bangumi';

/** One search result, with only the fields the matcher cares about. / 一条搜索结果，只带匹配用得到的字段。 */
function subject(over: Partial<BangumiSubject>): BangumiSubject {
  return {
    id: 1,
    type: 2,
    name: 'Dune',
    name_cn: '沙丘',
    ...over,
  };
}

describe('bangumiSubjectYear', () => {
  it('reads air_year first, then air_date, then date', () => {
    expect(bangumiSubjectYear(subject({ air_year: 2021 }))).toBe(2021);
    expect(bangumiSubjectYear(subject({ air_date: '2020-10-01' }))).toBe(2020);
    expect(bangumiSubjectYear(subject({ date: '1999-05-01' }))).toBe(1999);
    expect(
      bangumiSubjectYear(
        subject({ air_year: 2021, air_date: '1999-01-01', date: '1980-01-01' }),
      ),
    ).toBe(2021);
  });

  it('returns null when no usable date exists', () => {
    expect(bangumiSubjectYear(subject({}))).toBeNull();
    expect(bangumiSubjectYear(subject({ air_date: 'unknown' }))).toBeNull();
    expect(bangumiSubjectYear(subject({ air_year: 0 }))).toBeNull();
  });
});

describe('exactBangumiCandidates', () => {
  it('returns every exact title match, not just the first', () => {
    const original = subject({ id: 1, name: 'Dune', name_cn: '沙丘', air_year: 1984 });
    const remake = subject({ id: 2, name: 'Dune', name_cn: '沙丘', air_year: 2021 });
    const other = subject({ id: 3, name: 'Dune Part Two', name_cn: '沙丘 2' });

    expect(exactBangumiCandidates([original, other, remake], '沙丘')).toEqual([
      original,
      remake,
    ]);
  });

  it('normalizes case and surrounding whitespace, and ignores an empty title', () => {
    const candidate = subject({ id: 1, name: 'DUNE', name_cn: '沙丘' });

    expect(exactBangumiCandidates([candidate], ' dune ')).toEqual([candidate]);
    expect(exactBangumiCandidates([candidate], '   ')).toEqual([]);
  });

  it('keeps pickExactBangumiMatch returning the first candidate', () => {
    const first = subject({ id: 1 });
    const second = subject({ id: 2 });

    expect(pickExactBangumiMatch([first, second], '沙丘')).toBe(first);
    expect(pickExactBangumiMatch([], '沙丘')).toBeNull();
  });
});

describe('pickExactBangumiMatchByYear', () => {
  it('accepts an exact year and a one-year drift', async () => {
    await expect(
      pickExactBangumiMatchByYear([subject({ air_year: 2020 })], 2020, 1),
    ).resolves.toEqual(expect.objectContaining({ id: 1 }));
    await expect(
      pickExactBangumiMatchByYear([subject({ air_year: 2021 })], 2020, 1),
    ).resolves.toEqual(expect.objectContaining({ id: 1 }));
  });

  it('rejects a two-year drift and tries the next candidate', async () => {
    const remake = subject({ id: 2, air_year: 2020 });
    const first = subject({ id: 1, air_year: 2022 });

    await expect(pickExactBangumiMatchByYear([first, remake], 2020, 1)).resolves.toBe(
      remake,
    );
  });

  it('returns null when every candidate is rejected', async () => {
    await expect(
      pickExactBangumiMatchByYear(
        [subject({ air_year: 2022 }), subject({ id: 2, air_year: 2023 })],
        2020,
        1,
      ),
    ).resolves.toBeNull();
  });

  it('does not call the resolver at all when the source year is unknown', async () => {
    const resolveYear = vi.fn(() => 2022);
    const first = subject({ id: 1 });

    await expect(
      pickExactBangumiMatchByYear([first], null, 1, resolveYear),
    ).resolves.toBe(first);
    expect(resolveYear).not.toHaveBeenCalled();
  });

  it('lets a candidate with an unknown year pass instead of rejecting it', async () => {
    const undated = subject({ id: 1 });

    await expect(
      pickExactBangumiMatchByYear([undated], 2020, 1, () => null),
    ).resolves.toBe(undated);
  });

  it('leaves books, music and games out of the year filter entirely', async () => {
    const book = subject({ id: 1, type: 1, date: '1990-01-01' });
    const music = subject({ id: 2, type: 3, date: '1990-01-01' });
    const game = subject({ id: 3, type: 4, date: '1990-01-01' });
    const resolveYear = vi.fn((item: BangumiSubject) => bangumiSubjectYear(item));

    await expect(
      pickExactBangumiMatchByYear([book, music, game], 2020, 1, resolveYear),
    ).resolves.toBe(book);
    expect(resolveYear).not.toHaveBeenCalled();
  });

  it('applies the filter to real-action (6) as well as anime (2)', async () => {
    const real = subject({ id: 1, type: 6, air_year: 2022 });

    await expect(pickExactBangumiMatchByYear([real], 2020, 1)).resolves.toBeNull();
  });

  it('returns null for an empty candidate list', async () => {
    await expect(pickExactBangumiMatchByYear([], 2020, 1)).resolves.toBeNull();
  });
});
