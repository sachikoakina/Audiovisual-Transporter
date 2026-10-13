import dotenv from 'dotenv';
import { consola } from 'consola';
import {
  ItemCategory,
  SHELF_TYPES,
  type BangumiSubjectType,
  type FeedItem,
  type RatingProfile,
  type ShelfType,
} from './types';

dotenv.config();

/**
 * Parse env flag. Empty/unset → defaultValue.
 * Truthy: 1, true, yes, on (case-insensitive).
 */
export function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Douban RSS category tokens (English + Chinese aliases). */
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

export type CategoryAllowlist<T extends string> =
  | { mode: 'all' }
  | { mode: 'none'; raw: string }
  | { mode: 'set'; values: ReadonlySet<T> };

/** How Douban/Bangumi marks merge into an existing NeoDB mark. */
export type NeodbMergeProfile = 'overwrite' | 'neodb_prefer';

/**
 * Parse merge profile. Empty/unset → defaultValue.
 * Invalid values warn and fall back to defaultValue.
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
 * Which sync paths to run.
 * Defaults match a NeoDB + Bangumi setup (Notion off).
 */
export const syncConfig = {
  /** Douban RSS → Notion */
  doubanNotion: envEnabled('SYNC_DOUBAN_NOTION', false),
  /** Douban RSS → NeoDB */
  doubanNeodb: envEnabled('SYNC_DOUBAN_NEODB', true),
  /** Douban RSS → Bangumi */
  doubanBangumi: envEnabled('SYNC_DOUBAN_BANGUMI', true),
  /** Bangumi collections → NeoDB */
  bangumiNeodb: envEnabled('SYNC_BANGUMI_NEODB', true),
  /** Bangumi → NeoDB progress (episode/chapter/track). Default off. */
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

/** Bangumi subject_type values needed for the allowlist (for API query). */
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
 * Whether a Bangumi collection's subject_type is in scope before platform checks.
 * Manga-only still needs books (type 1) here; call {@link needsBangumiMangaPlatformCheck}.
 */
export function isBangumiSubjectTypeAllowed(
  allowlist: CategoryAllowlist<BangumiNeodbCategory>,
  subjectType: BangumiSubjectType,
): boolean {
  if (allowlist.mode === 'all') {
    return true;
  }
  if (allowlist.mode === 'none') {
    return false;
  }

  const { values } = allowlist;
  switch (subjectType) {
    case 1:
      return values.has('book') || values.has('manga');
    case 2:
      return values.has('anime');
    case 3:
      return values.has('music');
    case 4:
      return values.has('game');
    case 6:
      return values.has('real');
    default:
      return false;
  }
}

/**
 * True when books must be filtered by platform === "漫画"
 * (manga allowed, full book not).
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
// Shared review log
//
// `SYNC_UNMATCHED_LOG` started life as a NeoDB → TMDB option, but the file it
// names is useful to every path: it is where entries a path could not process
// are appended for later review. Each writer stamps its own `source`, so both
// directions can share one file without ambiguity.
// ───────────────────────────────────────────────────────────────────────────

/** Where unprocessable entries are appended. Empty disables the log. */
export const unmatchedLogFile =
  process.env.SYNC_UNMATCHED_LOG ?? '.cache/unmatched.json';

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path
//
// Kept as its own object rather than merged into `syncConfig` above, so this
// addition cannot perturb the existing Douban/Bangumi behaviour.
// All environment reads for this path live here, nowhere else.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Shelves processed by default.
 * `dropped` is deliberately absent — the mapping skips it, so including it
 * would only waste requests. It can still be listed explicitly; it simply
 * resolves to "no TMDB operation".
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

/** Which shelves to process. Empty env → the default subset above. */
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
  /** Default OFF: a new path must not change behaviour until explicitly enabled. */
  enabled: envEnabled('SYNC_NEODB_TMDB', false),
  shelfTypes: resolveTmdbShelfTypes(),
  /** Category allowlist. Empty → all syncable categories (movie, tv). */
  categories: splitCategoryTokens(process.env.SYNC_CATEGORIES),
  dryRun: envEnabled('SYNC_DRY_RUN', false),
  maxItems: envInt('SYNC_MAX_ITEMS', 200, 1),
  ratingProfile: resolveRatingProfile(),
  yearTolerance: envInt('SYNC_YEAR_TOLERANCE', 1, 0),
  /** Incremental de-duplication store. Empty string disables it. */
  stateFile: process.env.SYNC_STATE_FILE ?? '.cache/sync-state.json',
  incremental: envEnabled('SYNC_INCREMENTAL', true),
  /** Unmatched items are dumped here for review. Empty disables. */
  unmatchedLog: unmatchedLogFile,

  neodb: {
    /** Self-hosted instances: point this at your server. */
    baseUrl: stripTrailingSlash(process.env.NEODB_BASE_URL || 'https://neodb.social'),
    requestDelayMs: envInt('NEODB_REQUEST_DELAY_MS', 300),
    maxPages: envInt('NEODB_MAX_PAGES', 10, 1),
  },

  tmdb: {
    apiKey: process.env.TMDB_API_KEY,
    /** Overridable for proxies/mirrors. */
    baseUrl: stripTrailingSlash(
      process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
    ),
    /** v4 user token; converted to a session when no session id is supplied. */
    accessToken: process.env.TMDB_ACCESS_TOKEN,
    /** v3 session id. Required for any write. */
    sessionId: process.env.TMDB_SESSION_ID,
    /** Optional; resolved via /3/account when absent. */
    accountId: process.env.TMDB_ACCOUNT_ID,
    language: process.env.TMDB_LANGUAGE || 'zh-CN',
    includeAdult: envEnabled('TMDB_INCLUDE_ADULT', false),
    requestDelayMs: envInt('TMDB_REQUEST_DELAY_MS', 300),
  },
};

/** Categories the user asked for, restricted to what TMDB can hold. */
export function resolveTargetCategories(): string[] {
  return neodbTmdbConfig.categories.length > 0
    ? neodbTmdbConfig.categories
    : ['movie', 'tv'];
}

export function describeNeodbTmdbConfig(): string {
  const shelves = neodbTmdbConfig.shelfTypes.join('|') || '(none)';
  return (
    `NeoDB→TMDB: ${neodbTmdbConfig.enabled ? 'on' : 'off'} ` +
    `shelves=${shelves}, categories=${resolveTargetCategories().join('|')}, ` +
    `dryRun=${neodbTmdbConfig.dryRun}, incremental=${neodbTmdbConfig.incremental}, ` +
    `rating=${neodbTmdbConfig.ratingProfile}, maxItems=${neodbTmdbConfig.maxItems}`
  );
}

/**
 * Credential check, run before any request is attempted.
 *
 * Note on the TMDB side: a v4 *read* token carries `"scopes":["api_read"]` and
 * cannot write. Writes need a v3 session id or a user-scoped v4 token.
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
