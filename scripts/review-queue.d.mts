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

export function readRunReport(dir: string): RunReport | null;

export function runReportLines(
  report: RunReport | null,
  observed: ReadonlyArray<{ kind: string }>,
): string[];
