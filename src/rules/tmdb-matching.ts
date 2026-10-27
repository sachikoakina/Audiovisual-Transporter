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

/**
 * Release year of a result, from either the film or the TV date field.
 *
 * Exported because the same parse is needed on the `getTmdbById` response: a TMDB *link* points at
 * an entity the user chose, so the only thing left to sanity-check is whether that entity's year is
 * anywhere near the NeoDB item's. Two copies of `/^(\d{4})/` would drift the day TMDB adds a field.
 *
 * 搜索结果的发行年份，取电影或剧集的日期字段。
 *
 * 导出是因为 `getTmdbById` 的响应需要同一次解析：TMDB **外链**指向的是用户自己选的实体，剩下
 * 唯一值得核对的就是它的年份与 NeoDB 条目是否大致相当。两份 `/^(\d{4})/` 迟早会走样。
 */
export function tmdbResultYear(result: TmdbSearchResult): number | undefined {
  const raw = result.release_date || result.first_air_date;
  const match = raw?.match(/^(\d{4})/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Exact normalized title match only — never settle for the closest hit.
 *
 * `expectedYear` is **required** and the candidate must carry a date inside `tolerance`
 * (default ±1, because release years routinely differ by one between regions and databases).
 *
 * It used to be optional, and the branch it skipped was the whole problem: with `expectedYear`
 * undefined the function returned `true` on a title match alone, so 338 of one run's 2 904 items
 * were settled by title with nothing else checked, and six known wrong writes came out of it. The
 * parameter is now mandatory so that "compare years" cannot be skipped by forgetting to pass one —
 * a caller that has no year must not reach this function at all (see `resolveTmdbTarget`).
 *
 * 只接受规范化后完全相同的标题 —— 绝不退而取「最接近」的结果。
 *
 * `expectedYear` **必填**，且候选必须带日期并落在 `tolerance` 之内（默认 ±1，因为不同地区与数据库
 * 记录的上映年份经常相差一年）。
 *
 * 它原先是可选的，而它跳过的那个分支正是问题本身：`expectedYear` 为 undefined 时函数仅凭标题
 * 相等就返回 `true`，于是某轮 2 904 条里有 338 条只由标题定案，已知的六次错写全部出自这里。
 * 参数改为必填，使「比年份」不可能因为忘传一个值而被跳过 —— 拿不到年份的调用方根本不该走到这个
 * 函数（见 `resolveTmdbTarget`）。
 */
export function pickExactTmdbMatch(
  results: TmdbSearchResult[],
  title: string,
  expectedYear: number,
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
      const year = tmdbResultYear(result);
      // No date on the candidate is a rejection, not a pass: a result that cannot be dated cannot
      // be shown to be the same work, and an undated entry is exactly what one wrong write landed on.
      // 候选没有日期是拒绝而不是放行：无法定年的结果就无法证明是同一部作品，而有一次错写正是落在
      // 一条没有日期的条目上。
      return year != null && Math.abs(year - expectedYear) <= tolerance;
    }) ?? null
  );
}
