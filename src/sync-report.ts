import fs from 'node:fs';
import { consola } from 'consola';
import { pathHasFailed, type PathReport } from './types';

/**
 * Display layer for sync results.
 *
 * Kept out of the sync logic so presentation can change without touching
 * behaviour, and so every entry point (`index.ts`, `neodb-to-tmdb-full-cli.ts`,
 * `bangumi-to-neodb-full-cli.ts`) renders results the same way.
 *
 * 同步结果的展示层。
 *
 * 刻意与同步逻辑分离：这样改展示不会碰到行为；同时让所有入口
 * （`index.ts`、`neodb-to-tmdb-full-cli.ts`、`bangumi-to-neodb-full-cli.ts`）以同一种方式呈现结果。
 */

/**
 * How many unresolved titles to list before falling back to "see the log".
 * A run against a large shelf can leave hundreds; printing them all would
 * bury the summary that matters.
 */
const MAX_LISTED_TITLES = 20;

/**
 * GitHub Actions reads bare `::group::` / `::warning::` lines as *workflow
 * commands*. They must reach stdout completely unadorned — routing them
 * through consola would prepend `[info]` and silently break them — and they
 * are meaningless noise anywhere else, so they are emitted only inside Actions.
 */
const inActions = process.env.GITHUB_ACTIONS === 'true';

function raw(line: string): void {
  process.stdout.write(`${line}\n`);
}

function ciGroup(title: string): void {
  if (inActions) {
    raw(`::group::${title}`);
  }
}

function ciEndGroup(): void {
  if (inActions) {
    raw('::endgroup::');
  }
}

function ciAnnotation(level: 'notice' | 'warning', message: string): void {
  if (inActions) {
    raw(`::${level}::${message}`);
  }
}

/**
 * Render `a+b+c = total ✔`, so a miscount — or a truncated log — is obvious at
 * a glance instead of hiding behind twelve plausible-looking numbers.
 */
function consistencyLine(parts: number[], total: number): string {
  const sum = parts.reduce((acc, n) => acc + n, 0);
  return `${parts.join('+')} = ${sum} ${sum === total ? '✔' : `✘ expected ${total}`}`;
}

/**
 * East-Asian wide characters occupy two columns in a monospace log. Counting
 * them correctly is what keeps the frame's right edge straight when labels are
 * Chinese.
 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE_CHAR.test(char) ? 2 : 1;
  }
  return width;
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Draw the closing block by hand rather than with `consola.box()`: consola
 * swaps in a CI reporter when it detects `CI`, which flattens the box into
 * indented lines — exactly where the block most needs to stand out. Emitting it
 * raw keeps local and CI output identical. (These lines start with box-drawing
 * characters, never `::`, so Actions will not mistake them for commands.)
 */
function printFrame(title: string, body: string[]): void {
  const inner = Math.max(displayWidth(title), ...body.map(displayWidth));
  const rule = '─'.repeat(inner + 2);
  raw(`┌${rule}┐`);
  raw(`│ ${padTo(title, inner)} │`);
  raw(`│ ${' '.repeat(inner)} │`);
  for (const row of body) {
    raw(`│ ${padTo(row, inner)} │`);
  }
  raw(`└${rule}┘`);
}

function stateLabel(report: PathReport): string {
  if (pathHasFailed(report)) {
    return 'FAILED';
  }
  // A tolerated failure is deliberately not `FAILED` (it does not affect the exit code) but must
  // not be mistaken for `ok` either.
  // 被容忍的失败刻意不标 `FAILED`（它不影响退出码），但也不能被当成 `ok`。
  if (report.tolerated && (report.aborted || report.failed > 0)) {
    return 'TOLERATED';
  }
  if (report.capped) {
    return report.unresolved > 0 ? `capped, ${report.unresolved} unresolved` : 'capped';
  }
  return report.unresolved > 0 ? `ok, ${report.unresolved} unresolved` : 'ok';
}

/**
 * One path's result: counts, a self-check, then whatever needs a human look.
 * Printed as soon as that path finishes, so the streaming log stays readable.
 */
export function printPathSummary(report: PathReport): void {
  consola.info(
    `${report.label}: scanned ${report.scanned}, written ${report.written}, ` +
      `unchanged ${report.unchanged}, skipped ${report.skipped}, ` +
      `unresolved ${report.unresolved}, failed ${report.failed}` +
      `${report.capped ? ' — cap reached' : ''}` +
      `${report.aborted ? ' — aborted before it could run' : ''}`,
  );

  if (!report.aborted) {
    consola.info(
      `${report.label} self-check: ` +
        consistencyLine(
          [
            report.written,
            report.unchanged,
            report.skipped,
            report.unresolved,
            report.failed,
          ],
          report.scanned,
        ),
    );
  }

  if (report.unresolved === 0) {
    return;
  }

  ciGroup(`${report.label}: ${report.unresolved} unresolved`);

  const listed = report.unresolvedTitles.slice(0, MAX_LISTED_TITLES);
  consola.warn(
    `${report.unresolved} unresolved item(s) — no counterpart at the destination:`,
  );
  for (const title of listed) {
    consola.warn(`  · ${title}`);
  }
  const rest = report.unresolved - listed.length;
  if (rest > 0) {
    consola.warn(`  … and ${rest} more`);
  }
  if (report.reviewLog) {
    // Same wording both directions use, so a single grep finds every run that
    // left something for review.
    consola.warn(
      `${report.unresolved} unmatched item(s) written to ${report.reviewLog}.`,
    );
  }

  ciEndGroup();

  ciAnnotation(
    'notice',
    `${report.label}: ${report.unresolved} unresolved item(s); see ${
      report.reviewLog || 'the review log'
    }.`,
  );
}

/**
 * Closing block for the whole run — mirrors the opening `Sync paths:` line.
 * Called once per process, after every path has printed its own summary and
 * listed its own unresolved entries.
 *
 * An empty `reports` array means no path ran at all, which is almost always a misconfiguration
 * (every `SYNC_*` switch off). That used to be indistinguishable in the logs from a run whose
 * writes were all no-ops, so it now says so explicitly instead of returning silently.
 *
 * 整轮的收尾块 —— 与开头的 `Sync paths:` 一行呼应。每进程只调用一次，且在每条链路都打印完
 * 自己的汇总、列完自己的未解决条目之后。
 *
 * `reports` 为空意味着没有任何链路运行过，这几乎总是配置问题（所有 `SYNC_*` 开关都是关的）。
 * 过去这在日志里与「运行成功但所有写入都是无操作」无法区分，因此现在改为明确说明，而不是
 * 静默返回。
 */
export function printOverallSummary(reports: PathReport[]): void {
  if (reports.length === 0) {
    consola.warn(
      'No sync path ran — every SYNC_* switch is off, or every enabled path lacked credentials.',
    );
    return;
  }

  const labelWidth = Math.max(...reports.map((r) => displayWidth(r.label)));
  const lines = reports.map((r) => {
    const pad = (n: number) => String(n).padStart(4);
    return (
      `${padTo(r.label, labelWidth)}   scanned ${pad(r.scanned)}   ` +
      `written ${pad(r.written)}   unresolved ${pad(r.unresolved)}   ` +
      `failed ${pad(r.failed)}   ${stateLabel(r)}`
    );
  });

  const failedCount = reports.filter(pathHasFailed).length;
  // Counted separately so a tolerated failure is announced in the headline instead of vanishing.
  // 单独统计，让「被容忍的失败」出现在标题里而不是凭空消失。
  const toleratedCount = reports.filter(
    (r) => r.tolerated && (r.aborted || r.failed > 0),
  ).length;
  const toleratedSuffix = toleratedCount > 0 ? `, ${toleratedCount} tolerated` : '';
  const headline =
    failedCount === 0
      ? `${reports.length} path(s) ran, none failed${toleratedSuffix}`
      : `${reports.length} path(s) ran, ${failedCount} FAILED${toleratedSuffix}`;

  printFrame(`Sync finished — ${headline}`, lines);
  appendJobSummary(summaryMarkdown(reports, headline));

  if (failedCount === 0) {
    consola.success('All enabled sync paths completed.');
  } else {
    consola.error(`${failedCount} path(s) reported failures — see above.`);
    ciAnnotation('warning', `${failedCount} sync path(s) failed.`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Job summary
// ───────────────────────────────────────────────────────────────────────────

/**
 * Markdown for the run's summary page. Not capped as tightly as the log
 * listing: the summary is meant to be the complete reference, and its 1 MiB
 * budget is nowhere near what a few hundred titles cost.
 */
const MAX_SUMMARY_TITLES = 200;

function summaryMarkdown(reports: PathReport[], headline: string): string {
  const lines = [
    `## Sync finished — ${headline}`,
    '',
    'Scanned 源端读取并尝试处理的条目数；Written 成功写入（新建或更新）；Unchanged 目标端已有且内容一致、未写入；Skipped 被同步规则主动跳过（不计为失败）；Unresolved 无法确定目标端对应实体；Failed 处理时实际出错。',
    '',
    '**计数关系**：Scanned 是分母，其余五项是对它的划分，彼此互不重合 —— `written + unchanged + skipped + unresolved + failed = scanned`，每条链路的 `self-check` 行会校验这一点。唯一例外是 `NeoDB → TMDB`：它的 Written 与 Failed 按**字段**计（评分、watchlist 各一次），同一作品最多贡献 2，因此该链路在两项都写时等式可能不成立。State 列的 `TOLERATED` 表示该链路失败但被 `SYNC_DOUBAN_REQUIRED=0` 免除了退出码。',
    '',
    '| Path | Scanned | Written | Unchanged | Skipped | Unresolved | Failed | State |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const r of reports) {
    lines.push(
      `| ${r.label} | ${r.scanned} | ${r.written} | ${r.unchanged} | ` +
        `${r.skipped} | ${r.unresolved} | ${r.failed} | ${stateLabel(r)} |`,
    );
  }

  for (const r of reports.filter((item) => item.unresolved > 0)) {
    lines.push('', `### ${r.label} — ${r.unresolved} unresolved`, '');

    const listed = r.unresolvedTitles.slice(0, MAX_SUMMARY_TITLES);
    for (const title of listed) {
      lines.push(`- ${title}`);
    }
    const rest = r.unresolved - listed.length;
    if (rest > 0) {
      lines.push(`- … and ${rest} more`);
    }

    if (r.reviewLog) {
      lines.push('', `Full entries: \`${r.reviewLog}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Append the report to `$GITHUB_STEP_SUMMARY`, which GitHub renders on the
 * run's summary page.
 *
 * Chosen over `actions/upload-artifact` for three reasons: GitHub's billing
 * docs exempt job summaries (and logs) from the storage allowance, so this
 * costs nothing; the panel is readable without downloading or unzipping
 * anything; and it needs no workflow change at all, since the path is already
 * in the environment of the step that runs this. It is also immune to the
 * scrollback truncation that has already cost us one log capture.
 *
 * Must be plain markdown — anything consola touches would gain a prefix and
 * stop rendering. Absent outside Actions, where this is a no-op.
 */
function appendJobSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    return;
  }
  try {
    fs.appendFileSync(summaryFile, `${markdown}\n`, 'utf8');
  } catch (error) {
    // A summary is a convenience. Never let it affect the run's outcome.
    consola.debug('Could not write the job summary: ', error);
  }
}
