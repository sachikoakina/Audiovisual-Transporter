/**
 * Path ② — Douban RSS → NeoDB.
 * 链路② —— 豆瓣 RSS → NeoDB。
 *
 * Unlike its siblings (③ Douban→Bangumi, ④ Bangumi→NeoDB, ⑤ NeoDB→TMDB) this path used to make
 * back-to-back calls with no pause, which made it the most likely to be rate-limited. It now
 * waits `NEODB_REQUEST_DELAY_MS` (default 300 ms) between items — the same knob paths ③ and ⑤ use.
 *
 * 与它的兄弟链路（③ 豆瓣→Bangumi、④ Bangumi→NeoDB、⑤ NeoDB→TMDB）不同，本链路原先连续调用
 * API、中间不做停顿，因此最容易被限流。现在它在条目之间等待 `NEODB_REQUEST_DELAY_MS`
 * （默认 300 ms），与链路 ③ 和 ⑤ 用的是同一个开关。
 *
 * A path that is switched on but cannot run reports `aborted` rather than returning silently, so a
 * missing token cannot be misread as a successful no-op. `aborted` also makes the run exit
 * non-zero — deliberately: an enabled path with no credentials is a misconfiguration.
 *
 * 已启用但无法运行的链路会上报 `aborted`，而不是静默返回，因此缺少令牌不会被误读成
 * 「跑过且无事」。`aborted` 同时会让整轮以非零退出码结束 —— 这是刻意的：启用了链路却没有凭据
 * 属于配置错误。
 */
import dotenv from 'dotenv';
import { consola } from 'consola';
import { DOUBAN_EXPRESSED_STATUSES, doubanStarsToTenPoint } from '../rules/douban';
import { mergeNeodbMark } from '../rules/neodb-mark-merge';
import type { FeedItem, ItemStatus, ItemSyncOutcome, PathReport } from '../types';
import { newPathReport } from '../types';
import { fetchNeodbItemByUrl } from '../clients/neodb-catalog';
import { neodbThrottle, neodbToken, neodbVisibility } from '../clients/neodb-http';
import { getNeodbMark, markNeodbItem, verifyNeodbToken } from '../clients/neodb-shelf';
import {
  filterDoubanFeedsByCategory,
  syncConfig,
  unmatchedLogFile,
} from '../sync-config';
import { printPathSummary } from '../sync-report';
import { PathAbortedError, failureReason, readOptionalOrThrow } from '../read-guards';
import { itemLabel, upsertReviewEntry } from '../utils';

dotenv.config();

const LABEL = 'Douban → NeoDB';

/**
 * Sync Douban RSS feed items to NeoDB, one item at a time.
 * 把豆瓣 RSS 条目逐条同步到 NeoDB。
 *
 * @param feeds - Feed items to sync. 待同步的条目。
 * @returns The path's report; `aborted` when the path could not run.
 *   本条链路的报告；无法运行时 `aborted` 为真。
 */
export default async function syncDoubanToNeodb(
  feeds: FeedItem[],
): Promise<PathReport> {
  const report = newPathReport(LABEL);

  if (!neodbToken) {
    consola.warn('Douban → NeoDB needs NEODB_API_TOKEN; skip.');
    report.aborted = true;
    printPathSummary(report);
    return report;
  }

  // A live check, not just an existence check. Without it the first item learns the token is
  // dead, and `b35595b` turns that into `aborted` — but only after a catalogue lookup and a mark
  // read have already gone out. One cheap request buys a clean "credentials are dead" verdict.
  // 活体校验，而不只是存在性检查。缺了它，是第一条目才发现 token 已失效；`b35595b` 之后那会变成
  // `aborted`，但已经先发出一次目录查询和一次标记读取了。一次廉价请求换来干净的「凭据已失效」结论。
  if (!(await verifyNeodbToken())) {
    report.aborted = true;
    printPathSummary(report);
    return report;
  }

  const filtered = filterDoubanFeedsByCategory(
    feeds,
    syncConfig.doubanNeodbCategories,
    LABEL,
    (item) => {
      report.skippedItems.push({
        title: item.title || item.id,
        url: item.link,
        reason: 'category-not-allowed',
      });
    },
  );
  report.scanned = feeds.length;
  report.skipped = feeds.length - filtered.length;
  // Category-excluded items were examined and found out of scope; that decision does not depend
  // on the loop below, so they are recorded up front. The rest join the set when the loop actually
  // reaches them — an abort must not mark the untouched tail as "looked at".
  // 被分类白名单剔除的条目已经看过、结论是「不在范围内」，这个结论不依赖下面的循环，因此先记下。
  // 其余条目在循环真正轮到时才加入集合 —— 中途 abort 不能把后面没跑的条目记成「已检查」。
  const kept = new Set(filtered.map((item) => item.link));
  const scanned = new Set(
    feeds.filter((item) => !kept.has(item.link)).map((item) => item.link),
  );

  consola.start('Going to sync to NeoDB...');
  for (const item of filtered) {
    scanned.add(item.link);
    try {
      const outcome = await syncFeedItemToNeodb(item);
      report[outcome] += 1;
      recordOutcome(item, outcome, report);
    } catch (error) {
      if (error instanceof PathAbortedError) {
        // Every remaining item would fail the same way, so the honest thing is to stop and say
        // it once: the exit code comes from `aborted`, and the summary says "aborted" in words.
        // 剩下每一条都会以同样方式失败，所以诚实的做法是停下并说一次：退出码来自 `aborted`，
        // 摘要里也会用文字写明「aborted」。
        report.aborted = true;
        consola.error(`Douban → NeoDB aborted: ${error.message}`);
        break;
      }

      // One bad item must never abort the batch. Until this guard existed, a single throw took
      // the whole path with it: no report, no counts, and every remaining item unprocessed.
      // 一条坏数据绝不能让整批停下。在补上这层之前，任何一次抛错都会带走整条链路：
      // 没有报告、没有计数，剩下的条目一条都没跑。
      report.failed += 1;
      report.failedItems.push({
        title: item.title || item.id,
        url: item.link,
        reason: failureReason(error, 'neodb-read-failed', 'neodb-item-threw'),
      });
      // Deliberately not `Item failed, continuing:` — that sentence is how the review list
      // recognises Bangumi → NeoDB, and it routes on that string alone.
      // 刻意不用 `Item failed, continuing:` —— 名单靠那句话认出 Bangumi → NeoDB，它只认这个字符串。
      consola.error(
        `Douban → NeoDB item threw, continuing: ${itemLabel(item.title || item.id, item.link)} —`,
        error instanceof Error ? error.message : error,
      );
    }
    await neodbThrottle();
  }
  report.scannedIds = [...scanned].sort();
  consola.success('NeoDB synced ✨');

  printPathSummary(report);
  return report;
}

/**
 * Explain what the item's outcome was, without changing it.
 *
 * `unresolved` used to be the one gap that mattered most here: this path counted it and said
 * nothing else — no title in the summary, no record in the review log — so a run could report
 * "3 unresolved … and 3 more" followed by nothing at all. The outcome itself is untouched; this
 * only makes the existing count legible.
 *
 * 解释条目为何得到这个结果，但不改变结果。
 *
 * `unresolved` 曾是这里最要紧的那个缺口：这条链路只加一，别的什么都不留 —— 汇总里没有标题、
 * 留档里没有记录 —— 于是一轮运行会打出「3 unresolved … and 3 more」后面空空如也。
 * 结果本身没有被改动，这里只是让既有的计数变得可读。
 */
function recordOutcome(
  item: FeedItem,
  outcome: ItemSyncOutcome,
  report: PathReport,
): void {
  if (outcome === 'unresolved') {
    const title = item.title || item.id;
    report.unresolvedTitles.push(title);

    // Written to the same review log the other three paths use. Without it this path's data gaps
    // existed only in a summary that a CI run throws away — the review list reads logs, and
    // nothing here named the item per-line until `syncFeedItemToNeodb` started printing
    // `No NeoDB match, skip:`. Both halves are needed: the log line is what the list can parse,
    // this entry is what a human can download.
    // 写进另外三条链路共用的留档。缺了它，本链路的数据缺口只存在于一份 CI 用完即弃的摘要里
    // —— 名单读的是日志，而在 `syncFeedItemToNeodb` 开始打印 `No NeoDB match, skip:` 之前，
    // 这里没有任何一行点名。两者都需要：日志行供名单解析，这条记录供人下载。
    const written = upsertReviewEntry(unmatchedLogFile, {
      source: 'douban→neodb',
      reason: 'no-neodb-match',
      title,
      externalId: item.id,
      externalUrl: item.link,
    });
    // Only claim the log when it was really written. See `douban-to-bangumi.ts#recordUnresolved`.
    // 只有真的写成功才声明。见 `douban-to-bangumi.ts#recordUnresolved`。
    if (written) {
      report.reviewLog = unmatchedLogFile;
    }
    return;
  }

  if (outcome === 'failed') {
    // Create and update are reported by the same slug: the console already distinguishes them
    // ("Item is not marked" vs "Item mark changed"), and splitting the slug would only make the
    // summary say one thing twice.
    // 新建与更新共用同一个 slug：控制台已经用「Item is not marked」与「Item mark changed」
    // 区分过，再拆 slug 只会让汇总把同一件事说两遍。
    report.failedItems.push({
      title: item.title || item.id,
      url: item.link,
      reason: 'neodb-mark-rejected',
    });
  } else if (outcome === 'skipped') {
    report.skippedItems.push({
      title: item.title || item.id,
      url: item.link,
      reason: 'guard-target-status',
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-item sync (path ② orchestration)
// 单条目同步（链路② 的条目级编排）
//
// Lives here rather than in `clients/neodb-shelf.ts` because it is orchestration: it
// sequences catalogue lookup, mark read, merge rule and write. The client keeps only the
// transport primitives (`getNeodbMark` / `markNeodbItem`).
// 放在这里而不是 `clients/neodb-shelf.ts`，因为它是编排：它串起目录查询、标记读取、合并规则
// 与写入。客户端只保留传输原语（`getNeodbMark` / `markNeodbItem`）。
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sync one Douban RSS item to NeoDB: fetch by link, compare the mark, update only if needed.
 * 把一条豆瓣 RSS 条目同步到 NeoDB：按链接抓取、比较标记、仅在需要时更新。
 *
 * @returns The `ItemSyncOutcome` for this single item, so the caller's report adds up.
 *   该单条条目的 `ItemSyncOutcome`，使调用方的报告自洽。
 */
async function syncFeedItemToNeodb(item: FeedItem): Promise<ItemSyncOutcome> {
  const neodbItem = await fetchNeodbItemByUrl(item.link);
  if (!neodbItem?.uuid) {
    // No catalog counterpart on NeoDB. A data gap, not an error — do not turn CI red.
    // One line per item, in the same shape as ③'s `No Bangumi match, skip:` and ⑤'s
    // `No TMDB match; skip`: the review list is built from these lines, so a path that only counts
    // an unresolved item leaves it out of the list entirely.
    // NeoDB 目录里没有对应条目。这是数据缺口而非错误 —— 不应让 CI 变红。
    // 每条打一行，形状与 ③ 的 `No Bangumi match, skip:`、⑤ 的 `No TMDB match; skip` 一致：
    // 待核对名单正是从这些行里长出来的，只计数不点名的链路，条目会整个从名单里消失。
    consola.warn('No NeoDB match, skip: ', itemLabel(item.title || item.id, item.link));
    return 'unresolved';
  }

  const label = `${neodbItem.title}[${item.link}]`;
  consola.info('Going to check item mark status: ', label);

  // A failed read throws: this item is left untouched and counted, instead of being mistaken for
  // "not marked yet" and created over.
  // 读取失败会抛出：这一条原样不动并计入失败，而不是被当成「还没有标记」直接新建覆盖。
  const mark = readOptionalOrThrow(await getNeodbMark(neodbItem.uuid), 'NeoDB mark');
  const sourceGrade = doubanStarsToTenPoint(item.rating);

  if (!mark) {
    consola.info('Item is not marked, going to mark now: ', label);
    const ok = await markNeodbItem(neodbItem, {
      shelfType: item.status,
      comment: item.comment,
      ratingGrade: sourceGrade,
      createdTime: item.time,
    });
    return ok ? 'written' : 'failed';
  }

  // Preserve NeoDB statuses Douban RSS cannot express (e.g. dropped ← Bangumi 搁置/抛弃).
  // 保留豆瓣 RSS 无法表达的目标端状态（例如 dropped ← Bangumi 的搁置/抛弃）。
  const existingStatus = mark.shelf_type as ItemStatus;
  if (existingStatus && !DOUBAN_EXPRESSED_STATUSES.has(existingStatus)) {
    consola.info(
      'NeoDB has Douban-absent status, skip overwrite: ',
      `${label} shelf_type=${mark.shelf_type}`,
    );
    return 'skipped';
  }

  const merged = mergeNeodbMark(
    mark,
    {
      shelfType: item.status,
      ratingGrade: sourceGrade,
      comment: item.comment || '',
    },
    syncConfig.doubanNeodbMerge,
    neodbVisibility,
  );

  if (!merged.shouldWrite) {
    consola.info('NeoDB mark unchanged, skip: ', label);
    return 'unchanged';
  }

  if (merged.keptRating || merged.keptComment) {
    consola.info(
      'NeoDB prefer: keeping existing ',
      [merged.keptRating ? 'rating' : null, merged.keptComment ? 'comment' : null]
        .filter(Boolean)
        .join('+'),
      ' on ',
      label,
    );
  }

  consola.info('Item mark changed, going to update: ', label);
  const ok = await markNeodbItem(neodbItem, {
    shelfType: merged.shelfType,
    comment: merged.comment,
    ratingGrade: merged.ratingGrade,
    createdTime: item.time,
  });
  return ok ? 'written' : 'failed';
}
