/**
 * Path ④ — Bangumi collections → NeoDB.
 * 链路④ —— Bangumi 收藏 → NeoDB。
 *
 * This is the only path that walks pagination (`while (true)` bounded by the collection total),
 * and the only one that can be told to stop after a single page: without `fullSync` it breaks out
 * of the loop after the first page.
 * 这是唯一会遍历分页的链路（`while (true)`，以收藏总数为界），也是唯一可以「只跑一页」的链路：
 * 若 `fullSync` 为假，它在第一页之后就退出循环。
 *
 * Deliberately asymmetric with path ② on one point: marks are updated WITHOUT `createdTime`, to
 * preserve the mark date already stored in NeoDB — Bangumi's `updated_at` is not trustworthy
 * enough to overwrite it (see the note inside `syncCollectionToNeodb`).
 * 这里有一处刻意与链路② 不对称：更新标记时**不传** `createdTime`，以保留 NeoDB 里已有的标记
 * 日期 —— Bangumi 的 `updated_at` 不足以可信到可以覆盖它（见 `syncCollectionToNeodb` 内的注释）。
 *
 * When resolving a Bangumi URL it prefers the Douban-linked twin, so that marks land on the same
 * NeoDB uuid as path ② (Douban → NeoDB).
 * 解析 Bangumi URL 时优先选择带豆瓣外链的孪生条目，使标记落在与链路②（豆瓣 RSS → NeoDB）
 * 相同的 NeoDB uuid 上。
 */
import dotenv from 'dotenv';
import { consola } from 'consola';
import {
  newPathReport,
  type BangumiCollectionType,
  type BangumiSubjectType,
  type NeodbItem,
  type PathReport,
} from '../types';
import {
  BANGUMI_TO_NEODB_STATUS,
  bangumiCollectionToNeodbProgress,
  neodbItemSupportsProgress,
} from '../rules/bangumi-neodb';
import {
  bangumiCollectionLimit,
  bangumiSubjectUrl,
  bangumiThrottle,
  bangumiToken,
  getBangumiMe,
  getBangumiSubject,
  listBangumiCollections,
  type BangumiCollection,
} from '../clients/bangumi';
import { neodbToken, neodbVisibility } from '../clients/neodb-http';
import { resolveNeodbItemForBangumiUrl } from '../clients/neodb-catalog';
import {
  getNeodbMark,
  getNeodbProgress,
  markNeodbItem,
  setNeodbProgress,
} from '../clients/neodb-shelf';
import { mergeNeodbMark } from '../rules/neodb-mark-merge';
import {
  bangumiSubjectTypesForAllowlist,
  needsBangumiMangaPlatformCheck,
  syncConfig,
  unmatchedLogFile,
} from '../sync-config';
import { upsertReviewEntry } from '../utils';
import { printPathSummary } from '../sync-report';

dotenv.config();

const LABEL = 'Bangumi → NeoDB';

/**
 * What happened to one collection. The four cases partition every scanned
 * collection, which is what lets `printPathSummary` self-check the totals.
 */
type CollectionOutcome = 'written' | 'unchanged' | 'skipped-platform' | 'unresolved';

/** Counters for this path, mirroring the shape of `SyncCounters`. */
type BangumiCounters = {
  scanned: number;
  written: number;
  unchanged: number;
  /** Non-manga books dropped by a manga-only category allowlist. */
  skippedPlatform: number;
  /** Collections NeoDB has no catalog entry for. */
  unresolved: number;
  /** Collections that threw — a bug or an outage, not a data gap. */
  failed: number;
};

function newBangumiCounters(): BangumiCounters {
  return {
    scanned: 0,
    written: 0,
    unchanged: 0,
    skippedPlatform: 0,
    unresolved: 0,
    failed: 0,
  };
}

/**
 * Sync recent (or all) Bangumi collections to NeoDB.
 * Requires both BANGUMI_ACCESS_TOKEN and NEODB_API_TOKEN.
 *
 * @returns a report of what happened. Unresolved entries are a data gap and do
 * not fail the run; `failed` and `aborted` do — the caller decides via
 * `pathHasFailed`.
 */
export default async function syncBangumiToNeodb(
  fullSync = false,
): Promise<PathReport> {
  const report = newPathReport(LABEL);
  const counters = newBangumiCounters();

  if (!bangumiToken || !neodbToken) {
    // This used to be a silent `return`. A path that is switched on but cannot
    // run must say so, or the log reads as a successful no-op.
    consola.warn(
      'Bangumi → NeoDB needs both BANGUMI_ACCESS_TOKEN and NEODB_API_TOKEN; skip.',
    );
    report.aborted = true;
    return report;
  }

  const me = await getBangumiMe();
  if (!me?.username) {
    consola.error('Cannot resolve Bangumi username; skip Bangumi → NeoDB');
    report.aborted = true;
    return report;
  }

  const allowlist = syncConfig.bangumiNeodbCategories;
  const subjectTypes = bangumiSubjectTypesForAllowlist(allowlist);

  if (subjectTypes && subjectTypes.length === 0) {
    consola.warn('Bangumi → NeoDB category allowlist is empty; skip.');
    return report;
  }

  consola.start(
    fullSync
      ? 'Going to full-sync Bangumi → NeoDB...'
      : 'Going to sync recent Bangumi → NeoDB...',
  );

  const mangaPlatformCheck = needsBangumiMangaPlatformCheck(allowlist);

  // null = mixed fetch (all types); otherwise one pass per subject_type
  const typePasses: Array<BangumiSubjectType | undefined> = subjectTypes
    ? subjectTypes
    : [undefined];

  for (const subjectType of typePasses) {
    let offset = 0;
    const limit = bangumiCollectionLimit;

    while (true) {
      const page = await listBangumiCollections({
        username: me.username,
        limit,
        offset,
        subjectType,
      });

      if (page === null) {
        // A failed request, which must NOT be mistaken for "no more collections". Stop this pass
        // and say why. Deliberately not counted as `failed`: a transient API error is not a data
        // error, and turning CI red for it would train everyone to ignore red.
        // 请求失败，绝不能当成「没有更多收藏了」。停止本趟遍历并说明原因。刻意不计入 `failed`：
        // 临时的 API 错误不是数据错误，为它让 CI 变红只会训练所有人忽略红色。
        consola.warn(
          `Bangumi collection page failed at offset ${offset}` +
            `${subjectType ? ` (subject_type=${subjectType})` : ''}; stopping this pass.`,
        );
        break;
      }

      if (!page.data.length) {
        break;
      }

      for (const collection of page.data) {
        counters.scanned += 1;
        // One bad item must never abort the batch.
        try {
          const outcome = await syncCollectionToNeodb(collection, mangaPlatformCheck);
          switch (outcome) {
            case 'written':
              counters.written += 1;
              break;
            case 'unchanged':
              counters.unchanged += 1;
              break;
            case 'skipped-platform':
              counters.skippedPlatform += 1;
              // Only reachable when the allowlist asked for manga: the subject sits in Bangumi's
              // book type but its platform is not 「漫画」, so importing it would put a
              // non-manga book into the manga shelf.
              // 只有白名单要求漫画时才会走到：该条在 Bangumi 属书籍类型，但平台不是「漫画」，
              // 导入它会把一本非漫画书塞进漫画书架。
              report.skippedItems.push({
                label: collectionTitle(collection),
                reason: 'platform-mismatch',
              });
              break;
            case 'unresolved':
              counters.unresolved += 1;
              recordUnresolved(collection, report);
              break;
            default: {
              // Compile-time tripwire. Adding a member to `CollectionOutcome` without wiring it
              // up here used to mean a silently uncounted collection; now it fails to compile.
              // 编译期保险丝。往 `CollectionOutcome` 加成员却忘了在这里接线，过去意味着一条
              // 被静默漏计的收藏，现在会编译失败。
              const unreachable: never = outcome;
              throw new Error(`Unhandled collection outcome: ${unreachable}`);
            }
          }
        } catch (error) {
          counters.failed += 1;
          // The message goes into the detail on purpose: "item-threw" alone would send the reader
          // back to the log for the one piece of information that was already in hand.
          // 错误信息进明细是刻意的：只写「item-threw」会让读者为了一个当时就在手上的信息
          // 回头翻日志。
          const detail = error instanceof Error ? error.message : String(error);
          report.failedItems.push({
            label: collectionTitle(collection),
            reason: `item-threw: ${detail}`,
          });
          consola.error(
            `Item failed, continuing: ${collectionTitle(collection)} —`,
            error instanceof Error ? error.message : error,
          );
        }
        await bangumiThrottle();
      }

      if (!fullSync) {
        break;
      }

      offset += page.data.length;
      if (offset >= page.total) {
        break;
      }
    }
  }

  report.scanned = counters.scanned;
  report.written = counters.written;
  report.unchanged = counters.unchanged;
  report.skipped = counters.skippedPlatform;
  report.unresolved = counters.unresolved;
  report.failed = counters.failed;

  // Kept verbatim: this counts collections that resolved and were processed —
  // written *or* already up to date. `printPathSummary` breaks the two apart.
  consola.success(
    `Bangumi → NeoDB synced (${counters.written + counters.unchanged} items) ✨`,
  );
  printPathSummary(report);

  return report;
}

/** Append the entry to the review log and remember it for the closing listing. */
function recordUnresolved(collection: BangumiCollection, report: PathReport): void {
  const title = collectionTitle(collection);

  report.unresolvedTitles.push(title);

  const written = upsertReviewEntry(unmatchedLogFile, {
    source: 'bangumi→neodb',
    reason: 'neodb-unresolved',
    title,
    externalId: String(collection.subject_id),
    externalUrl: bangumiSubjectUrl(collection.subject_id),
    subjectType: collection.subject_type,
    collectionType: collection.type,
  });
  // See `douban-to-bangumi.ts#recordUnresolved`: claim the log only when it was written.
  // 见 `douban-to-bangumi.ts#recordUnresolved`：只有真的写成功才声明留档。
  if (written) {
    report.reviewLog = unmatchedLogFile;
  }
}

function collectionTitle(collection: BangumiCollection): string {
  return (
    collection.subject?.name_cn ||
    collection.subject?.name ||
    `subject/${collection.subject_id}`
  );
}

async function syncCollectionToNeodb(
  collection: BangumiCollection,
  mangaPlatformCheck: boolean,
): Promise<CollectionOutcome> {
  const url = bangumiSubjectUrl(collection.subject_id);
  const title = collectionTitle(collection);
  consola.info('Bangumi → NeoDB: ', `${title}[${url}]`);

  if (
    mangaPlatformCheck &&
    collection.subject_type === 1 &&
    !(await isBangumiManga(collection.subject_id, title))
  ) {
    return 'skipped-platform';
  }

  const neodbItem = await resolveNeodbItemForBangumiUrl(url, {
    titles: [collection.subject?.name_cn, collection.subject?.name],
    subjectType: collection.subject_type,
  });
  if (!neodbItem?.uuid) {
    consola.warn('NeoDB could not resolve Bangumi URL, skip: ', url);
    return 'unresolved';
  }

  const shelfType = BANGUMI_TO_NEODB_STATUS[collection.type as BangumiCollectionType];
  const ratingGrade = collection.rate || 0;
  const comment = collection.comment || '';
  // Bangumi updated_at is unreliable; only used when creating a new NeoDB mark.
  const createdTime = collection.updated_at || undefined;

  const mark = await getNeodbMark(neodbItem.uuid);
  // Left `false` only when there was nothing to write. A write NeoDB *refused* throws instead,
  // so `false` here can never mean "the mark did not land".
  // 只在「本来就没东西要写」时保持 `false`。NeoDB *拒绝*的写入改为抛错，
  // 于是这里的 `false` 绝不会意味着「标记没落地」。
  let markWritten = false;

  if (!mark) {
    if (
      !(await markNeodbItem(neodbItem, {
        shelfType,
        comment,
        ratingGrade,
        createdTime,
      }))
    ) {
      // The refusal has to reach the counters, the detail list and the exit code, and this
      // throw is the only channel the caller already handles for that.
      // 拒绝必须能到达计数、明细与退出码；这个 throw 是调用方已经处理好的唯一通道。
      throw new Error('NeoDB rejected the new mark');
    }
    markWritten = true;
  } else {
    const merged = mergeNeodbMark(
      mark,
      { shelfType, ratingGrade, comment },
      syncConfig.bangumiNeodbMerge,
      neodbVisibility,
    );

    if (!merged.shouldWrite) {
      consola.info('NeoDB mark unchanged, skip: ', title);
    } else {
      if (merged.keptRating || merged.keptComment) {
        consola.info(
          'NeoDB prefer: keeping existing ',
          [merged.keptRating ? 'rating' : null, merged.keptComment ? 'comment' : null]
            .filter(Boolean)
            .join('+'),
          ' on ',
          title,
        );
      }
      // Do not pass createdTime on update — preserves NeoDB mark date.
      if (
        !(await markNeodbItem(neodbItem, {
          shelfType: merged.shelfType,
          comment: merged.comment,
          ratingGrade: merged.ratingGrade,
        }))
      ) {
        throw new Error('NeoDB rejected the mark update');
      }
      markWritten = true;
    }
  }

  // Progress can move even when the mark itself did not, so it counts as a
  // write on its own — otherwise "unchanged" would hide a real update.
  const progressWritten = syncConfig.bangumiNeodbProgress
    ? await syncProgressToNeodb(collection, neodbItem, title)
    : false;

  return markWritten || progressWritten ? 'written' : 'unchanged';
}

async function isBangumiManga(subjectId: number, title: string): Promise<boolean> {
  const subject = await getBangumiSubject(subjectId);
  const platform = subject?.platform?.trim() || '';
  if (platform === '漫画') {
    return true;
  }
  consola.info(
    'Bangumi → NeoDB: skip non-manga book: ',
    `${title} (platform=${platform || 'unknown'})`,
  );
  return false;
}

/** @returns true when a progress value was actually written. */
async function syncProgressToNeodb(
  collection: BangumiCollection,
  neodbItem: NeodbItem,
  title: string,
): Promise<boolean> {
  const progress = bangumiCollectionToNeodbProgress(collection);
  if (!progress) {
    // Games have no progress mapping at all: the rule returns null for subject_type 4, and
    // Bangumi's `ep_status` can only update book progress anyway. Say so once per item —
    // otherwise "this game has no progress" is indistinguishable from "no progress was set".
    // 游戏完全没有进度映射：规则对 subject_type 4 返回 null，而且 Bangumi 的 `ep_status` 本来就
    // 只能更新书籍进度。每个条目说明一次 —— 否则「这个游戏没有进度」与「本来就没填进度」在日志里
    // 无法区分。
    if (collection.subject_type === 4) {
      consola.info('NeoDB progress not applicable to game: ', title);
    }
    return false;
  }

  if (!neodbItemSupportsProgress(neodbItem, progress)) {
    consola.info(
      'NeoDB progress not applicable for catalog category, skip: ',
      `${title} (${neodbItem.category}/${progress.type})`,
    );
    return false;
  }

  const existing = await getNeodbProgress(neodbItem.uuid);
  if (
    existing &&
    existing.type === progress.type &&
    String(existing.value ?? '') === progress.value
  ) {
    consola.info('NeoDB progress unchanged, skip: ', title);
    return false;
  }

  await setNeodbProgress(neodbItem, progress);
  return true;
}
