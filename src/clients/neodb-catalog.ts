/**
 * NeoDB catalog client — look up catalogue items and resolve which entry a source URL refers to.
 * NeoDB 目录客户端 —— 查询目录条目，并解析某个源 URL 究竟指向哪一条目录记录。
 *
 * Scope: read-only catalogue work. Item marks, progress and shelf listing live in
 * `neodb-shelf.ts`; credentials and transport helpers live in `neodb-http.ts`.
 * 范围：只做目录侧的读取工作。条目标记、进度与书架列表在 `neodb-shelf.ts`；凭据与传输助手在
 * `neodb-http.ts`。
 */
import { neodbClient, neodbFailureCode } from './neodb-http';
import { consola } from 'consola';
import { sleep } from '../utils';
import { normalizeTitleKey } from '../rules/tmdb-matching';
import type { BangumiSubjectType, NeodbItem } from '../types';

/** NeoDB `/api/catalog/search` category filter. / NeoDB `/api/catalog/search` 的 category 过滤值。 */
export type NeodbSearchCategory =
  'book' | 'movie' | 'tv' | 'movie,tv' | 'music' | 'game' | 'podcast' | 'performance';

/**
 * Fetch a catalog item from NeoDB by an external site URL (Douban, Bangumi, etc.).
 * Retries when NeoDB returns 202 / no uuid yet (fetch in progress).
 *
 * 按外部站点 URL（豆瓣、Bangumi 等）从 NeoDB 拉取目录条目。
 * 当 NeoDB 返回 202（尚无 uuid，正在抓取）时重试。
 */
export async function fetchNeodbItemByUrl(
  url: string,
  retries = 3,
): Promise<NeodbItem | null> {
  consola.info('Going to fetch NeoDB item: ', url);
  try {
    const neodbItem = (await neodbClient('api/catalog/fetch', {
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
  } catch (error) {
    consola.error('Fetch NeoDB item with error: ', neodbFailureCode(error));
    return null;
  }
}

/** Extract the Bangumi subject id from NeoDB `external_resources`. / 从 NeoDB 的 `external_resources` 中提取 Bangumi subject id。 */
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

/** Extract a Douban subject/game/drama URL from NeoDB `external_resources`. / 从 NeoDB 的 `external_resources` 中提取豆瓣条目/游戏/舞台剧 URL。 */
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

/** Bangumi subject type → the catalog search category that can contain it. / Bangumi subject 类型 → 可能包含它的目录搜索分类。 */
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

/** NeoDB item category → the catalog search category that can contain it. / NeoDB 条目 category → 可能包含它的目录搜索分类。 */
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

/** All normalized title keys an item can be matched under. / 一个条目可用于匹配的全部规范化标题键。 */
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

/** Trim, drop empties, and de-duplicate by normalized title key. / 去空格、丢弃空值，并按规范化标题键去重。 */
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

/** Search the NeoDB catalog (internal index only; does not fetch external URLs). / 搜索 NeoDB 目录（仅内部索引，不会去抓取外部 URL）。 */
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
    const result = (await neodbClient('api/catalog/search', {
      searchParams,
      headers: { accept: 'application/json' },
    }).json()) as { data?: NeodbItem[] };
    return result.data || [];
  } catch (error) {
    consola.error('NeoDB catalog search failed: ', neodbFailureCode(error));
    return [];
  }
}

/**
 * Find a Douban-linked catalog twin by exact title match when `external_resources`
 * on the Bangumi-fetched item do not already include a Douban URL.
 *
 * 当从 Bangumi 取到的条目其 `external_resources` 里没有豆瓣 URL 时，按标题精确匹配寻找
 * 一条带豆瓣外链的「孪生条目」。
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
  /** Candidate titles from Bangumi (`name_cn` / `name`). / Bangumi 给出的候选标题（`name_cn` / `name`）。 */
  titles?: Array<string | null | undefined>;
  subjectType?: BangumiSubjectType;
};

/**
 * Resolve the NeoDB catalog item for a Bangumi URL, preferring the Douban-linked
 * twin when NeoDB has separate entries for the same work.
 * This keeps Bangumi→NeoDB marks on the same uuid as Douban→NeoDB.
 *
 * 1) Prefer a Douban URL already present on the Bangumi-fetched item's `external_resources`
 * 2) Else search the catalog by title for an exact-title hit that has a Douban link
 *
 * 为某个 Bangumi URL 解析出对应的 NeoDB 目录条目；当 NeoDB 对同一作品存在多条记录时，优先
 * 选择带豆瓣外链的那条。这样可以让 Bangumi→NeoDB 的标记落在与 Douban→NeoDB 相同的 uuid 上。
 *
 * 1) 优先使用从 Bangumi 取到的条目 `external_resources` 上已有的豆瓣 URL
 * 2) 否则按标题搜索目录，寻找标题完全相同且带豆瓣外链的结果
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
