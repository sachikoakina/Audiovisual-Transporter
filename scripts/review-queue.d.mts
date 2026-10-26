/**
 * Hand-written types for the two exports `scripts/review-queue.mjs` offers to tests.
 * 手写类型：`scripts/review-queue.mjs` 提供给测试的那两个导出。
 *
 * The script stays plain ESM — it runs on a bare `node` in CI, with no build step — so its types
 * are declared here rather than inferred. Only what the tests touch is declared; the rest of the
 * file is internal by design.
 * 该脚本保持纯 ESM —— CI 里用裸 `node` 跑，没有构建步骤 —— 因此类型在这里声明而不是推断。
 * 只声明测试用到的那部分；其余部分按设计是内部的。
 */
export type RunReportPath = {
  label: string;
  // The four `runReportLines` actually reads. The rest of `PathReport` travels with the file but
  // is not part of this contract, so it stays optional — a test can build the minimum.
  // `runReportLines` 真正读的四个字段。`PathReport` 的其余部分随文件同行，但不属于这份契约，
  // 因此保持可选 —— 测试可以只构造最小值。
  failed: number;
  skipped: number;
  unresolved: number;
  scanned?: number;
  written?: number;
  unchanged?: number;
};

export type RunReport = { version: number; paths: RunReportPath[] };

/**
 * One item as the log parser sees it, and as `render` consumes it.
 * 解析器看到、`render` 消费的单条条目。
 *
 * The three timeline fields are optional because a freshly parsed item has not been through
 * `merge` yet — only `render` needs them, and it defaults them the same way `merge` does.
 * 三个时间线字段是可选的：刚解析出的条目还没经过 `merge`，只有 `render` 用得到它们，而它对缺省值
 * 的处理与 `merge` 一致。
 */
export type ReviewItem = {
  key: string;
  kind: string;
  source: string;
  reason: string;
  title: string;
  url: string;
  id: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  missedRuns?: number;
  seenCount?: number;
};

export type ParsedLogs = {
  items: ReviewItem[];
  unattributable: number;
  sawPathSummary: boolean;
};

export function parseLogs(logsDir: string): ParsedLogs;

export function render(input: {
  items: ReadonlyArray<ReviewItem>;
  added: ReadonlyArray<ReviewItem>;
  removed: ReadonlyArray<ReviewItem>;
  degraded: string;
  runStartedAt: string;
  runUrl?: string;
  unattributable?: number;
}): string;

export function readRunReport(dir: string): RunReport | null;

export function runReportLines(
  report: RunReport | null,
  observed: ReadonlyArray<{ kind: string }>,
): string[];
