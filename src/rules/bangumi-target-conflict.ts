/**
 * Pure rules for deciding which Bangumi collection may write a NeoDB target when several
 * subjects resolve to the same uuid.
 *
 * 当多个 Bangumi subject 解析到同一个 NeoDB uuid 时，决定谁可以写入的纯规则。
 *
 * The source identity is always the Bangumi URL, so only status and a stable subject-id tie-break
 * remain. A lower-status claim must not overwrite a stronger one.
 * 目标来源始终是 Bangumi URL，因此只剩状态等级与稳定的 subject id 兜底；低状态认领不能覆盖
 * 更强认领。
 */
import type { BangumiCollectionType, ShelfType } from '../types';

export type StatusGuard = 'off' | 'no-downgrade';

export type TargetClaim = {
  subjectId: number;
  collectionType: BangumiCollectionType;
};

/**
 * 1 wish, 2 done, 3 doing, 4 on-hold, 5 dropped.
 * `dropped` is deliberately the weakest claim: it must not silently replace a complete/progress
 * mark just because it arrived last.
 * 1 想看、2 看过、3 在看、4 搁置、5 抛弃。`dropped` 刻意排在最低：它不能因为最后到达就静默覆盖
 * 看过/在看的标记。
 */
const COLLECTION_RANK: Record<BangumiCollectionType, number> = {
  1: 1,
  2: 3,
  3: 2,
  4: 2,
  5: 0,
};

function collectionRank(type: BangumiCollectionType): number {
  return COLLECTION_RANK[type];
}

/**
 * Negative when `candidate` outranks `existing`, positive when it loses, zero when equal.
 * 负数表示 candidate 更优，正数表示 existing 更优，0 表示同级。
 */
export function compareClaims(candidate: TargetClaim, existing: TargetClaim): number {
  const status =
    collectionRank(candidate.collectionType) - collectionRank(existing.collectionType);
  if (status !== 0) return -status;

  // Stable tie-break: the older subject id wins, so the result does not depend on list order.
  // 稳定兜底：较小的 subject id 胜出，结果不依赖列表顺序。
  return candidate.subjectId - existing.subjectId;
}

export function shouldSkipClaim(
  existing: TargetClaim,
  candidate: TargetClaim,
): boolean {
  // The same subject may be revisited across pages or runs; never block its own correction.
  // 同一个 subject 可能在分页/多轮中重复出现；不要阻止它自己的修正。
  if (existing.subjectId === candidate.subjectId) return false;
  return compareClaims(candidate, existing) > 0;
}

export function applyStatusGuard(
  existingShelf: ShelfType | null,
  sourceShelf: ShelfType,
  guard: StatusGuard,
): ShelfType {
  if (guard === 'no-downgrade' && existingShelf === 'complete') {
    return 'complete';
  }
  return sourceShelf;
}
