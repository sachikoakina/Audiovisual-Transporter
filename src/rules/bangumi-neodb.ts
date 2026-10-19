/**
 * Bangumi ↔ NeoDB rules — status mapping, guards, and progress mapping.
 * Bangumi ↔ NeoDB 规则 —— 状态映射、守卫表、以及进度映射。
 *
 * Zero I/O, zero environment reads: literal tables plus two pure functions, all directly
 * assertable with literal inputs.
 * 零 I/O、零环境读取：字面量表格 + 两个纯函数，全部可直接用字面量断言。
 *
 * Absorbed from the former `const.ts`.
 * 由原先的 `const.ts` 吸收而来。
 */
import {
  ItemCategory,
  ItemStatus,
  type BangumiCollectionType,
  type BangumiSubjectType,
  type NeodbProgressType,
} from '../types';

/** NeoDB / Douban shelf status → Bangumi CollectionType / NeoDB、豆瓣的书架状态 → Bangumi CollectionType。 */
export const NEODB_TO_BANGUMI_COLLECTION: Record<ItemStatus, BangumiCollectionType> = {
  [ItemStatus.Wishlist]: 1,
  [ItemStatus.Complete]: 2,
  [ItemStatus.Progress]: 3,
  [ItemStatus.Dropped]: 5,
};

/** Bangumi CollectionType → NeoDB shelf_type / Bangumi CollectionType → NeoDB shelf_type。 */
export const BANGUMI_TO_NEODB_STATUS: Record<BangumiCollectionType, ItemStatus> = {
  1: ItemStatus.Wishlist,
  2: ItemStatus.Complete,
  3: ItemStatus.Progress,
  4: ItemStatus.Progress, // 搁置 → 在看/在玩（NeoDB 无搁置）/ on-hold → in progress (NeoDB has no on-hold)
  5: ItemStatus.Dropped, // 抛弃 → dropped / dropped
};

/**
 * Bangumi collection types with no Douban RSS equivalent (搁置 / 抛弃).
 * Douban→Bangumi should preserve these when already set.
 *
 * Bangumi 中豆瓣 RSS 无法对应的收藏类型（搁置 / 抛弃）。当目标端已设为这些值时，
 * 「豆瓣 → Bangumi」应予以保留。
 */
export const BANGUMI_STATUSES_ABSENT_FROM_DOUBAN: ReadonlySet<BangumiCollectionType> =
  new Set([4, 5]);

/**
 * Category tokens accepted by `SYNC_BANGUMI_NEODB_CATEGORIES`.
 * `manga` means books whose platform is "漫画"; `book` covers all books.
 *
 * `SYNC_BANGUMI_NEODB_CATEGORIES` 接受的分类标识。`manga` 指 platform 为「漫画」的书籍；
 * `book` 覆盖全部书籍。
 */
export type BangumiNeodbCategory =
  'anime' | 'manga' | 'book' | 'music' | 'game' | 'real';

/**
 * Category tokens → the Bangumi `subject_type` values they need.
 *
 * Pure on purpose: the mapping lives here, not in `sync-config`, so the offline assertions can
 * pin it without importing a module that reads the environment.
 *
 * 分类标识 → 需要查询的 Bangumi `subject_type` 取值。
 *
 * 刻意做成纯函数：映射放在这里而不是 `sync-config`，这样离线断言无需导入「会读环境变量」的
 * 模块就能把它钉住。
 */
export function bangumiSubjectTypesForCategories(
  categories: Iterable<BangumiNeodbCategory>,
): BangumiSubjectType[] {
  const types = new Set<BangumiSubjectType>();
  for (const category of categories) {
    switch (category) {
      case 'book':
      case 'manga':
        types.add(1);
        break;
      case 'anime':
        types.add(2);
        break;
      case 'music':
        types.add(3);
        break;
      case 'game':
        types.add(4);
        break;
      case 'real':
        types.add(6);
        break;
    }
  }
  return [...types].sort((a, b) => a - b);
}

/**
 * Douban category → Bangumi subject type candidates for search filter.
 * Movie may be anime (2) or real (6); prefer both when searching.
 *
 * 豆瓣分类 → 搜索过滤时使用的 Bangumi subject 类型候选。电影可能是动画（2）或三次元（6），
 * 搜索时两者都带上。
 */
export const CATEGORY_TO_BANGUMI_TYPES: Partial<
  Record<ItemCategory, BangumiSubjectType[]>
> = {
  [ItemCategory.Book]: [1],
  [ItemCategory.Movie]: [2, 6],
  [ItemCategory.Music]: [3],
  [ItemCategory.Game]: [4],
  // Drama (话剧) has no Bangumi equivalent; only sync when NeoDB already has a Bangumi link.
  // 话剧在 Bangumi 没有对应类型；仅当 NeoDB 已带 Bangumi 外链时才同步。
};

/** A single NeoDB progress pair to POST. / 待 POST 的一组 NeoDB 进度值。 */
export type NeodbProgressPayload = {
  type: NeodbProgressType;
  value: string;
};

/**
 * Map Bangumi collection progress to a single NeoDB progress pair.
 * Games are skipped. Zero counts are skipped (do not clear NeoDB progress).
 * Caller should also filter by NeoDB item category (e.g. movies reject episode).
 *
 * 把 Bangumi 收藏的进度映射为单组 NeoDB 进度值。游戏跳过。计数为 0 时跳过
 * （不得清空 NeoDB 的进度）。调用方还应再按 NeoDB 条目的 category 过滤
 * （例如电影不接受 episode）。
 */
export function bangumiCollectionToNeodbProgress(collection: {
  subject_type: BangumiSubjectType;
  ep_status?: number;
  vol_status?: number;
}): NeodbProgressPayload | null {
  const ep = collection.ep_status ?? 0;
  const vol = collection.vol_status ?? 0;

  switch (collection.subject_type) {
    case 2:
    case 6:
      if (ep <= 0) return null;
      return { type: 'episode', value: String(ep) };
    case 1:
      if (vol > 0) return { type: 'chapter', value: String(vol) };
      if (ep > 0) return { type: 'chapter', value: String(ep) };
      return null;
    case 3:
      if (ep <= 0) return null;
      return { type: 'track', value: String(ep) };
    case 4:
    default:
      return null;
  }
}

/**
 * Whether NeoDB accepts this progress type for the catalog item category.
 * Movies often share Bangumi subject_type with TV but reject `episode` (HTTP 400).
 *
 * NeoDB 是否接受该进度类型与条目 category 的组合。电影常与剧集共用 Bangumi subject_type，
 * 但会拒绝 `episode`（HTTP 400）。
 */
export function neodbItemSupportsProgress(
  neodbItem: { category?: string; type?: string },
  progress: NeodbProgressPayload,
): boolean {
  const cat = String(neodbItem.category || '').toLowerCase();
  const type = String(neodbItem.type || '').toLowerCase();

  switch (progress.type) {
    case 'episode':
      // TV / seasons only. movie / performance / etc. → skip.
      // 仅剧集/季。movie / performance 等 → 跳过。
      return cat === 'tv';
    case 'chapter':
    case 'page':
      return cat === 'book';
    case 'track':
      return cat === 'music';
    default:
      // Unknown combo: do not POST (avoid noisy 400s).
      // 未知组合：不 POST（避免刷出大量 400）。
      return !(cat === 'movie' || type === 'movie');
  }
}

/**
 * What Douban → Bangumi would send for one subject, and whether anything must be sent at all.
 * 豆瓣 → Bangumi 对某个条目将要发送的内容，以及是否真的需要发送。
 */
export type BangumiWritePlan = {
  /** Collection type to send. / 要发送的收藏类型。 */
  type: BangumiCollectionType;
  /** Rating to send — either the incoming one or the preserved Bangumi one. / 要发送的评分。 */
  rate: number;
  /** Comment to send. / 要发送的短评。 */
  comment: string;
  /** True when the Bangumi-side rating was kept instead of the incoming one. / 是否保留了 Bangumi 侧已有评分。 */
  keepExistingRate: boolean;
  /** True when nothing differs, so no request must be sent. / 是否无差异、无需发送请求。 */
  unchanged: boolean;
};

/**
 * Decide what to write to Bangumi, given what Bangumi already holds.
 *
 * The one rule that is not a plain overwrite: **a Bangumi rating that already exists wins.**
 * Douban's stars only fill an empty (`0`) rating; once Bangumi has one, later Douban changes —
 * including "Douban has no rating at all", which converts to `0` — are ignored. Without this,
 * an unrated Douban entry silently wiped the rating already stored on Bangumi.
 *
 * `unchanged` must be computed from the *effective* rate, not from the incoming one. Otherwise an
 * item whose Bangumi rating is 8 and whose Douban rating is 6 would differ on every run, trigger a
 * write on every run, and never count as `unchanged`.
 *
 * 在已知 Bangumi 现有收藏的前提下，决定要写入什么。
 *
 * 唯一不是「直接覆盖」的规则：**Bangumi 侧已有的评分优先**。豆瓣星级只用于填补空（`0`）评分；
 * 一旦 Bangumi 有分，之后豆瓣的改分（包括「豆瓣没评分」被换算成 `0` 的情况）都不再生效。
 * 没有这条规则时，豆瓣未评分的条目会把 Bangumi 已有的评分静默清零。
 *
 * `unchanged` 必须按**最终生效的**评分计算，而不是按传入值：否则「Bangumi 8 分、豆瓣 6 分」的
 * 条目每轮都会有差异，每轮都发写请求，永远不会记为 `unchanged`。
 */
export function resolveBangumiCollectionWrite(input: {
  desiredType: BangumiCollectionType;
  desiredRate: number;
  desiredComment: string;
  existing?: {
    type: BangumiCollectionType;
    rate?: number | null;
    comment?: string | null;
  } | null;
}): BangumiWritePlan {
  const { desiredType, desiredRate, desiredComment, existing } = input;

  const existingRate = existing?.rate ?? 0;
  const existingType = existing?.type;
  const existingComment = existing?.comment ?? '';
  const keepExistingRate = existingType !== undefined && existingRate > 0;
  const rate = keepExistingRate ? existingRate : desiredRate;

  const unchanged =
    existingType !== undefined &&
    existingType === desiredType &&
    existingRate === rate &&
    existingComment === desiredComment;

  return {
    type: desiredType,
    rate,
    comment: desiredComment,
    keepExistingRate,
    unchanged,
  };
}
