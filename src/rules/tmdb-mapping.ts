/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MAPPING — NeoDB shelf_type → TMDB operations.
 *
 *  This is the single source of truth for sync behaviour. To change what the
 *  sync does, change this table; nothing else encodes mapping knowledge.
 *  The NeoDB-side extractors this table relies on are in the lower half of the
 *  same file, so the whole rule really is in one place.
 *
 *  本映射表就是同步行为的唯一真源。要改变同步做什么，就改这张表；没有其他地方
 *  编码映射知识。本表依赖的 NeoDB 侧提取函数就在同一文件的下半部分，因此这条
 *  规则确实集中在一处。
 *
 *  | shelf_type | TMDB operation                                              |
 *  |------------|-------------------------------------------------------------|
 *  | wishlist   | add to watchlist                                            |
 *  | progress   | add to watchlist (TMDB has no "in progress" state)          |
 *  | complete   | rating_grade > 0 → set rating, remove from watchlist        |
 *  |            | otherwise        → add to watchlist                        |
 *  | dropped    | skip — do nothing on TMDB                                   |
 *
 *  Two consequences worth knowing:
 *
 *  1. `progress` adds to the watchlist rather than removing it. TMDB cannot
 *     express "in progress", so an in-progress item is treated as still-to-watch.
 *
 *  2. `complete` with no rating ALSO adds to the watchlist. TMDB has no
 *     "watched" flag, and rating is the closest available expression of having
 *     watched something — so an unrated completed item has no way to say
 *     "watched", and falls back to the watchlist. This means a watched-but-
 *     unrated item ends up looking like "want to watch". It is what the
 *     mapping specifies; it is called out here so it is never a surprise.
 *
 *  两个值得知道的后果：
 *
 *  1. `progress` 是加入 watchlist，而不是移出。TMDB 无法表达「在看」，因此「在看」
 *     的条目被当作「还想看」处理。
 *
 *  2. 无评分的 `complete` 也会加入 watchlist。TMDB 没有「已看」标记，而评分是「看过」
 *     最接近的表达方式 —— 因此无评分的已看条目无法表达「已看」，只能退化为加入
 *     watchlist。也就是说「看过但没评分」的条目最终看起来像「想看」。这是映射表
 *     明确规定的行为；写在这里，是为了让它永远不会成为意外。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type {
  NeodbCategory,
  NeodbItem,
  ShelfType,
  TmdbAccountStates,
  TmdbMediaType,
} from '../types';

// ───────────────────────────────────────────────────────────────────────────
// NeoDB-side facts and extractors
// NeoDB 侧的事实与提取函数
//
// These read what NeoDB said about an item. They perform no network calls, so
// they can be asserted against literal `NeodbItem` objects.
//
// 这些函数解读 NeoDB 关于某个条目的描述。它们不发起任何网络请求，因此可以直接
// 用字面量 `NeodbItem` 对象断言。
// ───────────────────────────────────────────────────────────────────────────

/**
 * NeoDB category → TMDB media type.
 * Anything absent here has no TMDB counterpart and is dropped before any
 * network call (book / music / game / podcast / performance).
 *
 * NeoDB category → TMDB 媒体类型。不在此表内的一律没有 TMDB 对应物，会在任何网络
 * 请求之前就被丢弃（book / music / game / podcast / performance）。
 */
export const NEODB_TO_TMDB_MEDIA_TYPE: Partial<Record<NeodbCategory, TmdbMediaType>> = {
  movie: 'movie',
  tv: 'tv',
};

/** NeoDB categories with no TMDB counterpart at all. / 完全没有 TMDB 对应物的 NeoDB 分类。 */
export const NEODB_CATEGORIES_WITHOUT_TMDB: ReadonlySet<string> =
  new Set<NeodbCategory>(['book', 'music', 'game', 'podcast', 'performance']);

/**
 * NeoDB rating_grade (0–10, integer) → TMDB rating (0.5–10, step 0.5).
 *
 * Both are 10-point scales, so this is step alignment rather than rescaling.
 * NeoDB uses 0 to mean "unrated", which becomes `null` so callers neither write
 * nor delete — deleting would wipe a rating the user set by hand on TMDB.
 *
 * This function is also what makes the mapping's "rating_grade > 0" test exact:
 * a 0 / null / undefined grade yields null, anything else yields a usable rating.
 *
 * NeoDB 的 rating_grade（0–10 整数）→ TMDB 评分（0.5–10，步长 0.5）。
 *
 * 两者都是 10 分制，所以这里是**步长对齐**而不是重新换算。NeoDB 用 0 表示「未评分」，
 * 这里转成 `null`，使调用方既不写入也不删除 —— 删除会抹掉用户在 TMDB 上手动设的评分。
 *
 * 这个函数也正使映射表里的 "rating_grade > 0" 判断精确：0 / null / undefined 都得
 * `null`，其余都得到可用的评分。
 */
export function neodbGradeToTmdbRating(
  grade: number | null | undefined,
): number | null {
  if (grade == null || !Number.isFinite(grade) || grade <= 0) {
    return null;
  }
  const snapped = Math.round(grade * 2) / 2;
  return Math.min(Math.max(snapped, 0.5), 10);
}

/** Read an existing TMDB rating defensively (`rated` may be `false`). / 防御性地读取 TMDB 现有评分（`rated` 可能是 `false`）。 */
/**
 * The rating already on TMDB, or `null` when there is none.
 * TMDB 上已有的评分；没有则 `null`。
 *
 * Takes a *read* states object, never a maybe-null: accepting `null` was how "could not read"
 * became "no rating yet", and the write plan then had no way to tell the two apart.
 * 参数是**读到的** states，不接受可空：以前接受 `null` 正是「读不到」变成「还没有评分」的路径，
 * 而写计划从此再也分不清这两者。
 */
export function extractTmdbRating(states: TmdbAccountStates): number | null {
  const rated = states.rated;
  if (rated && typeof rated === 'object' && typeof rated.value === 'number') {
    return rated.value;
  }
  return null;
}

/**
 * Release year, best effort.
 * Verified: `year` exists on movie/tv items, `pub_year` on books. Books are
 * never synced, but probing both keeps this robust if that changes.
 *
 * 发行年份，尽力而为。已实测：`year` 存在于 movie/tv 条目，`pub_year` 存在于图书。
 * 图书从不参与同步，但同时探测两者可以让它在情况变化时依然稳健。
 */
export function extractNeodbYear(item: NeodbItem): number | undefined {
  for (const candidate of [item.year, item.pub_year]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return undefined;
}

/** Extract a TMDB target from NeoDB external_resources, if the link is present. / 若存在该外链，从 NeoDB 的 external_resources 中提取 TMDB 目标。 */
export function extractTmdbTargetFromNeodb(
  item: NeodbItem,
): { mediaType: TmdbMediaType; id: number } | null {
  for (const resource of item.external_resources ?? []) {
    const match = resource.url?.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    if (match?.[1] && match[2]) {
      const mediaType = match[1].toLowerCase() === 'tv' ? 'tv' : 'movie';
      return { mediaType, id: Number(match[2]) };
    }
  }
  return null;
}

/**
 * May a NeoDB item's own TMDB link be trusted for this media type?
 * NeoDB 条目自带的 TMDB 外链，对这个媒体类型是否可信？
 *
 * Strict equality, with no allowlist of "compatible" pairs: there is no pair that is legitimately
 * different. A `movie` link on a `tv` item points at another entity — it is not a near miss, and the
 * link level is the only level that compares nothing, so this is its minimum evidence.
 *
 * TV seasons are covered without a special case: a season's category is `tv`, so a `tv/N` link
 * agrees. What such a link loses is *which* season, and that is a separate, semantics-level
 * question this check deliberately does not answer.
 *
 * 严格相等，不设「兼容」白名单：没有任何一对是合理不同的。`tv` 条目上的 `movie` 外链指向的是另一个
 * 实体 —— 它不是差一点，而外链那一级是唯一不做任何比较的一级，这就是它的最低证据。
 *
 * 剧集的季不需要特例：季的 category 是 `tv`，因此 `tv/N` 外链是相符的。这类外链丢失的是**哪一季**，
 * 那是另一个语义层面的问题，本检查刻意不回答。
 */
export function isLinkTypeCompatible(
  linkMediaType: TmdbMediaType | string | undefined,
  itemMediaType: TmdbMediaType,
): boolean {
  return linkMediaType === itemMediaType;
}

/** Extract an IMDb id from NeoDB external_resources, if the link is present. / 若存在该外链，从 NeoDB 的 external_resources 中提取 IMDb id。 */
export function extractImdbIdFromNeodb(item: NeodbItem): string | null {
  for (const resource of item.external_resources ?? []) {
    const match = resource.url?.match(/imdb\.com\/title\/(tt\d+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/** Candidate titles for search: display_title, title, then localized titles. / 用于搜索的候选标题：display_title、title，然后是本地化标题。 */
export function collectTitles(item: NeodbItem): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  push(item.display_title);
  push(item.title);
  for (const localized of item.localized_title ?? []) {
    push(localized.text);
  }
  return out;
}

/** Normalise a shelf_type value coming from the API. / 规范化 API 返回的 shelf_type 取值。 */
export function toShelfType(value: string): ShelfType | null {
  switch (value) {
    case 'wishlist':
    case 'progress':
    case 'complete':
    case 'dropped':
      return value;
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The mapping itself
// 映射表本体
// ───────────────────────────────────────────────────────────────────────────

/** The TMDB operations a shelf state resolves to. / 一个书架状态解析出的 TMDB 操作。 */
export type TmdbOperationPlan = {
  /** true = perform no TMDB operation at all. / true = 完全不产生 TMDB 操作。 */
  skip: boolean;
  /** true = add to watchlist, false = remove from watchlist, null = leave alone. / true = 加入 watchlist，false = 移出 watchlist，null = 保持不动。 */
  watchlist: boolean | null;
  /** TMDB rating to write (0.5–10), or null = write no rating. / 要写入的 TMDB 评分（0.5–10），null = 不写评分。 */
  rating: number | null;
  /** Human-readable explanation, surfaced in logs and dry-run output. / 人类可读的解释，会出现在日志与 dry-run 输出里。 */
  reason: string;
};

/**
 * Resolve a NeoDB shelf state into TMDB operations.
 *
 * Pure and reusable: same inputs always produce the same plan, no I/O, no
 * config access. `ratingGrade` is only consulted for `complete`.
 *
 * 把 NeoDB 的一个书架状态解析为 TMDB 操作。
 *
 * 纯函数、可复用：同样的输入永远产出同样的计划，无 I/O、不读配置。
 * `ratingGrade` 只在 `complete` 时被参考。
 */
export function resolveTmdbOperations(
  shelfType: ShelfType,
  ratingGrade: number | null | undefined,
): TmdbOperationPlan {
  switch (shelfType) {
    case 'wishlist':
      return {
        skip: false,
        watchlist: true,
        rating: null,
        reason: '想看 → 加入 watchlist',
      };

    case 'progress':
      return {
        skip: false,
        // TMDB has no "in progress" state, so it is treated as still-to-watch.
        // TMDB 没有「在看」状态，因此按「还想看」处理。
        watchlist: true,
        rating: null,
        reason: '在看 → TMDB 无该状态，归入 watchlist',
      };

    case 'complete': {
      // 0 / null / undefined all mean "unrated" and normalise to null.
      // 0 / null / undefined 都表示「未评分」，统一归一为 null。
      const rating = neodbGradeToTmdbRating(ratingGrade);

      if (rating !== null) {
        return {
          skip: false,
          // The rating itself carries "watched", so the item leaves the watchlist.
          // 评分本身就承载了「看过」，因此该条目要移出 watchlist。
          watchlist: false,
          rating,
          reason: `看过(评分 ${ratingGrade}) → 写入评分 ${rating} 并移出 watchlist`,
        };
      }

      return {
        skip: false,
        // No rating → nothing can express "watched" → fall back to watchlist.
        // 无评分 → 无法表达「已看」→ 退化为加入 watchlist。
        watchlist: true,
        rating: null,
        reason: '看过但无评分 → TMDB 无"已看"态，退化为加入 watchlist',
      };
    }

    case 'dropped':
      return {
        skip: true,
        watchlist: null,
        rating: null,
        reason: '弃看 → 跳过，不产生任何 TMDB 操作（不当作想看）',
      };
  }
}
