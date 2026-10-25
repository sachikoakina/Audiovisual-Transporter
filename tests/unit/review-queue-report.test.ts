/**
 * The cross-check between the run's JSON report and the log parser.
 * 运行报表与日志解析之间的对账。
 *
 * The list itself is built from logs — that is deliberate, and `docs/review-queue.md` says why.
 * What this file pins is the *other* half: when the run counted more failures than the parser
 * recognised, the summary has to say so, and say it in the direction that points at the parser.
 * 名单本身由日志构建 —— 这是刻意的，理由在 `docs/review-queue.md`。这里钉的是另一半：当本轮
 * 计出的失败多于解析器认出的条数时，摘要必须说出来，而且方向要指向解析器。
 */
import { describe, expect, it } from 'vitest';
import { runReportLines } from '../../scripts/review-queue.mjs';

const report = (failed: number, skipped = 0, unresolved = 0) => ({
  version: 1,
  paths: [{ label: 'NeoDB → TMDB', failed, skipped, unresolved }],
});

describe('runReportLines', () => {
  it('contributes nothing when no report was downloaded', () => {
    expect(runReportLines(null, [])).toEqual([]);
  });

  it('states the totals without warning when the run agrees with the log', () => {
    const text = runReportLines(report(0, 2), [{ kind: 'skipped' }]).join('\n');
    expect(text).toContain('failed 0');
    expect(text).toContain('skipped 2');
    expect(text).not.toContain('⚠️');
  });

  it('warns with the gap when the run counted more failures than the log yielded', () => {
    const text = runReportLines(report(3), [{ kind: 'failed' }]).join('\n');
    expect(text).toContain('⚠️');
    expect(text).toContain('报表记了 3 条 failed，日志只解析出 1 条');
  });

  it('names the paths that reported failures, so the reader knows where to look', () => {
    expect(runReportLines(report(3), []).join('\n')).toContain('`NeoDB → TMDB` 3');
  });

  it('stays quiet when the log yielded more than the run counted (the safe direction)', () => {
    // More parsed than counted means the parser is picking up something the run did not count —
    // worth investigating, but it cannot be a silent *loss*, which is what this line is for.
    // 解析出的多于计出的，说明解析器捡到了本轮没计入的东西 —— 值得查，但它不是「无声丢失」，
    // 而这一行正是为后者存在的。
    const text = runReportLines(report(1), [
      { kind: 'failed' },
      { kind: 'failed' },
    ]).join('\n');
    expect(text).not.toContain('⚠️');
  });
});
