/**
 * Bangumi client — api.bgm.tv v0 endpoints used by the Douban→Bangumi and Bangumi→NeoDB paths.
 * Bangumi 客户端 —— 豆瓣→Bangumi 与 Bangumi→NeoDB 两条链路用到的 api.bgm.tv v0 端点。
 *
 * Scale conversion is NOT here: Douban's 1–5 stars → 0–10 lives in `rules/douban.ts`
 * (`doubanStarsToTenPoint`), because it is a fact about Douban's scale, not about Bangumi.
 * 分制换算**不在**这里：豆瓣 1–5 星 → 0–10 分位于 `rules/douban.ts`
 * （`doubanStarsToTenPoint`），因为那是豆瓣分制的事实，而不是 Bangumi 的。
 */
import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import type { BangumiCollectionType, BangumiSubjectType, ReadResult } from '../types';
import { classifyReadFailure } from '../rules/read-result';
import { sleep } from '../utils';

dotenv.config();

/** `BANGUMI_ACCESS_TOKEN`. `undefined` disables every authenticated call. / `BANGUMI_ACCESS_TOKEN`；为 `undefined` 时所有需鉴权的调用都会被跳过。 */
export const bangumiToken = process.env.BANGUMI_ACCESS_TOKEN;
/** `BANGUMI_PRIVATE=true` makes new collections private. / `BANGUMI_PRIVATE=true` 时新建收藏为私密。 */
export const bangumiPrivate = process.env.BANGUMI_PRIVATE === 'true';
/** Page size for collection listing, clamped to Bangumi's accepted maximum of 50. / 收藏列表的分页大小，被约束在 Bangumi 接受的 50 以内。 */
export const bangumiCollectionLimit = Math.min(
  Math.max(Number(process.env.BANGUMI_COLLECTION_LIMIT ?? 50), 1),
  50,
);
/** Bangumi requires a descriptive UA. / Bangumi 要求带一个可识别的 UA。 */
export const bangumiUserAgent =
  process.env.BANGUMI_USER_AGENT ||
  'douban-backup/1.0 (https://github.com/bambooom/douban-backup)';

const BGM_API = 'https://api.bgm.tv';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'User-Agent': bangumiUserAgent,
  };
  if (bangumiToken) {
    headers.Authorization = `Bearer ${bangumiToken}`;
  }
  return headers;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof HTTPError && error.response.statusCode === 401;
}

function logUnauthorized(): void {
  consola.error(
    'Bangumi token 可能已过期，请到 https://next.bgm.tv/demo/access-token 重新生成并更新 BANGUMI_ACCESS_TOKEN secret',
  );
}

export type BangumiSubject = {
  id: number;
  type: BangumiSubjectType;
  name: string;
  name_cn: string;
  /** TV, Web, 漫画, 小说, ... — present on full subject, not SlimSubject */
  platform?: string;
};

export type BangumiCollection = {
  subject_id: number;
  subject_type: BangumiSubjectType;
  rate: number;
  type: BangumiCollectionType;
  comment?: string | null;
  tags?: string[];
  ep_status?: number;
  vol_status?: number;
  updated_at: string;
  private: boolean;
  subject?: BangumiSubject & {
    name?: string;
    name_cn?: string;
  };
};

export type BangumiUser = {
  id: number;
  username: string;
  nickname: string;
};

export async function getBangumiMe(): Promise<BangumiUser | null> {
  if (!bangumiToken) {
    return null;
  }
  try {
    return (await got(`${BGM_API}/v0/me`, {
      headers: authHeaders(),
    }).json()) as BangumiUser;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error('Failed to get Bangumi /v0/me: ', error);
    }
    return null;
  }
}

/**
 * Full subject details (includes platform for books: 漫画 / 小说 / ...).
 *
 * A 404 here means the subject itself is gone, which is *not* "no platform": the manga gate
 * cannot be evaluated either way, so 404 is classified as an item-level read failure.
 * 主体详情（书籍的平台 漫画 / 小说 / … 就在这里）。这里的 404 意味着主体本身不存在，
 * 而不是「没有平台」：漫画闸门无论如何都判不了，所以 404 归为条目级读取失败。
 */
export async function getBangumiSubject(
  subjectId: number,
): Promise<ReadResult<BangumiSubject>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  try {
    return {
      status: 'found',
      value: (await got(`${BGM_API}/v0/subjects/${subjectId}`, {
        headers: authHeaders(),
      }).json()) as BangumiSubject,
    };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    const kind = classifyReadFailure(status, 'item');
    if (kind === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `subject ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`Failed to get Bangumi subject ${subjectId}: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `subject ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/**
 * One collection (the user's status/rating/comment on a subject).
 * 一条收藏（用户对某主体 的状态/评分/短评）。
 *
 * `absent` = the user has not collected this subject, which is the only reading a create may be
 * based on. A 404 is that answer; a 401 or a 5xx is not.
 * `absent` = 用户没有收藏这个主体，也是唯一可以据此新建的读法。404 是这个答案，401 或 5xx 不是。
 */
export async function getBangumiCollection(
  username: string,
  subjectId: number,
): Promise<ReadResult<BangumiCollection>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  try {
    return {
      status: 'found',
      value: (await got(`${BGM_API}/v0/users/${username}/collections/${subjectId}`, {
        headers: authHeaders(),
      }).json()) as BangumiCollection,
    };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    const kind = classifyReadFailure(status);
    if (kind === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `collection ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    if (kind === 'absent') {
      return { status: 'absent' };
    }
    consola.error(`Failed to get Bangumi collection ${subjectId}: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `collection ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

export async function upsertBangumiCollection(
  subjectId: number,
  payload: {
    type: BangumiCollectionType;
    rate?: number;
    comment?: string;
    private?: boolean;
  },
): Promise<boolean> {
  if (!bangumiToken) {
    return false;
  }
  try {
    await got.post(`${BGM_API}/v0/users/-/collections/${subjectId}`, {
      headers: authHeaders(),
      json: payload,
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(`Failed to upsert Bangumi collection ${subjectId}: `, error);
    }
    return false;
  }
}

export async function searchBangumiSubjects(
  keyword: string,
  types?: BangumiSubjectType[],
  limit = 10,
): Promise<BangumiSubject[]> {
  try {
    const body: {
      keyword: string;
      filter?: { type?: BangumiSubjectType[] };
    } = { keyword };
    if (types?.length) {
      body.filter = { type: types };
    }

    const result = (await got
      .post(`${BGM_API}/v0/search/subjects`, {
        headers: authHeaders(),
        searchParams: { limit, offset: 0 },
        json: body,
      })
      .json()) as { data?: BangumiSubject[] };

    return result.data || [];
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error('Failed to search Bangumi subjects: ', error);
    }
    return [];
  }
}

/**
 * Find an exact title match (name or name_cn) among search results.
 */
export function pickExactBangumiMatch(
  subjects: BangumiSubject[],
  title: string,
): BangumiSubject | null {
  const normalized = title.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (
    subjects.find(
      (s) =>
        s.name?.trim().toLowerCase() === normalized ||
        s.name_cn?.trim().toLowerCase() === normalized,
    ) || null
  );
}

/**
 * List a user's collections, one page at a time.
 * 分页列出某个用户的收藏。
 *
 * A failed request (401, network, rate limit) returns **`null`**, not an empty page. Returning
 * `{ total: 0, data: [] }` — as this used to — made a failure indistinguishable from "this user has
 * no more collections", so a full sync could stop early and report success.
 * 请求失败（401、网络问题、限流）时返回 **`null`**，而不是空页。原先返回
 * `{ total: 0, data: [] }` 会让失败与「该用户没有更多收藏了」无法区分，于是全量同步可能提前
 * 停止并报告成功。
 *
 * @returns The page, or `null` on failure. 该页；失败时为 `null`。
 */
export async function listBangumiCollections(options: {
  username: string;
  limit?: number;
  offset?: number;
  subjectType?: BangumiSubjectType;
}): Promise<{ total: number; data: BangumiCollection[] } | null> {
  const limit = options.limit ?? bangumiCollectionLimit;
  try {
    const searchParams: Record<string, string | number> = {
      limit,
      offset: options.offset ?? 0,
    };
    if (options.subjectType) {
      searchParams.subject_type = options.subjectType;
    }

    return (await got(`${BGM_API}/v0/users/${options.username}/collections`, {
      headers: authHeaders(),
      searchParams,
    }).json()) as { total: number; data: BangumiCollection[] };
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error('Failed to list Bangumi collections: ', error);
    }
    return null;
  }
}

/** Canonical subject URL for a Bangumi subject id. / 由 Bangumi subject id 得到规范的条目 URL。 */
export function bangumiSubjectUrl(subjectId: number): string {
  return `https://bgm.tv/subject/${subjectId}`;
}

/** Small delay between Bangumi API calls to avoid rate limits. / Bangumi API 调用之间的固定小延迟，用于规避限流。 */
export async function bangumiThrottle(): Promise<void> {
  await sleep(400);
}
