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
  getNeodbItemDetail,
} from '../clients/neodb-catalog';
import {
  bangumiPrivate,
  bangumiSubjectYear,
  bangumiToken,
  bangumiThrottle,
  exactBangumiCandidates,
  getBangumiCollection,
  getBangumiMe,
  getBangumiSubject,
  isBangumiYearFilterType,
  pickExactBangumiMatchByYear,
  searchBangumiSubjects,
  upsertBangumiCollection,
  type BangumiSubject,
} from '../clients/bangumi';
import { neodbThrottle } from '../clients/neodb-http';
import { doubanStarsToTenPoint } from '../rules/douban';
import { extractNeodbYear } from '../rules/tmdb-mapping';
import {
  filterDoubanFeedsByCategory,
  syncConfig,
  unmatchedLogFile,
} from '../sync-config';
import { printPathSummary } from '../sync-report';
import { itemLabel, upsertReviewEntry } from '../utils';
import { PathAbortedError, failureReason, readOptionalOrThrow } from '../read-guards';

dotenv.config();

const LABEL = 'Douban → Bangumi';

/**
 * Years the two sides may differ by before a candidate is rejected. One year absorbs the usual
 * region/database drift; anything wider is a different work far more often than a data quirk.
 * 两侧年份允许多大差值。1 年用于吸收常见的地区/数据库差异；再大就更可能是不同作品。
 */
const BANGUMI_YEAR_TOLERANCE = 1;

/**
 * Run-local lookups for the year soft filter. `null` is cached too: a missing year costs one
 * request per run, not one per attempt, and a failed read is never retried as if it were a gap.
 * 年份软过滤的单轮查表。`null` 也会缓存：缺年份每轮只花一次请求，而不是每次尝试都重查；读取
 * 失败也不会被当成「真的没有」反复重试。
 */
type YearCache = {
  /** NeoDB uuid → year (or null). / NeoDB uuid → 年份（或 null）。 */
  neodb: Map<string, number | null>;
  /** Bangumi subject id → year (or null). / Bangumi subject id → 年份（或 null）。 */
  bangumi: Map<number, number | null>;
};

/**
 * Sync Douban RSS feed items to Bangumi collections.
 * Matching: NeoDB external_resources first, then exact title search. The title fallback compares
 * years for anime (2) and real-action (6) only, and only when both sides carry one.
 *
 * 把豆瓣 RSS 条目同步到 Bangumi 收藏。
 * 匹配顺序：先看 NeoDB 的 external_resources，再做精确标题搜索。标题 fallback 只对动画（2）与
 * 真人（6）比较年份，且只在两侧都有年份时比较。
 *
 * @returns The path's report; `aborted` when the path could not run.
 *   本条链路的报告；无法运行时 `aborted` 为真。
 */
export default async function syncDoubanToBangumi(
  feeds: FeedItem[],
): Promise<PathReport> {
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
        title: item.title || item.id,
        url: item.link,
        reason: 'category-not-allowed',
      });
    },
  );
  report.scanned = feeds.length;
  report.skipped = feeds.length - filtered.length;
  // Douban links cover the `标题[链接]` entries (unresolved + most failure lines);
  // `syncFeedItemToBangumi` adds the `bangumi:<id>` identity once a subject is resolved.
  // Category-excluded items are recorded up front, since their verdict does not depend on the
  // loop; the rest join the set only when reached, so an abort cannot over-cover the tail.
  // 豆瓣链接覆盖 `标题[链接]` 形态的条目（未匹配与多数失败行）；`syncFeedItemToBangumi` 在
  // subject 解析成功后补上 `bangumi:<id>`。被分类白名单剔除的条目先记下，结论不依赖循环；
  // 其余条目只在真正轮到时加入，abort 因此不会把尾部误记成已检查。
  const kept = new Set(filtered.map((item) => item.link));
  const scanned = new Set(
    feeds.filter((item) => !kept.has(item.link)).map((item) => item.link),
  );

  // Shared across every item in this run: a year is immutable, so a uuid/id hit is always safe.
  // 本轮所有条目共用：年份不可变，uuid/id 命中永远安全。
  const years: YearCache = { neodb: new Map(), bangumi: new Map() };

  consola.start('Going to sync Douban → Bangumi...');
  for (const item of filtered) {
    scanned.add(item.link);
    try {
      const outcome = await syncFeedItemToBangumi(item, me.username, scanned, years);
      report[outcome] += 1;
      if (outcome === 'unresolved') {
        recordUnresolved(item, report);
      } else if (outcome === 'skipped') {
        // The only skip this path can produce: Bangumi already holds a status Douban cannot express
        // (搁置/抛弃), so overwriting it would destroy a fact the source has no way to restore.
        // 本链路唯一可能的跳过：Bangumi 上已是豆瓣表达不了的状态（搁置/抛弃），覆盖它会毁掉源端
        // 无法再表达的事实。
        report.skippedItems.push({
          title: item.title || item.id,
          url: item.link,
          reason: 'guard-bangumi-status',
        });
      } else if (outcome === 'failed') {
        report.failedItems.push({
          title: item.title || item.id,
          url: item.link,
          reason: 'bangumi-write-rejected',
        });
      }
    } catch (error) {
      if (error instanceof PathAbortedError) {
        // Every remaining item would fail the same way, so the honest thing is to stop and say
        // it once: the exit code comes from `aborted`, and the summary says "aborted" in words.
        // 剩下每一条都会以同样方式失败，所以诚实的做法是停下并说一次：退出码来自 `aborted`，
        // 摘要里也会用文字写明「aborted」。
        report.aborted = true;
        consola.error(`Douban → Bangumi aborted: ${error.message}`);
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
        reason: failureReason(error, 'bangumi-read-failed', 'bangumi-item-threw'),
      });
      // Deliberately not `Item failed, continuing:` — that sentence is how the review list
      // recognises Bangumi → NeoDB, and it routes on that string alone.
      // 刻意不用 `Item failed, continuing:` —— 名单靠那句话认出 Bangumi → NeoDB，它只认这个字符串。
      consola.error(
        `Douban → Bangumi item threw, continuing: ${item.title || item.id}[${item.link}] —`,
        error instanceof Error ? error.message : error,
      );
    }
    await bangumiThrottle();
  }
  report.scannedIds = [...scanned].sort();
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
  /**
   * Identities examined this run, including `bangumi:<id>` for every resolved subject.
   * 本轮检查过的身份，包含每个解析成功的 subject 的 `bangumi:<id>`。
   */
  scanned: Set<string>,
  /** Run-local year lookups shared by every title-search attempt. / 本轮共享的年份查表。 */
  years: YearCache,
): Promise<ItemSyncOutcome> {
  const label = itemLabel(item.title || item.id, item.link);
  consola.info('Douban → Bangumi: ', label);

  const neodbItem = await fetchNeodbItemByUrl(item.link);
  const subjectId = await resolveBangumiSubjectId(item, neodbItem, years);

  if (!subjectId) {
    consola.warn('No Bangumi match, skip: ', label);
    return 'unresolved';
  }

  // The guard below is the one review entry on this path whose key is not the Douban link: its
  // log line names `subject/N`, and the parser derives `bangumi:N` from it. Record that identity
  // for every resolved subject — not only when the guard fires — so an entry created by an older
  // guard run can still age out after the Bangumi status changes.
  // 下面那条守卫是本链路唯一不按豆瓣链接建 key 的条目：日志行只给 `subject/N`，解析器据此得到
  // `bangumi:N`。只要 subject 解析成功就记下这个身份 —— 不只在守卫触发时记，这样更早一轮留下的
  // 守卫条目在 Bangumi 状态改变后仍能正常老化。
  scanned.add(`bangumi:${subjectId}`);

  const desiredType = NEODB_TO_BANGUMI_COLLECTION[item.status];
  const desiredRate = doubanStarsToTenPoint(item.rating);
  const desiredComment = item.comment || '';

  // A failed read throws: this item is left untouched and counted, instead of being mistaken for
  // "not collected yet" and created over.
  // 读取失败会抛出：这一条原样不动并计入失败，而不是被当成「还没有收藏」直接新建覆盖。
  const existing = readOptionalOrThrow(
    await getBangumiCollection(username, subjectId),
    'Bangumi collection',
  );
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
  years: YearCache,
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
  // Only anime (2) / real-action (6) get the year soft filter. Book / music / game keep the old
  // first-exact-title behaviour; Drama already returned above.
  // 只有动画（2）/ 真人（6）启用年份软过滤。书籍 / 音乐 / 游戏保持原来的「第一个精确同名」；
  // 话剧在上面已经返回。
  const yearGateEnabled = types?.some((type) => isBangumiYearFilterType(type)) ?? false;

  // Resolved at most once per item, and only when there is an exact candidate to compare. A
  // missing source year makes the selector return the first candidate without touching the
  // candidate-year resolver, so this stays a zero-request path.
  // 每个条目最多解析一次，且只在确实存在精确同名候选时才解析。源年份缺失时，选择器会直接返回
  // 第一个候选、不调用候选年份解析器，因此这条路径保持零额外请求。
  let expectedYear: Promise<number | null> | null = null;
  const getExpectedYear = (): Promise<number | null> => {
    if (!yearGateEnabled) {
      return Promise.resolve(null);
    }
    expectedYear ??= resolveNeodbYear(neodbItem, years);
    return expectedYear;
  };

  const pick = async (candidates: BangumiSubject[]): Promise<BangumiSubject | null> => {
    if (!candidates.length) {
      return null;
    }
    return pickExactBangumiMatchByYear(
      candidates,
      await getExpectedYear(),
      BANGUMI_YEAR_TOLERANCE,
      (candidate) => resolveBangumiCandidateYear(candidate, years),
    );
  };

  const results = await searchBangumiSubjects(keyword, types);
  const exact = await pick(exactBangumiCandidates(results, keyword));
  if (exact) {
    consola.info('Matched Bangumi via exact title search: ', exact.id);
    return exact.id;
  }

  // Also try FeedItem.title if NeoDB title differed
  if (item.title && item.title !== keyword) {
    const again = await pick(exactBangumiCandidates(results, item.title));
    if (again) {
      consola.info('Matched Bangumi via FeedItem title: ', again.id);
      return again.id;
    }
    const secondSearch = await searchBangumiSubjects(item.title, types);
    const secondExact = await pick(exactBangumiCandidates(secondSearch, item.title));
    if (secondExact) {
      consola.info('Matched Bangumi via second title search: ', secondExact.id);
      return secondExact.id;
    }
  }

  return null;
}

/**
 * NeoDB's release year for the source item, cheapest source first: the inline `year` / `pub_year`
 * (some catalog responses carry them), the run cache, then the item's own `api_url`.
 *
 * A failure here is not an item failure: the year filter is an extra tie-breaker, so an
 * unreadable year simply means "do not filter". Caching `null` keeps that one request per run.
 * 源条目的 NeoDB 发行年份，从最便宜的开始：内联 `year` / `pub_year`（部分目录响应会带）、
 * 本轮缓存、最后才是条目自己的 `api_url`。
 *
 * 这里失败不算条目失败：年份过滤只是额外的裁决证据，读不到年份只意味着「不过滤」。缓存 `null`
 * 让这次请求一轮最多发生一次。
 */
async function resolveNeodbYear(
  neodbItem: NeodbItem | null,
  years: YearCache,
): Promise<number | null> {
  if (!neodbItem) {
    return null;
  }

  const inline = extractNeodbYear(neodbItem);
  if (inline != null) {
    return inline;
  }
  if (years.neodb.has(neodbItem.uuid)) {
    return years.neodb.get(neodbItem.uuid) ?? null;
  }
  if (!neodbItem.api_url) {
    years.neodb.set(neodbItem.uuid, null);
    return null;
  }

  await neodbThrottle();
  const detail = await getNeodbItemDetail(neodbItem.api_url);
  const year = detail ? (extractNeodbYear(detail) ?? null) : null;
  years.neodb.set(neodbItem.uuid, year);
  return year;
}

/**
 * Bangumi's release year for one candidate. Search results often carry `air_year` / `air_date`;
 * only a miss pays for the full subject. Any read failure yields `null`, which the selector treats
 * as "pass" — never as "reject".
 * 一个候选的 Bangumi 发行年份。搜索结果通常已带 `air_year` / `air_date`，只有缺失时才去取完整
 * 条目。任何读取失败都返回 `null`，选择器会把它当作「放行」——绝不当作「拒绝」。
 */
async function resolveBangumiCandidateYear(
  candidate: BangumiSubject,
  years: YearCache,
): Promise<number | null> {
  const inline = bangumiSubjectYear(candidate);
  if (inline != null) {
    return inline;
  }
  if (years.bangumi.has(candidate.id)) {
    return years.bangumi.get(candidate.id) ?? null;
  }

  await bangumiThrottle();
  const detail = await getBangumiSubject(candidate.id);
  const year = detail.status === 'found' ? bangumiSubjectYear(detail.value) : null;
  years.bangumi.set(candidate.id, year);
  return year;
}
