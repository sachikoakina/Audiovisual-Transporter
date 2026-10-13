import Parser from 'rss-parser';
import DB_PROPERTIES from '../cols.json';

export type DB_PROPERTIES_KEYS = Exclude<keyof typeof DB_PROPERTIES, 'NAME'>;

export enum ItemCategory {
  Movie = 'movie',
  Music = 'music',
  Book = 'book',
  Game = 'game',
  Drama = 'drama',
}

// follow the schema value of Neodb
export enum ItemStatus {
  Wishlist = 'wishlist',
  Progress = 'progress',
  Complete = 'complete',
  Dropped = 'dropped',
}

export type RSSFeedItem = {
  [key: string]: any;
} & Parser.Item;

export type FeedItem = {
  id: string;
  link: string;
  title: string;
  rating: number | null;
  comment: string | null;
  time: string;
  status: ItemStatus;
  category: ItemCategory;
};

/** Bangumi SubjectType: 1 book, 2 anime, 3 music, 4 game, 6 real */
export type BangumiSubjectType = 1 | 2 | 3 | 4 | 6;

/** Bangumi CollectionType: 1 wish, 2 done, 3 doing, 4 on-hold, 5 dropped */
export type BangumiCollectionType = 1 | 2 | 3 | 4 | 5;

/** NeoDB shelf progress type */
export type NeodbProgressType =
  | 'page'
  | 'chapter'
  | 'part'
  | 'episode'
  | 'track'
  | 'cycle'
  | 'timestamp'
  | 'percentage';

export enum NotionPropTypesEnum {
  TITLE = 'title',
  RICH_TEXT = 'rich_text',
  FILES = 'files',
  DATE = 'date',
  MULTI_SELECT = 'multi_select',
  NUMBER = 'number',
  URL = 'url',
}

export type NotionRichTextPropType = {
  id?: string;
  type: NotionPropTypesEnum.RICH_TEXT;
  rich_text: {
    type: 'text';
    text: {
      content: string;
    };
  }[];
};

export type NotionTitlePropType = {
  id?: 'title';
  type: NotionPropTypesEnum.TITLE;
  title: {
    text: {
      content: string;
    };
  }[];
};

export type NotionFilesPropType = {
  id?: string;
  type: NotionPropTypesEnum.FILES;
  files: {
    name: string;
    type: 'external';
    external: {
      url: string;
    };
  }[];
};

export type NotionDatePropType = {
  id?: string;
  type: NotionPropTypesEnum.DATE;
  date: {
    start: string;
    end: string | null;
    time_zone: string | null;
  };
};

export type NotionMultiSelectPropType = {
  id?: string;
  type: NotionPropTypesEnum.MULTI_SELECT;
  multi_select: {
    name: string;
  }[];
};

export type NotionNumberPropType = {
  id?: string;
  type: NotionPropTypesEnum.NUMBER;
  number: number | null;
};

export type NotionUrlPropType = {
  id?: string;
  type: NotionPropTypesEnum.URL;
  url: string;
};

export type NotionColPropTypes =
  | NotionRichTextPropType
  | NotionTitlePropType
  | NotionFilesPropType
  | NotionDatePropType
  | NotionMultiSelectPropType
  | NotionNumberPropType
  | NotionUrlPropType;

export type FailedItem = {
  link: string;
  title: string;
};

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path
//
// Shapes below are copied from the verified NeoDB API reference, not guessed.
// See README "接口依据" for sources.
// ───────────────────────────────────────────────────────────────────────────

/** `{type}` path variable of GET /api/me/shelf/{type}. Verified: all four exist. */
export type ShelfType = 'wishlist' | 'progress' | 'complete' | 'dropped';

export const SHELF_TYPES: readonly ShelfType[] = [
  'wishlist',
  'progress',
  'complete',
  'dropped',
] as const;

/** `category` query parameter of GET /api/me/shelf/{type}. */
export type NeodbCategory =
  'book' | 'movie' | 'tv' | 'music' | 'game' | 'podcast' | 'performance';

export const NEODB_CATEGORIES: readonly NeodbCategory[] = [
  'book',
  'movie',
  'tv',
  'music',
  'game',
  'podcast',
  'performance',
] as const;

/**
 * ItemSchema — the catalog object, inlined as `mark.item` on the shelf API.
 *
 * This is the union of what the two sync paths need: the legacy Douban/Notion
 * fields (`id`, `brief`) and the shelf fields (`year`, `pub_year`,
 * `description`). Kept in types.ts so nothing imports back into neodb.ts.
 */
export type NeodbItem = {
  /** Legacy field required by the existing mark logic. */
  id: string;
  type: string;
  uuid: string;
  url: string;
  api_url: string;
  category: NeodbCategory | string;
  parent_uuid: string | null;
  display_title: string;
  title: string;
  /** Short summary (legacy field name). */
  brief: string;
  description: string;
  cover_image_url: string;
  rating: number;
  rating_count: number;
  localized_title?: { lang?: string; text?: string }[];
  localized_description?: { lang?: string; text?: string }[];
  /** Platform URLs; verified platforms include douban, imdb and tmdb. */
  external_resources: { url: string }[];
  /** MovieSchema / TVSchema only. */
  year?: number;
  /** EditionSchema (books) only. */
  pub_year?: number;
};

/**
 * MarkSchema — one element of `data[]` in PagedMarkSchema.
 *
 * Named `NeodbShelfMark` to avoid colliding with `NeodbMark` in neodb.ts,
 * which is a different (item-less) shape used by the legacy mark logic.
 */
export type NeodbShelfMark = {
  shelf_type: ShelfType | string;
  /** 0 = public, 1 = followers, 2 = private. Not mapped to TMDB (no equivalent). */
  visibility?: number;
  post_id?: number;
  /** Catalog item, inlined — no second request needed. */
  item: NeodbItem;
  created_time?: string;
  /** Free-text short comment. TMDB has no write endpoint for it. */
  comment_text?: string;
  /** 0 = unrated, 2 = 1 star … 10 = 5 stars. */
  rating_grade?: number;
  tags?: string[];
};

/** PagedMarkSchema — response of GET /api/me/shelf/{type}. */
export type NeodbPagedMark = {
  data: NeodbShelfMark[];
  pages: number;
  count: number;
};

/** GET /api/me */
export type NeodbMe = {
  username?: string;
  display_name?: string;
  url?: string;
};

/** Only movie and tv can carry a TMDB user mark. */
export type TmdbMediaType = 'movie' | 'tv';

/** A resolved TMDB target — enough to address every write endpoint. */
export type TmdbTarget = {
  mediaType: TmdbMediaType;
  id: number;
  title?: string;
};

/**
 * GET /3/{movie|tv}/{id}/account_states.
 * `rated` is `{ value }` when rated and `false` when not — never a boolean.
 */
export type TmdbAccountStates = {
  id: number;
  favorite: boolean;
  rated: { value: number } | false;
  watchlist: boolean;
};

export type TmdbSearchResult = {
  id: number;
  media_type?: string;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
};

/** How a NeoDB↔TMDB rating conflict resolves. */
export type RatingProfile = 'tmdb_prefer' | 'overwrite';

export type SyncCounters = {
  scanned: number;
  skippedCategory: number;
  skippedShelf: number;
  skippedCached: number;
  /**
   * Same TMDB item reached again in one run (an item can sit on several
   * shelves). Counted so that the per-path self-check still adds up: without
   * it, a duplicate would bump `scanned` and nothing else.
   */
  skippedDuplicate: number;
  matchedTmdbLink: number;
  matchedImdb: number;
  matchedSearch: number;
  unmatched: number;
  writtenWatchlist: number;
  writtenRating: number;
  unchanged: number;
  failed: number;
};

export function newSyncCounters(): SyncCounters {
  return {
    scanned: 0,
    skippedCategory: 0,
    skippedShelf: 0,
    skippedCached: 0,
    skippedDuplicate: 0,
    matchedTmdbLink: 0,
    matchedImdb: 0,
    matchedSearch: 0,
    unmatched: 0,
    writtenWatchlist: 0,
    writtenRating: 0,
    unchanged: 0,
    failed: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-path result reporting
// ───────────────────────────────────────────────────────────────────────────

/**
 * Outcome of one sync path, consumed by the closing summary.
 *
 * Two counts are deliberately treated differently by the exit code:
 *
 *   `unresolved` — the destination simply has no counterpart for this entry
 *                  (an obscure OVA, a book NeoDB never catalogued). That is a
 *                  data gap, not a defect: record it and warn, but never fail
 *                  the run, or CI would go red on every pass.
 *   `failed`     — something threw. A real error: fail the run.
 */
export type PathReport = {
  /** Shown in the summary, e.g. `Bangumi → NeoDB`. */
  label: string;
  scanned: number;
  written: number;
  unchanged: number;
  skipped: number;
  unresolved: number;
  failed: number;
  /** A configured cap stopped the run before everything was walked. */
  capped: boolean;
  /** The path could not run at all (missing credentials, network failure). */
  aborted: boolean;
  /** Titles needing a human look, in encounter order. */
  unresolvedTitles: string[];
  /** Set only when entries were actually appended to it. */
  reviewLog: string;
};

export function newPathReport(label: string): PathReport {
  return {
    label,
    scanned: 0,
    written: 0,
    unchanged: 0,
    skipped: 0,
    unresolved: 0,
    failed: 0,
    capped: false,
    aborted: false,
    unresolvedTitles: [],
    reviewLog: '',
  };
}

/** Whether this report should make the run exit non-zero. */
export function pathHasFailed(report: PathReport): boolean {
  return report.aborted || report.failed > 0;
}
