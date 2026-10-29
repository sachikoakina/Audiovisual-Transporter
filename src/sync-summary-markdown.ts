/**
 * The Markdown half of the run summary.
 *
 * `sync-report.ts` owns everything a terminal reads — per-path lines, detail sections, the framed
 * closing block. This module owns the job-summary page: the table, the per-path detail sections and
 * the review-log pointer. They were one file until the summary page grew its own budget and
 * grouping rules; keeping them apart means a wording change for the terminal cannot silently move
 * a heading on the GitHub Actions page.
 *
 * Shared on purpose: `stateLabel` lives here because both halves must print the same word for the
 * same state (`TOLERATED` must never become `ok` on one side only). The console half imports it.
 *
 * 运行摘要的 Markdown 半边。
 *
 * `sync-report.ts` 负责终端读到的一切 —— 逐链路行、明细小节、带框的收尾块；本模块负责作业摘要
 * 页面：表格、逐链路明细小节，以及留档位置的指路。两者原本在同一个文件里，直到摘要页长出自己
 * 的预算与分组规则；分开之后，为终端改一句措辞就不会悄悄挪动 Actions 页面上的标题。
 *
 * 刻意共用：`stateLabel` 放在这里，因为两边必须为同一个状态打印同一个词（`TOLERATED` 不能只在
 * 一边变成 `ok`）。控制台那一半从本模块导入它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderDetailLines } from './rules/review-detail';
import { pathHasFailed, type PathReport, type ReviewDetail } from './types';

/**
 * GitHub Actions reads bare `::group::` / `::warning::` lines as *workflow commands*, so they must
 * reach stdout unadorned. Only the review-log sentence depends on the environment here; the rest is
 * pure string building.
 *
 * GitHub Actions 会把裸的 `::group::` / `::warning::` 当成工作流命令，因此必须原样到 stdout。
 * 这里只有留档那句话依赖环境，其余都是纯字符串构造。
 */
const inActions = process.env.GITHUB_ACTIONS === 'true';

/**
 * The one word a report's state gets, shared by the console and the summary page.
 *
 * A tolerated failure is deliberately not `FAILED` (it does not affect the exit code) but must not
 * be mistaken for `ok` either. A dry run reports what it *would* have done — without that word the
 * row reads as a run that wrote 12 items, which is the one claim a dry run must never make.
 *
 * 一份报告的状态只用一个词，控制台与摘要页共用。被容忍的失败刻意不标 `FAILED`（不影响退出码），
 * 但也不能被当成 `ok`。dry-run 报的是「本来会做什么」—— 少了这个词，该行读起来就像真的写了 12 条。
 */
export function stateLabel(report: PathReport): string {
  if (pathHasFailed(report)) {
    return 'FAILED';
  }
  if (report.tolerated && (report.aborted || report.failed > 0)) {
    return 'TOLERATED';
  }
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
 * Say what the review log holds — the entry count and size, and, where the path can actually be
 * opened, where it is.
 *
 * The log line used to print the *configured* string (`.cache/unmatched.json` — relative), which
 * says nothing about where the file went and cannot be opened by clicking it. The resolved absolute
 * path fixes that locally.
 *
 * It does not apply in Actions: CI does not write this file at all (`sync.yml` leaves
 * `SYNC_UNMATCHED_LOG` empty), because nothing can outlive the runner. The durable list is the
 * 待核对名单 artifact, so the CI form names the count and that artifact — never a path the reader
 * could be tempted to open.
 *
 * 说明留档里有什么 —— 条目数与体积，以及（仅在路径真的能打开时）它在哪。
 *
 * 过去这里打印的是**配置里的那个字符串**（`.cache/unmatched.json`，相对路径），既说明不了文件
 * 落在哪、也点不开。本地打印解析后的绝对路径正好解决这一点。
 *
 * CI 不适用：那里根本不写这个文件（`sync.yml` 把 `SYNC_UNMATCHED_LOG` 置空），因为没有任何东西
 * 能活过 runner。能长期留存的是待核对名单 artifact，因此 CI 形态只给条目数与那个 artifact ——
 * 绝不给一个读者会想去打开的路径。
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
    // CI-only override: the file is normally not written there, so reaching this branch means
    // someone set SYNC_UNMATCHED_LOG on purpose. Even then, no path is offered.
    // 仅为 CI 里的显式覆盖：那里通常不写该文件，走到这个分支说明有人刻意设了
    // SYNC_UNMATCHED_LOG。即便如此也不给路径。
    return inActions
      ? `Full entries: ${scale} recorded this run. The list that survives is the ` +
          '待核对名单 artifact (`docs/review-queue.md`).'
      : `Full entries: \`${absolute}\` (${scale})`;
  } catch {
    // No guessing about which environment this is: `inActions` already knows.
    // 不必再猜这是哪个环境：`inActions` 已经知道了。
    const missing = 'Full entries: **not present** (nothing was recorded this run)';
    return inActions ? missing : `${missing} — expected at \`${absolute}\``;
  }
}

/**
 * Markdown for the run's summary page. Not capped as tightly as the log listing: the summary is
 * meant to be the complete reference, and its 1 MiB budget is nowhere near what a few hundred
 * titles cost.
 *
 * 摘要页的 Markdown。它不像日志清单那样收得那么紧：摘要本就是完整参照，而几百个标题离它 1 MiB
 * 的预算还差得远。
 */
const MAX_SUMMARY_TITLES = 200;

/** Render the whole job summary for one run. / 渲染一轮运行的整份作业摘要。 */
export function renderSummaryMarkdown(reports: PathReport[], headline: string): string {
  const lines = [
    `## Sync finished — ${headline}`,
    '',
    'Scanned 源端读取并尝试处理的条目数；Written 成功写入（新建或更新）；Unchanged 目标端已有且内容一致、未写入；Skipped 被同步规则主动跳过（不计为失败）；Unresolved 无法确定目标端对应实体；Failed 处理时实际出错。',
    '',
    '**计数关系**：Scanned 是分母，其余五项是对它的划分，彼此互不重合 —— `written + unchanged + skipped + unresolved + failed = scanned`，每条链路的 `self-check` 行会校验这一点，**五条链路一视同仁**（`NeoDB → TMDB` 的评分与 watchlist 也按条目计，字段分项单独打印）。State 列的取值：`TOLERATED` 表示该链路失败但被 `SYNC_DOUBAN_REQUIRED=0` 免除了退出码；`dry-run` 表示这一轮什么都没发出去，计数是「本来会写什么」。',
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
  // 无序列表给不了这种参照，看的人无法回答「我看到第几条了」。
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
