import fs from 'node:fs';
import { consola } from 'consola';
import { pathHasFailed, type PathReport } from './types';

/**
 * Display layer for sync results.
 *
 * Kept out of the sync logic so presentation can change without touching
 * behaviour, and so every entry point (`index.ts`, `sync-tmdb-only.ts`,
 * `sync-bangumi-full.ts`) renders results the same way.
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
 */
export function printOverallSummary(reports: PathReport[]): void {
  if (reports.length === 0) {
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
  const headline =
    failedCount === 0
      ? `${reports.length} path(s) ran, none failed`
      : `${reports.length} path(s) ran, ${failedCount} FAILED`;

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
