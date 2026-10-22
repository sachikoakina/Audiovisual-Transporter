/**
 * Path ③ — Douban RSS → Bangumi.
 * 链路③ —— 豆瓣 RSS → Bangumi。
 *
 * Subject resolution order (see `resolveBangumiSubjectId`): a Bangumi link already present on the
 * NeoDB item → exact-title search → the feed title → one more search. Collection updates compare
 * the three relevant fields first, so an unchanged item costs no write.
 * 条目解析顺序（见 `resolveBangumiSubjectId`）：NeoDB 条目上已有的 Bangumi 外链 → 精确标题搜索
 * → feed 标题 → 再搜一次。更新收藏前会先比较三个相关字段，因此未变化的条目不会产生写入。
 *
 * One field is NOT a plain overwrite: a rating that already exists on Bangumi is preserved. Douban
 * only fills an empty (`0`) rating, and "Douban has no rating" (which converts to `0`) can no
 * longer wipe one. See `resolveBangumiCollectionWrite`.
 * 有一个字段不是直接覆盖：Bangumi 侧已有的评分会被保留。豆瓣只填补空（`0`）评分，而
 * 「豆瓣没评分」（会被换算成 `0`）不再能把它清零。见 `resolveBangumiCollectionWrite`。
 *
 * Already-set statuses that Douban RSS cannot express (搁置/抛弃) are preserved rather than
 * overwritten. Calls are paced with `bangumiThrottle()`.
 * 目标端已设为豆瓣 RSS 无法表达的状态（搁置/抛弃）时会予以保留，不被覆盖。调用之间用
 * `bangumiThrottle()` 节流。
 *
 * A path that is switched on but cannot run reports `aborted` rather than returning silently, so a
 * missing token (or an unresolvable username) cannot be misread as a successful no-op.
 * 已启用但无法运行的链路会上报 `aborted`，而不是静默返回，因此缺少令牌（或用户名无法解析）
 * 不会被误读成「跑过且无事」。
 */
import dotenv from 'dotenv';
import { consola } from 'consola';
import type { FeedItem, ItemSyncOutcome, NeodbItem, PathReport } from '../types';
import { ItemCategory, newPathReport } from '../types';
import {
  BANGUMI_STATUSES_ABSENT_FROM_DOUBAN,
  CATEGORY_TO_BANGUMI_TYPES,
  NEODB_TO_BANGUMI_COLLECTION,
  resolveBangumiCollectionWrite,
} from '../rules/bangumi-neodb';
import {
  extractBangumiIdFromNeodb,
  fetchNeodbItemByUrl,
} from '../clients/neodb-catalog';
import {
  bangumiPrivate,
  bangumiToken,
  bangumiThrottle,
  getBangumiCollection,
  getBangumiMe,
  pickExactBangumiMatch,
  searchBangumiSubjects,
  upsertBangumiCollection,
} from '../clients/bangumi';
import { doubanStarsToTenPoint } from '../rules/douban';
import {
  filterDoubanFeedsByCategory,
  syncConfig,
  unmatchedLogFile,
} from '../sync-config';
import { printPathSummary } from '../sync-report';
import { upsertReviewEntry } from '../utils';

dotenv.config();

const LABEL = 'Douban → Bangumi';

/**
 * Sync Douban RSS feed items to Bangumi collections.
 * Matching: NeoDB external_resources first, then exact title search.
 *
 * 把豆瓣 RSS 条目同步到 Bangumi 收藏。
 * 匹配顺序：先看 NeoDB 的 external_resources，再做精确标题搜索。
 *
 * @returns The path's report; `aborted` when the path could not run.
 *   本条链路的报告；无法运行时 `aborted` 为真。
 */
export default async function syncDoubanToBangumi(feeds: FeedItem[]): Promise<PathReport> {
  const report = newPathReport(LABEL);

  if (!bangumiToken) {
    consola.warn('Douban → Bangumi needs BANGUMI_ACCESS_TOKEN; skip.');
    report.aborted = true;
    printPathSummary(report);
    return report;
  }

  const me = await getBangumiMe();
  if (!me?.username) {
    consola.error('Cannot resolve Bangumi username; skip Douban → Bangumi');
    report.aborted = true;
    printPathSummary(report);
    return report;
  }

  const filtered = filterDoubanFeedsByCategory(
    feeds,
    syncConfig.doubanBangumiCategories,
    LABEL,
    (item) => {
      report.skippedItems.push({
        label: `${item.title || item.id}[${item.link}]`,
        reason: 'category-not-allowed',
      });
    },
  );
  report.scanned = feeds.length;
  report.skipped = feeds.length - filtered.length;

  consola.start('Going to sync Douban → Bangumi...');
  for (const item of filtered) {
    const outcome = await syncFeedItemToBangumi(item, me.username);
    report[outcome] += 1;
    if (outcome === 'unresolved') {
      recordUnresolved(item, report);
    } else if (outcome === 'skipped') {
      // The only skip this path can produce: Bangumi already holds a status Douban cannot express
      // (搁置/抛弃), so overwriting it would destroy a fact the source has no way to restore.
      // 本链路唯一可能的跳过：Bangumi 上已是豆瓣表达不了的状态（搁置/抛弃），覆盖它会毁掉源端
      // 无法再表达的事实。
      report.skippedItems.push({
        label: `${item.title || item.id}[${item.link}]`,
        reason: 'guard-bangumi-status',
      });
    } else if (outcome === 'failed') {
      report.failedItems.push({
        label: `${item.title || item.id}[${item.link}]`,
        reason: 'bangumi-write-rejected',
      });
    }
    await bangumiThrottle();
  }
  consola.success('Bangumi synced ✨');

  printPathSummary(report);
  return report;
}

/**
 * Remember an unresolved item for the closing listing AND the on-disk review log.
 * Without this, the summary said "3 unresolved … and 3 more" with no titles at all, because the
 * listing reads `unresolvedTitles` — which this path never filled — and the notice pointed at a
 * review log this path never wrote.
 *
 * 把未匹配条目记入收尾清单**和**磁盘上的留档日志。缺了这一步，汇总只会打出
 * 「3 unresolved … and 3 more」却一个标题都没有 —— 因为清单读的是 `unresolvedTitles`，而这条
 * 链路此前从未填充它；同时 notice 指向的留档日志也从未被本链路写过。
 */
function recordUnresolved(item: FeedItem, report: PathReport): void {
  report.unresolvedTitles.push(item.title || item.id);

  const written = upsertReviewEntry(unmatchedLogFile, {
    source: 'douban→bangumi',
    reason: 'no-bangumi-match',
    title: item.title || item.id,
    externalId: item.id,
    externalUrl: item.link,
  });
  // Only claim the log when it was really written: `upsertReviewEntry` swallows filesystem
  // errors, and "3 unmatched item(s) written to X" after a failed write is a lie the reader
  // would then act on.
  // 只有真的写成功才声明。`upsertReviewEntry` 会吞掉文件系统错误，而写入失败之后再来一句
  // 「3 条已写入 X」，是读者会照着去行动的谎话。
  if (written) {
    report.reviewLog = unmatchedLogFile;
  }
}

/**
 * @returns The `ItemSyncOutcome` for this single item, so the caller's report adds up.
 *   该单条条目的 `ItemSyncOutcome`，使调用方的报告自洽。
 */
async function syncFeedItemToBangumi(
  item: FeedItem,
  username: string,
): Promise<ItemSyncOutcome> {
  const label = `${item.title || item.id}[${item.link}]`;
  consola.info('Douban → Bangumi: ', label);

  const neodbItem = await fetchNeodbItemByUrl(item.link);
  const subjectId = await resolveBangumiSubjectId(item, neodbItem);

  if (!subjectId) {
    consola.warn('No Bangumi match, skip: ', label);
    return 'unresolved';
  }

  const desiredType = NEODB_TO_BANGUMI_COLLECTION[item.status];
  const desiredRate = doubanStarsToTenPoint(item.rating);
  const desiredComment = item.comment || '';

  const existing = await getBangumiCollection(username, subjectId);
  if (existing && BANGUMI_STATUSES_ABSENT_FROM_DOUBAN.has(existing.type)) {
    consola.info(
      'Bangumi has Douban-absent status (搁置/抛弃), skip overwrite: ',
      `subject/${subjectId} type=${existing.type}`,
    );
    return 'skipped';
  }

  const plan = resolveBangumiCollectionWrite({
    desiredType,
    desiredRate,
    desiredComment,
    existing,
  });

  if (plan.unchanged) {
    consola.info('Bangumi collection unchanged, skip: ', `subject/${subjectId}`);
    return 'unchanged';
  }

  if (plan.keepExistingRate) {
    // Keep this line: without it, "why did my Douban re-rating do nothing" is unanswerable from
    // the log alone.
    // 这一行要保留：否则「我在豆瓣改了分，为什么没生效」在日志里根本查不出来。
    consola.info(
      'Bangumi keeps existing rate: ',
      `${plan.rate} (Douban ${desiredRate}), subject/${subjectId}`,
    );
  }

  consola.info(
    existing ? 'Updating Bangumi collection: ' : 'Creating Bangumi collection: ',
    `subject/${subjectId}`,
  );

  const ok = await upsertBangumiCollection(subjectId, {
    type: plan.type,
    rate: plan.rate,
    comment: plan.comment,
    private: bangumiPrivate,
  });
  return ok ? 'written' : 'failed';
}

async function resolveBangumiSubjectId(
  item: FeedItem,
  neodbItem: NeodbItem | null,
): Promise<number | null> {
  if (neodbItem) {
    const fromNeodb = extractBangumiIdFromNeodb(neodbItem);
    if (fromNeodb) {
      consola.info('Matched Bangumi via NeoDB external_resources: ', fromNeodb);
      return fromNeodb;
    }
  }

  // Drama has no Bangumi type; only sync when NeoDB already linked it.
  if (item.category === ItemCategory.Drama) {
    return null;
  }

  const keyword = neodbItem?.display_title || neodbItem?.title || item.title;
  if (!keyword) {
    return null;
  }

  const types = CATEGORY_TO_BANGUMI_TYPES[item.category];
  const results = await searchBangumiSubjects(keyword, types);
  const exact = pickExactBangumiMatch(results, keyword);
  if (exact) {
    consola.info('Matched Bangumi via exact title search: ', exact.id);
    return exact.id;
  }

  // Also try FeedItem.title if NeoDB title differed
  if (item.title && item.title !== keyword) {
    const again = pickExactBangumiMatch(results, item.title);
    if (again) {
      consola.info('Matched Bangumi via FeedItem title: ', again.id);
      return again.id;
    }
    const secondSearch = await searchBangumiSubjects(item.title, types);
    const secondExact = pickExactBangumiMatch(secondSearch, item.title);
    if (secondExact) {
      consola.info('Matched Bangumi via second title search: ', secondExact.id);
      return secondExact.id;
    }
  }

  return null;
}
