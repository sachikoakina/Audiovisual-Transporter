/**
 * Vocabulary shared by the review queue and the sync paths.
 *
 * The queue groups entries by item type and by the user's own state on the source. Both are
 * source-specific: Douban names five categories and three statuses, Bangumi numbers six subject
 * types and five collection types, NeoDB uses its own category and shelf names. This module is the
 * single place that turns those into one small closed vocabulary, so the queue never has to know
 * which platform an entry came from.
 *
 * 待核对名单与各同步链路共用的词汇。
 *
 * 名单要按条目类型和用户状态分组，而这两样都是各平台自己的说法：豆瓣是五个分类、三种状态，
 * Bangumi 是六个 subject type、五种收藏类型，NeoDB 又是另一套分类与书架名。这个模块是唯一把它们
 * 收敛成一个小闭集的地方，名单因此不必知道条目来自哪个平台。
 */

/** Display order, and the complete set of groups the list may produce. / 展示顺序，也是名单可能产生的全部分组。 */
export const REVIEW_CATEGORIES = [
  'movie',
  'tv',
  'anime',
  'book',
  'music',
  'game',
  'podcast',
  'performance',
  'other',
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** Display order for the user's state; `unknown` is the fallback. / 用户状态的展示顺序；`unknown` 是兜底。 */
export const REVIEW_SHELVES = [
  'wishlist',
  'progress',
  'complete',
  'on_hold',
  'dropped',
  'unknown',
] as const;

export type ReviewShelf = (typeof REVIEW_SHELVES)[number];

/**
 * Bangumi subject types, as numbers: 1 book, 2 anime, 3 music, 4 game, 6 real-action.
 * `6` covers both films and TV, and the source does not distinguish them — the honest bucket is
 * `tv` only because the queue's `movie` bucket already holds Douban's mixed feed.
 *
 * Bangumi 的 subject type：1 书籍、2 动画、3 音乐、4 游戏、6 三次元。6 同时包含电影与剧集，源端
 * 不做区分；归入 `tv` 只是因为 `movie` 已经承载了豆瓣那个混合 feed。
 */
const BANGUMI_SUBJECT_TYPE: Record<number, ReviewCategory> = {
  1: 'book',
  2: 'anime',
  3: 'music',
  4: 'game',
  6: 'tv',
};

/** Bangumi collection types: 1 wish, 2 done, 3 doing, 4 on-hold, 5 dropped. / 收藏类型。 */
const BANGUMI_COLLECTION_TYPE: Record<number, ReviewShelf> = {
  1: 'wishlist',
  2: 'complete',
  3: 'progress',
  4: 'on_hold',
  5: 'dropped',
};

/** Douban's `drama` is a stage play, which NeoDB calls `performance`. / 豆瓣的话剧对应 NeoDB 的演出。 */
const CATEGORY_ALIASES: Record<string, ReviewCategory> = {
  drama: 'performance',
  real: 'tv',
};

const SHELF_ALIASES: Record<string, ReviewShelf> = {
  doing: 'progress',
  hold: 'on_hold',
  onhold: 'on_hold',
};

function asNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Normalise a source's category to the queue's vocabulary. Numbers are Bangumi subject types;
 * strings are Douban / NeoDB names. Anything unrecognised becomes `other`, because dropping the
 * entry would hide the very gap the list exists to show.
 *
 * 把源端的分类收敛到名单词汇。数字按 Bangumi subject type 解释，字符串按豆瓣／NeoDB 名称解释；
 * 认不出的归入 `other` —— 丢弃条目会让名单藏起它本该暴露的缺口。
 */
export function normalizeReviewCategory(
  value: string | number | null | undefined,
): ReviewCategory {
  const numeric = asNumber(value);
  if (numeric !== null) {
    return BANGUMI_SUBJECT_TYPE[numeric] ?? 'other';
  }
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  if ((REVIEW_CATEGORIES as readonly string[]).includes(key)) {
    return key as ReviewCategory;
  }
  return CATEGORY_ALIASES[key] ?? 'other';
}

/**
 * Normalise a user state to the queue's vocabulary. Numbers are Bangumi collection types;
 * strings are Douban / NeoDB shelf names.
 *
 * 把用户状态收敛到名单词汇。数字按 Bangumi 收藏类型解释，字符串按豆瓣／NeoDB 书架名解释。
 */
export function normalizeReviewShelf(
  value: string | number | null | undefined,
): ReviewShelf {
  const numeric = asNumber(value);
  if (numeric !== null) {
    return BANGUMI_COLLECTION_TYPE[numeric] ?? 'unknown';
  }
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  if ((REVIEW_SHELVES as readonly string[]).includes(key)) {
    return key as ReviewShelf;
  }
  return SHELF_ALIASES[key] ?? 'unknown';
}

/**
 * The suffix appended to per-item log lines: `{movie|wishlist}`. Curly braces keep it apart from
 * the `标题[链接]` shape, and the parser strips it before splitting the label.
 *
 * 追加在逐条日志行末尾的后缀：`{movie|wishlist}`。花括号使它不与 `标题[链接]` 混淆，解析器会先
 * 摘掉它再拆标签。
 */
export function reviewMetaSuffix(
  category: string | number | null | undefined,
  shelf: string | number | null | undefined,
): string {
  return `{${normalizeReviewCategory(category)}|${normalizeReviewShelf(shelf)}}`;
}
