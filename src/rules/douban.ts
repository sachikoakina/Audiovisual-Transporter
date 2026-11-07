/**
 * Douban domain rules — the vocabulary Douban itself uses, and the pure mappings built on it.
 * 豆瓣领域规则 —— 豆瓣自己使用的词汇，以及建立在其上的纯映射。
 *
 * Zero I/O, zero environment reads: everything here is either a literal table or a pure
 * function, so it can be asserted directly with literal inputs.
 * 零 I/O、零环境读取：这里要么是字面量表格，要么是纯函数，因此可以直接用字面量断言。
 *
 * Absorbed from the former `const.ts`, which bundled four unrelated domains into one file.
 * 由原先的 `const.ts` 吸收而来 —— 那个文件把四个互不相关的域塞在了一处。
 */
import { ItemCategory, ItemStatus } from '../types';

/**
 * Matches any Douban RSS status prefix, capturing the status word.
 * 匹配任意豆瓣 RSS 状态前缀，并捕获状态词本身。
 *
 * Example / 例: `看过` in `看过 海边的曼彻斯特`, or `最近在看` (the optional `最近`).
 * 如 `看过 海边的曼彻斯特` 里的 `看过`，或 `最近在看`（`最近` 可选）。
 */
export const ANY_STATUS_PREFIX =
  /^(?:最近)?(看过|听过|读过|玩过|在看|在听|在读|在玩|想看|想听|想读|想玩)/;

/**
 * Same prefix, but including trailing whitespace, for `.replace()` to strip it.
 * 同一个前缀，但包含尾随空白，供 `.replace()` 直接剥掉。
 */
export const STRIP_STATUS_PREFIX =
  /^(?:最近)?(?:看过|听过|读过|玩过|在看|在听|在读|在玩|想看|想听|想读|想玩)\s*/;

/** Douban's star wording → star count (1–5). / 豆瓣的星级措辞 → 星数（1–5）。 */
export const RATING_TEXT_TO_STARS = {
  很差: 1,
  较差: 2,
  还行: 3,
  推荐: 4,
  力荐: 5,
};

/**
 * Douban status word → `ItemStatus`, per media kind.
 * The four maps are kept separate because the key set differs by medium (看/读/玩/听), and
 * they are named after the medium rather than after "state" so a reader can tell them apart.
 *
 * 豆瓣状态词 → `ItemStatus`，按媒介区分。四张表分开保留，因为键集随媒介变化（看/读/玩/听）；
 * 表名按媒介命名而不是笼统叫「State」，以便读者区分。
 */

/** 看（电影 / 电视剧 / 番组 / 舞台剧）/ watch — films, TV, stage drama. */
export const SEE_STATUS_MAP = {
  看过: ItemStatus.Complete,
  在看: ItemStatus.Progress,
  想看: ItemStatus.Wishlist,
};

/** 读（图书）/ read — books. */
export const READ_STATUS_MAP = {
  读过: ItemStatus.Complete,
  在读: ItemStatus.Progress,
  想读: ItemStatus.Wishlist,
};

/** 玩（游戏）/ play — games. */
export const PLAY_STATUS_MAP = {
  玩过: ItemStatus.Complete,
  在玩: ItemStatus.Progress,
  想玩: ItemStatus.Wishlist,
};

/** 听（音乐）/ listen — music. */
export const LISTEN_STATUS_MAP = {
  听过: ItemStatus.Complete,
  在听: ItemStatus.Progress,
  想听: ItemStatus.Wishlist,
};

/**
 * Statuses Douban RSS can express (想/在/过).
 * Destination statuses outside this set must not be overwritten by Douban→*.
 *
 * 豆瓣 RSS 能表达的状态（想/在/过）。不在此集合内的目标端状态，不得被「豆瓣 → 任意目标」
 * 的链路覆盖。
 */
export const DOUBAN_EXPRESSED_STATUSES: ReadonlySet<ItemStatus> = new Set([
  ItemStatus.Wishlist,
  ItemStatus.Progress,
  ItemStatus.Complete,
]);

/**
 * Douban's 1–5 stars → the 0–10 integer scale Bangumi and NeoDB both use.
 * 豆瓣的 1–5 星 → Bangumi 与 NeoDB 共用的 0–10 整数分制。
 *
 * Single definition on purpose: this conversion used to be written out three times (Bangumi's
 * `rate`, and two inline `* 2` expressions in the NeoDB client), so a change to Douban's rating
 * scale had three places to update and two of them were easy to miss.
 * 刻意只保留一处定义：这个换算原先被写了三遍（Bangumi 的 `rate`，以及 NeoDB 客户端里两处内联的
 * `* 2`），因此豆瓣一旦调整评分制就有三处要改，其中两处很容易被漏掉。
 *
 * `0`, `null` and `undefined` all mean "unrated" and map to `0`, matching both APIs' convention.
 * `0`、`null`、`undefined` 都表示「未评分」，统一映射为 `0`，与两个 API 的约定一致。
 */
export function doubanStarsToTenPoint(rating: number | null | undefined): number {
  if (!rating) {
    return 0;
  }
  return rating * 2;
}

// ───────────────────────────────────────────────────────────────────────────
// RSS entry → (category, subject id, status)
// RSS 条目 → (分类, 条目 id, 状态)
//
// Lives here, beside the four status tables it is built from, because adding a Douban category
// means touching both: a new table with no rule row is silently unparseable, and a rule row
// pointing at a table nobody added is a type error. Keeping them in one file makes that a
// one-file edit instead of a two-file edit — which is what the RSS client used to require.
// 放在这里，与它所依赖的四张状态表并列：新增一个豆瓣分类必定同时动到两者 —— 只加状态表没有规则行
// 就是静默解析不出来，只加规则行指向不存在的表则是类型错误。放在同一个文件里，这件事从「改两个文件」
// 变成「改一个文件」，而 RSS 客户端原先要求的正是前者。
// ───────────────────────────────────────────────────────────────────────────

/** One row: a status vocabulary, the category it implies, and the link that identifies that category. / 一行：一套状态词汇、它对应的分类，以及标识该分类的链接形状。 */
export type DoubanItemRule = {
  statuses: Record<string, ItemStatus>;
  category: ItemCategory;
  idPattern: RegExp;
};

/**
 * One row per (status vocabulary, category, link shape). The four `if/else` branches this
 * replaces were identical apart from those three things, and the COPY is what made the film /
 * stage-drama split easy to get wrong: `看过` is one vocabulary pointing at two categories.
 * 每行一个（状态词汇、分类、链接形状）三元组。它替掉的四段 `if/else` 除了这三样之外完全一样，
 * 而正是**复制**让「电影 / 舞台剧」这一分叉容易出错：`看过` 是同一套词汇指向两个分类。
 *
 * Order matters only for `看*`: the film pattern wins because it is listed first.
 * 顺序只对 `看*` 有意义：电影模式在前，因此它优先。
 */
export const DOUBAN_ITEM_RULES: ReadonlyArray<DoubanItemRule> = [
  {
    statuses: SEE_STATUS_MAP,
    category: ItemCategory.Movie,
    idPattern: /movie\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: SEE_STATUS_MAP,
    category: ItemCategory.Drama,
    idPattern: /www\.douban\.com\/location\/drama\/(\d+)\/?/,
  },
  {
    statuses: READ_STATUS_MAP,
    category: ItemCategory.Book,
    idPattern: /book\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: LISTEN_STATUS_MAP,
    category: ItemCategory.Music,
    idPattern: /music\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: PLAY_STATUS_MAP,
    category: ItemCategory.Game,
    idPattern: /www\.douban\.com\/game\/(\d+)\/?/,
  },
];
