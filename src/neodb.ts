import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import { DOUBAN_EXPRESSED_STATUSES } from './const';
import {
  ItemStatus,
  type BangumiSubjectType,
  type FeedItem,
  type NeodbItem,
  type NeodbMe,
  type NeodbPagedMark,
  type NeodbProgressType,
  type ShelfType,
} from './types';
import { sleep } from './utils';
import { mergeNeodbMark } from './neodb-merge';
import { neodbTmdbConfig, syncConfig } from './sync-config';

dotenv.config();

export const neodbToken = process.env.NEODB_API_TOKEN;
export const neodbVisibility = Number(process.env.NEODB_VISIBILITY ?? 2);

/**
 * Re-exported from types.ts so the catalog shape lives in exactly one place
 * and no module has to import back into this one.
 */
export type { NeodbItem } from './types';

/** NeoDB /api/catalog/search category filter */
export type NeodbSearchCategory =
  'book' | 'movie' | 'tv' | 'movie,tv' | 'music' | 'game' | 'podcast' | 'performance';

export type NeodbMark = {
  shelf_type: ItemStatus | string;
  visibility?: number;
  comment_text?: string;
  rating_grade?: number;
  created_time?: string;
};

/**
 * Fetch a catalog item from NeoDB by an external site URL (Douban, Bangumi, etc.).
 * Retries when NeoDB returns 202 / no uuid yet (fetch in progress).
 */
export async function fetchNeodbItemByUrl(
  url: string,
  retries = 3,
): Promise<NeodbItem | null> {
  consola.info('Going to fetch NeoDB item: ', url);
  try {
    const neodbItem = (await got('https://neodb.social/api/catalog/fetch', {
      searchParams: { url },
      headers: { accept: 'application/json' },
    }).json()) as NeodbItem;

    if (neodbItem.uuid) {
      return neodbItem;
    }

    if (retries <= 0) {
      consola.warn('NeoDB item still not ready after retries: ', url);
      return null;
    }

    await sleep(1500);
    return fetchNeodbItemByUrl(url, retries - 1);
  } catch (error: any) {
    consola.error('Fetch NeoDB item with error: ', error.code ?? error.message);
    return null;
  }
}

/**
 * Get current user's mark for a NeoDB item. Returns null if not marked.
 */
export async function getNeodbMark(uuid: string): Promise<NeodbMark | null> {
  if (!neodbToken) {
    return null;
  }

  try {
    return (await got(`https://neodb.social/api/me/shelf/item/${uuid}`, {
      headers: {
        Authorization: `Bearer ${neodbToken}`,
        accept: 'application/json',
      },
    }).json()) as NeodbMark;
  } catch (error: any) {
    if (error.code === 'ERR_NON_2XX_3XX_RESPONSE') {
      return null;
    }
    consola.error("Query item's mark with error code: ", error.code);
    return null;
  }
}

export type MarkNeodbOptions = {
  shelfType: ItemStatus | string;
  comment?: string | null;
  /** Douban 1–5 stars; will be converted to 0–10 grade. Pass null to clear. */
  rating?: number | null;
  /** Already in NeoDB 0–10 scale. Takes precedence over rating when set. */
  ratingGrade?: number | null;
  createdTime?: string | null;
  visibility?: number;
};

/**
 * Mark (create or update) an item on the current user's NeoDB shelf.
 */
export async function markNeodbItem(
  neodbItem: NeodbItem,
  options: MarkNeodbOptions,
): Promise<boolean> {
  if (!neodbToken) {
    return false;
  }

  const label = `${neodbItem.title || neodbItem.display_title}[${neodbItem.uuid}]`;
  consola.info('Going to mark on NeoDB: ', label);

  let ratingGrade = 0;
  if (options.ratingGrade != null) {
    ratingGrade = options.ratingGrade;
  } else if (options.rating) {
    ratingGrade = options.rating * 2;
  }

  try {
    await got.post(`https://neodb.social/api/me/shelf/item/${neodbItem.uuid}`, {
      headers: {
        Authorization: `Bearer ${neodbToken}`,
        accept: 'application/json',
      },
      json: {
        shelf_type: options.shelfType,
        visibility: options.visibility ?? neodbVisibility,
        comment_text: options.comment || '',
        rating_grade: ratingGrade,
        created_time: options.createdTime || undefined,
        post_to_fediverse: false,
      },
    });
    return true;
  } catch (error) {
    consola.error('Failed to mark item: ', neodbItem?.title, ' with error: ', error);
    return false;
  }
}

export type NeodbProgress = {
  type: NeodbProgressType | null;
  value: string | null;
};

function progressHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${neodbToken}`,
    accept: 'application/json',
  };
}

function absoluteNeodbUrl(url: string): string {
  return url.startsWith('http') ? url : `https://neodb.social${url}`;
}

function redirectUrlFromError(error: HTTPError): string | null {
  const location = error.response.headers.location;
  if (typeof location === 'string' && location) {
    return absoluteNeodbUrl(location);
  }
  let body: unknown = error.response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (
    body &&
    typeof body === 'object' &&
    'url' in body &&
    typeof body.url === 'string'
  ) {
    return absoluteNeodbUrl(body.url);
  }
  return null;
}

async function neodbProgressRequest<T>(
  method: 'get' | 'post',
  url: string,
  json?: { type: NeodbProgressType; value: string },
  retried = false,
): Promise<T | null> {
  if (!neodbToken) {
    return null;
  }

  try {
    const options = {
      headers: progressHeaders(),
      followRedirect: false,
      throwHttpErrors: true,
      ...(json ? { json } : {}),
    };
    if (method === 'post') {
      return (await got.post(url, options).json()) as T;
    }
    return (await got(url, options).json()) as T;
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : 0;
    // GET merge → 302; POST/DELETE merge → 307. Retry once against returned url.
    if (error instanceof HTTPError && (status === 302 || status === 307) && !retried) {
      const redirected = redirectUrlFromError(error);
      if (redirected) {
        consola.info('NeoDB progress redirected, retry: ', redirected);
        return neodbProgressRequest<T>(method, redirected, json, true);
      }
    }
    if (error instanceof HTTPError && status === 404) {
      return null;
    }
    if (error instanceof HTTPError) {
      const body = error.response.body;
      consola.error(
        'NeoDB progress request failed: ',
        `${status} ${error.message}`,
        typeof body === 'string' ? body : body,
      );
      return null;
    }
    consola.error('NeoDB progress request failed: ', error);
    return null;
  }
}

function neodbProgressUrl(uuid: string): string {
  return `https://neodb.social/api/me/shelf/item/${uuid}/progress`;
}

export async function getNeodbProgress(uuid: string): Promise<NeodbProgress | null> {
  return neodbProgressRequest<NeodbProgress>('get', neodbProgressUrl(uuid));
}

export async function setNeodbProgress(
  neodbItem: NeodbItem,
  progress: { type: NeodbProgressType; value: string },
): Promise<boolean> {
  const label = `${neodbItem.title || neodbItem.display_title}[${neodbItem.uuid}]`;
  consola.info(
    'Going to set NeoDB progress: ',
    `${label} ${progress.type}=${progress.value}`,
  );
  const result = await neodbProgressRequest<NeodbProgress>(
    'post',
    neodbProgressUrl(neodbItem.uuid),
    progress,
  );
  return result != null;
}

/**
 * Sync a FeedItem to NeoDB: fetch by link, compare mark, update if needed.
 */
export async function syncFeedItemToNeodb(item: FeedItem): Promise<void> {
  const neodbItem = await fetchNeodbItemByUrl(item.link);
  if (!neodbItem?.uuid) {
    return;
  }

  const label = `${neodbItem.title}[${item.link}]`;
  consola.info('Going to check item mark status: ', label);

  const mark = await getNeodbMark(neodbItem.uuid);
  const sourceGrade = item.rating ? item.rating * 2 : 0;

  if (!mark) {
    consola.info('Item is not marked, going to mark now: ', label);
    await markNeodbItem(neodbItem, {
      shelfType: item.status,
      comment: item.comment,
      ratingGrade: sourceGrade,
      createdTime: item.time,
    });
    return;
  }

  // Preserve NeoDB statuses Douban RSS cannot express (e.g. dropped ← Bangumi 搁置/抛弃).
  const existingStatus = mark.shelf_type as ItemStatus;
  if (existingStatus && !DOUBAN_EXPRESSED_STATUSES.has(existingStatus)) {
    consola.info(
      'NeoDB has Douban-absent status, skip overwrite: ',
      `${label} shelf_type=${mark.shelf_type}`,
    );
    return;
  }

  const merged = mergeNeodbMark(
    mark,
    {
      shelfType: item.status,
      ratingGrade: sourceGrade,
      comment: item.comment || '',
    },
    syncConfig.doubanNeodbMerge,
    neodbVisibility,
  );

  if (!merged.shouldWrite) {
    consola.info('NeoDB mark unchanged, skip: ', label);
    return;
  }

  if (merged.keptRating || merged.keptComment) {
    consola.info(
      'NeoDB prefer: keeping existing ',
      [merged.keptRating ? 'rating' : null, merged.keptComment ? 'comment' : null]
        .filter(Boolean)
        .join('+'),
      ' on ',
      label,
    );
  }

  consola.info('Item mark changed, going to update: ', label);
  await markNeodbItem(neodbItem, {
    shelfType: merged.shelfType,
    comment: merged.comment,
    ratingGrade: merged.ratingGrade,
    createdTime: item.time,
  });
}

/**
 * Extract Bangumi subject id from NeoDB external_resources.
 */
export function extractBangumiIdFromNeodb(neodbItem: NeodbItem): number | null {
  const resources = neodbItem.external_resources || [];
  for (const resource of resources) {
    const match = resource.url?.match(/(?:bgm\.tv|bangumi\.tv)\/subject\/(\d+)/i);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * Extract a Douban subject/game URL from NeoDB external_resources.
 */
export function extractDoubanUrlFromNeodb(neodbItem: NeodbItem): string | null {
  const resources = neodbItem.external_resources || [];
  for (const resource of resources) {
    const url = resource.url;
    if (!url) continue;
    if (
      /(?:movie|book|music)\.douban\.com\/subject\/\d+/i.test(url) ||
      /(?:www\.)?douban\.com\/(?:game|location\/drama)\/\d+/i.test(url)
    ) {
      return url;
    }
  }
  return null;
}

export function bangumiSubjectTypeToNeodbSearchCategory(
  subjectType: BangumiSubjectType,
): NeodbSearchCategory | undefined {
  switch (subjectType) {
    case 1:
      return 'book';
    case 2:
    case 6:
      return 'movie,tv';
    case 3:
      return 'music';
    case 4:
      return 'game';
    default:
      return undefined;
  }
}

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '');
}

function collectNeodbItemTitleKeys(item: NeodbItem): Set<string> {
  const keys = new Set<string>();
  for (const raw of [
    item.title,
    item.display_title,
    ...(item.localized_title || []).map((t) => t.text),
  ]) {
    if (!raw?.trim()) continue;
    keys.add(normalizeTitleKey(raw));
  }
  return keys;
}

function uniqueNonEmptyTitles(titles: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of titles) {
    const trimmed = title?.trim();
    if (!trimmed) continue;
    const key = normalizeTitleKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Search NeoDB catalog (internal index only; does not fetch external URLs).
 */
export async function searchNeodbCatalog(
  query: string,
  category?: NeodbSearchCategory,
): Promise<NeodbItem[]> {
  const q = query.trim();
  if (!q) {
    return [];
  }
  try {
    const searchParams: Record<string, string | number> = { query: q, page: 1 };
    if (category) {
      searchParams.category = category;
    }
    const result = (await got('https://neodb.social/api/catalog/search', {
      searchParams,
      headers: { accept: 'application/json' },
    }).json()) as { data?: NeodbItem[] };
    return result.data || [];
  } catch (error: any) {
    consola.error('NeoDB catalog search failed: ', error.code ?? error.message);
    return [];
  }
}

/**
 * Find a Douban-linked catalog twin by exact title match when external_resources
 * on the Bangumi-fetched item do not already include a Douban URL.
 */
export async function findDoubanLinkedTwinByTitle(
  fromBangumi: NeodbItem,
  titles: Array<string | null | undefined>,
  category?: NeodbSearchCategory,
): Promise<NeodbItem | null> {
  const queries = uniqueNonEmptyTitles([
    ...titles,
    fromBangumi.title,
    fromBangumi.display_title,
  ]);
  if (!queries.length) {
    return null;
  }

  const queryKeys = new Set(queries.map(normalizeTitleKey));
  const categories: Array<NeodbSearchCategory | undefined> = category
    ? [category, undefined]
    : [undefined];
  const seenUuid = new Set<string>([fromBangumi.uuid]);

  for (const cat of categories) {
    for (const query of queries) {
      const hits = await searchNeodbCatalog(query, cat);
      for (const hit of hits) {
        if (!hit.uuid || seenUuid.has(hit.uuid)) continue;
        seenUuid.add(hit.uuid);
        if (!extractDoubanUrlFromNeodb(hit)) continue;

        const hitKeys = collectNeodbItemTitleKeys(hit);
        let matched = false;
        for (const key of queryKeys) {
          if (hitKeys.has(key)) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;

        consola.info(
          'NeoDB Douban twin found via title search: ',
          `${fromBangumi.uuid} → ${hit.uuid} (${hit.title || hit.display_title})`,
        );
        return hit;
      }
    }
  }

  return null;
}

export type ResolveBangumiNeodbOptions = {
  /** Candidate titles from Bangumi (name_cn / name). */
  titles?: Array<string | null | undefined>;
  subjectType?: BangumiSubjectType;
};

/**
 * Resolve NeoDB catalog item for a Bangumi URL, preferring the Douban-linked
 * twin when NeoDB has separate entries for the same work.
 * This keeps Bangumi→NeoDB marks on the same uuid as Douban→NeoDB.
 *
 * 1) Prefer Douban URL already on the Bangumi-fetched item's external_resources
 * 2) Else search catalog by title for an exact-title hit that has a Douban link
 */
export async function resolveNeodbItemForBangumiUrl(
  bangumiUrl: string,
  options: ResolveBangumiNeodbOptions = {},
): Promise<NeodbItem | null> {
  const fromBangumi = await fetchNeodbItemByUrl(bangumiUrl);
  if (!fromBangumi?.uuid) {
    return null;
  }

  const doubanUrl = extractDoubanUrlFromNeodb(fromBangumi);
  if (doubanUrl) {
    const fromDouban = await fetchNeodbItemByUrl(doubanUrl);
    if (fromDouban?.uuid && fromDouban.uuid !== fromBangumi.uuid) {
      consola.info(
        'NeoDB has separate Douban/Bangumi catalog entries; prefer Douban twin: ',
        `${fromBangumi.uuid} → ${fromDouban.uuid}`,
      );
      return fromDouban;
    }
    return fromBangumi;
  }

  const category =
    options.subjectType != null
      ? bangumiSubjectTypeToNeodbSearchCategory(options.subjectType)
      : neodbCategoryToSearchCategory(fromBangumi.category);

  const twin = await findDoubanLinkedTwinByTitle(
    fromBangumi,
    options.titles || [],
    category,
  );
  return twin || fromBangumi;
}

function neodbCategoryToSearchCategory(
  category: string | undefined,
): NeodbSearchCategory | undefined {
  switch (category) {
    case 'book':
      return 'book';
    case 'movie':
    case 'tv':
      return 'movie,tv';
    case 'music':
      return 'music';
    case 'game':
      return 'game';
    case 'podcast':
      return 'podcast';
    case 'performance':
      return 'performance';
    default:
      return undefined;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path: shelf listing
//
// Verified endpoints (see README "接口依据" for sources):
//   GET /api/token                            → credential probe
//   GET /api/me                               → current account
//   GET /api/me/shelf/{type}?category=&page=  → PagedMarkSchema
//
// `type` is a PATH parameter, not a query parameter. That is the single most
// likely integration bug here, hence the explicit URL construction below.
//
// Uses its own client because the base URL is configurable (self-hosted
// instances), independent of the legacy calls above.
// ───────────────────────────────────────────────────────────────────────────

const neodbShelfClient = got.extend({
  prefixUrl: neodbTmdbConfig.neodb.baseUrl,
  headers: { accept: 'application/json' },
  timeout: { request: 30000 },
  retry: {
    limit: 3,
    methods: ['GET'],
    statusCodes: [408, 429, 500, 502, 503, 504],
    errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'],
    calculateDelay: ({ attemptCount, error, computedValue }) => {
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return retryAfter * 1000;
      }
      return Math.min(2 ** attemptCount * 500, 8000) || computedValue;
    },
  },
});

function shelfAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${neodbToken ?? ''}` };
}

function shelfFailureCode(error: unknown): string {
  if (error instanceof HTTPError) {
    return `${error.response.statusCode} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function logShelfUnauthorized(): void {
  consola.error(
    'NeoDB 返回 401：token 无效或已过期。请到你的实例 /developer/ 页面重新授权并更新 NEODB_API_TOKEN。',
  );
}

export async function neodbThrottle(): Promise<void> {
  await sleep(neodbTmdbConfig.neodb.requestDelayMs);
}

/** GET /api/token — cheap way to validate credentials before a full run. */
export async function verifyNeodbToken(): Promise<boolean> {
  if (!neodbToken) {
    return false;
  }
  try {
    await neodbShelfClient('api/token', { headers: shelfAuthHeaders() });
    return true;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logShelfUnauthorized();
    } else {
      consola.error('NeoDB token check failed: ', shelfFailureCode(error));
    }
    return false;
  }
}

/** GET /api/me */
export async function getNeodbMe(): Promise<NeodbMe | null> {
  if (!neodbToken) {
    return null;
  }
  try {
    return (await neodbShelfClient('api/me', {
      headers: shelfAuthHeaders(),
    }).json()) as NeodbMe;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logShelfUnauthorized();
    } else {
      consola.error('Failed to fetch NeoDB account: ', shelfFailureCode(error));
    }
    return null;
  }
}

/**
 * One page of GET /api/me/shelf/{type}.
 * Returns null on failure so callers can tell "error" from "empty page".
 */
export async function fetchShelfPage(options: {
  shelfType: ShelfType;
  category?: string;
  page: number;
}): Promise<NeodbPagedMark | null> {
  if (!neodbToken) {
    return null;
  }

  const searchParams: Record<string, string | number> = { page: options.page };
  if (options.category) {
    searchParams.category = options.category;
  }

  try {
    const result = (await neodbShelfClient(`api/me/shelf/${options.shelfType}`, {
      headers: shelfAuthHeaders(),
      searchParams,
    }).json()) as NeodbPagedMark;

    // Defensive: the shape is verified, but a proxy or a fork could differ.
    if (!Array.isArray(result?.data)) {
      consola.warn(
        `Unexpected shelf response for ${options.shelfType} page ${options.page}; treating as empty.`,
      );
      return { data: [], pages: 1, count: 0 };
    }
    return result;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logShelfUnauthorized();
    } else if (error instanceof HTTPError && error.response.statusCode === 404) {
      consola.warn(
        `Shelf "${options.shelfType}" returned 404 — it may not exist on this instance.`,
      );
    } else {
      consola.error(
        `Failed to fetch shelf ${options.shelfType} page ${options.page}: `,
        shelfFailureCode(error),
      );
    }
    return null;
  }
}

/**
 * Walk the pages of one shelf, up to `neodbTmdbConfig.maxPages`.
 * Stops early on an empty page or when the reported page count is reached.
 */
export async function fetchShelf(
  shelfType: ShelfType,
  category?: string,
): Promise<NeodbPagedMark['data']> {
  const collected: NeodbPagedMark['data'] = [];

  for (let page = 1; page <= neodbTmdbConfig.neodb.maxPages; page += 1) {
    const result = await fetchShelfPage({ shelfType, category, page });
    if (result === null) {
      consola.warn(`Aborting shelf "${shelfType}" at page ${page} after an error.`);
      break;
    }
    if (result.data.length === 0) {
      break;
    }

    collected.push(...result.data);

    const reportedPages = Number(result.pages);
    if (Number.isFinite(reportedPages) && page >= reportedPages) {
      break;
    }
    if (page === neodbTmdbConfig.neodb.maxPages) {
      consola.warn(
        `Shelf "${shelfType}" hit NEODB_MAX_PAGES (${neodbTmdbConfig.neodb.maxPages}); more items remain.`,
      );
      break;
    }
    await neodbThrottle();
  }

  return collected;
}
