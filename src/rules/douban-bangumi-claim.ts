/**
 * Deterministic target claim for ③ Douban → Bangumi.
 *
 * Several feed entries can resolve to the same Bangumi subject (different editions, duplicate
 * catalog entries, or a title collision). If each writes independently, the last one wins and a
 * `complete` entry can be downgraded by a later `wishlist`/`progress` entry. This rule keeps one
 * claim per subject for the current run:
 *
 * - identity confidence: link > ISBN > title;
 * - status strength: complete > progress/wishlist > dropped;
 * - stable tie-break: smaller source URL wins.
 *
 * ③ 同一条目可能被多个豆瓣 feed 条目命中（不同版次、重复目录或同名碰撞）。若各自写入，最后
 * 一条会覆盖前一条，「看过」可能被「想看/在看」降级。本规则在同一轮内按目标去重：外链 >
 * ISBN > 标题；complete > progress/wishlist > dropped；仍相同则较小 source URL 胜出。
 */
import type { ItemStatus } from '../types';

export type DoubanClaimVia = 'link' | 'isbn' | 'title';

export type DoubanTargetClaim = {
  subjectId: number;
  sourceId: string;
  via: DoubanClaimVia;
  status: ItemStatus;
};

const VIA_RANK: Record<DoubanClaimVia, number> = {
  link: 3,
  isbn: 2,
  title: 1,
};

const STATUS_RANK: Record<ItemStatus, number> = {
  complete: 3,
  progress: 2,
  wishlist: 2,
  dropped: 1,
};

/** Whether the incoming claim must yield to the incumbent. / 新认领是否应让位给已有认领。 */
export function shouldSkipDoubanClaim(
  incumbent: DoubanTargetClaim,
  incoming: DoubanTargetClaim,
): boolean {
  // The same source may be revisited; never block its own correction.
  // 同一来源可能被再次处理；不要阻止它自己的修正。
  if (incumbent.sourceId === incoming.sourceId) {
    return false;
  }

  const via = VIA_RANK[incoming.via] - VIA_RANK[incumbent.via];
  if (via !== 0) {
    return via < 0;
  }

  const status = STATUS_RANK[incoming.status] - STATUS_RANK[incumbent.status];
  if (status !== 0) {
    return status < 0;
  }

  return incoming.sourceId >= incumbent.sourceId;
}
