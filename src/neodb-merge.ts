import type { NeodbMergeProfile } from './sync-config';

/** Minimal mark shape for merge (avoids circular import with neodb.ts). */
export type NeodbMarkLike = {
  shelf_type: string;
  visibility?: number;
  comment_text?: string;
  rating_grade?: number;
};

export type NeodbMarkSource = {
  shelfType: string;
  ratingGrade: number;
  comment: string;
};

export type MergedNeodbMark = {
  shelfType: string;
  ratingGrade: number;
  comment: string;
  shouldWrite: boolean;
  keptRating: boolean;
  keptComment: boolean;
};

/**
 * Merge source fields onto an existing NeoDB mark per profile.
 * Status always follows source. Rating/comment: overwrite or fill-empty (neodb_prefer).
 * Visibility is compared against the configured target visibility when deciding shouldWrite.
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
