/**
 * Rating and comment are independent NeoDB merge switches.
 * NeoDB 的评分与短评是两个独立开关。
 */
import { describe, expect, it } from 'vitest';
import {
  describeCommentChange,
  mergeNeodbMark,
} from '../../src/rules/neodb-mark-merge';

const source = {
  shelfType: 'complete',
  ratingGrade: 6,
  comment: 'Douban comment',
};
const existing = {
  shelf_type: 'complete',
  rating_grade: 9,
  comment_text: 'NeoDB comment',
};

describe('mergeNeodbMark independent profiles', () => {
  it('keeps the target rating while overwriting only the comment', () => {
    const merged = mergeNeodbMark(existing, source, 'neodb_prefer', 2, 'overwrite');

    expect(merged.ratingGrade).toBe(9);
    expect(merged.comment).toBe('Douban comment');
  });

  it('overwrites only the rating while keeping the target comment', () => {
    const merged = mergeNeodbMark(existing, source, 'overwrite', 2, 'neodb_prefer');

    expect(merged.ratingGrade).toBe(6);
    expect(merged.comment).toBe('NeoDB comment');
  });

  it('fills both empty target fields independently', () => {
    const merged = mergeNeodbMark(
      { shelf_type: 'complete', rating_grade: 0, comment_text: '' },
      source,
      'neodb_prefer',
      2,
      'neodb_prefer',
    );

    expect(merged.ratingGrade).toBe(6);
    expect(merged.comment).toBe('Douban comment');
    expect(merged.shouldWrite).toBe(true);
  });

  it('stays unchanged when both target fields win', () => {
    const merged = mergeNeodbMark(existing, source, 'neodb_prefer', 2, 'neodb_prefer');

    expect(merged.shouldWrite).toBe(false);
    expect(merged.keptRating).toBe(true);
    expect(merged.keptComment).toBe(true);
  });
});

describe('describeCommentChange', () => {
  it('does not include the comment text', () => {
    const before = 'private old comment';
    const after = 'private new comment';

    expect(describeCommentChange(before, after)).toBe(
      `changed oldLen=${before.length} newLen=${after.length}`,
    );
    expect(describeCommentChange(before, after)).not.toContain('private');
  });

  it('describes fill, clear, and unchanged states', () => {
    expect(describeCommentChange('', 'new')).toBe('filled newLen=3');
    expect(describeCommentChange('old', '')).toBe('cleared oldLen=3');
    expect(describeCommentChange('same', 'same')).toBe('unchanged');
  });
});
