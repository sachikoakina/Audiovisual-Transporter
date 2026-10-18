import { consola } from 'consola';
import runNeodbToTmdb from './paths/neodb-to-tmdb';
import { describeNeodbTmdbConfig, neodbTmdbConfig } from './sync-config';
import { printOverallSummary } from './sync-report';
import { pathHasFailed } from './types';

/**
 * Standalone entry for the NeoDB → TMDB path only.
 *
 * Use this when you want to sync just that path and leave the Douban/Bangumi
 * cron alone. The combined entry is `src/index.ts`.
 *
 *   npm run sync:neodb-tmdb
 *
 * 只跑 NeoDB → TMDB 的独立入口。
 *
 * 当你想单独同步这一条链路、不动豆瓣/Bangumi 的定时任务时使用。合并入口是 `src/index.ts`。
 *
 *   npm run sync:neodb-tmdb
 *
 * This entry takes no command-line arguments; run it via its npm script.
 * 本入口不带任何命令行参数，通过对应的 npm script 运行。
 */
async function main(): Promise<void> {
  if (!neodbTmdbConfig.enabled) {
    consola.warn('SYNC_NEODB_TMDB is off; skip NeoDB → TMDB.');
    return;
  }

  consola.info('NeoDB → TMDB sync: ', describeNeodbTmdbConfig());
  consola.start('Starting NeoDB → TMDB sync...');

  const report = await runNeodbToTmdb();
  printOverallSummary([report]);

  // Report failure through the exit code, never process.exit() — terminating
  // directly would discard the summary that explains what happened.
  if (pathHasFailed(report)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
