/**
 * Path ④ — Bangumi collections → NeoDB.
 * 链路④ —— Bangumi 收藏 → NeoDB。
 *
 * This is the only path that walks pagination (`while (true)` bounded by the collection total),
 * and the only one that can be told to stop after a single page: without `bangumiNeodbFullSync` it breaks out
 * of the loop after the first page.
 * 这是唯一会遍历分页的链路（`while (true)`，以收藏总数为界），也是唯一可以「只跑一页」的链路：
 * 若 `bangumiNeodbFullSync` 为假，它在第一页之后就退出循环。
 *
 * 标记时间由 `SYNC_BANGUMI_NEODB_MARK_TIME_POLICY` 决定：新建用 Bangumi 时间；状态不变时
 * 保留目标时间，状态变化时用 Bangumi 时间覆盖。`initial-source` / `always-source` 可改变后续行为。
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
import { neodbThrottle, neodbToken } from '../clients/neodb-http';
import { resolveNeodbItemForBangumiUrlDetailed } from '../clients/neodb-catalog';
import {
  getNeodbMark,
  getNeodbProgress,
  markNeodbItem,
  setNeodbProgress,
} from '../clients/neodb-shelf';
import { describeCommentChange, mergeNeodbMark } from '../rules/neodb-mark-merge';
import {
  applyStatusGuard,
  shouldSkipClaim,
  type TargetClaim,
} from '../rules/bangumi-target-conflict';
import { planNeodbMarkTime } from '../rules/neodb-mark-time';
import { planNeodbVisibility } from '../rules/neodb-visibility';
import {
  bangumiSubjectTypesForAllowlist,
  needsBangumiMangaPlatformCheck,
  syncConfig,
  unmatchedLogFile,
} from '../sync-config';
import {
  itemLabel,
  readBangumiNeodbFullSyncCursor,
  upsertReviewEntry,
  writeBangumiNeodbFullSyncCursor,
} from '../utils';
import {
  normalizeReviewCategory,
  normalizeReviewShelf,
  reviewMetaSuffix,
} from '../rules/review-vocab';
import { printPathSummary } from '../sync-report';
import {
  PathAbortedError,
  readOptionalOrThrow,
  readValueOrThrow,
} from '../read-guards';

dotenv.config();

const LABEL = 'Bangumi → NeoDB';

/**
 * What happened to one collection. The four cases partition every scanned
 * collection, which is what lets `printPathSummary` self-check the totals.
 */
type CollectionOutcome =
  | 'written'
  | 'unchanged'
  | 'skipped-platform'
  | 'skipped-duplicate'
  | 'unresolved'
  | 'unresolved-not-found';

/** Counters for this path, mirroring the shape of `SyncCounters`. */
type BangumiCounters = {
  scanned: number;
  written: number;
  unchanged: number;
  /** Non-manga books dropped by a manga-only category allowlist. */
  skippedPlatform: number;
  /** A different Bangumi subject claimed the same NeoDB uuid first. */
  skippedDuplicate: number;
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
    skippedDuplicate: 0,
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
  bangumiNeodbFullSync = false,
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
    printPathSummary(report);
    return report;
  }

  const me = await getBangumiMe();
  if (!me?.username) {
    consola.error('Cannot resolve Bangumi username; skip Bangumi → NeoDB');
    report.aborted = true;
    printPathSummary(report);
    return report;
  }

  const allowlist = syncConfig.bangumiNeodbCategories;
  const subjectTypes = bangumiSubjectTypesForAllowlist(allowlist);

  if (subjectTypes && subjectTypes.length === 0) {
    consola.warn('Bangumi → NeoDB category allowlist is empty; skip.');
    // Every other early guard prints the per-path summary; this one silently produced no line at
    // all, so a misconfigured allowlist looked like a path that never ran.
    // 其余早退守卫都会打印逐链路摘要；只有这里什么都不打，配置错误看起来就像链路根本没运行。
    printPathSummary(report);
    return report;
  }

  consola.start(
    bangumiNeodbFullSync
      ? 'Going to full-sync Bangumi → NeoDB...'
      : 'Going to sync recent Bangumi → NeoDB...',
  );

  const mangaPlatformCheck = needsBangumiMangaPlatformCheck(allowlist);

  // Only a full walk resumes. A capped run must start at the head every time, on purpose: its
  // whole window *is* the newest page, so honouring a leftover cursor there would silently hide
  // exactly the marks that run exists to catch. The cursor also never decides whether to write —
  // every write is already compared — so a stale value can only cost a re-walk.
  // 只有全量才续跑。常规运行每次必须从头部开始，这是刻意的：它的窗口**就是**最新那一页，
  // 在那里沿用残留游标会静默藏掉这一轮本来要抓的新标记。游标也从不决定要不要写 —— 每次写入本来
  // 都要先比对 —— 因此旧值最多只让某一页重走一遍。
  const cursorFile = bangumiNeodbFullSync ? syncConfig.bangumiNeodbFullSyncCursor : '';
  const cursor = readBangumiNeodbFullSyncCursor(cursorFile);

  // null = mixed fetch (all types); otherwise one pass per subject_type
  const typePasses: Array<BangumiSubjectType | undefined> = subjectTypes
    ? subjectTypes
    : [undefined];

  // Two identities per collection on purpose: `unresolved` is keyed by the Bangumi URL (its log
  // line is `标题[链接]`), while `item-threw` and `platform-mismatch` are keyed by the title (their
  // lines carry no link). Recording both is what lets each entry age out independently.
  // 每个收藏刻意记两个身份：`unresolved` 按 Bangumi 链接建 key（日志行是 `标题[链接]`），而
  // `item-threw` 与 `platform-mismatch` 按标题建 key（日志行不带链接）。两个都记，两类条目才能
  // 各自独立老化。
  const scanned = new Set<string>();
  // One target may be claimed by several Bangumi subjects (a manga and its anime, two duplicate
  // subjects, …). The first claim is remembered for the whole run so a lower-confidence or
  // lower-status subject cannot overwrite it later in the same run.
  // 一个 NeoDB 目标可能被多个 Bangumi subject 认领（漫画与动画、重复条目等）。整轮记住第一个
  // 认领者，避免后续更低置信度/更低状态的 subject 在同一轮里覆盖它。
  const targetClaims = new Map<string, TargetClaim>();
  // Successful resolutions only; failures are retried next run instead of being cached as absent.
  // 只缓存成功解析；失败留给下一轮重试，不把瞬时错误固化成「不存在」。
  const resolutionCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveNeodbItemForBangumiUrlDetailed>>
  >();
  const yearCache = new Map<number, number | undefined>();

  for (const subjectType of typePasses) {
    // One cursor per pass: a full sync can run several, and each has its own offset.
    // 一趟一个游标：一次全量可能跑多趟，每趟有自己的 offset。
    const passKey = subjectType === undefined ? 'mixed' : String(subjectType);
    let offset = bangumiNeodbFullSync ? (cursor.offsets[passKey] ?? 0) : 0;
    if (offset > 0) {
      consola.info(
        `Resuming the ${passKey} pass at offset ${offset}; earlier collections are already done.`,
      );
    }
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
        // An empty page ends the pass — and if a cursor brought us here, that cursor now points
        // past the end (the shelf shrank, or a kill landed mid-page). Dropping it is what keeps
        // this from becoming a permanent no-op: without it, every future full walk would ask for
        // the same offset, get nothing, and stop again.
        // 空页即本趟结束 —— 而如果我们是带着游标过来的，那个游标此刻已指到末尾之外（书架变短了，
        // 或中断正好落在页中）。丢掉它才不会让这里变成永久空转：没有这一步，之后每次全量都会问
        // 同一个 offset、拿到空、再停下。
        if (bangumiNeodbFullSync) {
          delete cursor.offsets[passKey];
          writeBangumiNeodbFullSyncCursor(cursorFile, cursor);
        }
        break;
      }

      // Complete first: when two subjects claim one uuid, the winner writes and the lower claim is
      // skipped, instead of the lower one writing first and being overwritten later in the run.
      // 先处理“看过”：两个 subject 认领同一 uuid 时，胜者先写、低状态者被跳过，而不是低状态
      // 先写、随后又被覆盖。
      const ordered = [...page.data].sort((a, b) => {
        const rank = (c: BangumiCollection) =>
          c.type === 2 ? 3 : c.type === 3 || c.type === 4 ? 2 : c.type === 1 ? 1 : 0;
        return rank(b) - rank(a) || a.subject_id - b.subject_id;
      });
      for (const collection of ordered) {
        counters.scanned += 1;
        scanned.add(bangumiSubjectUrl(collection.subject_id));
        scanned.add(collectionTitle(collection));
        // One bad item must never abort the batch.
        try {
          const outcome = await syncCollectionToNeodb(
            collection,
            mangaPlatformCheck,
            targetClaims,
            resolutionCache,
            yearCache,
          );
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
                title: collectionTitle(collection),
                url: bangumiSubjectUrl(collection.subject_id),
                reason: 'platform-mismatch',
                category: normalizeReviewCategory(collection.subject_type),
                shelf: normalizeReviewShelf(collection.type),
              });
              break;
            case 'skipped-duplicate':
              counters.skippedDuplicate += 1;
              report.skippedItems.push({
                title: collectionTitle(collection),
                url: bangumiSubjectUrl(collection.subject_id),
                reason: 'duplicate-target',
                category: normalizeReviewCategory(collection.subject_type),
                shelf: normalizeReviewShelf(collection.type),
              });
              break;
            case 'unresolved':
              counters.unresolved += 1;
              recordUnresolved(collection, report, 'neodb-unresolved');
              break;
            case 'unresolved-not-found':
              counters.unresolved += 1;
              recordUnresolved(collection, report, 'neodb-unresolved-404');
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
          if (error instanceof PathAbortedError) {
            // The credentials are gone, not the item: every remaining collection would fail the
            // same way. Stop both loops and let `aborted` carry the exit code.
            // 坏的是凭据而不是条目：剩下每一条收藏都会以同样方式失败。两层循环都停，
            // 让 `aborted` 去承担退出码。
            report.aborted = true;
            consola.error(`Bangumi → NeoDB aborted: ${error.message}`);
            break;
          }
          counters.failed += 1;
          // The message goes into the detail on purpose: "item-threw" alone would send the reader
          // back to the log for the one piece of information that was already in hand.
          // 错误信息进明细是刻意的：只写「item-threw」会让读者为了一个当时就在手上的信息
          // 回头翻日志。
          const detail = error instanceof Error ? error.message : String(error);
          report.failedItems.push({
            title: collectionTitle(collection),
            url: bangumiSubjectUrl(collection.subject_id),
            reason: `item-threw: ${detail}`,
            category: normalizeReviewCategory(collection.subject_type),
            shelf: normalizeReviewShelf(collection.type),
          });
          consola.error(
            `Item failed, continuing: ${collectionTitle(collection)} —`,
            error instanceof Error ? error.message : error,
          );
        }
        // One collection fans out to several NeoDB calls (resolve, read mark, write mark, optional
        // progress). ④ never throttled those, unlike ⑤, so a full sync could burst the instance.
        // 每条收藏会扇出多次 NeoDB 调用（解析、读标记、写标记、可选进度）。④ 从不对它们节流，
        // 与 ⑤ 不同，全量同步可能把实例打出突发流量。
        await neodbThrottle();
        await bangumiThrottle();
      }

      if (report.aborted) {
        break;
      }

      if (!bangumiNeodbFullSync) {
        break;
      }

      offset += page.data.length;
      // Written once per page, never per item: a kill loses at most one page of progress, and this
      // is two orders of magnitude cheaper than the page it follows.
      // 每页写一次，绝不每条写：被杀最多丢一页进度，而这次写入比它之前那一页便宜两个数量级。
      if (offset >= page.total) {
        // The pass is done, so drop its cursor — otherwise the next full run would start in the
        // middle of a shelf that has since changed shape.
        // 这一趟走完了，去掉它的游标 —— 否则下一次全量会从一条已经变了形状的书架中间开始。
        delete cursor.offsets[passKey];
      } else {
        cursor.offsets[passKey] = offset;
      }
      writeBangumiNeodbFullSyncCursor(cursorFile, cursor);
      if (offset >= page.total) {
        break;
      }
    }

    if (report.aborted) {
      break;
    }
  }

  report.scanned = counters.scanned;
  report.scannedIds = [...scanned].sort();
  report.written = counters.written;
  report.unchanged = counters.unchanged;
  report.skipped = counters.skippedPlatform + counters.skippedDuplicate;
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
function recordUnresolved(
  collection: BangumiCollection,
  report: PathReport,
  reason: string,
): void {
  const title = collectionTitle(collection);

  report.unresolvedTitles.push(title);
  report.unresolvedItems.push({
    title,
    url: bangumiSubjectUrl(collection.subject_id),
    reason,
    category: normalizeReviewCategory(collection.subject_type),
    shelf: normalizeReviewShelf(collection.type),
  });

  const written = upsertReviewEntry(unmatchedLogFile, {
    source: 'bangumi→neodb',
    reason,
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
  targetClaims: Map<string, TargetClaim>,
  resolutionCache: Map<
    string,
    Awaited<ReturnType<typeof resolveNeodbItemForBangumiUrlDetailed>>
  >,
  yearCache: Map<number, number | undefined>,
): Promise<CollectionOutcome> {
  const url = bangumiSubjectUrl(collection.subject_id);
  const title = collectionTitle(collection);
  consola.info('Bangumi → NeoDB: ', itemLabel(title, url));

  if (
    mangaPlatformCheck &&
    collection.subject_type === 1 &&
    !(await isBangumiManga(collection.subject_id, title))
  ) {
    return 'skipped-platform';
  }

  const yearFromSummary =
    Number(collection.subject?.date?.slice(0, 4)) ||
    Number(collection.subject?.air_date?.slice(0, 4)) ||
    collection.subject?.air_year ||
    undefined;
  let expectedYear = yearFromSummary;
  let yearSource = yearFromSummary ? 'summary' : 'missing';
  if (!expectedYear) {
    if (!yearCache.has(collection.subject_id)) {
      const subject = readOptionalOrThrow(
        await getBangumiSubject(collection.subject_id),
        'Bangumi subject year',
      );
      const fullYear =
        Number(subject?.date?.slice(0, 4)) ||
        Number(subject?.air_date?.slice(0, 4)) ||
        subject?.air_year ||
        undefined;
      yearCache.set(collection.subject_id, fullYear);
    }
    expectedYear = yearCache.get(collection.subject_id);
    yearSource = expectedYear ? 'full-subject' : 'missing';
  }
  consola.info(
    'Bangumi year: ',
    `subject=${collection.subject_id} source=${yearSource} year=${expectedYear ?? 'missing'}`,
  );
  let resolution = resolutionCache.get(url);
  if (!resolution) {
    resolution = await resolveNeodbItemForBangumiUrlDetailed(url, {
      titles: [collection.subject?.name_cn, collection.subject?.name],
      subjectType: collection.subject_type,
      expectedYear,
    });
    if (resolution.item?.uuid) {
      resolutionCache.set(url, resolution);
    }
  }
  const neodbItem = resolution.item;
  consola.info(
    'NeoDB resolution: ',
    `subject=${collection.subject_id} expectedYear=${expectedYear ?? 'missing'} ` +
      `via=${resolution.via} chosen=${neodbItem?.uuid ?? 'none'}` +
      `${resolution.ambiguous ? ' ambiguous=true' : ''}`,
  );
  if (resolution.ambiguous) {
    consola.warn(
      'NeoDB same-title twins ambiguous; using direct item: ',
      `subject=${collection.subject_id} year=${expectedYear ?? 'missing'} uuid=${neodbItem?.uuid ?? 'none'}`,
    );
  }
  if (!neodbItem?.uuid) {
    // The title leads and the URL follows, instead of the URL alone. The review list has to name
    // the entry it is asking about, and a bare `bgm.tv/subject/N` is only an address — the list
    // could show the reader a link and nothing to recognise it by. `标题[链接]` is also the shape
    // ② (`itemLabel`) and ③ already print, so one `splitLabel` reads all three.
    // 标题在前、链接在后，而不是只打链接。名单必须能说出它在问哪一条，而光秃秃的
    // `bgm.tv/subject/N` 只是个地址 —— 读者只会看到一个认不出来的链接。`标题[链接]` 也正是
    // ②（`itemLabel`）与 ③ 已有的形状，一个 `splitLabel` 就能读这三条。
    consola.warn(
      'NeoDB could not resolve Bangumi URL, skip: ',
      `${itemLabel(title, url)} ${reviewMetaSuffix(collection.subject_type, collection.type)}`,
    );
    return resolution.failure === 'not-found' ? 'unresolved-not-found' : 'unresolved';
  }

  const claim: TargetClaim = {
    subjectId: collection.subject_id,
    subjectType: collection.subject_type,
    collectionType: collection.type as BangumiCollectionType,
    title,
    via: resolution.via,
  };
  const existingClaim = targetClaims.get(neodbItem.uuid);
  if (existingClaim && shouldSkipClaim(existingClaim, claim)) {
    // Two different Bangumi subjects resolve to one NeoDB item. Writing both is what made
    // "看过" and "在看/想看" overwrite each other; keep the stronger claim and make the loser
    // visible in the report instead of silently writing.
    // 两个不同的 Bangumi subject 解析到同一个 NeoDB 条目。两个都写正是「看过」被「在看/想看」
    // 覆盖的原因；保留更强的认领者，并让落败者在报表里可见，而不是静默写入。
    consola.warn(
      `duplicate target: subject ${existingClaim.subjectId}(${existingClaim.via}, type=${existingClaim.collectionType}) ` +
        `and ${claim.subjectId}(${claim.via}, type=${claim.collectionType}) both map to ${neodbItem.uuid}; ` +
        `keeping the first.`,
    );
    return 'skipped-duplicate';
  }
  targetClaims.set(neodbItem.uuid, claim);

  const shelfType = BANGUMI_TO_NEODB_STATUS[collection.type as BangumiCollectionType];
  const ratingGrade = collection.rate || 0;
  const comment = collection.comment || '';
  // A failed read throws: the mark is left alone and the item is counted, instead of being
  // mistaken for "not marked yet" and created over.
  // 读取失败会抛出：标记原样不动并计入失败，而不是被当成「还没有标记」直接新建覆盖。
  const mark = readOptionalOrThrow(await getNeodbMark(neodbItem.uuid), 'NeoDB mark');
  if (mark && mark.visibility === undefined) {
    consola.warn(
      'NeoDB mark has no visibility; keeping the configured target without forcing a write: ',
      `subject=${collection.subject_id} uuid=${neodbItem.uuid}`,
    );
  }
  const effectiveShelf = applyStatusGuard(
    (mark?.shelf_type as Parameters<typeof applyStatusGuard>[0]) ?? null,
    shelfType,
    syncConfig.bangumiNeodbStatusGuard,
  );
  const statusChanged = mark != null && mark.shelf_type !== effectiveShelf;
  const markTimePlan = planNeodbMarkTime({
    policy: syncConfig.bangumiNeodbMarkTimePolicy,
    isNew: !mark,
    statusChanged,
    sourceRaw: collection.updated_at,
    targetRaw: mark?.created_time,
  });
  const visibilityPlan = planNeodbVisibility({
    mode: syncConfig.bangumiNeodbVisibilityMode,
    targetVisibility: syncConfig.bangumiNeodbVisibility,
    sourcePrivate: collection.private,
    existingVisibility: mark?.visibility,
  });
  const targetVisibility = visibilityPlan.visibility;
  if (visibilityPlan.reason === 'source-missing') {
    consola.warn(
      'Bangumi collection private is missing; keeping the existing NeoDB visibility: ',
      `subject=${collection.subject_id} chosen=${targetVisibility}`,
    );
  }
  consola.info(
    'NeoDB visibility: ',
    `subject=${collection.subject_id} mode=${syncConfig.bangumiNeodbVisibilityMode} ` +
      `sourcePrivate=${collection.private ?? 'missing'} ` +
      `configured=${syncConfig.bangumiNeodbVisibility} ` +
      `chosen=${targetVisibility} reason=${visibilityPlan.reason}`,
  );
  consola.info(
    'NeoDB mark time: ',
    `subject=${collection.subject_id} source=${collection.updated_at || 'none'} ` +
      `target=${mark?.created_time || 'none'} statusChanged=${statusChanged} ` +
      `policy=${syncConfig.bangumiNeodbMarkTimePolicy} ` +
      `chosen=${markTimePlan.markTime || 'omit'} reason=${markTimePlan.reason}`,
  );
  consola.debug(
    `NeoDB mark plan: subject=${collection.subject_id} type=${collection.type} ` +
      `via=${resolution.via} before=${mark?.shelf_type ?? 'none'} after=${effectiveShelf}`,
  );
  // Left `false` only when there was nothing to write. A write NeoDB *refused* throws instead,
  // so `false` here can never mean "the mark did not land".
  // 只在「本来就没东西要写」时保持 `false`。NeoDB *拒绝*的写入改为抛错，
  // 于是这里的 `false` 绝不会意味着「标记没落地」。
  let markWritten = false;

  if (!mark) {
    if (
      !(await markNeodbItem(neodbItem, {
        shelfType: effectiveShelf,
        comment,
        ratingGrade,
        markTime: markTimePlan.markTime,
        visibility: targetVisibility,
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
      { shelfType: effectiveShelf, ratingGrade, comment },
      syncConfig.bangumiNeodbRating,
      targetVisibility,
      syncConfig.bangumiNeodbComment,
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
      const reasons = [
        mark.shelf_type !== merged.shelfType ? 'status' : null,
        (mark.rating_grade || 0) !== merged.ratingGrade ? 'rating' : null,
        (mark.comment_text || '') !== merged.comment ? 'comment' : null,
        (mark.visibility ?? targetVisibility) !== targetVisibility
          ? 'visibility'
          : null,
      ].filter(Boolean);
      consola.info(
        'NeoDB write: ',
        `subject=${collection.subject_id} shelf=${mark.shelf_type}→${merged.shelfType} ` +
          `rating=${mark.rating_grade || 0}→${merged.ratingGrade} ` +
          `comment=${describeCommentChange(mark.comment_text || '', merged.comment)} ` +
          `visibility=${mark.visibility ?? targetVisibility}→${targetVisibility} ` +
          `reason=${reasons.join('+') || 'unknown'}`,
      );
      if (
        !(await markNeodbItem(neodbItem, {
          shelfType: merged.shelfType,
          comment: merged.comment,
          ratingGrade: merged.ratingGrade,
          markTime: markTimePlan.markTime,
          visibility: targetVisibility,
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
  // `readValueOrThrow` rather than a nullable read: "could not read the platform" and "the
  // platform is not 漫画" both used to end in `skipped-platform`, so a failed read silently
  // dropped a book this run was supposed to import. Failing the item is the honest answer.
  // 用 `readValueOrThrow` 而不是可空读取：「读不到平台」与「平台不是漫画」过去都落到
  // `skipped-platform`，于是一次读取失败会静默丢掉一本本该导入的书。让这一条失败才是诚实的。
  const subject = readValueOrThrow(
    await getBangumiSubject(subjectId),
    'Bangumi subject',
  );
  const platform = subject.platform?.trim() || '';
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
