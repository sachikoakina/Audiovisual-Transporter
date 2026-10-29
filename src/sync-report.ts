import fs from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { renderDetailLines } from './rules/review-detail';
import { renderSummaryMarkdown, stateLabel } from './sync-summary-markdown';
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
      `${report.aborted ? ' — aborted before it could run' : ''}` +
      `${report.dryRun ? ' — dry run, nothing was sent' : ''}`,
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
    // Same wording in every path that leaves something for review, so a single grep finds all of
    // them. The absolute path stays here even in CI: this line *is* the log, it is quoted in the
    // job's own transcript, and "the file was written during this run" is exactly what the path
    // proves. The job summary drops it in CI for the opposite reason — there the path is offered
    // as something to open. See `describeReviewLog`.
    // 凡是留下待核对条目的链路都用同一句话，一次 grep 就能全找出来。即使在 CI 里这里也保留绝对
    // 路径：这一行本来就写在日志里、会被作业自己的转录引住，而「这轮确实写过这个文件」正是路径
    // 能证明的事。作业摘要恰恰相反 —— 在那边路径是「给人去打开」的东西，所以 CI 里不打印。
    // 见 `describeReviewLog`。
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
export function printOverallSummary(reports: PathReport[], skipReason?: string): void {
  if (reports.length === 0) {
    // `skipReason` exists for the one case the old sentence got wrong: an empty feed is neither a
    // switch that is off nor a missing credential, and claiming otherwise sends the reader to the
    // wrong config file. The caller knows why nothing ran; the summary should repeat it, not guess.
    // `skipReason` 专为旧那句话唯一说错的情形而设：feed 为空既不是开关关着，也不是凭据缺失，
    // 那样说会把读者送去翻错的配置文件。调用方知道为什么什么都没跑；汇总应当复述，而不是猜。
    consola.warn(
      skipReason
        ? `No sync path ran — ${skipReason}.`
        : 'No sync path ran — every SYNC_* switch is off, or every enabled path lacked credentials.',
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
  // Written before the exit code is set, and read by a workflow step that runs regardless of it:
  // the summary survives a failed run. See `publishJobSummary`.
  // 在确定退出码之前写出，由一个与退出码无关的 workflow step 读取：失败的运行同样留下摘要。
  // 见 `publishJobSummary`。
  publishJobSummary(renderSummaryMarkdown(reports, headline));
  publishRunReport(reports);

  if (failedCount === 0) {
    consola.success('All enabled sync paths completed.');
  } else {
    consola.error(`${failedCount} path(s) reported failures — see above.`);
    ciAnnotation('warning', `${failedCount} sync path(s) failed.`);
  }
}

/**
 * The same run, as data.
 *
 * The summary above is for a human; this file is what a machine can check itself against — the
 * review queue reads it to notice log lines it failed to attribute. Written at the same moment as
 * the summary, i.e. before the exit code, so a failed run still leaves one behind.
 * 同一轮运行，以数据形式。上面的摘要给人看；这个文件给机器对账 —— 待核对名单读它，用来发现
 * 自己没能认领的日志行。与摘要同一时刻写出，即在确定退出码之前，因此失败的那一轮也会留下它。
 */
function publishRunReport(reports: readonly PathReport[]): void {
  const target = path.resolve(
    process.env.SYNC_REPORT_FILE || '.cache/sync-report.json',
  );
  const payload = { version: 1, generatedAt: new Date().toISOString(), paths: reports };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Same policy as the summary: a write failure is noise, not a run failure.
    // 与摘要同一策略：写不进去是噪音，不是运行失败。
    consola.warn(`Could not write the run report to ${target}: `, error);
  }
}

function publishJobSummary(markdown: string): void {
  const target = path.resolve(
    process.env.SYNC_SUMMARY_FILE || '.cache/sync-summary.md',
  );
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Overwrite rather than append: one run, one summary. Appending would stack a second copy
    // on top of the first when `npm run sync` is re-run locally.
    // 覆盖而非追加：一轮一份。追加会让本地重跑 `npm run sync` 时在第一份后面再叠一份。
    fs.writeFileSync(target, `${markdown}\n`, 'utf8');
  } catch (error) {
    // A summary is a convenience, but a *silently* missing one costs an hour of guessing, so
    // this must not hide behind `consola.debug` (which CI never prints).
    // 摘要只是便利，但「悄悄没有」要用一小时去猜，所以不能藏在 CI 从不打印的 `consola.debug` 后面。
    consola.warn(`Could not write the job summary to ${target}: `, error);
  }
}
