import { consola } from 'consola';
import runNeodbToTmdb from './paths/neodb-to-tmdb';
import { neodbTmdbConfig } from './sync-config';
import { printOverallSummary } from './sync-report';
import { newPathReport, pathHasFailed } from './types';

/**
 * Full sync of the NeoDB shelf to TMDB.
 * Intended for the first import and for `workflow_dispatch` runs, not the regular cron.
 *
 * NeoDB 书架到 TMDB 的全量同步。
 * 用于首次导入与 `workflow_dispatch`，而不是常规定时任务。
 *
 * Difference from the cron path: `paths/neodb-to-tmdb.ts` stops after `SYNC_MAX_ITEMS` items and
 * at most `NEODB_MAX_PAGES` pages per shelf; this entry passes `fullSync = true`, which lifts both
 * caps and turns the incremental store off for the run. Shelf and category selections still apply,
 * and `SYNC_DRY_RUN` is still honoured — a full dry run is the recommended first step.
 *
 * 与定时任务链路的区别：`paths/neodb-to-tmdb.ts` 受 `SYNC_MAX_ITEMS` 与 `NEODB_MAX_PAGES` 限制；
 * 本入口传入 `fullSync = true`，取消这两个上限并在本轮关闭增量存储。书架与分类的选择仍然生效，
 * `SYNC_DRY_RUN` 也仍然有效 —— 全量空跑正是推荐的第一步。
 *
 * This entry takes no command-line arguments; run it via its npm script.
 * 本入口不带任何命令行参数，通过对应的 npm script 运行。
 */
async function main(): Promise<void> {
  if (!neodbTmdbConfig.enabled) {
    // Fail loudly: running the full entry with the path switched off is a misconfiguration, not a
    // no-op. A green exit code would read as "the import ran and found nothing".
    // 明确失败：开关关闭时跑全量入口属于配置错误，不是「什么都不用做」。退出码 0 会被读成
    // 「导入跑过了，只是没有新数据」。
    consola.error(
      'SYNC_NEODB_TMDB is off — the NeoDB → TMDB full entry would do nothing. Set SYNC_NEODB_TMDB=1.',
    );
    process.exitCode = 1;
    return;
  }

  consola.start('Starting NeoDB → TMDB full sync...');

  try {
    const report = await runNeodbToTmdb(true);
    printOverallSummary([report]);

    // Report failure through the exit code, never process.exit() — terminating directly would
    // discard the summary that explains what happened.
    // 通过退出码上报失败，绝不用 `process.exit()` —— 直接终止会丢掉解释原因的汇总。
    if (pathHasFailed(report)) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Keep the invariant that a summary is always printed, even when the path throws before it can
    // build one: report the failure as `aborted`, then set the exit code.
    // 保持「汇总总会打印」的不变量，即使链路在产出报告之前就抛出：以 `aborted` 上报，最后再定退出码。
    consola.error('NeoDB → TMDB full sync failed: ', error);
    const aborted = newPathReport('NeoDB → TMDB');
    aborted.aborted = true;
    printOverallSummary([aborted]);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consola.error('Unexpected failure: ', error);
  process.exitCode = 1;
});
