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
import type { NeodbItem } from '../types';

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
 * enough to *describe* an item and not enough to *date* one — title matching in ③ and ⑤ needs the
 * year that only this per-item payload carries.
 *
 * 为什么需要它：书架端点（`GET /api/me/shelf/{type}`）内联的是 `ItemSchema`，而 `ItemSchema` 没有
 * `year` / `pub_year`。这两个字段只在 `api_url` 提供的条目级 schema（`MovieSchema`、`TVSchema`、
 * 季 schema）上。因此书架载荷足以**描述**一个条目，却不足以给它**定年** —— ③ 与 ⑤ 的标题匹配需要
 * 这个只存在于条目级载荷中的年份。
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

export type NeodbResolution = {
  item: NeodbItem | null;
  failure?: NeodbFetchFailure;
  /** True when the direct item already carries a Douban external link. / 直链条目已有豆瓣外链。 */
  doubanLinkPresent: boolean;
};

/**
 * Resolve the NeoDB catalog item for a Bangumi URL.
 * The Bangumi URL is the only target identity. A Douban link already present on the returned item
 * is recorded for diagnostics, never used to choose another item.
 *
 * 为 Bangumi URL 解析 NeoDB 目录条目。Bangumi URL 是唯一目标身份；返回条目自身已有的豆瓣外链
 * 只用于诊断，绝不据此改选其他条目。
 */
export async function resolveNeodbItemForBangumiUrlDetailed(
  bangumiUrl: string,
): Promise<NeodbResolution> {
  const failure: FetchFailureRef = {};
  const item = await fetchNeodbItemByUrl(bangumiUrl, 3, failure);
  if (!item?.uuid) {
    return {
      item: null,
      failure: failure.kind ?? 'temporary',
      doubanLinkPresent: false,
    };
  }
  return {
    item,
    doubanLinkPresent: extractDoubanUrlFromNeodb(item) != null,
  };
}
