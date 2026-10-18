/**
 * NeoDB mark merge rule — decide what an existing NeoDB mark should become.
 * NeoDB 标记合并规则 —— 决定一条已存在的 NeoDB 标记最终应该变成什么。
 *
 * Zero I/O, zero environment reads. The only import is a *type* from the shared vocabulary
 * (`types.ts`), so the rule can be asserted directly with literal objects.
 * 零 I/O、零环境读取。唯一的导入是从共享词汇表（`types.ts`）引入的一个**类型**，因此本规则
 * 可直接用字面量对象断言。
 */
import type { NeodbMergeProfile } from '../types';

/**
 * Structural shape of a NeoDB mark, deliberately not imported from the NeoDB client.
 * A structural parameter type keeps this rule module free of any `clients/` dependency, and lets
 * callers (and assertions) pass plain literal objects instead of constructing a full API type.
 *
 * NeoDB 标记的结构化形状，刻意不从 NeoDB 客户端导入类型。使用结构化参数类型可以让本规则
 * 模块完全不依赖 `clients/`，同时让调用方（以及断言）直接传字面量对象，而不必构造完整的
 * API 类型。
 */
export type NeodbMarkLike = {
  shelf_type: string;
  visibility?: number;
  comment_text?: string;
  rating_grade?: number;
};

/** The fields a source path wants to push. / 某条源链路希望推送的字段。 */
export type NeodbMarkSource = {
  shelfType: string;
  ratingGrade: number;
  comment: string;
};

/** The merged result, plus why it was or was not scheduled. / 合并结果，以及它被排入或未排入的原因。 */
export type MergedNeodbMark = {
  shelfType: string;
  ratingGrade: number;
  comment: string;
  shouldWrite: boolean;
  /** true = the existing rating won over the source's. / true = 保留原有评分而否定源值。 */
  keptRating: boolean;
  /** true = the existing comment won over the source's. / true = 保留原有短评而否定源值。 */
  keptComment: boolean;
};

/**
 * Merge source fields onto an existing NeoDB mark per profile.
 * Status always follows source. Rating/comment: overwrite or fill-empty (neodb_prefer).
 * Visibility is compared against the configured target visibility when deciding shouldWrite.
 *
 * 按 profile 把源字段合并进已有的 NeoDB 标记。
 * 状态永远跟随源值。评分/短评：`overwrite` 直接覆盖；`neodb_prefer` 只在原值为空时填入。
 * 在决定 shouldWrite 时，可见性是与「配置的目标可见性」做比较。
 */
export function mergeNeodbMark(
  existing: NeodbMarkLike | null,
  source: NeodbMarkSource,
  profile: NeodbMergeProfile,
  targetVisibility: number,
): MergedNeodbMark {
  if (!existing) {
    return {
      shelfType: source.shelfType,
      ratingGrade: source.ratingGrade,
      comment: source.comment,
      shouldWrite: true,
      keptRating: false,
      keptComment: false,
    };
  }

  let ratingGrade = source.ratingGrade;
  let comment = source.comment;
  let keptRating = false;
  let keptComment = false;

  if (profile === 'neodb_prefer') {
    if ((existing.rating_grade || 0) !== 0) {
      ratingGrade = existing.rating_grade || 0;
      keptRating = ratingGrade !== source.ratingGrade;
    }
    const existingComment = existing.comment_text || '';
    if (existingComment !== '') {
      comment = existingComment;
      keptComment = comment !== (source.comment || '');
    }
  }

  const shelfType = source.shelfType;
  const sameStatus = existing.shelf_type === shelfType;
  const sameComment = (existing.comment_text || '') === (comment || '');
  const sameRating = (existing.rating_grade || 0) === ratingGrade;
  const sameVisibility = (existing.visibility ?? targetVisibility) === targetVisibility;

  return {
    shelfType,
    ratingGrade,
    comment,
    shouldWrite: !(sameStatus && sameComment && sameRating && sameVisibility),
    keptRating,
    keptComment,
  };
}
