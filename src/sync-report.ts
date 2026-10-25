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
  // A dry run reports what it *would* have done. Without this word the row reads as a run that
  // wrote 12 items, which is the one claim a dry run must never make.
  // dry-run 报的是「本来会做什么」。少了这个词，该行读起来就像真的写了 12 条 ——
  // 而那正是 dry-run 绝不能声称的事。
  if (report.dryRun) {
    return report.unresolved > 0
      ? `dry-run, ${report.unresolved} unresolved`
      : 'dry-run';
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

/**
 * Say what the review log holds — the entry count and size, and (only where the path is usable)
 * where it is.
 *
 * The log line used to print the *configured* string (`.cache/unmatched.json` — relative), which
 * says nothing about where the file went and cannot be opened by clicking it. Printing the
 * resolved absolute path fixes that locally.
 *
 * It does **not** fix it in Actions: the path there resolves under `$GITHUB_WORKSPACE` on a
 * runner whose disk is discarded when the job ends, so the absolute path is a dead pointer —
 * precise, verifiable-looking, and impossible to follow. Printing it would spend the reader's
 * trust on nothing. In CI the useful facts are the ones that survive the VM: *how many* entries
 * were recorded and *how large* the file was. So the path is printed only outside Actions, and
 * the CI form names the relative location plus the place the list does survive (the review
 * queue artifact).
 *
 * 说明留档里有什么 —— 条目数与体积，以及（仅在路径真的可用时）它在哪。
 *
 * 过去这里打印的是**配置里的那个字符串**（`.cache/unmatched.json`，相对路径），既说明不了文件
 * 落在哪、也点不开。本地打印解析后的绝对路径正好解决这一点。
 *
 * 但在 Actions 里它解决不了：那里的路径解析到 `$GITHUB_WORKSPACE` 下，而 runner 的磁盘在作业
 * 结束时随虚拟机丢弃，绝对路径因此是个死指针 —— 精确、看起来可核对、却无从打开。打印它等于白
 * 花读者的信任。CI 里真正经得起虚拟机销毁的事实是：**记录了多少条**、文件**多大**。因此绝对
 * 路径只在非 Actions 环境打印，CI 形态只给相对位置，并指向真正能留存下来的地方（待核对名单
 * artifact）。
 */
function describeReviewLog(configured: string): string {
  const absolute = path.resolve(configured);
  try {
    const size = fs.statSync(absolute).size;
    const parsed: unknown = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const count = Array.isArray(parsed) ? parsed.length : 0;
    // One decimal: a 3.4 KiB file and a 340 KiB file deserve different first reactions.
    // 保留一位小数：3.4 KiB 与 340 KiB 值得不同的第一反应。
    const scale = `${count} entries, ${(size / 1024).toFixed(1)} KiB`;
    // Relative to the workspace, so an absolute `SYNC_UNMATCHED_LOG` cannot smuggle a
    // `/home/runner/...` path back into the summary. Normally this reproduces the default
    // `.cache/unmatched.json` verbatim.
    // 相对工作目录，免得有人把 `SYNC_UNMATCHED_LOG` 配成绝对路径时又把 `/home/runner/...` 带回
    // 摘要里。默认配置下这个值就是 `.cache/unmatched.json` 本身。
    const shown = path.relative(process.cwd(), absolute) || configured;
    return inActions
      ? `Full entries: ${scale} recorded at \`${shown}\` on the runner — its disk is ` +
          'discarded with the VM, so this is not downloadable. The list that survives is the ' +
          '待核对名单 artifact (`docs/review-queue.md`).'
      : `Full entries: \`${absolute}\` (${scale})`;
  } catch {
    // No guessing about which environment this is: `inActions` already knows.
    // 不必再猜这是哪个环境：`inActions` 已经知道了。
    const missing = 'Full entries: **not present** (nothing was recorded this run)';
    return inActions ? missing : `${missing} — expected at \`${absolute}\``;
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
  publishJobSummary(summaryMarkdown(reports, headline));

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
    '**明细小节**：按链路分组，每条链路一个 `### 来源 → 目标` 标题，其下再按档位分 `#### unresolved（N）`、`#### failed（N）`、`#### skipped（N）`。顺序固定为 `unresolved` → `failed` → `skipped`，空档位不产生标题，三档全零的链路连 `###` 标题都不出现 —— 与待核对名单的分组规则一致。`unresolved` 逐条列出（最多 200 条，编号即位置）；`failed` / `skipped` 按**原因**分组 —— 同一原因超过 20 条时折叠成一行，带上条数与示例，因为一轮完整运行里 `unchanged-since-last-run` 这类机械跳过动辄数百条，逐条展开会把真正需要处理的几条埋掉。折叠行的数字与节标题的计数同源，不会对不上。三档都用 Markdown 有序列表、**各自从 1 起**：`unresolved` 的编号即位置，`failed` / `skipped` 的编号只表示「本节第几条可见记录」—— 折叠行一次代表多条，编号不与条数一一对应。',
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
    appendPathDetails(lines, r);
  }

  return lines.join('\n');
}

/**
 * One path's detail block: a single `### 来源 → 目标` heading, then one `#### 档位（N）` per
 * non-empty kind. Grouping by path rather than repeating the path inside three sibling headings
 * means the reader sees "everything that happened to Bangumi → NeoDB" as one unit, and the
 * heading they scan for is the same string the console log and the review list use.
 *
 * 单条链路的明细块：一个 `### 来源 → 目标` 标题，其下每个非空档位一个 `#### 档位（N）`。按链路分组
 * 而不是把链路名重复进三个同级标题里，读者因此能把「Bangumi → NeoDB 这一轮发生了什么」看成
 * 一整块，而且他扫视时找的那个词，与控制台日志、待核对名单里是同一个。
 */
function appendPathDetails(lines: string[], r: PathReport): void {
  // Three empty sections under an empty `### Path` heading would only pad the page.
  // 三档全零还挂一个空的 `### 链路` 标题，只会把页面撑长。
  if (r.unresolved + r.failed + r.skipped === 0) {
    return;
  }
  lines.push('', `### ${r.label}`);
  appendUnresolvedSummary(lines, r);
  appendDetailSummary(lines, 'failed', r.failed, r.failedItems);
  appendDetailSummary(lines, 'skipped', r.skipped, r.skippedItems);
}

function appendUnresolvedSummary(lines: string[], r: PathReport): void {
  if (r.unresolved === 0) {
    return;
  }
  lines.push('', `#### unresolved（${r.unresolved}）`, '');

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
  kind: 'failed' | 'skipped',
  total: number,
  items: readonly ReviewDetail[],
): void {
  if (total === 0) {
    return;
  }

  // Numbered like `unresolved`, so all three sections of one path read the same way, and a
  // reader scanning top-down can say "I am at line 7". But the number counts *rendered
  // lines*, not entries: a collapsed reason line stands for many at once, and `maxLines`
  // can cut the section short, so "line #7" is not "entry #7". The count in the section
  // heading stays authoritative. See `rules/review-detail.ts`.
  // 与 `unresolved` 一样编号，于是同一条链路的三档读法一致，自上而下扫视时能说「我看到第 7
  // 行了」。但这个编号数的是**渲染出来的行**，不是条目：折叠行一次代表很多条，`maxLines`
  // 还会截断本节，所以「第 7 行」不等于「第 7 条」，条目数以小节标题里的计数为准。
  // 见 `rules/review-detail.ts`。
  lines.push('', `#### ${kind}（${total}）`, '', SUMMARY_DETAIL_INTRO[kind], '');

  const { lines: rendered, omitted } = renderDetailLines(items, SUMMARY_DETAIL_LIMITS);
  rendered.forEach((line, index) => {
    lines.push(`${index + 1}. ${line}`);
  });
  if (omitted > 0) {
    // Bullet, not a number: this is "how many are left", not one more row in the list above —
    // the same rule the `unresolved` tail follows.
    // 项目符号而非编号：这是「还剩多少」，不是上面清单里的又一行 —— 与 `unresolved` 的尾行同规则。
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
 * Leave the rendered report in a file for the workflow to publish as the job
 * summary.
 *
 * The process deliberately does **not** append to `$GITHUB_STEP_SUMMARY` itself
 * any more. That file is per-step and is attached when its step ends, so writing
 * the summary from inside the step that may exit non-zero made the report's
 * visibility depend on the sync's success — and the failed run is exactly the
 * one whose summary matters. `sync.yml` publishes this file from a step with
 * `if: always()`, which decouples the two: the sync decides the exit code, the
 * publishing step decides whether anyone gets to read why.
 *
 * Must be plain markdown — anything consola touches would gain a prefix and stop
 * rendering. Written unconditionally, including outside Actions, where the file
 * is simply there to read.
 *
 * 把渲染好的报告写进文件，交给工作流发布成作业摘要。
 *
 * 进程刻意不再自己往 `$GITHUB_STEP_SUMMARY` 追加。那个文件是 per-step 的、随所属 step 结束
 * 才提交，因此把摘要写在「可能以非零码退出」的那个 step 里，等于让报表的可见性取决于同步是否
 * 成功 —— 而恰恰是失败的那一轮最需要这份说明。`sync.yml` 改用一个 `if: always()` 的 step 发布
 * 这个文件，两者从此解耦：同步负责退出码，发布 step 负责「有人能看到为什么」。
 *
 * 必须是纯 markdown —— 被 consola 碰过就会多出前缀、不再渲染。无条件写出，Actions 之外也写，
 * 本地跑完直接看这个文件即可。
 */
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
