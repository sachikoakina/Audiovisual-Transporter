/**
 * NeoDB shelf client — item marks, progress, and shelf listing.
 * NeoDB 书架客户端 —— 条目标记、进度、以及书架列表。
 *
 * Scope: everything that touches the current user's own shelf. Catalogue lookup lives in
 * `neodb-catalog.ts`; credentials and transport helpers live in `neodb-http.ts`.
 * 范围：一切涉及当前用户自己书架的操作。目录查询在 `neodb-catalog.ts`；凭据与传输助手在
 * `neodb-http.ts`。
 */
import { HTTPError } from 'got';
import { consola } from 'consola';
import { doubanStarsToTenPoint } from '../rules/douban';
import { neodbTmdbConfig } from '../sync-config';
import {
  logNeodbUnauthorized,
  neodbAuthHeaders,
  neodbClient,
  neodbFailureCode,
  neodbThrottle,
  neodbToken,
  neodbVisibility,
  redirectUrlFromError,
} from './neodb-http';
import {
  ItemStatus,
  type NeodbItem,
  type NeodbMe,
  type NeodbPagedMark,
  type NeodbProgressType,
  type ShelfType,
} from '../types';

/** The current user's mark on one catalog item (no item payload — see `NeodbShelfMark`). / 当前用户在某条目录条目上的标记（不含条目内容，条目级结构见 `NeodbShelfMark`）。 */
export type NeodbMark = {
  shelf_type: ItemStatus | string;
  visibility?: number;
  comment_text?: string;
  rating_grade?: number;
  created_time?: string;
};

/**
 * Get the current user's mark for a NeoDB item. Returns null if not marked.
 * 取当前用户在某条 NeoDB 条目上的标记；未标记时返回 null。
 */
export async function getNeodbMark(uuid: string): Promise<NeodbMark | null> {
  if (!neodbToken) {
    return null;
  }

  try {
    return (await neodbClient(`api/me/shelf/item/${uuid}`, {
      headers: neodbAuthHeaders(),
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
  /** Douban 1–5 stars; will be converted to a 0–10 grade. Pass null to clear. / 豆瓣 1–5 星；会换算为 0–10 分。传 null 表示清空。 */
  rating?: number | null;
  /** Already in the NeoDB 0–10 scale. Takes precedence over `rating` when set. / 已是 NeoDB 的 0–10 分制；设置时优先于 `rating`。 */
  ratingGrade?: number | null;
  createdTime?: string | null;
  visibility?: number;
};

/**
 * Mark (create or update) an item on the current user's NeoDB shelf.
 * 在当前用户的 NeoDB 书架上看护（新建或更新）一个条目。
 *
 * Note: `post_to_fediverse` is pinned to `false` so a sync never posts to the fediverse.
 * 注意：`post_to_fediverse` 固定为 `false`，使同步永远不会向联邦宇宙发帖。
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
  } else {
    ratingGrade = doubanStarsToTenPoint(options.rating);
  }

  try {
    await neodbClient.post(`api/me/shelf/item/${neodbItem.uuid}`, {
      headers: neodbAuthHeaders(),
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
      headers: neodbAuthHeaders(),
      followRedirect: false,
      throwHttpErrors: true,
      ...(json ? { json } : {}),
    };
    if (method === 'post') {
      return (await neodbClient.post(url, options).json()) as T;
    }
    return (await neodbClient(url, options).json()) as T;
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : 0;
    // GET merge → 302; POST/DELETE merge → 307. Retry once against the returned url.
    // GET 合并返回 302，POST/DELETE 合并返回 307。按返回的 url 重试一次。
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
  return `api/me/shelf/item/${uuid}/progress`;
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

// ───────────────────────────────────────────────────────────────────────────
// Shelf listing
// 书架列表
//
// Verified endpoints (sources in README "链路② · 接口依据"):
//   GET /api/token                            → credential probe
//   GET /api/me                               → current account
//   GET /api/me/shelf/{type}?category=&page=  → PagedMarkSchema
//
// `type` is a PATH parameter, not a query parameter. That is the single most
// likely integration bug here, hence the explicit URL construction below.
//
// Unlike the per-item calls above, this half goes through `neodbShelfClient`,
// which honours the configurable `NEODB_BASE_URL` (self-hosted instances).
//
// 已验证的端点（来源见 README「五条链路 · 链路② 豆瓣 RSS → NeoDB · 接口依据」）：
//   GET /api/token                            → 凭据探测
//   GET /api/me                               → 当前账号
//   GET /api/me/shelf/{type}?category=&page=  → PagedMarkSchema
//
// `type` 是**路径参数**，不是查询参数。这是本处最容易踩的集成坑，因此下面的 URL 显式拼接。
//
// 与上面的条目级调用不同，本部分经由 `neodbShelfClient`，它遵守可配置的 `NEODB_BASE_URL`
// （用于自建实例）。
// ───────────────────────────────────────────────────────────────────────────

// Extends `neodbClient`, so the base URL is inherited from the one place that knows it; only the
// retry/timeout policy is overridden here.
// 从 `neodbClient` 扩展而来，因此 base URL 继承自唯一了解它的地方；这里只覆盖重试/超时策略。
const neodbShelfClient = neodbClient.extend({
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

/** GET /api/token — cheap way to validate credentials before a full run. / GET /api/token —— 在整轮运行前低成本校验凭据。 */
export async function verifyNeodbToken(): Promise<boolean> {
  if (!neodbToken) {
    return false;
  }
  try {
    await neodbShelfClient('api/token', { headers: neodbAuthHeaders() });
    return true;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else {
      consola.error('NeoDB token check failed: ', neodbFailureCode(error));
    }
    return false;
  }
}

/** `GET /api/me` — the current account. / `GET /api/me` —— 当前账号。 */
export async function getNeodbMe(): Promise<NeodbMe | null> {
  if (!neodbToken) {
    return null;
  }
  try {
    return (await neodbShelfClient('api/me', {
      headers: neodbAuthHeaders(),
    }).json()) as NeodbMe;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else {
      consola.error('Failed to fetch NeoDB account: ', neodbFailureCode(error));
    }
    return null;
  }
}

/**
 * One page of GET /api/me/shelf/{type}.
 * Returns null on failure so callers can tell "error" from "empty page".
 *
 * GET /api/me/shelf/{type} 的一页。失败时返回 null，使调用方能区分「出错」与「空页」。
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
      headers: neodbAuthHeaders(),
      searchParams,
    }).json()) as NeodbPagedMark;

    // Defensive: the shape is verified, but a proxy or a fork could differ.
    // 防御性处理：结构已实测，但代理或分支实现可能不同。
    if (!Array.isArray(result?.data)) {
      consola.warn(
        `Unexpected shelf response for ${options.shelfType} page ${options.page}; treating as empty.`,
      );
      return { data: [], pages: 1, count: 0 };
    }
    return result;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else if (error instanceof HTTPError && error.response.statusCode === 404) {
      consola.warn(
        `Shelf "${options.shelfType}" returned 404 — it may not exist on this instance.`,
      );
    } else {
      consola.error(
        `Failed to fetch shelf ${options.shelfType} page ${options.page}: `,
        neodbFailureCode(error),
      );
    }
    return null;
  }
}

/**
 * Walk the pages of one shelf, up to `maxPages`.
 * Stops early on an empty page or when the reported page count is reached.
 *
 * Only path ⑤ calls this. `maxPages` defaults to `NEODB_MAX_PAGES`; full-sync mode passes
 * `Infinity` to walk until the API itself says it is done.
 *
 * 遍历某个书架的分页，最多到 `maxPages`。遇到空页或已达到上报的总页数时提前停止。
 *
 * 只有链路⑤调用它。`maxPages` 默认取 `NEODB_MAX_PAGES`；全量模式传入 `Infinity`，一直走到
 * API 自己表示没有下一页为止。
 */
export async function fetchShelf(
  shelfType: ShelfType,
  category?: string,
  maxPages: number = neodbTmdbConfig.neodb.maxPages,
): Promise<NeodbPagedMark['data']> {
  const collected: NeodbPagedMark['data'] = [];

  for (let page = 1; page <= maxPages; page += 1) {
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
    if (page === maxPages) {
      consola.warn(
        `Shelf "${shelfType}" hit NEODB_MAX_PAGES (${maxPages}); more items remain.`,
      );
      break;
    }
    await neodbThrottle();
  }

  return collected;
}
