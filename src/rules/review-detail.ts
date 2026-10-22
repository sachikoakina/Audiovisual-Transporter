/*
 * How the closing listing turns a pile of `failed` / `skipped` details into something a human
 * can read. Pure: no I/O, no environment, no clock — so the truncation arithmetic that has to
 * agree with the counters can be asserted offline (see `scripts/verify-rules.ts`).
 *
 * 收尾清单如何把一堆 `failed` / `skipped` 明细变成人能读的东西。纯函数：不做 I/O、不读环境、
 * 不看时钟 —— 因此「截断后的条数必须与计数器对得上」这件事可以在离线断言里钉住
 * （见 `scripts/verify-rules.ts`）。
 *
 * Two rules matter more than the formatting:
 *
 *   1. **Group by reason, not by item.** A full NeoDB → TMDB run reports hundreds of
 *      `unchanged-since-last-run` skips — one line per item would bury the three skips that are
 *      actually wrong. A reason with more than `inlineGroup` entries therefore collapses into a
 *      single line carrying its count and a few examples.
 *   2. **Never print more entries than were counted.** The tail line is derived from the
 *      difference, never guessed, so "… and N more" plus the printed lines always add up to the
 *      number in the heading.
 *
 * 有两件事比排版本身更重要：
 *
 *   1. **按原因分组，而不是按条目罗列。** 一轮完整的 NeoDB → TMDB 会报几百条
 *      `unchanged-since-last-run`，逐条打印会把真正有问题的三条彻底埋掉。因此条目数超过
 *      `inlineGroup` 的原因会折叠成一行，带上条数与几个示例。
 *   2. **打印出的条数永不超过被计入的条数。** 尾行的数字由差值算出、绝不臆测，因此
 *      「… and N more」加上已打印的行，永远等于标题里的那个数。
 */

import type { ReviewDetail } from '../types';

/** Default rendering budgets. Sized so one section rarely exceeds a screen. / 默认预算，控制单节不超过一屏。 */
export const DETAIL_LIMITS = {
  /** Above this many entries, a reason collapses into one line. / 超过这个条数的原因折叠成一行。 */
  inlineGroup: 8,
  /** Hard cap on printed lines per section; the remainder becomes one "and N more" line. / 每节最多打印的行数。 */
  maxLines: 20,
  /** How many example labels a collapsed line shows. / 折叠行展示几个示例。 */
  examples: 3,
} as const;

export type DetailLimits = {
  inlineGroup: number;
  maxLines: number;
  examples: number;
};

export type ReasonGroup = {
  reason: string;
  items: ReviewDetail[];
};

/**
 * Group by reason, keeping first-appearance order.
 * Deliberately not sorted by count: "what did this run hit first" is a useful signal, and
 * reordering between runs makes two summaries harder to compare.
 *
 * 按原因分组，保留首次出现的顺序。刻意不按条数排序：「本轮先撞到什么」本身就是信息，
 * 而且跨轮顺序变化会让两份汇总难以对照。
 */
export function groupByReason(items: readonly ReviewDetail[]): ReasonGroup[] {
  const groups = new Map<string, ReviewDetail[]>();
  for (const item of items) {
    const existing = groups.get(item.reason);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(item.reason, [item]);
    }
  }
  return [...groups].map(([reason, groupItems]) => ({
    reason,
    items: groupItems,
  }));
}

function labelOf(item: ReviewDetail): string {
  const label = (item.label || '').trim();
  return label || '(unnamed)';
}

/**
 * Render the detail lines for one section.
 *
 * @returns `lines` ready to prefix with a bullet; `listed` = how many entries those lines
 *   account for; `omitted` = `items.length - listed`, so the caller's tail line cannot disagree
 *   with the counter.
 *   返回可直接加项目符号的行；`listed` 是这些行动到的条目数；`omitted` 是剩余条数，
 *   使调用方的尾行不可能与计数矛盾。
 */
export function renderDetailLines(
  items: readonly ReviewDetail[],
  limits: DetailLimits = DETAIL_LIMITS,
): { lines: string[]; listed: number; omitted: number } {
  const lines: string[] = [];
  let listed = 0;

  for (const group of groupByReason(items)) {
    const collapsed = group.items.length > limits.inlineGroup;
    // A collapsed group is one line whatever its size, so the cap is checked once; an expanded
    // group is checked per item, because that is what the budget is spent on.
    // 折叠组无论多少条都只占一行，因此只判一次；展开组按条目判，因为预算正是花在条目上的。
    const wanted = collapsed ? 1 : group.items.length;

    if (lines.length + wanted > limits.maxLines) {
      // Stop here rather than emit a partial group: a reason shown for two of its twelve
      // entries reads as "only two happened".
      // 就此打住，不输出半组：某个原因只列出十二条里的两条，会被读成「只发生了两条」。
      break;
    }

    if (collapsed) {
      const examples = group.items.slice(0, limits.examples).map(labelOf).join('、');
      const more = group.items.length > limits.examples ? ' …' : '';
      lines.push(`${group.reason} × ${group.items.length}（例：${examples}${more}）`);
      listed += group.items.length;
    } else {
      for (const item of group.items) {
        lines.push(`${labelOf(item)} — ${item.reason}`);
      }
      listed += group.items.length;
    }
  }

  return { lines, listed, omitted: items.length - listed };
}
