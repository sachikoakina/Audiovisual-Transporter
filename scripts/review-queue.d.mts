/**
 * Hand-written types for the exports `scripts/review-queue.mjs` offers to tests.
 * 手写类型：`scripts/review-queue.mjs` 提供给测试的那些导出。
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
  failed?: number;
  skipped?: number;
  unresolved?: number;
  scanned?: number;
  // Coverage: which identities the run examined, and whether a cap/abort cut it short. Optional
  // because an older report predates the field — the queue treats that as empty coverage.
  // 覆盖信息：本轮检查过哪些身份、是否被截断或中止。旧报表没有这个字段，因此可选 —— 名单会把
  // 缺失当作空覆盖处理。
  scannedIds?: string[];
  capped?: boolean;
  aborted?: boolean;
  written?: number;
  unchanged?: number;
  // Detail entries the queue uses to fill in type/state when the log line lacked them. Optional:
  // an older report does not carry them.
  // 名单用来补齐类型/状态的明细；旧报表没有这些字段，因此可选。
  unresolvedItems?: ReviewDetail[];
  failedItems?: ReviewDetail[];
  skippedItems?: ReviewDetail[];
};

export type ReviewDetail = {
  title?: string;
  url?: string;
  reason?: string;
  category?: string;
  shelf?: string;
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
  // Normalised vocabulary; a parsed line always carries a fallback (`other` / `unknown`).
  // 收敛后的词汇；解析出的条目总会有兜底值（`other` / `unknown`）。
  category?: string;
  shelf?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  missedRuns?: number;
  seenCount?: number;
};

/** Per-path coverage built from the run report. / 由运行报表折算出的逐链路覆盖信息。 */
export type Coverage = {
  ids: Set<string>;
  complete: boolean;
  unresolved: number;
};

export type MergeResult = {
  items: ReviewItem[];
  added: ReviewItem[];
  removed: ReviewItem[];
  degraded: string;
  uncovered: ReviewItem[];
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
  uncovered?: number;
  coverageAvailable?: boolean;
}): string;

export function readRunReport(dir: string): RunReport | null;

export function coverageFromReport(report: RunReport | null): Map<string, Coverage>;

export function merge(
  previous: ReadonlyArray<ReviewItem>,
  observed: ReadonlyArray<ReviewItem>,
  runStartedAt: string,
  coverage?: Map<string, Coverage> | null,
): MergeResult;

/**
 * One-time migration: drops ⑤ entries still keyed by title (`neodb→tmdb::title:…`) from a loaded
 * snapshot, now that ⑤'s identity is the absolutized NeoDB URL. Passes the array through
 * untouched when there is nothing to drop.
 * 一次性迁移：从加载的快照里丢弃仍按标题建 key 的 ⑤ 条目（`neodb→tmdb::title:…`）—— ⑤ 的身份
 * 现在是绝对化的 NeoDB URL。没有可清理项时原数组原样返回。
 */
export function dropLegacyTmdbTitleKeys(items: ReadonlyArray<ReviewItem>): ReviewItem[];

export function runReportLines(
  report: RunReport | null,
  observed: ReadonlyArray<{ kind: string }>,
): string[];
