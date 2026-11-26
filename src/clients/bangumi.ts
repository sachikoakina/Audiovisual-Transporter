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

/** Page size for collection listing, clamped to Bangumi's accepted maximum of 50. / 收藏列表的分页大小，被约束在 Bangumi 接受的 50 以内。 */
const rawCollectionLimit = process.env.BANGUMI_COLLECTION_LIMIT;
// `Number('')` is 0 and `Number('abc')` is NaN; both used to reach Bangumi as `limit=1` or
// `limit=NaN`. Anything unusable falls back to the default page size instead.
// `Number('')` 是 0、`Number('abc')` 是 NaN；两者过去会以 `limit=1` 或 `limit=NaN` 发给 Bangumi。
// 任何不可用的值都回落到默认页大小。
const parsedCollectionLimit =
  rawCollectionLimit === undefined || rawCollectionLimit.trim() === ''
    ? 50
    : Number(rawCollectionLimit);
export const bangumiCollectionLimit = Number.isFinite(parsedCollectionLimit)
  ? Math.floor(Math.min(Math.max(parsedCollectionLimit, 1), 50))
  : 50;
/** Bangumi requires a descriptive UA. / Bangumi 要求带一个可识别的 UA。 */
const bangumiUserAgent =
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

/** Bangumi infobox entry; `版本:*` values contain nested key/value pairs. / Bangumi 信息表项。 */
export type BangumiInfoboxItem = {
  key: string;
  value: string | { k: string; v: string }[];
};

export type BangumiSubject = {
  id: number;
  type: BangumiSubjectType;
  name: string;
  name_cn: string;
  /** TV, Web, 小说, ... — present on full subject, not SlimSubject */
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
  /** Total chapters for a book. / 书籍总章节数。 */
  eps?: number;
  /** Total volumes for a book. / 书籍总卷数。 */
  volumes?: number;
  /** Full subject only: book ISBN/author/edition metadata. / 完整条目才有：书籍 ISBN/作者/版次信息。 */
  infobox?: BangumiInfoboxItem[];
};

export type BangumiEpisode = {
  id: number;
  /** 0 main, 1 SP, 2 OP, 3 ED. / 0 本篇，1 SP，2 OP，3 ED。 */
  type: number;
  sort: number;
  ep?: number;
};

export type BangumiEpisodeState = {
  type: number;
  /** Unix seconds returned by the API. / API 返回的 Unix 秒。 */
  updatedAt?: number;
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
 * Full subject details, including fields the collection summary does not carry.
 * A 404 here means the subject itself is gone, which is an item-level read failure.
 * 主体详情，包含收藏摘要不携带的字段。这里的 404 意味着主体本身不存在，归为条目级读取失败。
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
    /** Book-only progress. / 仅书籍使用的进度。 */
    ep_status?: number;
    vol_status?: number;
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

/** Paginated subject episodes. / 分页读取条目分集。 */
export async function getBangumiEpisodes(
  subjectId: number,
): Promise<ReadResult<BangumiEpisode[]>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  const episodes: BangumiEpisode[] = [];
  let offset = 0;
  try {
    while (true) {
      await bangumiThrottle();
      const page = (await got(`${BGM_API}/v0/episodes`, {
        headers: authHeaders(),
        searchParams: { subject_id: subjectId, limit: 200, offset },
      }).json()) as { data?: BangumiEpisode[]; total?: number };
      const data = page.data ?? [];
      episodes.push(...data);
      offset += data.length;
      if (data.length < 200 || offset >= (page.total ?? offset)) break;
    }
    return { status: 'found', value: episodes };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    if (classifyReadFailure(status) === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `episodes ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`Failed to get Bangumi episodes ${subjectId}: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `episodes ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/** Current user's per-episode state for one subject. / 当前用户某条目的分集收藏状态。 */
export async function getBangumiEpisodeStates(
  subjectId: number,
): Promise<ReadResult<Map<number, BangumiEpisodeState>>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  const states = new Map<number, BangumiEpisodeState>();
  let offset = 0;
  try {
    while (true) {
      await bangumiThrottle();
      const page = (await got(
        `${BGM_API}/v0/users/-/collections/${subjectId}/episodes`,
        {
          headers: authHeaders(),
          searchParams: { limit: 1000, offset },
        },
      ).json()) as {
        data?: Array<{ episode?: { id?: number }; type?: number; updated_at?: number }>;
        total?: number;
      };
      const data = page.data ?? [];
      for (const row of data) {
        if (row.episode?.id != null && row.type != null) {
          states.set(row.episode.id, { type: row.type, updatedAt: row.updated_at });
        }
      }
      offset += data.length;
      if (data.length < 1000 || offset >= (page.total ?? offset)) break;
    }
    return { status: 'found', value: states };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    if (classifyReadFailure(status) === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `episode states ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`Failed to get Bangumi episode states ${subjectId}: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `episode states ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/** Mark one episode watched; server assigns updated_at. / 标记单集看过，时间由服务端写入。 */
export async function markBangumiEpisodeWatched(
  subjectId: number,
  episodeId: number,
): Promise<boolean> {
  if (!bangumiToken) return false;
  try {
    await bangumiThrottle();
    await got.put(`${BGM_API}/v0/users/-/collections/-/episodes/${episodeId}`, {
      headers: authHeaders(),
      json: { type: 2 },
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(
        `Failed to mark Bangumi episode ${subjectId}/${episodeId}: `,
        error,
      );
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

/** Normalize a Bangumi platform to the same coarse form used by NeoDB. / 将 Bangumi platform 归一为影视形态。 */
export function bangumiPlatformForm(platform?: string): 'tv' | 'movie' | null {
  const value = platform?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'tv' || value === 'web' || value.includes('电视剧')) return 'tv';
  if (value === '电影' || value.includes('剧场版')) return 'movie';
  return null;
}

export type BangumiMatchOptions = {
  sourceForm?: 'tv' | 'movie' | null;
  resolveForm?: (
    subject: BangumiSubject,
  ) => Promise<'tv' | 'movie' | null> | 'tv' | 'movie' | null;
};

type DatedBangumiCandidate = {
  subject: BangumiSubject;
  year: number | null;
  form: 'tv' | 'movie' | null;
};

async function pickBangumiByForm(
  candidates: DatedBangumiCandidate[],
  sourceForm: 'tv' | 'movie' | null,
  options: BangumiMatchOptions,
): Promise<BangumiSubject | null> {
  if (!sourceForm || candidates.length <= 1) {
    // Equal-year candidates without a usable form are a collision, not a reason to take the first.
    // 同年候选若缺少可用形态，是冲突而不是取第一个的理由。
    return null;
  }

  const forms = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      form:
        candidate.form ??
        (options.resolveForm ? await options.resolveForm(candidate.subject) : null),
    })),
  );
  const matching = forms.filter(({ form }) => form === sourceForm);
  return matching.length === 1 ? matching[0]!.candidate.subject : null;
}

/**
 * Pick the best exact-title candidate without first-hit selection.
 *
 * Order:
 *   1. exact year (difference 0)
 *   2. if multiple, media form (TV vs movie)
 *   3. otherwise the smallest drift within tolerance
 *   4. if multiple at that drift, media form
 *   5. anything still ambiguous returns null
 *
 * 选择精确同名候选，不再 first-hit：
 *   1. 年份完全相同
 *   2. 多个时按 TV / 电影形态裁决
 *   3. 没有同年候选时取容差内最小差值
 *   4. 最小差值仍多个时按形态裁决
 *   5. 仍无法唯一确定则返回 null
 *
 * @param resolveYear Injected so the caller can lazily fetch a missing date from the full subject
 *   endpoint; tests pass a plain function. / 由调用方注入，以便对缺失日期按需读取完整条目。
 * @param options Optional media-form resolver, used only when year leaves a tie. / 可选的媒体形态
 *   解析器，只在年份无法唯一裁决时使用。
 */
export async function pickExactBangumiMatchByYear(
  candidates: BangumiSubject[],
  expectedYear: number | null,
  tolerance: number,
  resolveYear: (
    subject: BangumiSubject,
  ) => Promise<number | null> | number | null = bangumiSubjectYear,
  options: BangumiMatchOptions = {},
): Promise<BangumiSubject | null> {
  if (!candidates.length) {
    return null;
  }

  // Non-year-filter types keep their prior behaviour: the first candidate wins.
  // 非年份过滤类型维持旧行为：第一个候选胜出。
  const nonYearCandidates = candidates.filter(
    (candidate) => !isBangumiYearFilterType(candidate.type),
  );
  const yearCandidates = candidates.filter((candidate) =>
    isBangumiYearFilterType(candidate.type),
  );
  if (yearCandidates.length === 0) {
    return nonYearCandidates[0] ?? null;
  }

  // Source year unknown and only one candidate: preserve the old zero-request path.
  // 源年份未知且只有一个候选：保持旧的零请求行为。
  if (expectedYear == null) {
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    // Multiple candidates without a source year is ambiguous, not a first-hit.
    // 多个候选且没有源年份是歧义，不允许 first-hit。
    return null;
  }

  const dated: DatedBangumiCandidate[] = [];
  for (const subject of yearCandidates) {
    dated.push({
      subject,
      year: await resolveYear(subject),
      form: bangumiPlatformForm(subject.platform),
    });
  }

  if (dated.every((candidate) => candidate.year == null)) {
    // A single undated exact-title candidate keeps the old compatibility path; multiple
    // undated candidates cannot be ordered without inventing evidence.
    // 唯一一个缺年份的精确同名候选保留旧兼容路径；多个缺年份候选不能凭空排序。
    return dated.length === 1 ? dated[0]!.subject : null;
  }

  const exact = dated.filter(
    (candidate) => candidate.year != null && candidate.year === expectedYear,
  );
  if (exact.length === 1) {
    return exact[0]!.subject;
  }
  if (exact.length > 1) {
    return pickBangumiByForm(exact, options.sourceForm ?? null, options);
  }

  const allowedDrift = Math.max(0, tolerance);
  const tolerant = dated.filter(
    (candidate) =>
      candidate.year != null && Math.abs(candidate.year - expectedYear) <= allowedDrift,
  );
  if (tolerant.length === 0) {
    return null;
  }

  const minDrift = Math.min(
    ...tolerant.map((candidate) => Math.abs(candidate.year! - expectedYear)),
  );
  const closest = tolerant.filter(
    (candidate) => Math.abs(candidate.year! - expectedYear) === minDrift,
  );

  if (closest.length === 1) {
    return closest[0]!.subject;
  }
  return pickBangumiByForm(closest, options.sourceForm ?? null, options);
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
