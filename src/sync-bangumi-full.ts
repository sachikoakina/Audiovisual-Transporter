import { consola } from 'consola';
import handleBangumiToNeodb from './handle-bangumi-neodb';
import { syncConfig } from './sync-config';
import { printOverallSummary } from './sync-report';
import { pathHasFailed } from './types';

/**
 * Full sync of all Bangumi collections to NeoDB.
 * Intended for manual / workflow_dispatch runs, not the regular cron.
 */
async function main(): Promise<void> {
  if (!syncConfig.bangumiNeodb) {
    consola.warn('SYNC_BANGUMI_NEODB is off; skip full sync.');
    return;
  }
  consola.start('Starting Bangumi → NeoDB full sync...');

  const report = await handleBangumiToNeodb(true);
  printOverallSummary([report]);

  if (pathHasFailed(report)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
