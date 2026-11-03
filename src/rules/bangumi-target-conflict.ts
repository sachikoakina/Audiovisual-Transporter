/**
 * Pure rules for deciding which Bangumi collection may write a NeoDB target when several
 * subjects resolve to the same uuid.
 *
 * 当多个 Bangumi subject 解析到同一个 NeoDB uuid 时，决定谁可以写入的纯规则。
 *
 * Identity confidence is ranked before status: a direct Bangumi link beats a Douban twin, which
 * beats a title-only twin. Only when two claims have the same confidence does the status rank
 * decide, so a manga's "在读" cannot downgrade an anime's "看过".
 * 身份置信度优先于状态：Bangumi 直链高于豆瓣孪生，豆瓣孪生高于仅标题匹配。只有置信度相同时才看
 * 状态等级，因此漫画的「在读」不能把动画的「看过」降级。
 */
import type { BangumiCollectionType, BangumiSubjectType, ShelfType } from '../types';
import type { NeodbResolutionVia } from '../clients/neodb-catalog';

export type StatusGuard = 'off' | 'no-downgrade';

export type TargetClaim = {
  subjectId: number;
  subjectType: BangumiSubjectType;
  collectionType: BangumiCollectionType;
  title: string;
  via: NeodbResolutionVia;
};

const VIA_RANK: Record<NeodbResolutionVia, number> = {
  direct: 3,
  'douban-twin': 2,
  'title-twin': 1,
  none: 0,
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
  const via = VIA_RANK[candidate.via] - VIA_RANK[existing.via];
  if (via !== 0) return -via;

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
