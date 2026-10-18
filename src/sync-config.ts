/**
 * Sync configuration — parse the environment once, hand the rest of the app a typed object.
 * 同步配置 —— 集中解析环境变量，向其余代码暴露一个有类型的配置对象。
 *
 * Central by intent: every `SYNC_*` / `NEODB_*` / `TMDB_*` / `NOTION_*` switch is read here so
 * that the effective configuration can be printed (`describeSyncConfig`) and diffed between
 * runs. Environment variable NAMES are part of the public interface — do not rename them.
 * 刻意做成中枢：所有 `SYNC_*` / `NEODB_*` / `TMDB_*` / `NOTION_*` 开关都在此读取，这样最终
 * 生效的配置可以被打印出来（`describeSyncConfig`）并在不同运行之间对比。环境变量**名称属于
 * 对外接口，不要改名**。
 */
import dotenv from 'dotenv';
import { consola } from 'consola';
import {
  ItemCategory,
  SHELF_TYPES,
  type BangumiSubjectType,
  type FeedItem,
  type NeodbMergeProfile,
  type RatingProfile,
  type ShelfType,
} from './types';

dotenv.config();

/**
 * Parse an env flag. Empty/unset → defaultValue.
 * Truthy: 1, true, yes, on (case-insensitive).
 *
 * 解析布尔型环境开关。空值/未设置 → defaultValue。真值：1、true、yes、on（不区分大小写）。
 */
export function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Douban RSS category tokens (English + Chinese aliases). / 豆瓣 RSS 分类标识（含中英别名）。 */
const DOUBAN_CATEGORY_ALIASES: Record<string, ItemCategory> = {
  movie: ItemCategory.Movie,
  music: ItemCategory.Music,
  book: ItemCategory.Book,
  game: ItemCategory.Game,
  drama: ItemCategory.Drama,
  电影: ItemCategory.Movie,
  音乐: ItemCategory.Music,
  书籍: ItemCategory.Book,
  书: ItemCategory.Book,
  游戏: ItemCategory.Game,
  话剧: ItemCategory.Drama,
};

/**
 * Bangumi → NeoDB category tokens.
 * `manga` is books with platform "漫画"; `book` covers all books.
 * Bangumi → NeoDB 的分类标识。`manga` 指 platform 为「漫画」的书籍；`book` 覆盖全部书籍。
 */
export type BangumiNeodbCategory =
  'anime' | 'manga' | 'book' | 'music' | 'game' | 'real';

const BANGUMI_CATEGORY_ALIASES: Record<string, BangumiNeodbCategory> = {
  anime: 'anime',
  manga: 'manga',
  book: 'book',
  music: 'music',
  game: 'game',
  real: 'real',
  动画: 'anime',
  动漫: 'anime',
  漫画: 'manga',
  书籍: 'book',
  书: 'book',
  音乐: 'music',
  游戏: 'game',
  三次元: 'real',
};

/**
 * A parsed allowlist, kept three-state on purpose.
 * `none` is distinct from `all` so that a typo'd category name fails CLOSED (syncs nothing and
 * says so) instead of silently degrading into "sync everything".
 * 解析后的白名单，刻意保持三态。`none` 与 `all` 必须区分开，这样写错分类名时会**失败在关闭
 * 一侧**（不同步任何东西，并且明确告知），而不是悄悄退化成「全部同步」。
 */
export type CategoryAllowlist<T extends string> =
  | { mode: 'all' }
  | { mode: 'none'; raw: string }
  | { mode: 'set'; values: ReadonlySet<T> };

/**
 * Parse merge profile. Empty/unset → defaultValue.
 * Invalid values warn and fall back to defaultValue.
 *
 * 解析合并策略。空值/未设置 → defaultValue。取值非法时告警并回退到 defaultValue。
 */
export function parseMergeProfile(
  envName: string,
  defaultValue: NeodbMergeProfile = 'neodb_prefer',
): NeodbMergeProfile {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'overwrite' || value === 'neodb_prefer') {
    return value;
  }
  consola.warn(
    `${envName}=${raw} is invalid (use overwrite|neodb_prefer); falling back to ${defaultValue}`,
  );
  return defaultValue;
}

function splitCategoryTokens(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(/[,，\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Parse a comma-separated category allowlist.
 * Empty/unset → all. Non-empty with zero recognized tokens → none (fail closed).
 *
 * 解析逗号分隔的分类白名单。空值/未设置 → all。非空但没有任何可识别标识 → none（失败在关闭一侧）。
 */
export function parseCategoryAllowlist<T extends string>(
  envName: string,
  aliases: Record<string, T>,
): CategoryAllowlist<T> {
  const raw = process.env[envName];
  const tokens = splitCategoryTokens(raw);
  if (tokens.length === 0) {
    return { mode: 'all' };
  }

  const values = new Set<T>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const mapped = aliases[token];
    if (mapped) {
      values.add(mapped);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length) {
    consola.warn(`${envName}: unrecognized category token(s): ${unknown.join(', ')}`);
  }

  if (values.size === 0) {
    consola.warn(
      `${envName} has no recognized categories; syncing nothing for this path (set empty to allow all).`,
    );
    return { mode: 'none', raw: raw ?? '' };
  }

  return { mode: 'set', values };
}

function formatAllowlist<T extends string>(allowlist: CategoryAllowlist<T>): string {
  if (allowlist.mode === 'all') {
    return 'all';
  }
  if (allowlist.mode === 'none') {
    return 'none';
  }
  return [...allowlist.values].sort().join('|');
}

/**
 * Which sync paths to run. Defaults match a NeoDB + Bangumi setup (Notion off).
 * 要运行哪些同步链路。默认值对应「NeoDB + Bangumi」的组合（Notion 关闭）。
 */
export const syncConfig = {
  /** Douban RSS → Notion / 豆瓣 RSS → Notion */
  doubanNotion: envEnabled('SYNC_DOUBAN_NOTION', false),
  /** Douban RSS → NeoDB / 豆瓣 RSS → NeoDB */
  doubanNeodb: envEnabled('SYNC_DOUBAN_NEODB', true),
  /** Douban RSS → Bangumi / 豆瓣 RSS → Bangumi */
  doubanBangumi: envEnabled('SYNC_DOUBAN_BANGUMI', true),
  /** Bangumi collections → NeoDB / Bangumi 收藏 → NeoDB */
  bangumiNeodb: envEnabled('SYNC_BANGUMI_NEODB', true),
  /** Bangumi → NeoDB progress (episode/chapter/track). Default off. / Bangumi → NeoDB 进度，默认关闭。 */
  bangumiNeodbProgress: envEnabled('SYNC_BANGUMI_NEODB_PROGRESS', false),

  doubanNotionCategories: parseCategoryAllowlist(
    'SYNC_DOUBAN_NOTION_CATEGORIES',
    DOUBAN_CATEGORY_ALIASES,
  ),
  doubanNeodbCategories: parseCategoryAllowlist(
    'SYNC_DOUBAN_NEODB_CATEGORIES',
    DOUBAN_CATEGORY_ALIASES,
  ),
  doubanBangumiCategories: parseCategoryAllowlist(
    'SYNC_DOUBAN_BANGUMI_CATEGORIES',
    DOUBAN_CATEGORY_ALIASES,
  ),
  bangumiNeodbCategories: parseCategoryAllowlist(
    'SYNC_BANGUMI_NEODB_CATEGORIES',
    BANGUMI_CATEGORY_ALIASES,
  ),

  doubanNeodbMerge: parseMergeProfile('SYNC_DOUBAN_NEODB_MERGE'),
  bangumiNeodbMerge: parseMergeProfile('SYNC_BANGUMI_NEODB_MERGE'),
};

export function needsDoubanRss(): boolean {
  return syncConfig.doubanNotion || syncConfig.doubanNeodb || syncConfig.doubanBangumi;
}

export function isDoubanCategoryAllowed(
  allowlist: CategoryAllowlist<ItemCategory>,
  category: ItemCategory,
): boolean {
  if (allowlist.mode === 'all') {
    return true;
  }
  if (allowlist.mode === 'none') {
    return false;
  }
  return allowlist.values.has(category);
}

/**
 * Filter Douban feed items by a path's category allowlist.
 * Logs one info line per skipped item.
 *
 * 按某条链路的分类白名单过滤豆瓣条目。每跳过一个条目打印一行 info 日志。
 */
export function filterDoubanFeedsByCategory(
  feeds: FeedItem[],
  allowlist: CategoryAllowlist<ItemCategory>,
  pathLabel: string,
): FeedItem[] {
  if (allowlist.mode === 'all') {
    return feeds;
  }
  return feeds.filter((item) => {
    if (isDoubanCategoryAllowed(allowlist, item.category)) {
      return true;
    }
    consola.info(
      `${pathLabel}: skip category ${item.category}: `,
      `${item.title || item.id}[${item.link}]`,
    );
    return false;
  });
}

/** Bangumi subject_type values needed for the allowlist (for API query). / 白名单对应的 Bangumi subject_type 取值（用于 API 查询）。 */
export function bangumiSubjectTypesForAllowlist(
  allowlist: CategoryAllowlist<BangumiNeodbCategory>,
): BangumiSubjectType[] | null {
  if (allowlist.mode === 'all') {
    return null;
  }
  if (allowlist.mode === 'none') {
    return [];
  }

  const types = new Set<BangumiSubjectType>();
  for (const cat of allowlist.values) {
    switch (cat) {
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
 * True when books must be filtered by platform === "漫画"
 * (manga allowed, full book not).
 *
 * 为真时表示书籍必须再按 platform ===「漫画」过滤（允许漫画、但不允许全部书籍）。
 */
export function needsBangumiMangaPlatformCheck(
  allowlist: CategoryAllowlist<BangumiNeodbCategory>,
): boolean {
  return (
    allowlist.mode === 'set' &&
    allowlist.values.has('manga') &&
    !allowlist.values.has('book')
  );
}

export function describeSyncConfig(): string {
  const lines = [
    `Douban→Notion: ${syncConfig.doubanNotion ? 'on' : 'off'} (${formatAllowlist(syncConfig.doubanNotionCategories)})`,
    `Douban→NeoDB: ${syncConfig.doubanNeodb ? 'on' : 'off'} (${formatAllowlist(syncConfig.doubanNeodbCategories)}, merge=${syncConfig.doubanNeodbMerge})`,
    `Douban→Bangumi: ${syncConfig.doubanBangumi ? 'on' : 'off'} (${formatAllowlist(syncConfig.doubanBangumiCategories)})`,
    `Bangumi→NeoDB: ${syncConfig.bangumiNeodb ? 'on' : 'off'} (${formatAllowlist(syncConfig.bangumiNeodbCategories)}, merge=${syncConfig.bangumiNeodbMerge}, progress=${syncConfig.bangumiNeodbProgress ? 'on' : 'off'})`,
  ];
  return lines.join(', ');
}

// ───────────────────────────────────────────────────────────────────────────
// Notion target lookup
// Notion 目标查找
//
// The column vocabulary itself lives in `cols.json`; what belongs here is the
// env → data-source-id mapping, because it is an environment read like any other.
//
// 列的词汇表本身在 `cols.json` 里；放在这里的是「env → data source id」的映射，
// 因为它和别处一样属于环境变量读取。
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Notion data source id for a Douban category.
 * 取某个豆瓣分类对应的 Notion data source id。
 *
 * NAMING CAVEAT: the env var is called `NOTION_*_DATABASE_ID` for backward compatibility, but
 * the value it must hold is a Notion **data source** id: the Notion API v5 queries and creates
 * pages against `data_source_id`, not `database_id`. The names are kept as-is because renaming
 * them would break every existing deployment.
 *
 * 命名提示：环境变量名为兼容历史沿用 `NOTION_*_DATABASE_ID`，但它必须填的是 Notion 的
 * **data source** id —— Notion API v5 的查询与建页都走 `data_source_id` 而非 `database_id`。
 * 变量名保持不变，改名会破坏所有现有部署。
 *
 * @param category - Douban category. 豆瓣分类。
 * @returns The configured id, or `undefined` when that category is not configured.
 *   已配置的 id；该分类未配置时为 `undefined`。
 */
export function getDataSourceId(category: ItemCategory): string | undefined {
  const dataSourceIds: Record<ItemCategory, string | undefined> = {
    [ItemCategory.Movie]: process.env.NOTION_MOVIE_DATABASE_ID,
    [ItemCategory.Music]: process.env.NOTION_MUSIC_DATABASE_ID,
    [ItemCategory.Book]: process.env.NOTION_BOOK_DATABASE_ID,
    [ItemCategory.Game]: process.env.NOTION_GAME_DATABASE_ID,
    [ItemCategory.Drama]: process.env.NOTION_DRAMA_DATABASE_ID,
  };
  return dataSourceIds[category];
}

// ───────────────────────────────────────────────────────────────────────────
// Shared review log
// 共享留档日志
//
// `SYNC_UNMATCHED_LOG` started life as a NeoDB → TMDB option, but the file it
// names is useful to every path: it is where entries a path could not process
// are appended for later review. Each writer stamps its own `source`, so both
// directions can share one file without ambiguity.
//
// `SYNC_UNMATCHED_LOG` 最初是 NeoDB → TMDB 的选项，但它指向的文件对每条链路都有用：
// 那是「某条链路无法处理的条目」被登记下来供人工复查的地方。每个写入方都会打上自己的
// `source`，因此两个方向可以共用同一个文件而不产生歧义。
// ───────────────────────────────────────────────────────────────────────────

/** Where unprocessable entries are appended. Empty disables the log. / 无法处理的条目的登记位置；空值表示关闭该日志。 */
export const unmatchedLogFile =
  process.env.SYNC_UNMATCHED_LOG ?? '.cache/unmatched.json';

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path
// NeoDB → TMDB 链路
//
// Kept as its own object rather than merged into `syncConfig` above, so this
// addition cannot perturb the existing Douban/Bangumi behaviour.
// All environment reads for this path live here, nowhere else.
//
// 独立成一个对象而不是并入上面的 `syncConfig`，这样这项新增就不会扰动既有的
// 豆瓣/Bangumi 行为。该链路的全部环境变量读取都在这里，不在别处。
// ───────────────────────────────────────────────────────────────────────────

/**
 * Shelves processed by default.
 * `dropped` is deliberately absent — the mapping skips it, so including it
 * would only waste requests. It can still be listed explicitly; it simply
 * resolves to "no TMDB operation".
 *
 * 默认处理的书架。刻意不含 `dropped` —— 映射表会跳过它，纳入它只会浪费请求。
 * 仍然可以显式列出它，只是最终解析为「不产生任何 TMDB 操作」。
 */
const DEFAULT_TMDB_SHELF_TYPES: readonly ShelfType[] = [
  'wishlist',
  'progress',
  'complete',
];

function envInt(name: string, defaultValue: number, min = 0): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < min) {
    return defaultValue;
  }
  return Math.floor(raw);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Which shelves to process. Empty env → the default subset above. / 处理哪些书架。环境变量为空 → 上面的默认子集。 */
function resolveTmdbShelfTypes(): ShelfType[] {
  const tokens = splitCategoryTokens(process.env.SYNC_SHELF_TYPES);
  if (tokens.length === 0) {
    return [...DEFAULT_TMDB_SHELF_TYPES];
  }

  const resolved: ShelfType[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    if ((SHELF_TYPES as readonly string[]).includes(token)) {
      resolved.push(token as ShelfType);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length) {
    consola.warn(`SYNC_SHELF_TYPES: unrecognized value(s): ${unknown.join(', ')}`);
  }
  if (resolved.length === 0) {
    consola.warn('SYNC_SHELF_TYPES resolved to nothing; no shelf will be synced.');
  }
  return resolved;
}

/**
 * Rating conflict policy. Separate parser from {@link parseMergeProfile} because
 * the choices differ: here the *target* is TMDB.
 *
 * 评分冲突策略。与 {@link parseMergeProfile} 分开解析，因为可选项不同：
 * 这里的**目标端**是 TMDB。
 */
function resolveRatingProfile(): RatingProfile {
  const raw = (process.env.SYNC_RATING_PROFILE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'tmdb_prefer') {
    return 'tmdb_prefer';
  }
  if (raw === 'overwrite' || raw === 'neodb_prefer') {
    return 'overwrite';
  }
  consola.warn(
    `SYNC_RATING_PROFILE=${raw} is invalid (use tmdb_prefer|overwrite); using tmdb_prefer.`,
  );
  return 'tmdb_prefer';
}

export const neodbTmdbConfig = {
  /** Default OFF: a new path must not change behaviour until explicitly enabled. / 默认关闭：新链路在显式启用前不得改变行为。 */
  enabled: envEnabled('SYNC_NEODB_TMDB', false),
  shelfTypes: resolveTmdbShelfTypes(),
  /** Category allowlist. Empty → all syncable categories (movie, tv). / 分类白名单；空 → 全部可同步分类（movie、tv）。 */
  categories: splitCategoryTokens(process.env.SYNC_CATEGORIES),
  dryRun: envEnabled('SYNC_DRY_RUN', false),
  maxItems: envInt('SYNC_MAX_ITEMS', 200, 1),
  ratingProfile: resolveRatingProfile(),
  yearTolerance: envInt('SYNC_YEAR_TOLERANCE', 1, 0),
  /** Incremental de-duplication store. Empty string disables it. / 增量去重存储；空字符串表示关闭。 */
  stateFile: process.env.SYNC_STATE_FILE ?? '.cache/sync-state.json',
  incremental: envEnabled('SYNC_INCREMENTAL', true),
  /**
   * Full-sync intent from the environment, same idea as `BANGUMI_FULL_SYNC`. It lifts the two
   * per-run caps (`SYNC_MAX_ITEMS`, `NEODB_MAX_PAGES`) and turns the incremental store off; the
   * dedicated full entry overrides it for its own run by passing `true` explicitly.
   *
   * Note the trap this exists to remove: `envInt(name, default, min)` returns the default for any
   * value below `min`, and both caps use `min = 1` — so `SYNC_MAX_ITEMS=0` is *not* "unlimited",
   * it silently falls back to 200.
   *
   * 环境变量里的全量意图，与 `BANGUMI_FULL_SYNC` 同一思路。它取消两道单轮上限
   * （`SYNC_MAX_ITEMS`、`NEODB_MAX_PAGES`）并关闭增量存储；专用的全量入口会在该次运行中显式
   * 传入 `true` 覆盖它。
   *
   * 注意它要消除的那个陷阱：`envInt(name, default, min)` 对任何小于 `min` 的值都返回默认值，
   * 而两道上限的 `min` 都是 `1` —— 所以 `SYNC_MAX_ITEMS=0` **不是**「无限」，而是静默回落到 200。
   */
  fullSync: envEnabled('NEODB_TMDB_FULL_SYNC', false),
  /** Unmatched items are dumped here for review. Empty disables. / 未匹配条目登记在此供复查；空值表示关闭。 */
  unmatchedLog: unmatchedLogFile,

  neodb: {
    /** Self-hosted instances: point this at your server. / 自建实例：把它指向你自己的服务器。 */
    baseUrl: stripTrailingSlash(process.env.NEODB_BASE_URL || 'https://neodb.social'),
    requestDelayMs: envInt('NEODB_REQUEST_DELAY_MS', 300),
    maxPages: envInt('NEODB_MAX_PAGES', 10, 1),
  },

  tmdb: {
    apiKey: process.env.TMDB_API_KEY,
    /** Overridable for proxies/mirrors. / 可覆盖，用于代理或镜像。 */
    baseUrl: stripTrailingSlash(
      process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
    ),
    /** v4 user token; converted to a session when no session id is supplied. / v4 用户令牌；未提供 session id 时会用它换 session。 */
    accessToken: process.env.TMDB_ACCESS_TOKEN,
    /** v3 session id. Required for any write. / v3 session id；任何写入都必须提供。 */
    sessionId: process.env.TMDB_SESSION_ID,
    /** Optional; resolved via /3/account when absent. / 可选；缺省时通过 /3/account 解析。 */
    accountId: process.env.TMDB_ACCOUNT_ID,
    language: process.env.TMDB_LANGUAGE || 'zh-CN',
    includeAdult: envEnabled('TMDB_INCLUDE_ADULT', false),
    requestDelayMs: envInt('TMDB_REQUEST_DELAY_MS', 300),
  },
};

/** Categories the user asked for, restricted to what TMDB can hold. / 用户要求的分类，并限定在 TMDB 能承载的范围内。 */
export function resolveTargetCategories(): string[] {
  return neodbTmdbConfig.categories.length > 0
    ? neodbTmdbConfig.categories
    : ['movie', 'tv'];
}

/**
 * The limits a single run actually uses, after full-sync intent is folded in.
 *
 * 一次运行实际使用的上限 —— 全量意图折算之后的结果。
 */
export type NeodbTmdbRunMode = {
  fullSync: boolean;
  /** `SYNC_MAX_ITEMS`; `Infinity` in full mode. Compared against items that reached TMDB. / 全量模式下为 `Infinity`；与实际进入 TMDB 的条数比较。 */
  maxItems: number;
  /** `NEODB_MAX_PAGES`; `Infinity` in full mode. / 全量模式下为 `Infinity`。 */
  maxPages: number;
  /** `SYNC_INCREMENTAL`; forced off in full mode. / 全量模式下强制关闭。 */
  incremental: boolean;
};

/**
 * Fold `fullSync` into the per-run limits.
 *
 * Full sync does **not** mean "ignore what you selected": shelves and categories still apply. It
 * only lifts the two per-run caps and turns the incremental store off, because a full import has
 * to re-examine every mark — and the store would skip exactly the ones already recorded.
 * `SYNC_DRY_RUN` is deliberately untouched: full + dry-run is a legal and useful combination.
 *
 * 把 `fullSync` 折算成本次运行的上限。
 *
 * 全量**不**意味着「无视你的选择」：书架与分类依然生效。它只取消两道单轮上限，并关闭增量存储，
 * 因为全量导入必须重新检查每一条标记 —— 而增量存储恰好会跳过那些已经记录过的条目。
 * `SYNC_DRY_RUN` 刻意不受影响：全量 + 空跑是合法且有用的组合。
 */
export function resolveNeodbTmdbRunMode(fullSync: boolean): NeodbTmdbRunMode {
  if (!fullSync) {
    return {
      fullSync: false,
      maxItems: neodbTmdbConfig.maxItems,
      maxPages: neodbTmdbConfig.neodb.maxPages,
      incremental: neodbTmdbConfig.incremental,
    };
  }

  return {
    fullSync: true,
    maxItems: Number.POSITIVE_INFINITY,
    maxPages: Number.POSITIVE_INFINITY,
    incremental: false,
  };
}

/**
 * One-line summary of the configuration this run actually uses.
 *
 * Takes the resolved mode instead of reading `neodbTmdbConfig` directly, so that a full run
 * triggered by the dedicated entry (where the env var may be unset) still logs the truth.
 *
 * 本次运行实际所用配置的单行摘要。
 *
 * 接收折算后的 mode 而不是直接读 `neodbTmdbConfig`：这样由专用入口触发的全量运行（环境变量可能
 * 未设置）也会打印真实生效的值。
 */
export function describeNeodbTmdbConfig(mode: NeodbTmdbRunMode): string {
  const shelves = neodbTmdbConfig.shelfTypes.join('|') || '(none)';
  const limit = (value: number): string =>
    Number.isFinite(value) ? String(value) : '∞';
  return (
    `NeoDB→TMDB: ${neodbTmdbConfig.enabled ? 'on' : 'off'} ` +
    `shelves=${shelves}, categories=${resolveTargetCategories().join('|')}, ` +
    `dryRun=${neodbTmdbConfig.dryRun}, incremental=${mode.incremental}, ` +
    `rating=${neodbTmdbConfig.ratingProfile}, fullSync=${mode.fullSync ? 'on' : 'off'}, ` +
    `maxItems=${limit(mode.maxItems)}, maxPages=${limit(mode.maxPages)}`
  );
}

/**
 * Credential check, run before any request is attempted.
 *
 * Note on the TMDB side: a v4 *read* token carries `"scopes":["api_read"]` and
 * cannot write. Writes need a v3 session id or a user-scoped v4 token.
 *
 * 凭据检查，在任何请求发出之前运行。
 *
 * TMDB 侧的注意点：v4 的**只读**令牌带 `"scopes":["api_read"]`，无法写入。写入需要
 * v3 session id，或具备用户作用域的 v4 令牌。
 */
export function validateNeodbTmdbCredentials(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (!neodbTmdbConfig.enabled) {
    return { ok: true, problems };
  }
  if (!neodbTokenConfigured()) {
    problems.push('NEODB_API_TOKEN is not set — cannot read your shelf.');
  }
  if (!neodbTmdbConfig.tmdb.apiKey) {
    problems.push('TMDB_API_KEY is not set — TMDB requests cannot be addressed.');
  }
  if (!neodbTmdbConfig.tmdb.sessionId && !neodbTmdbConfig.tmdb.accessToken) {
    problems.push(
      'Neither TMDB_SESSION_ID nor TMDB_ACCESS_TOKEN is set — TMDB writes are impossible.',
    );
  }

  return { ok: problems.length === 0, problems };
}

function neodbTokenConfigured(): boolean {
  return Boolean(process.env.NEODB_API_TOKEN);
}
