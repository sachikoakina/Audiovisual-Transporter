import { consola } from 'consola';
import syncBangumiToNeodb from './paths/bangumi-to-neodb';
import { syncConfig } from './sync-config';
import { printOverallSummary } from './sync-report';
import { pathHasFailed } from './types';

/**
 * Full sync of all Bangumi collections to NeoDB.
 * Intended for manual / workflow_dispatch runs, not the regular cron.
 *
 * Bangumi 收藏到 NeoDB 的全量同步。
 * 用于手动触发 / `workflow_dispatch`，而不是常规定时任务。
 *
 * Difference from the cron path: `paths/bangumi-to-neodb.ts` stops after one page unless it is
 * told otherwise, so this entry passes `fullSync = true` to make it walk every page.
 * 与定时任务链路的区别：`paths/bangumi-to-neodb.ts` 默认只走一页，本入口传入
 * `fullSync = true` 让它遍历全部分页。
 *
 * This entry takes no command-line arguments; run it via its npm script.
 * 本入口不带任何命令行参数，通过对应的 npm script 运行。
 */
async function main(): Promise<void> {
  if (!syncConfig.bangumiNeodb) {
    consola.warn('SYNC_BANGUMI_NEODB is off; skip full sync.');
    return;
  }
  consola.start('Starting Bangumi → NeoDB full sync...');

  const report = await syncBangumiToNeodb(true);
  printOverallSummary([report]);

  if (pathHasFailed(report)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
