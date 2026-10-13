import { consola } from 'consola';
import runNeodbToTmdb from './handle-neodb-tmdb';
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
