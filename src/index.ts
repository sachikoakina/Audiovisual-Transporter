/**
 * Total entry point — runs whichever paths the environment enables, then prints one summary.
 * 总入口 —— 按环境变量启用的链路依次执行，最后打印一份汇总。
 *
 * Path order and failure policy, as actually implemented:
 *   1. Douban RSS is fetched ONCE and shared by the three Douban paths.
 *   2. A failure anywhere in those three is caught here and logged, then the run CONTINUES —
 *      so a Douban outage still lets Bangumi→NeoDB and NeoDB→TMDB do their work.
 *   3. Bangumi→NeoDB runs next, then NeoDB→TMDB.
 *   4. `printOverallSummary` runs before the exit code is set, so the summary always survives.
 *   5. No path calls `process.exit()` any more, and all 5 paths return a `PathReport`. A path that
 *      is enabled but cannot run (missing credentials, unresolvable identity) reports `aborted`,
 *      which fails the run on purpose — an enabled path with no credentials is a misconfiguration.
 *
 * 链路的执行顺序与失败策略（按实际实现）：
 *   1. 豆瓣 RSS 只抓取一次，由三条豆瓣链路共用。
 *   2. 这三条链路中的任何失败都在此处捕获并记录，然后**继续执行** —— 因此豆瓣侧故障时
 *      Bangumi→NeoDB 与 NeoDB→TMDB 仍能完成工作。
 *   3. 之后执行 Bangumi→NeoDB，最后执行 NeoDB→TMDB。
 *   4. `printOverallSummary` 在确定退出码之前调用，因此汇总总能打印出来。
 *   5. 已无任何链路调用 `process.exit()`，且 5 条链路都返回 `PathReport`。已启用但无法运行的
 *      链路会上报 `aborted`，并**刻意**让整轮失败 —— 启用了链路却没有凭据属于配置错误。
 */
import { consola } from 'consola';
import { fetchRSSFeeds, normalizeRssFeeds } from './clients/douban-rss';
import syncDoubanToNotion from './paths/douban-to-notion';
import syncDoubanToNeodb from './paths/douban-to-neodb';
import syncDoubanToBangumi from './paths/douban-to-bangumi';
import syncBangumiToNeodb from './paths/bangumi-to-neodb';
import runNeodbToTmdb from './paths/neodb-to-tmdb';
import { ItemStatus, newPathReport, pathHasFailed, type PathReport } from './types';
import {
  describeSyncConfig,
  envEnabled,
  needsDoubanRss,
  neodbTmdbConfig,
  syncConfig,
} from './sync-config';
import { printOverallSummary } from './sync-report';

async function main(): Promise<void> {
  consola.info('Sync paths: ', describeSyncConfig());

  /**
   * Paths that report their own counters, folded into the closing summary.
   *
   * All 5 paths produce a `PathReport`. A path that is enabled but cannot run comes back with
   * `aborted`, so it still appears — as a failure, which is the point.
   *
   * 会自带计数、并被并入收尾汇总的链路。5 条链路都会产出 `PathReport`。已启用但无法运行的链路
   * 会带 `aborted` 返回，因此它依然出现 —— 作为失败出现，这正是目的。
   */
  const reports: PathReport[] = [];
  let doubanFailed = false;

  if (needsDoubanRss()) {
    try {
      const feeds = await fetchRSSFeeds();
      if (feeds.length === 0) {
        consola.info('No new Douban RSS items.');
      } else {
        const normalizedFeeds = normalizeRssFeeds(feeds);
        const completeFeeds = normalizedFeeds.filter(
          (f) => f.status === ItemStatus.Complete,
        );

        if (syncConfig.doubanNotion && completeFeeds.length) {
          reports.push(await syncDoubanToNotion(completeFeeds));
        }

        // Both paths always return a report; when they cannot run they report `aborted`, which
        // `pathHasFailed` turns into a non-zero exit code.
        // 两条链路始终返回报告；无法运行时报告 `aborted`，由 `pathHasFailed` 折算为非零退出码。
        if (syncConfig.doubanNeodb) {
          reports.push(await syncDoubanToNeodb(normalizedFeeds));
        }

        if (syncConfig.doubanBangumi) {
          reports.push(await syncDoubanToBangumi(normalizedFeeds));
        }
      }
    } catch (error) {
      doubanFailed = true;
      consola.error(
        'Douban RSS sync failed; continuing with Bangumi→NeoDB if enabled. Error: ',
        error,
      );
    }
  } else {
    consola.info('All Douban→* paths disabled; skip Douban RSS.');
  }

  if (syncConfig.bangumiNeodb) {
    // Read through `envEnabled` like every other switch, so `'true'` / `'yes'` / `'on'` work too.
    // Previously this compared against the literal `'1'`, which made BANGUMI_FULL_SYNC=1 the only
    // accepted spelling and quietly ignored the others.
    // 与其他所有开关一样走 `envEnabled`，因此 `'true'` / `'yes'` / `'on'` 同样生效。原先这里是
    // 与字面量 `'1'` 比较，导致只有 `BANGUMI_FULL_SYNC=1` 这一种写法有效，其余写法被静默忽略。
    const fullSync = envEnabled('BANGUMI_FULL_SYNC', false);
    reports.push(await syncBangumiToNeodb(fullSync));
  }

  // NeoDB → TMDB runs last. It reads NeoDB's own shelf rather than the Douban
  // RSS feed, so it is independent of everything above: it cannot change how
  // any existing path behaves, and a failure here only sets the exit code.
  if (neodbTmdbConfig.enabled) {
    // Only the start marker here: the path itself prints the effective configuration, so printing
    // it here as well would show the same line twice (and would drift the moment a full-mode run
    // resolves its limits differently from the raw environment).
    // 这里只留开始标记：配置由链路自身打印。在这里再打一次会重复同一行，而且一旦全量运行折算出的
    // 上限与原始环境变量不同，就会出现两行互相矛盾的配置。
    consola.start('NeoDB → TMDB');
    try {
      reports.push(await runNeodbToTmdb());
    } catch (error) {
      consola.error('NeoDB → TMDB failed: ', error);
      const aborted = newPathReport('NeoDB → TMDB');
      aborted.aborted = true;
      reports.push(aborted);
    }
  } else {
    // Say so explicitly. A silent skip is indistinguishable in the logs from a
    // successful run whose writes were all no-ops, which makes a missing
    // SYNC_NEODB_TMDB look like "the sync ran but wrote nothing".
    consola.info('NeoDB → TMDB: disabled — set SYNC_NEODB_TMDB=1 to enable. Skipped.');
  }

  // Printed before the exit code is finalised so the summary always survives.
  printOverallSummary(reports);

  if (doubanFailed) {
    process.exitCode = 1;
  }
  if (reports.some(pathHasFailed)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
