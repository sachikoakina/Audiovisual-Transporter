/**
 * Resolve the visibility written to a NeoDB mark.
 *
 * `target` keeps the configured value for every item. `source` follows the source's private flag
 * for each item; Bangumi only has a boolean, so it maps to 0 (public) or 2 (private), never 1.
 *
 * 解析写入 NeoDB 标记的可见性。`target` 统一使用配置值；`source` 逐条跟随源端 private，
 * 因为 Bangumi 只有布尔值，只能映射为 0（公开）或 2（私密），不会产生 1。
 */
export type NeodbVisibilityMode = 'target' | 'source';

export type NeodbVisibilityPlan = {
  visibility: number;
  reason: 'target' | 'source-private' | 'source-public' | 'source-missing';
};

export function planNeodbVisibility(input: {
  mode: NeodbVisibilityMode;
  targetVisibility: number;
  sourcePrivate?: boolean;
  existingVisibility?: number;
}): NeodbVisibilityPlan {
  if (input.mode === 'target') {
    return { visibility: input.targetVisibility, reason: 'target' };
  }

  if (input.sourcePrivate === true) {
    return { visibility: 2, reason: 'source-private' };
  }
  if (input.sourcePrivate === false) {
    return { visibility: 0, reason: 'source-public' };
  }

  // Do not invent public/private when the source cannot answer. Keep the target's current value
  // when known — clamped to the legal {0,1,2}, because a non-compliant instance could echo an
  // out-of-range value straight back on the next visibility-only write — otherwise use the
  // configured fallback; callers log the missing source value.
  // 源端无法回答时不要猜测；优先保留目标现有值——夹取到合法的 {0,1,2}，否则不合规实例返回的
  // 越界值会在下一次仅可见性写回时被原样写回——其余情况使用配置兜底；缺失由调用方告警。
  const existing = input.existingVisibility;
  return {
    visibility:
      existing === 0 || existing === 1 || existing === 2
        ? existing
        : input.targetVisibility,
    reason: 'source-missing',
  };
}
