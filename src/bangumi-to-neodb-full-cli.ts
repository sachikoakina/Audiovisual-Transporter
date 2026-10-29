import { consola } from 'consola';
import syncBangumiToNeodb from './paths/bangumi-to-neodb';
import { syncConfig } from './sync-config';
import { printOverallSummary } from './sync-report';
import { newPathReport, pathHasFailed } from './types';

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
    // Same policy as the NeoDB → TMDB full entry: running a full import with the path switched off
    // is a misconfiguration, not a no-op. A green exit code would read as "the import ran and found
    // nothing".
    // 与 NeoDB → TMDB 全量入口同一策略：开关关闭时跑全量导入属于配置错误，不是「什么都不用做」。
    // 退出码 0 会被读成「导入跑过了，只是没有新数据」。
    consola.error(
      'SYNC_BANGUMI_NEODB is off — the Bangumi → NeoDB full entry would do nothing. Set SYNC_BANGUMI_NEODB=1.',
    );
    process.exitCode = 1;
    return;
  }
  consola.start('Starting Bangumi → NeoDB full sync...');

  try {
    const report = await syncBangumiToNeodb(true);
    printOverallSummary([report]);

    if (pathHasFailed(report)) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Keep the invariant that a summary is always printed, even when the path throws before it can
    // build one: report the failure as `aborted`, then set the exit code.
    // 保持「汇总总会打印」的不变量：即使链路在产出报告之前就抛出，也以 `aborted` 上报并定退出码。
    consola.error('Bangumi → NeoDB full sync failed: ', error);
    const aborted = newPathReport('Bangumi → NeoDB');
    aborted.aborted = true;
    printOverallSummary([aborted]);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
