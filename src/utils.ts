/**
 * Shared utilities — process-level helpers, incremental sync state, and the review log.
 * 通用工具 —— 进程级辅助函数、增量同步状态、以及留档日志。
 *
 * Deliberately narrow: this file holds only things that are not specific to any single
 * platform. Notion vocabulary moved to `clients/notion.ts`, and the Notion data-source id
 * lookup moved to `sync-config.ts` (where the rest of the env reading lives), which also
 * removed the last `cols.json` dependency from this file.
 * 刻意保持窄口径：本文件只放与任何单一平台无关的东西。Notion 词汇已移至
 * `clients/notion.ts`，Notion data source id 的查找已移至 `sync-config.ts`（其余读取
 * 环境变量的地方），这也顺带移除了本文件对 `cols.json` 的最后依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { consola } from 'consola';
import { type NeodbShelfMark } from './types';

dotenv.config();

/**
 * Delay execution for a number of milliseconds.
 * 延迟指定毫秒数。
 *
 * @param ms - Milliseconds to sleep. 需要等待的毫秒数。
 * @returns A promise that resolves after the delay. 延迟结束后 resolve 的 Promise。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path: incremental sync state
// NeoDB → TMDB 链路：增量同步状态
//
// Records a content fingerprint per (shelf, item) so an unchanged mark costs
// zero TMDB requests on later runs. Kept as a plain JSON file so it is easy to
// inspect and delete.
// 为每个 (书架, 条目) 记录内容指纹，使得未变化的标记在后续运行中不产生任何 TMDB 请求。
// 以纯 JSON 文件保存，便于人工查看与删除。
// ───────────────────────────────────────────────────────────────────────────

export type StateEntry = {
  /** Content fingerprint: changes whenever the mark changes. / 内容指纹：标记一变就变。 */
  fp: string;
  /** When this entry was last written, for pruning. / 该条目最近一次写入的时间，用于裁剪。 */
  at: string;
};

export type SyncState = {
  version: number;
  updatedAt: string;
  /** key = `${shelfType}:${itemUuid}` / 键格式：`${shelfType}:${itemUuid}` */
  synced: Record<string, StateEntry>;
};

const STATE_VERSION = 1;
/** Keep the state file bounded; oldest entries are dropped first. / 限制状态文件大小，优先丢弃最旧的条目。 */
const MAX_STATE_ENTRIES = 20000;

/**
 * Write JSON via a temp file in the same directory, then rename over the target.
 * 先写入同目录下的临时文件，再改名覆盖目标文件。
 *
 * `rename` within one filesystem is atomic, so a crash (or a killed CI job) leaves either the old
 * file or the new one — never a half-written file. A plain `writeFileSync` truncates first, so the
 * failure mode it allows is a truncated JSON file that the next run reads as "no state", which
 * silently re-syncs everything.
 * 同一文件系统内的 `rename` 是原子的，因此崩溃（或被杀掉的 CI 任务）只会留下旧文件或新文件，
 * 绝不会留下写了一半的文件。而 `writeFileSync` 会先截断，它允许的失败形态是一个被截断的 JSON
 * 文件，下一次运行会把它读成「没有状态」，于是静默地重新同步所有内容。
 */
function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  // Same directory as the target, so the rename cannot cross a filesystem boundary.
  // 与目标同目录，确保 rename 不会跨文件系统。
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function emptyState(): SyncState {
  return { version: STATE_VERSION, updatedAt: new Date().toISOString(), synced: {} };
}

/**
 * `code` / message off an unknown thrown value, without `catch (error: any)`.
 * 从任意抛出物里取 `code` 与消息，不用 `catch (error: any)`。
 *
 * `ENOENT` is the one code the state file actually branches on; everything else is only ever
 * printed, so a narrow read of the two known fields is enough.
 * `ENOENT` 是状态文件真正会分支处理的唯一 code；其余只用于打印，因此只读这两个字段就够了。
 */
function fileErrorDetail(error: unknown): { code?: string; text: string } {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      code: typeof code === 'string' ? code : undefined,
      text: typeof message === 'string' ? message : String(error),
    };
  }
  return { text: String(error) };
}

export function readState(file: string): SyncState {
  if (!file) {
    return emptyState();
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as SyncState;
    if (parsed?.version !== STATE_VERSION || typeof parsed.synced !== 'object') {
      consola.warn(`State file ${file} has an unexpected shape; starting fresh.`);
      return emptyState();
    }
    return parsed;
  } catch (error) {
    const { code, text } = fileErrorDetail(error);
    if (code !== 'ENOENT') {
      consola.warn(`Could not read state file ${file}: ${text}`);
    }
    return emptyState();
  }
}

export function writeState(file: string, state: SyncState): void {
  if (!file) {
    return;
  }
  try {
    const pruned = pruneState(state);
    pruned.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, pruned);
  } catch (error) {
    consola.error(`Could not write state file ${file}: ${fileErrorDetail(error).text}`);
  }
}

function pruneState(state: SyncState): SyncState {
  const keys = Object.keys(state.synced);
  if (keys.length <= MAX_STATE_ENTRIES) {
    return state;
  }

  const kept = keys
    .sort((a, b) =>
      (state.synced[b]?.at ?? '').localeCompare(state.synced[a]?.at ?? ''),
    )
    .slice(0, MAX_STATE_ENTRIES);

  const synced: Record<string, StateEntry> = {};
  for (const key of kept) {
    synced[key] = state.synced[key]!;
  }
  consola.info(`State pruned: ${keys.length} → ${kept.length} entries.`);
  return { ...state, synced };
}

/**
 * Where a full ④ walk got to, so a run killed by the job timeout continues instead of restarting.
 * ④ 全量走到了哪里 —— 让被作业超时杀掉的运行继续，而不是从零重来。
 *
 * Keyed by *pass* (`mixed` for the untyped fetch, `1`/`2`/`4`/`6` when the allowlist asks for one
 * `subject_type` each), because a full sync may walk several passes and each has its own offset.
 * 按**趟**为键（混合抓取用 `mixed`，白名单按 `subject_type` 分趟时用 `1`/`2`/`4`/`6`），因为一次
 * 全量可能走多趟，每趟有自己的 offset。
 *
 * It is a *cursor*, not a cache: it never decides whether to write. The worst case for a stale
 * value is re-walking a page, because every write is already idempotent (`mergeNeodbMark`).
 * 它是**游标**而不是缓存：它从不决定要不要写。旧值的最坏后果是多重走一页，因为写入本身已经幂等
 * （`mergeNeodbMark`）。
 */
export type FullSyncCursor = {
  version: 1;
  updatedAt: string;
  /** Pass key → collections of that pass already processed. / 趟 键 → 该趟已处理的收藏数。 */
  offsets: Record<string, number>;
};

function emptyFullSyncCursor(): FullSyncCursor {
  return { version: 1, updatedAt: '', offsets: {} };
}

export function readFullSyncCursor(file: string): FullSyncCursor {
  if (!file) {
    return emptyFullSyncCursor();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FullSyncCursor;
    if (parsed?.version !== 1 || typeof parsed.offsets !== 'object') {
      consola.warn(
        `Cursor file ${file} has an unexpected shape; starting from the first page.`,
      );
      return emptyFullSyncCursor();
    }
    return parsed;
  } catch (error) {
    const { code, text } = fileErrorDetail(error);
    if (code !== 'ENOENT') {
      consola.warn(`Could not read the full-sync cursor ${file}: ${text}`);
    }
    return emptyFullSyncCursor();
  }
}

export function writeFullSyncCursor(file: string, cursor: FullSyncCursor): void {
  if (!file) {
    return;
  }
  try {
    writeJsonAtomic(file, { ...cursor, updatedAt: new Date().toISOString() });
  } catch (error) {
    // A lost cursor costs one wasted walk and never a wrong write, so this stays a warning:
    // failing the run over it would be worse than the thing it protects against.
    // 丢掉游标只浪费一次遍历，绝不会写错数据，因此这里只告警：为它让整轮失败，比它要防的事更糟。
    consola.warn(
      `Could not save the full-sync cursor ${file}: ${fileErrorDetail(error).text}`,
    );
  }
}

/**
 * NeoDB uuid → release year, so the one field the shelf listing drops is fetched once per item.
 * NeoDB uuid → 发行年份，使书架列表丢掉的这一个字段每个条目只需取一次。
 *
 * The shelf endpoint inlines `ItemSchema`, which has no year; the year only comes from a second
 * request per item (`api_url`). That request is the whole cost of the year gate, so it must not
 * repeat: a year is immutable, which makes uuid a safe key and makes a stale entry impossible.
 * 书架端点内联的 `ItemSchema` 没有年份，年份只能靠每个条目的一次额外请求（`api_url`）取得。那次
 * 请求就是年份闸门的全部成本，因此不能重复：年份不可变，所以 uuid 是安全的键，也不可能有陈旧值。
 *
 * It is a *cache*, not a source of truth: a miss only costs one request, and a lost file only costs
 * one request per item. Nothing here may ever decide whether to write.
 * 它是**缓存**而不是真源：未命中只多一次请求，文件丢失也只让每个条目多一次请求。这里任何东西都不
 * 得决定要不要写。
 */
export type ItemYearCache = {
  version: 1;
  updatedAt: string;
  /** uuid → year, in insertion order (oldest first). / uuid → 年份，按插入顺序（最旧在前）。 */
  years: Record<string, number>;
};

const ITEM_YEAR_VERSION = 1;
/** Keep the cache file bounded; the oldest insertions are dropped first. / 限制缓存文件大小，优先丢弃最早插入的。 */
const MAX_ITEM_YEARS = 20000;

function emptyItemYearCache(): ItemYearCache {
  return { version: ITEM_YEAR_VERSION, updatedAt: '', years: {} };
}

export function readItemYearCache(file: string): ItemYearCache {
  if (!file) {
    return emptyItemYearCache();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ItemYearCache;
    if (parsed?.version !== ITEM_YEAR_VERSION || typeof parsed.years !== 'object') {
      consola.warn(
        `Year cache ${file} has an unexpected shape; starting empty (everything refetches).`,
      );
      return emptyItemYearCache();
    }
    return parsed;
  } catch (error) {
    const { code, text } = fileErrorDetail(error);
    if (code !== 'ENOENT') {
      consola.warn(`Could not read the year cache ${file}: ${text}`);
    }
    return emptyItemYearCache();
  }
}

export function writeItemYearCache(file: string, cache: ItemYearCache): void {
  if (!file) {
    return;
  }
  try {
    writeJsonAtomic(file, {
      ...pruneItemYears(cache),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Losing the cache costs one request per item next run and nothing else, so it never fails a run.
    // 丢掉缓存只会让下一轮每个条目多一次请求，别无其他后果，因此绝不让整轮失败。
    consola.warn(
      `Could not save the year cache ${file}: ${fileErrorDetail(error).text}`,
    );
  }
}

/**
 * Drop the oldest insertions once the cache outgrows its bound.
 * 缓存超出上限后丢弃最早插入的条目。
 *
 * Insertion order is the ordering: JSON objects keep string keys in insertion order, and `uuid`
 * keys are never numeric, so a round trip through the file preserves it. Recency of *use* is
 * deliberately not tracked — a year never changes, so evicting a live entry costs one request and
 * nothing else.
 * 顺序就是插入顺序：JSON 对象的字符串键保持插入顺序，而 `uuid` 键永远不是数字键，因此经文件往返
 * 不会打乱。刻意不记录**访问**时间 —— 年份永不改变，淘汰掉一个仍在用的条目只多一次请求，别无损失。
 */
function pruneItemYears(cache: ItemYearCache): ItemYearCache {
  const keys = Object.keys(cache.years);
  if (keys.length <= MAX_ITEM_YEARS) {
    return cache;
  }

  const kept = keys.slice(-MAX_ITEM_YEARS);
  const years: Record<string, number> = {};
  for (const key of kept) {
    years[key] = cache.years[key]!;
  }
  consola.info(`Year cache pruned: ${keys.length} → ${kept.length} entries.`);
  return { ...cache, years };
}

/** Build the state key for one shelf item. / 生成一个书架条目在状态文件里的键。 */
export function stateKey(shelfType: string, itemUuid: string): string {
  return `${shelfType}:${itemUuid}`;
}

/** `标题[链接]` — the one shape `review-queue.mjs` parses. / 待核对名单解析的唯一形状。 */
export function itemLabel(title: string, url: string): string {
  return `${title}[${url}]`;
}

/**
 * Content fingerprint of a mark. Only the fields this sync actually pushes are
 * included, so an unrelated field change does not force a re-sync.
 * 标记的内容指纹。只纳入本同步真正会推送的字段，因此无关字段的变化不会触发重新同步。
 */
export function fingerprintMark(mark: NeodbShelfMark): string {
  const payload = [
    mark.shelf_type ?? '',
    String(mark.rating_grade ?? 0),
    mark.comment_text ?? '',
  ].join('\u0001');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Fields every entry carries. Path-specific fields are added on top. / 每条记录都有的字段，各链路再在其上追加自己的字段。 */
export type ReviewLogEntry = Record<string, unknown> & {
  /** Which path wrote it, e.g. `bangumi→neodb` / `neodb→tmdb`. / 由哪条链路写入，如 `bangumi→neodb` / `neodb→tmdb`。 */
  source: string;
  /** Why it could not be processed, e.g. `neodb-unresolved`. / 未能处理的原因，如 `neodb-unresolved`。 */
  reason: string;
  /** ISO timestamp of the first run that reported this entry. / 首次报告该条目的运行时间（ISO）。 */
  firstSeenAt: string;
  /** ISO timestamp of the most recent run that still reported it. / 最近一次仍报告该条目的运行时间（ISO）。 */
  lastSeenAt: string;
};

/**
 * Identity of an entry: which path, and which item on that path.
 * Both writers always supply one of these ids, so the title fallback only
 * matters for hand-edited files.
 * 一条记录的身份：哪条链路 + 该链路上的哪个条目。两个写入方总会提供其中一个 id，
 * 因此按标题兜底只对人工编辑过的文件有意义。
 */
function reviewKey(entry: Record<string, unknown>): string {
  const id = entry.externalId ?? entry.uuid ?? entry.title ?? '';
  return `${String(entry.source ?? '')}::${String(id)}`;
}

/**
 * In-process cache of the parsed review log, keyed by file path.
 * 进程内留档日志的解析结果缓存，以文件路径为键。
 *
 * Without it, `upsertReviewEntry` re-read and re-wrote the entire JSON array once per unresolved
 * item — O(n²) disk work on a run that leaves hundreds of entries. Only this process writes the
 * file during a run, so the cache cannot go stale in a way that matters.
 * 没有它时，`upsertReviewEntry` 会为每一条未解决条目重新读取并整体重写一遍 JSON 数组 ——
 * 在留下数百条记录的运行里是 O(n²) 的磁盘开销。一次运行中只有本进程会写这个文件，因此缓存
 * 不会以任何有意义的方式过期。
 */
const reviewLogCache = new Map<string, ReviewLogEntry[]>();

function readReviewLog(file: string): ReviewLogEntry[] {
  const cached = reviewLogCache.get(file);
  if (cached) {
    return cached;
  }
  let entries: ReviewLogEntry[];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries = Array.isArray(parsed)
      ? (parsed.filter(
          (item) => typeof item === 'object' && item !== null,
        ) as ReviewLogEntry[])
      : [];
  } catch {
    // Missing on the first run, or hand-edited into invalid JSON — start over.
    // 首次运行时文件不存在，或被人改成非法 JSON —— 从零开始。
    entries = [];
  }
  reviewLogCache.set(file, entries);
  return entries;
}

/**
 * Record an entry that could not be processed, keyed so re-running does not
 * duplicate it. Best effort: never throws.
 * 记录一条无法处理的条目，按 key 去重，使重复运行不会产生重复记录。尽力而为：从不抛错。
 *
 * This is an upsert rather than an append on purpose. The same few obscure
 * items fail on every run, so appending would grow the file without bound
 * while telling you nothing new — and, because entries carried no timestamp,
 * the "history" it appeared to preserve could not even be ordered: two runs
 * produced two identical records with no way to say which was newer.
 * Re-recording refreshes `lastSeenAt` and leaves `firstSeenAt` alone, which is
 * what separates a long-standing gap from a newly appeared one.
 *
 * 刻意做成 upsert 而不是 append。每次运行都只有同样那几个冷门条目失败，若追加写入，
 * 文件会无界增长却提供不了新信息；而且由于记录不带时间戳，它表面上保留的「历史」连
 * 先后都无法判断：两次运行会产出两条完全相同的记录，无从分辨哪条更新。重新记录只刷新
 * `lastSeenAt`、保留 `firstSeenAt`，这正是区分「长期缺口」与「新出现问题」的依据。
 *
 * @returns `true` when the file was actually written. Callers use this to decide whether they
 *   may tell the reader "written to <path>" — a warning about a failed write must not be
 *   followed by a summary line claiming success.
 *   文件确实被写入时为 `true`。调用方据此决定能否对读者说「已写入 <路径>」——
 *   「写入失败」的警告后面不该跟着一句声称成功的汇总。
 */
export function upsertReviewEntry(
  file: string,
  entry: Record<string, unknown> & { source: string; reason: string },
  now: string = new Date().toISOString(),
): boolean {
  if (!file) {
    return false;
  }
  try {
    const key = reviewKey(entry);
    // The cached array is mutated in place and shared, so the callers see the update without
    // another read. See `reviewLogCache`.
    // 缓存的数组被就地修改并共享，因此调用方无需再读一次就能看到更新。见 `reviewLogCache`。
    const existing = readReviewLog(file);
    const index = existing.findIndex((item) => reviewKey(item) === key);

    if (index >= 0) {
      const previous = existing[index]!;
      existing[index] = {
        ...entry,
        // Keep the original sighting; only the trailing edge moves.
        // 保留首次出现时间，只推进最近一次。
        firstSeenAt: previous.firstSeenAt ?? now,
        lastSeenAt: now,
      } as ReviewLogEntry;
    } else {
      existing.push({ ...entry, firstSeenAt: now, lastSeenAt: now } as ReviewLogEntry);
    }

    writeJsonAtomic(file, existing);
    return true;
  } catch (error) {
    consola.warn(`Could not update review log ${file}: ${fileErrorDetail(error).text}`);
    return false;
  }
}
