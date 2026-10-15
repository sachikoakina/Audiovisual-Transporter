/**
 * TMDB title matching — decide which real entity a NeoDB title refers to.
 * TMDB 标题匹配 —— 判定一个 NeoDB 标题对应的是哪个真实实体。
 *
 * Zero I/O, zero environment reads. This decides whether a rating lands on the intended TMDB
 * item or on a stranger's entry with a similar name, which is exactly why it is separated from
 * the TMDB client and asserted directly against literal search results.
 * 零 I/O、零环境读取。它决定一个评分是落在预期的那条 TMDB 条目上，还是落在同名陌生条目上；
 * 这正是把它从 TMDB 客户端里拆出来、并直接用字面量搜索结果断言的原因。
 */
import type { TmdbSearchResult } from '../types';

/**
 * Canonical comparison key for a title.
 * Case-folded and whitespace-stripped, so `"The  Matrix"` and `"the matrix"` collide.
 * Shared with the NeoDB catalog search (`clients/neodb-catalog.ts`) so both matchers compare
 * titles by the exact same rule.
 *
 * 标题的规范化比较键。大小写折叠并去掉全部空白，因此 `"The  Matrix"` 与 `"the matrix"` 视为
 * 同一键。与 NeoDB 目录搜索（`clients/neodb-catalog.ts`）共用，使两个匹配器用完全相同的规则
 * 比较标题。
 */
export function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '');
}

/** Every title a TMDB search result could be matched under. / 一条 TMDB 搜索结果可能用来匹配的全部标题。 */
function titleCandidates(result: TmdbSearchResult): string[] {
  return [
    result.title,
    result.original_title,
    result.name,
    result.original_name,
  ].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/** Release year of a result, from either the film or the TV date field. / 搜索结果的发行年份，取电影或剧集的日期字段。 */
function resultYear(result: TmdbSearchResult): number | undefined {
  const raw = result.release_date || result.first_air_date;
  const match = raw?.match(/^(\d{4})/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Exact normalized title match only — never settle for the closest hit.
 *
 * `expectedYear` is optional: when supplied, the year must be within `tolerance` (default ±1,
 * because release years routinely differ by one between regions and databases).
 *
 * 只接受规范化后完全相同的标题 —— 绝不退而取「最接近」的结果。
 *
 * `expectedYear` 可选：提供时，年份必须落在 `tolerance` 之内（默认 ±1，因为不同地区与数据库
 * 记录的上映年份经常相差一年）。
 */
export function pickExactTmdbMatch(
  results: TmdbSearchResult[],
  title: string,
  expectedYear?: number,
  tolerance = 1,
): TmdbSearchResult | null {
  const wanted = normalizeTitleKey(title);
  if (!wanted) {
    return null;
  }

  return (
    results.find((result) => {
      const titles = titleCandidates(result).map(normalizeTitleKey);
      if (!titles.includes(wanted)) {
        return false;
      }
      if (expectedYear == null) {
        return true;
      }
      const year = resultYear(result);
      return year != null && Math.abs(year - expectedYear) <= tolerance;
    }) ?? null
  );
}
