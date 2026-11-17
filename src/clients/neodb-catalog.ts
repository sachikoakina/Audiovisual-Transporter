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
import { normalizeIsbn } from '../rules/isbn';
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
function errorStatus(error: unknown): number | undefined {
  const response = (error as { response?: { statusCode?: number } }).response;
  return response?.statusCode;
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, string> } })
    .response?.headers;
  const raw = headers?.['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

export type NeodbFetchFailure = 'not-found' | 'temporary';

type FetchFailureRef = { kind?: NeodbFetchFailure };

export async function fetchNeodbItemByUrl(
  url: string,
  retries = 3,
  failure: FetchFailureRef = {},
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
      failure.kind ??= 'temporary';
      consola.warn('NeoDB item still not ready after retries: ', url);
      return null;
    }

    await sleep(1500);
    return fetchNeodbItemByUrl(url, retries - 1, failure);
  } catch (error) {
    const status = errorStatus(error);
    if ((status === 429 || (status != null && status >= 500)) && retries > 0) {
      const delay = retryAfterMs(error) ?? Math.min(2000 * 2 ** (3 - retries), 8000);
      consola.warn(
        `NeoDB catalog fetch returned ${status}; retrying in ${delay}ms: `,
        url,
      );
      await sleep(delay);
      return fetchNeodbItemByUrl(url, retries - 1, failure);
    }
    // Only a real 404 is "catalog entry absent"; every other failure may succeed next run.
    // 只有真正的 404 才是「目录条目不存在」；其他失败都可能下一轮成功。
    failure.kind = status === 404 ? 'not-found' : 'temporary';
    consola.error('Fetch NeoDB item with error: ', neodbFailureCode(error));
    return null;
  }
}

/**
 * Fetch one catalogue entry from its own `api_url` — the fields the shelf listing never carries.
 * 用条目自身的 `api_url` 拉取完整目录条目 —— 也就是书架列表永远不带的字段。
 *
 * Why this exists: the shelf endpoint (`GET /api/me/shelf/{type}`) inlines `ItemSchema`, and
 * `ItemSchema` has no `year` / `pub_year`. Those two fields live only on the per-item schemas
 * (`MovieSchema`, `TVSchema`, the season schema) served from `api_url`. So the shelf payload is
 * enough to *describe* an item and not enough to *date* one — which is what the title-search level
 * needs; this detail fetch supplies the year used by `SYNC_YEAR_TOLERANCE`.
 *
 * 为什么需要它：书架端点（`GET /api/me/shelf/{type}`）内联的是 `ItemSchema`，而 `ItemSchema` 没有
 * `year` / `pub_year`。这两个字段只在 `api_url` 提供的条目级 schema（`MovieSchema`、`TVSchema`、
 * 季 schema）上。因此书架载荷足以**描述**一个条目，却不足以给它**定年** —— 标题搜索那一级正
 * 需要年份；这里读取详情，供 `SYNC_YEAR_TOLERANCE` 使用。
 *
 * `api_url` is a catalogue path (`/api/movie/<uuid>`), so it goes through the same client and base
 * URL as every other catalogue call; a self-hosted instance works unchanged. Returns `null` rather
 * than throwing: a year this call cannot deliver costs one match, never a wrong write.
 *
 * `api_url` 是目录路径（`/api/movie/<uuid>`），因此与其他目录调用共用同一个客户端与 base URL，
 * 自建实例无需改动。返回 `null` 而不抛出：这次调用拿不到年份只会少一次匹配，绝不会写错。
 */
export async function getNeodbItemDetail(apiUrl: string): Promise<NeodbItem | null> {
  // `prefixUrl` refuses a leading slash, and NeoDB always ships `api_url` with one. An absolute
  // URL loses its origin: the path is the only part that identifies the entry.
  // `prefixUrl` 不接受前导斜杠，而 NeoDB 的 `api_url` 总是带一个。绝对 URL 会丢掉 origin：
  // 只有路径部分才标识这个条目。
  const cataloguePath = apiUrl
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '');
  if (!cataloguePath) {
    return null;
  }

  try {
    const detail = (await neodbClient(cataloguePath, {
      headers: { accept: 'application/json' },
    }).json()) as NeodbItem;
    return detail?.uuid ? detail : null;
  } catch (error) {
    consola.warn(
      'Fetch NeoDB item detail failed: ',
      `${cataloguePath} — ${neodbFailureCode(error)}`,
    );
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
function extractDoubanUrlFromNeodb(neodbItem: NeodbItem): string | null {
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
function bangumiSubjectTypeToNeodbSearchCategory(
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

/**
 * Whether a title is only a season marker (`Season1`, `第1季`, ...).
 * A season marker may still be searched, but it cannot prove a work identity by itself.
 *
 * 判断标题是否只是季标记（`Season1`、`第1季` 等）。季标记仍可参与搜索，但不能单独证明作品身份。
 */
export function isGenericSeasonTitle(title: string): boolean {
  const key = normalizeTitleKey(title);
  return (
    /^(?:season|s)\d+$/.test(key) ||
    /^第\d+季$/.test(key) ||
    /^シーズン\d+$/.test(key) ||
    /^시즌\d+$/.test(key)
  );
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
async function searchNeodbCatalog(
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
function itemYear(item: NeodbItem): number | undefined {
  return item.year ?? item.pub_year;
}

function yearMatches(
  expectedYear: number | undefined,
  actualYear: number | undefined,
  tolerance = 1,
): boolean {
  if (expectedYear == null || actualYear == null) {
    // A missing year on either side is not evidence against the match.
    // 任一侧缺年份都不构成反对匹配的证据。
    return true;
  }
  return Math.abs(expectedYear - actualYear) <= tolerance;
}

function formsCompatibleForTwin(
  a: NeodbSearchCategory | undefined,
  b: NeodbSearchCategory | undefined,
): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  return (a === 'movie' && b === 'tv') || (a === 'tv' && b === 'movie');
}

type TitleMatchRule = 'movie' | 'tv' | 'book' | 'generic' | 'reject';

function titleMatchRuleOf(a: NeodbItem, b: NeodbItem): TitleMatchRule {
  const formA = mediaFormOf(a);
  const formB = mediaFormOf(b);

  if (!formA || !formB) return 'reject';

  if (formA === 'movie' && formB === 'movie') return 'movie';
  if (
    (formA === 'tv' && formB === 'tv') ||
    (formA === 'movie' && formB === 'tv') ||
    (formA === 'tv' && formB === 'movie')
  ) {
    return 'tv';
  }
  if (formA === 'book' && formB === 'book') return 'book';
  if (formA === formB && formA !== 'movie' && formA !== 'tv') return 'generic';
  return 'reject';
}

function seasonFromTitle(title: string): number | null {
  const key = normalizeTitleKey(title);
  const explicit =
    key.match(/(?:season|s)(\d{1,2})(?=\D|$)/) ??
    key.match(/第(\d{1,2})季/) ??
    key.match(/(\d{1,2})(?:st|nd|rd|th)season/);

  if (explicit?.[1]) return Number(explicit[1]);

  const numbered = key.match(/(\d{1,2})(?=月红篇|篇|章|$)/);
  return numbered?.[1] ? Number(numbered[1]) : null;
}

function seasonNumberOf(item: NeodbItem): number | null {
  const seasons = new Set<number>();
  for (const title of [
    item.title,
    item.display_title,
    ...(item.localized_title || []).map((entry) => entry.text),
  ]) {
    if (!title) continue;
    const season = seasonFromTitle(title);
    if (season != null) seasons.add(season);
  }

  // Conflicting season markers are not trustworthy.
  // 同一候选出现互相冲突的季号时，不把它当作可用证据。
  return seasons.size === 1 ? [...seasons][0] : null;
}

function seasonsCompatible(
  a: NeodbItem,
  b: NeodbItem,
): { ok: boolean; aSeason: number | null; bSeason: number | null } {
  const aSeason = seasonNumberOf(a);
  const bSeason = seasonNumberOf(b);

  if (aSeason != null && bSeason != null) {
    return { ok: aSeason === bSeason, aSeason, bSeason };
  }

  if (aSeason == null && bSeason == null) {
    return { ok: true, aSeason, bSeason };
  }

  // A TV season with no explicit number cannot be safely matched against
  // another TV season that does have one. movie ↔ tv keeps its cross-form
  // exception because a movie normally has no season number.
  const aForm = mediaFormOf(a);
  const bForm = mediaFormOf(b);
  const hasMovie = aForm === 'movie' || bForm === 'movie';

  return { ok: hasMovie, aSeason, bSeason };
}

function imdbOf(item: NeodbItem): string | undefined {
  for (const resource of item.external_resources || []) {
    const match = resource.url?.match(/imdb\.com\/title\/(tt\d+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function isbnsOf(item: NeodbItem): string[] {
  const raw = item.isbn?.trim();
  if (!raw) return [];
  const normalized = normalizeIsbn(raw);
  return normalized ? [normalized] : [];
}

type StrongTitleMatch = 'match' | 'conflict' | 'insufficient';

function strongTitleMatchOf(
  rule: TitleMatchRule,
  a: NeodbItem,
  b: NeodbItem,
): StrongTitleMatch {
  if (rule === 'movie') {
    const imdbA = imdbOf(a);
    const imdbB = imdbOf(b);
    if (imdbA && imdbB) return imdbA === imdbB ? 'match' : 'conflict';
  }

  if (rule === 'book') {
    const isbnA = isbnsOf(a);
    const isbnB = isbnsOf(b);
    if (isbnA.length > 0 && isbnB.length > 0) {
      return isbnA.some((isbn) => isbnB.includes(isbn)) ? 'match' : 'conflict';
    }
  }

  return 'insufficient';
}

/** Coarse NeoDB media form, used only as a final tie-break. / 仅用于最终软裁决的 NeoDB 媒体形态。 */
function mediaFormOf(item: NeodbItem): NeodbSearchCategory | undefined {
  if (item.category === 'movie' || item.category === 'tv') {
    return item.category;
  }
  if (
    item.category === 'book' ||
    item.category === 'music' ||
    item.category === 'game'
  ) {
    return item.category;
  }
  const url = item.url || '';
  if (/\/movie\//.test(url)) return 'movie';
  if (/\/tv\//.test(url)) return 'tv';
  if (/\/book\//.test(url)) return 'book';
  if (/\/music\//.test(url)) return 'music';
  if (/\/game\//.test(url)) return 'game';
  return undefined;
}

export async function findDoubanLinkedTwinCandidates(
  fromBangumi: NeodbItem,
  titles: Array<string | null | undefined>,
  category?: NeodbSearchCategory,
  expectedYear?: number,
  yearTolerance = 1,
): Promise<NeodbItem[]> {
  const sourceTitles = uniqueNonEmptyTitles([
    ...titles,
    ...(fromBangumi.localized_title || []).map((entry) => entry.text),
    fromBangumi.title,
    fromBangumi.display_title,
  ]);
  if (!sourceTitles.length) {
    return [];
  }

  const authoritativeTitles = sourceTitles.filter(
    (title) => !isGenericSeasonTitle(title),
  );
  const genericTitles = sourceTitles.filter(isGenericSeasonTitle);
  const authoritativeKeys = new Set(authoritativeTitles.map(normalizeTitleKey));
  const genericKeys = new Set(genericTitles.map(normalizeTitleKey));
  // Never widen the search beyond the category implied by the Bangumi subject type. A book with
  // the same title as a film must not resolve to that film just because the book category had no
  // Douban-linked hit.
  // 绝不把搜索扩大到 Bangumi subject type 对应的分类之外。与电影同名的书籍，不能因为书
  // 分类没有豆瓣孪生就命中那部电影。
  const categories: Array<NeodbSearchCategory | undefined> = category
    ? [category]
    : [undefined];
  const seenUuid = new Set<string>([fromBangumi.uuid]);
  const candidates: NeodbItem[] = [];
  const yearCache = new Map<string, number | undefined>();

  const candidateYear = async (candidate: NeodbItem): Promise<number | undefined> => {
    const inline = itemYear(candidate);
    if (inline != null) return inline;
    if (!candidate.api_url) return undefined;
    if (yearCache.has(candidate.uuid)) return yearCache.get(candidate.uuid);

    const detail = await getNeodbItemDetail(candidate.api_url);
    const year = detail ? itemYear(detail) : undefined;
    yearCache.set(candidate.uuid, year);
    return year;
  };

  for (const cat of categories) {
    for (const query of sourceTitles) {
      const hits = await searchNeodbCatalog(query, cat);
      for (const hit of hits) {
        if (!hit.uuid || seenUuid.has(hit.uuid)) continue;
        seenUuid.add(hit.uuid);
        if (!extractDoubanUrlFromNeodb(hit)) continue;

        const rule = titleMatchRuleOf(fromBangumi, hit);
        if (rule === 'reject') continue;

        if (rule === 'movie' || rule === 'book') {
          const strong = strongTitleMatchOf(rule, fromBangumi, hit);
          if (strong === 'conflict') continue;
          if (strong === 'match') {
            candidates.push(hit);
            continue;
          }
        }

        if (rule === 'tv') {
          const seasons = seasonsCompatible(fromBangumi, hit);
          if (!seasons.ok) continue;
        }

        const hitKeys = collectNeodbItemTitleKeys(hit);
        const matchesAuthoritative = [...authoritativeKeys].some((key) =>
          hitKeys.has(key),
        );
        const matchesGeneric = [...genericKeys].some((key) => hitKeys.has(key));

        if (!matchesAuthoritative) {
          // A generic season title may participate in search, but when the source has a real
          // title it cannot establish identity by itself.
          // 通用季标题可以参与搜索，但源端有真实标题时，它不能单独证明身份。
          if (!matchesGeneric || authoritativeKeys.size > 0) continue;
          if (expectedYear == null) continue;

          const actualYear = await candidateYear(hit);
          if (actualYear == null || actualYear !== expectedYear) continue;
          candidates.push(hit);
          continue;
        }

        const actualYear = await candidateYear(hit);
        // A missing search-result year used to pass as a match. Treat it as unknown, not as
        // evidence, whenever the source year is known.
        // 搜索结果缺年份过去会被当成通过；源端年份已知时，未知不是证据。
        if (expectedYear != null && actualYear == null) continue;
        if (!yearMatches(expectedYear, actualYear, yearTolerance)) continue;
        candidates.push(hit);
      }
    }
  }

  return candidates;
}

/** Pick one twin, preferring a matching year and a compatible NeoDB media form. / 按年份与媒体形态选一个孪生。 */
export function pickDoubanLinkedTwin(
  candidates: NeodbItem[],
  fromBangumi: NeodbItem,
  expectedYear?: number,
): { item: NeodbItem | null; ambiguous: boolean } {
  const directForm = mediaFormOf(fromBangumi);
  const compatible = directForm
    ? candidates.filter((candidate) =>
        formsCompatibleForTwin(directForm, mediaFormOf(candidate)),
      )
    : candidates;
  if (!compatible.length) {
    return { item: null, ambiguous: false };
  }
  if (compatible.length === 1) {
    return { item: compatible[0], ambiguous: false };
  }

  const scored = compatible.map((item) => {
    const year = itemYear(item);
    const score =
      expectedYear == null || year == null
        ? 0
        : Math.abs(expectedYear - year) <= 1
          ? 2
          : -1;
    return { item, score };
  });
  const viable = scored.filter((entry) => entry.score >= 0);
  if (!viable.length) {
    return { item: null, ambiguous: false };
  }
  const max = Math.max(...viable.map((entry) => entry.score));
  const best = viable.filter((entry) => entry.score === max);
  if (best.length !== 1) {
    return { item: null, ambiguous: true };
  }
  return { item: best[0].item, ambiguous: false };
}

export async function findDoubanLinkedTwinByTitle(
  fromBangumi: NeodbItem,
  titles: Array<string | null | undefined>,
  category?: NeodbSearchCategory,
  expectedYear?: number,
  yearTolerance = 1,
): Promise<NeodbItem | null> {
  const candidates = await findDoubanLinkedTwinCandidates(
    fromBangumi,
    titles,
    category,
    expectedYear,
    yearTolerance,
  );
  return pickDoubanLinkedTwin(candidates, fromBangumi, expectedYear).item;
}

export type ResolveBangumiNeodbOptions = {
  /** Candidate titles from Bangumi (`name_cn` / `name`). / Bangumi 给出的候选标题（`name_cn` / `name`）。 */
  titles?: Array<string | null | undefined>;
  subjectType?: BangumiSubjectType;
  /** Release year when known, used to reject same-title remakes. / 已知发行年，用于拒绝同名翻拍。 */
  expectedYear?: number;
  /** Allowed year difference for title candidates. / 标题候选允许的年份差。 */
  yearTolerance?: number;
};

export type NeodbResolutionVia = 'direct' | 'title-twin' | 'none';

export type NeodbResolution = {
  item: NeodbItem | null;
  via: NeodbResolutionVia;
  failure?: NeodbFetchFailure;
  /** Multiple same-title candidates could not be reduced to one. / 同名候选无法唯一收敛。 */
  ambiguous?: boolean;
  /** Whether the direct item declared a Douban external link. / 直链条目是否声明豆瓣外链。 */
  doubanLinkPresent: boolean;
};

/**
 * Resolve the NeoDB catalog item for a Bangumi URL.
 *
 * If the Bangumi-fetched item already declares a Douban URL, that item is the shared entry and is
 * used directly. Otherwise, search by title for an exact-title hit that has a Douban link.
 *
 * 为某个 Bangumi URL 解析出对应的 NeoDB 目录条目。
 *
 * 如果 Bangumi 直链条目本身已经声明豆瓣 URL，它就是共同条目，直接使用；否则按标题搜索目录，
 * 寻找标题完全相同且带豆瓣外链的结果。
 */
export async function resolveNeodbItemForBangumiUrlDetailed(
  bangumiUrl: string,
  options: ResolveBangumiNeodbOptions = {},
): Promise<NeodbResolution> {
  const failure: FetchFailureRef = {};
  const fromBangumi = await fetchNeodbItemByUrl(bangumiUrl, 3, failure);
  if (!fromBangumi?.uuid) {
    return {
      item: null,
      via: 'none',
      failure: failure.kind ?? 'temporary',
      doubanLinkPresent: false,
    };
  }

  if (extractDoubanUrlFromNeodb(fromBangumi)) {
    return { item: fromBangumi, via: 'direct', doubanLinkPresent: true };
  }

  const category =
    options.subjectType != null
      ? bangumiSubjectTypeToNeodbSearchCategory(options.subjectType)
      : neodbCategoryToSearchCategory(fromBangumi.category);

  const candidates = await findDoubanLinkedTwinCandidates(
    fromBangumi,
    options.titles || [],
    category,
    options.expectedYear,
    options.yearTolerance,
  );
  const picked = pickDoubanLinkedTwin(candidates, fromBangumi, options.expectedYear);
  if (picked.ambiguous) {
    consola.warn(
      'NeoDB same-title twins are ambiguous; using the direct item: ',
      `${fromBangumi.uuid} candidates=${candidates.map((candidate) => candidate.uuid).join(',')}`,
    );
    return {
      item: fromBangumi,
      via: 'direct',
      ambiguous: true,
      doubanLinkPresent: false,
    };
  }
  if (picked.item) {
    consola.info(
      'NeoDB Douban twin found via title search: ',
      `${fromBangumi.uuid} → ${picked.item.uuid} (${picked.item.title || picked.item.display_title})`,
    );
    return { item: picked.item, via: 'title-twin', doubanLinkPresent: false };
  }
  return { item: fromBangumi, via: 'direct', doubanLinkPresent: false };
}
