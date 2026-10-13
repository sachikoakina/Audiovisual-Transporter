import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import type { BangumiCollectionType, BangumiSubjectType } from './types';
import { sleep } from './utils';

dotenv.config();

export const bangumiToken = process.env.BANGUMI_ACCESS_TOKEN;
export const bangumiPrivate = process.env.BANGUMI_PRIVATE === 'true';
export const bangumiCollectionLimit = Math.min(
  Math.max(Number(process.env.BANGUMI_COLLECTION_LIMIT ?? 50), 1),
  50,
);
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
 */
export async function getBangumiSubject(
  subjectId: number,
): Promise<BangumiSubject | null> {
  if (!bangumiToken) {
    return null;
  }
  try {
    return (await got(`${BGM_API}/v0/subjects/${subjectId}`, {
      headers: authHeaders(),
    }).json()) as BangumiSubject;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
      return null;
    }
    if (error instanceof HTTPError && error.response.statusCode === 404) {
      return null;
    }
    consola.error(`Failed to get Bangumi subject ${subjectId}: `, error);
    return null;
  }
}

export async function getBangumiCollection(
  username: string,
  subjectId: number,
): Promise<BangumiCollection | null> {
  if (!bangumiToken) {
    return null;
  }
  try {
    return (await got(`${BGM_API}/v0/users/${username}/collections/${subjectId}`, {
      headers: authHeaders(),
    }).json()) as BangumiCollection;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
      return null;
    }
    if (error instanceof HTTPError && error.response.statusCode === 404) {
      return null;
    }
    consola.error(`Failed to get Bangumi collection ${subjectId}: `, error);
    return null;
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

export async function listBangumiCollections(options: {
  username: string;
  limit?: number;
  offset?: number;
  subjectType?: BangumiSubjectType;
}): Promise<{ total: number; data: BangumiCollection[] }> {
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
    return { total: 0, data: [] };
  }
}

export function bangumiSubjectUrl(subjectId: number): string {
  return `https://bgm.tv/subject/${subjectId}`;
}

/** Small delay between Bangumi API calls to avoid rate limits. */
export async function bangumiThrottle(): Promise<void> {
  await sleep(400);
}

/**
 * Convert Douban 1–5 star rating to Bangumi 0–10 rate.
 */
export function doubanRatingToBangumi(rating: number | null | undefined): number {
  if (!rating) {
    return 0;
  }
  return rating * 2;
}
