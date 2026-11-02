/**
 * Which timestamp NeoDB should store as a mark's `created_time`.
 *
 * Bangumi only exposes `updated_at` — the collection's last edit (status, rating, comment or
 * progress) — not a dedicated "status marked at" field. The default therefore keeps NeoDB's own
 * date; callers can explicitly opt into using Bangumi's last-operation time.
 *
 * Bangumi 只提供 `updated_at` —— 收藏的最后一次修改（状态、评分、短评或进度），它不是专门的
 * “状态标记时间”。因此默认保留 NeoDB 自己的日期；调用方可以显式选择使用 Bangumi 的最后操作时间。
 */
export type CreatedTimeMode = 'target' | 'source' | 'source-newer';

export type CreatedTimeInput = {
  mode: CreatedTimeMode;
  isNew: boolean;
  sourceRaw?: string | null;
  targetRaw?: string | null;
};

/**
 * Parse an ISO-ish timestamp and normalize it to UTC. Returns undefined for missing/invalid input;
 * callers must then omit `created_time` rather than sending `now()` or an empty string.
 * 解析 ISO 风格时间并归一化为 UTC。缺失/非法返回 undefined；调用方应省略 `created_time`，而不是
 * 发送 `now()` 或空字符串。
 */
export function normalizeCreatedTime(raw?: string | null): string | undefined {
  if (!raw?.trim()) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function resolveCreatedTime({
  mode,
  isNew,
  sourceRaw,
  targetRaw,
}: CreatedTimeInput): string | undefined {
  const source = normalizeCreatedTime(sourceRaw);
  if (!source) return undefined;

  // A new mark has no target date to protect; all modes may seed it from Bangumi.
  // 新建标记没有目标日期可保护；所有模式都可以用 Bangumi 的时间作为初始值。
  if (isNew) return source;

  if (mode === 'target') return undefined;
  if (mode === 'source') return source;

  const target = normalizeCreatedTime(targetRaw);
  if (!target) return source;

  // source-newer: never move the mark date backwards.
  // source-newer：不允许把标记日期改回过去。
  return Date.parse(source) > Date.parse(target) ? source : undefined;
}
