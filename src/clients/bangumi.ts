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
  // A descriptive UA with a real URL, which is what Bangumi asks for. The old default
  // (`douban-backup/1.0 (…/bambooom/douban-backup)`) named a different project — and carried its
  // typo — so a misbehaving request pointed at somebody else's repository.
  // Bangumi 要求带可识别的 UA 与真实链接。旧默认值（`douban-backup/1.0 (…/bambooom/douban-backup)`）
  // 写的是另一个项目，还带着那个项目的拼写错误 —— 出问题时指向的是别人的仓库。
  'audiovisual-transporter/1.0 (+https://github.com/sachikoakina/Audiovisual-Transporter)';

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

/**
 * Explain a 401 in the user's own language, with the exact fix — the same contract as
 * `neodb-http.ts#logNeodbUnauthorized`. These three messages are the deliberate exception to
 * "runtime messages are English"; keeping the reason in all three stops the next reader from
 * "fixing" one of them.
 * 用用户的语言解释 401，并给出确切的修复步骤 —— 与 `neodb-http.ts#logNeodbUnauthorized` 同一契约。
 * 这三条消息是「运行时消息用英文」的刻意例外；把理由写进三处，下一个读者才不会去「修」其中一条。
 */
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
  /**
   * Release/air date, as different endpoints name it. Search (`SlimSubject`) carries
   * `air_year` / `air_date`; the full subject (`getBangumiSubject`) carries `date`.
   *
   * All optional on purpose: a missing date must never be a reason to reject a candidate. The
   * year filter is a tie-breaker for exact-title collisions, not a completeness requirement.
   *
   * 发行/放送日期，不同端点命名不同：搜索（`SlimSubject`）带 `air_year` / `air_date`，完整条目
   * （`getBangumiSubject`）带 `date`。
   *
   * 全部可选是刻意的：缺日期绝不能成为拒绝候选的理由。年份过滤只是精确同名冲突的补充证据，
   * 不是完整性要求。
   */
  air_year?: number;
  air_date?: string;
  date?: string;
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
  // `subject` is a full `BangumiSubject`, which already declares `name` and `name_cn` as
  // required. The old intersection re-declared both as optional, i.e. it made the type weaker
  // than the payload it describes while looking more precise.
  // `subject` 就是完整的 `BangumiSubject`，它本来就声明了必填的 `name` 与 `name_cn`。旧的交叉
  // 把两者重新声明成可选，看上去更精确，实际比它描述的载荷更弱。
  subject?: BangumiSubject;
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
 * Find every exact title match (name or name_cn), in response order.
 *
 * `pickExactBangumiMatch` used to return only the first one. The year filter needs the rest:
 * rejecting the first candidate is only useful if the next one can still be considered.
 * 找出所有精确同名的候选（name 或 name_cn），保持响应顺序。
 *
 * `pickExactBangumiMatch` 原先只返回第一个。年份过滤需要完整的候选列表：排除第一个之后，
 * 后面的候选仍然要被考虑。
 */
export function exactBangumiCandidates(
  subjects: BangumiSubject[],
  title: string,
): BangumiSubject[] {
  const normalized = title.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return subjects.filter(
    (s) =>
      s.name?.trim().toLowerCase() === normalized ||
      s.name_cn?.trim().toLowerCase() === normalized,
  );
}

/** Parse a year out of `air_year` (number/string) or a `YYYY-MM-DD` / `YYYY` date string. / 从 `air_year` 或日期字符串中解析四位年份。 */
function parseBangumiYear(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const match = raw.trim().match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

/**
 * The release year a Bangumi subject can be dated by, or `null` when it carries none.
 * `air_year` wins because it is already a year; `air_date` / `date` are the two date spellings.
 * 用来给 Bangumi 条目定年的年份；没有则返回 `null`。`air_year` 本身就是年份，优先取；
 * `air_date` / `date` 是两种日期写法。
 */
export function bangumiSubjectYear(subject: BangumiSubject): number | null {
  return (
    parseBangumiYear(subject.air_year) ??
    parseBangumiYear(subject.air_date) ??
    parseBangumiYear(subject.date)
  );
}

/**
 * Only anime (2) and real-action (6) participate in the year soft filter. Books, music and games
 * are never filtered: their release years follow different conventions and a mismatch there is
 * more likely a data-shape problem than evidence of a different work.
 * 只有动画（2）与真人（6）参与年份软过滤。书籍、音乐、游戏不参与：它们的发行年口径不同，
 * 年份对不上更可能是数据形态问题，而不是「不是同一部作品」的证据。
 */
export function isBangumiYearFilterType(type: BangumiSubjectType): boolean {
  return type === 2 || type === 6;
}

/**
 * Pick the first exact-title candidate that survives the year soft filter.
 *
 * The rule is deliberately three-valued:
 *   - source year unknown → the filter does not run at all (returns the first candidate)
 *   - candidate year unknown → that candidate passes; missing data is not evidence
 *   - both known → keep only when |candidate − source| <= tolerance
 *
 * A candidate rejected here is skipped, not fatal: the next exact-title candidate is tried, and
 * `null` is returned only when every candidate was rejected. That `null` flows into the existing
 * `No Bangumi match, skip` line, which is exactly where a human can see the collision.
 * 选择第一个通过年份软过滤的精确同名候选。
 *
 * 规则刻意是三态的：
 *   - 源年份未知 → 过滤完全不运行（返回第一个候选）
 *   - 候选年份未知 → 该候选通过；缺数据不是证据
 *   - 双方都已知 → 只有 |候选 − 源| <= 容差 才保留
 *
 * 这里排除的候选只是被跳过，不是致命错误：继续尝试下一个精确同名候选，只有全部被排除才返回
 * `null`。这个 `null` 会流入既有的 `No Bangumi match, skip`，让人能在日志里看到这次同名冲突。
 *
 * @param resolveYear Injected so the caller can lazily fetch a missing date from the full subject
 *   endpoint; tests pass a plain function. / 由调用方注入，以便对缺失日期按需读取完整条目；
 *   测试可以直接传普通函数。
 */
export async function pickExactBangumiMatchByYear(
  candidates: BangumiSubject[],
  expectedYear: number | null,
  tolerance: number,
  resolveYear: (
    subject: BangumiSubject,
  ) => Promise<number | null> | number | null = bangumiSubjectYear,
): Promise<BangumiSubject | null> {
  if (!candidates.length) {
    return null;
  }
  // No source year: no comparison, no extra requests, exactly the pre-existing behaviour.
  // 没有源年份：不比较、不额外请求，完全保持原有行为。
  if (expectedYear == null) {
    return candidates[0];
  }

  const allowedDrift = Math.max(0, tolerance);
  for (const candidate of candidates) {
    // Defensive: the search is already filtered by type, but a caller that passes a mixed list
    // must not have its books/music/games rejected by a year rule that was never meant for them.
    // 防御性判断：搜索已按类型过滤；但即使调用方传入混合列表，书/音乐/游戏也不该被这条
    // 本不适用于它们的年份规则排除。
    if (!isBangumiYearFilterType(candidate.type)) {
      return candidate;
    }

    const year = await resolveYear(candidate);
    if (year == null) {
      return candidate;
    }
    if (Math.abs(year - expectedYear) <= allowedDrift) {
      return candidate;
    }
    consola.info(
      'Bangumi candidate rejected by year: ',
      `subject/${candidate.id} (${year}) vs expected ${expectedYear} ±${allowedDrift}`,
    );
  }
  return null;
}

/**
 * Find the first exact title match (name or name_cn) among search results.
 *
 * Kept as-is for callers that do not need the year filter.
 * 找出第一个精确同名（name 或 name_cn）的搜索结果；保留给不需要年份过滤的调用方。
 */
export function pickExactBangumiMatch(
  subjects: BangumiSubject[],
  title: string,
): BangumiSubject | null {
  return exactBangumiCandidates(subjects, title)[0] ?? null;
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
