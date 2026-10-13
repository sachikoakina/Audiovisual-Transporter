import { consola } from 'consola';
import { fetchRSSFeeds, handleRSSFeeds } from './handle-rss';
import handleNotion from './handle-notion';
import handleNeodb from './handle-neodb';
import handleBangumi from './handle-bangumi';
import handleBangumiToNeodb from './handle-bangumi-neodb';
import runNeodbToTmdb from './handle-neodb-tmdb';
import { ItemStatus, newPathReport, pathHasFailed, type PathReport } from './types';
import {
  describeNeodbTmdbConfig,
  describeSyncConfig,
  needsDoubanRss,
  neodbTmdbConfig,
  syncConfig,
} from './sync-config';
import { printOverallSummary } from './sync-report';

async function main(): Promise<void> {
  consola.info('Sync paths: ', describeSyncConfig());

  /** Paths that report their own counters, folded into the closing summary. */
  const reports: PathReport[] = [];
  let doubanFailed = false;

  if (needsDoubanRss()) {
    try {
      const feeds = await fetchRSSFeeds();
      if (feeds.length === 0) {
        consola.info('No new Douban RSS items.');
      } else {
        const normalizedFeeds = handleRSSFeeds(feeds);
        const completeFeeds = normalizedFeeds.filter(
          (f) => f.status === ItemStatus.Complete,
        );

        if (syncConfig.doubanNotion && completeFeeds.length) {
          await handleNotion(completeFeeds);
        }

        if (syncConfig.doubanNeodb) {
          await handleNeodb(normalizedFeeds);
        }

        if (syncConfig.doubanBangumi) {
          await handleBangumi(normalizedFeeds);
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
    const fullSync = process.env.BANGUMI_FULL_SYNC === '1';
    reports.push(await handleBangumiToNeodb(fullSync));
  }

  // NeoDB → TMDB runs last. It reads NeoDB's own shelf rather than the Douban
  // RSS feed, so it is independent of everything above: it cannot change how
  // any existing path behaves, and a failure here only sets the exit code.
  if (neodbTmdbConfig.enabled) {
    consola.start('NeoDB → TMDB: ', describeNeodbTmdbConfig());
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
