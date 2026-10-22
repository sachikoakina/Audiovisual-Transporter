import fs from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { renderDetailLines } from './rules/review-detail';
import { pathHasFailed, type PathReport, type ReviewDetail } from './types';

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
 * What each detail line means, in one sentence. Kept next to the counters they explain because
 * the distinction is the whole point: `failed` means something broke, `skipped` means the code
 * decided not to write — and only some of those decisions are worth a human's time.
 *
 * 每类明细的含义，一句话。刻意放在它所解释的计数器旁边，因为这个区分本身就是重点：
 * `failed` 是「出错了」，`skipped` 是「代码决定不写」—— 而这些决定里只有一部分值得人工过目。
 */
const DETAIL_HEADINGS: Record<'failed' | 'skipped', (total: number) => string> = {
  failed: (total) => `${total} failed item(s) — the write was attempted and rejected:`,
  skipped: (total) => `${total} skipped item(s) — deliberately not written:`,
};

/**
 * Print one detail section for `failed` or `skipped`.
 *
 * The heading carries the counter; the lines explain it. When the two disagree the section says
 * so instead of rounding to whichever is prettier — that mismatch has meant "a new counter was
 * added without a matching detail" every time it has happened.
 *
 * 打印 `failed` 或 `skipped` 的一节明细。标题给计数，行给解释；两者不一致时明说不一致，
 * 而不是向好看的一边取整 —— 每次出现这种不一致，都意味着「新增了计数却没配套明细」。
 */
function printDetailSection(report: PathReport, kind: 'failed' | 'skipped'): void {
  const total = kind === 'failed' ? report.failed : report.skipped;
  const items = kind === 'failed' ? report.failedItems : report.skippedItems;

  ciGroup(`${report.label}: ${total} ${kind}`);
  consola.warn(DETAIL_HEADINGS[kind](total));

  const { lines, omitted } = renderDetailLines(items);
  for (const line of lines) {
    consola.warn(`  · ${line}`);
  }
  if (omitted > 0) {
    consola.warn(`  … and ${omitted} more`);
  }
  if (items.length !== total) {
    // Both directions are wrong, and both are worth saying out loud: fewer details than counted
    // means the path never named what it counted (so the listing hides something), more details
    // than counted means one of the two was counted twice. Either way the counter wins, because
    // it is the thing the self-check line already verified against `scanned`.
    // 两个方向都不对，都值得说明：明细少于计数 = 链路没能点名（清单藏了东西）；明细多于计数 =
    // 其中一处被数了两遍。无论哪种，都以计数为准 —— 它才是 self-check 行已经与 `scanned` 对过账的那个。
    consola.warn(
      `  (detail has ${items.length} entr(ies), count is ${total} — the count is authoritative)`,
    );
  }
  ciEndGroup();
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

  if (report.unresolved > 0) {
    printUnresolved(report);
  }
  if (report.failed > 0) {
    printDetailSection(report, 'failed');
  }
  if (report.skipped > 0) {
    printDetailSection(report, 'skipped');
  }
}

/**
 * Resolve the review log's path and say whether it is really there.
 *
 * The log line used to print the *configured* string (`.cache/unmatched.json` — relative), which
 * says nothing about where the file went and cannot be opened by clicking it. Worse, in Actions
 * it names a path on an ephemeral runner, so the reader who goes looking on their own disk finds
 * nothing no matter how hard they look. Printing the resolved absolute path plus the entry count
 * makes "it exists but you are looking in the wrong place" and "it was never written"
 * distinguishable at a glance.
 *
 * 解析留档日志的真实路径，并说明它到底在不在。
 *
 * 过去这里打印的是**配置里的那个字符串**（`.cache/unmatched.json`，相对路径），既说明不了文件
 * 落在哪、也点不开。更糟的是在 Actions 里它指向的是一台用完即弃的 runner，读者回自己磁盘上找
 * 永远找不到。打印解析后的绝对路径与条目数，才能一眼区分「文件存在、只是你在错的地方找」与
 * 「它压根没被写过」。
 */
function describeReviewLog(configured: string): string {
  const absolute = path.resolve(configured);
  try {
    const size = fs.statSync(absolute).size;
    const parsed: unknown = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const count = Array.isArray(parsed) ? parsed.length : 0;
    // One decimal: a 3.4 KiB file and a 340 KiB file deserve different first reactions.
    // 保留一位小数：3.4 KiB 与 340 KiB 值得不同的第一反应。
    return `Full entries: \`${absolute}\` (${count} entries, ${(size / 1024).toFixed(1)} KiB)`;
  } catch {
    return `Full entries: \`${absolute}\` — **not present** (nothing was recorded this run, or it ran on a CI runner whose disk is discarded)`;
  }
}

function printUnresolved(report: PathReport): void {
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
    // left something for review. The path is resolved on purpose: see
    // `describeReviewLog`.
    // 两个方向用同一句话，因此一次 grep 就能找到所有留下待核对的运行。路径刻意解析成绝对路径，
    // 原因见 `describeReviewLog`。
    consola.warn(
      `${report.unresolved} unmatched item(s) written to ${path.resolve(report.reviewLog)}.`,
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
    '**明细小节**：`unresolved` 逐条列出（最多 200 条，编号即位置）；`failed` / `skipped` 按**原因**分组 —— 同一原因超过 8 条时折叠成一行，带上条数与示例，因为一轮完整运行里 `unchanged-since-last-run` 这类机械跳过动辄数百条，逐条展开会把真正需要处理的几条埋掉。折叠行的数字与节标题的计数同源，不会对不上。',
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

  for (const r of reports) {
    if (r.unresolved > 0) {
      lines.push('', `### ${r.label} — ${r.unresolved} unresolved`, '');

      // Ordered list on purpose: the summary is read against the count in the heading, so a
      // numbered entry doubles as a position ("#37 of 44"). A bullet list gave no such anchor and
      // made "how far down the list am I" unanswerable.
      // 刻意用有序列表：读者会拿清单与标题里的数字对照，编号即位置（「44 条里的第 37 条」）。
      // 无序列表给不了这个参照，看的人无法回答「我看到第几条了」。
      const listed = r.unresolvedTitles.slice(0, MAX_SUMMARY_TITLES);
      listed.forEach((title, index) => {
        lines.push(`${index + 1}. ${title}`);
      });
      const rest = r.unresolved - listed.length;
      if (rest > 0) {
        // Not numbered: the tail is a remainder, not an entry.
        // 不编号：这一段是「剩余条数」，不是清单里的一条。
        lines.push(`- … and ${rest} more`);
      }

      if (r.reviewLog) {
        lines.push('', describeReviewLog(r.reviewLog));
      }
    }

    // Bullets, not numbers: a collapsed reason line stands for many entries at once, so
    // "entry #37" would no longer mean anything. See `rules/review-detail.ts`.
    // 用项目符号而不是编号：折叠行一次代表很多条，「第 37 条」不再有意义。见 `rules/review-detail.ts`。
    appendDetailSummary(lines, r.label, 'failed', r.failed, r.failedItems);
    appendDetailSummary(lines, r.label, 'skipped', r.skipped, r.skippedItems);
  }

  return lines.join('\n');
}

/**
 * The summary page has room for far more than a terminal, so its budgets are looser than
 * `DETAIL_LIMITS` — but still bounded, because the page is rendered for a human, not slurped.
 * 摘要页比终端宽裕得多，因此预算比 `DETAIL_LIMITS` 宽松 —— 但仍然有限，因为那是给人看的页面。
 */
const SUMMARY_DETAIL_LIMITS = { inlineGroup: 20, maxLines: 60, examples: 5 };

/**
 * One line per kind in the summary, saying what the kind *means* — the heading already repeats
 * the English heading's count, so repeating its sentence too would spend the reader's attention
 * on nothing.
 * 摘要里每类一句，说的是这一类**意味着什么** —— 标题已经复述了英文标题里的计数，再复述它的
 * 那句话只是白白花掉读者的注意力。
 */
const SUMMARY_DETAIL_INTRO: Record<'failed' | 'skipped', string> = {
  failed: '写入被目标端拒绝，或处理时抛出异常。**这些会让退出码非零。**',
  skipped:
    '按同步规则主动跳过，不计为失败 —— 其中既有一轮就几百条的机械跳过（如增量命中、本轮重复），也有真该看一眼的配置缺口（如某分类没配 Notion 数据源）。',
};

function appendDetailSummary(
  lines: string[],
  label: string,
  kind: 'failed' | 'skipped',
  total: number,
  items: readonly ReviewDetail[],
): void {
  if (total === 0) {
    return;
  }
  lines.push('', `### ${label} — ${total} ${kind}`, '', SUMMARY_DETAIL_INTRO[kind], '');

  const { lines: rendered, omitted } = renderDetailLines(items, SUMMARY_DETAIL_LIMITS);
  for (const line of rendered) {
    lines.push(`- ${line}`);
  }
  if (omitted > 0) {
    lines.push(`- … and ${omitted} more`);
  }
  if (items.length !== total) {
    lines.push(
      '',
      `_Detail covers ${items.length} of ${total}; the table above is authoritative._`,
    );
  }
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
