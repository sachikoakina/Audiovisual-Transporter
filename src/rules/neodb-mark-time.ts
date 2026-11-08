/**
 * Which timestamp NeoDB should store on a mark.
 *
 * NeoDB's API field is still `created_time`, but the product rule is about the mark's time:
 * - a new mark is seeded from the source;
 * - `status` keeps the target time while the status is unchanged and uses the source when the
 *   status changes;
 * - `initial-source` only seeds new marks and always keeps the target time afterwards;
 * - `always-source` uses the source on every write.
 *
 * NeoDB 的 API 字段仍叫 `created_time`，但业务规则描述的是“标记时间”：
 * - 新建标记用来源时间；
 * - `status` 在状态不变时保留目标时间，状态变化时使用来源时间；
 * - `initial-source` 只给新标记播种，之后永远保留目标时间；
 * - `always-source` 每次写入都使用来源时间。
 */
export type MarkTimePolicy = 'status' | 'initial-source' | 'always-source';

export type MarkTimePlan = {
  markTime?: string;
  reason:
    | 'new'
    | 'same-status'
    | 'status-changed'
    | 'initial-source'
    | 'always-source'
    | 'missing';
};

export type MarkTimeInput = {
  policy: MarkTimePolicy;
  isNew: boolean;
  statusChanged: boolean;
  sourceRaw?: string | null;
  targetRaw?: string | null;
};

/** Parse an ISO-ish timestamp and normalize it to UTC; invalid values are omitted. / 解析并归一化时间；非法值省略。 */
export function normalizeMarkTime(raw?: string | null): string | undefined {
  if (!raw?.trim()) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function planNeodbMarkTime({
  policy,
  isNew,
  statusChanged,
  sourceRaw,
  targetRaw,
}: MarkTimeInput): MarkTimePlan {
  const source = normalizeMarkTime(sourceRaw);
  const target = normalizeMarkTime(targetRaw);

  // A new mark has no target value to protect, so every policy seeds it from the source.
  // 新建标记没有目标值可保护，因此所有策略都用来源时间初始化。
  if (isNew) {
    return source ? { markTime: source, reason: 'new' } : { reason: 'missing' };
  }

  if (policy === 'always-source') {
    return source
      ? { markTime: source, reason: 'always-source' }
      : { reason: 'missing' };
  }

  if (policy === 'initial-source') {
    return target
      ? { markTime: target, reason: 'initial-source' }
      : { reason: 'missing' };
  }

  if (statusChanged) {
    return source
      ? { markTime: source, reason: 'status-changed' }
      : { reason: 'missing' };
  }

  return target ? { markTime: target, reason: 'same-status' } : { reason: 'missing' };
}
