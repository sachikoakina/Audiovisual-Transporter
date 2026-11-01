/**
 * Pure conflict rules: identity beats status, and a guard only protects an existing complete mark.
 * 纯冲突规则：身份优先于状态；guard 只保护目标端已有的“看过”。
 */
import { describe, expect, it } from 'vitest';
import {
  applyStatusGuard,
  compareClaims,
  shouldSkipClaim,
  type TargetClaim,
} from '../../src/rules/bangumi-target-conflict';

function claim(over: Partial<TargetClaim>): TargetClaim {
  return {
    subjectId: 1,
    subjectType: 2,
    collectionType: 2,
    title: 'Title',
    via: 'direct',
    ...over,
  };
}

describe('compareClaims', () => {
  it('ranks a direct link over a title twin regardless of status', () => {
    const directProgress = claim({ via: 'direct', collectionType: 3 });
    const titleComplete = claim({ via: 'title-twin', collectionType: 2 });

    expect(compareClaims(directProgress, titleComplete)).toBeLessThan(0);
  });

  it('ranks complete over progress when confidence is equal', () => {
    const complete = claim({ collectionType: 2 });
    const progress = claim({ collectionType: 3 });

    expect(compareClaims(complete, progress)).toBeLessThan(0);
    expect(compareClaims(progress, complete)).toBeGreaterThan(0);
  });

  it('uses subject id as a stable tie-break', () => {
    const older = claim({ subjectId: 10 });
    const newer = claim({ subjectId: 20 });

    expect(compareClaims(older, newer)).toBeLessThan(0);
  });
});

describe('shouldSkipClaim', () => {
  it('never blocks the same subject from being revisited', () => {
    const existing = claim({ subjectId: 7, collectionType: 2 });
    const same = claim({ subjectId: 7, collectionType: 3 });

    expect(shouldSkipClaim(existing, same)).toBe(false);
  });

  it('skips a lower-ranked different subject', () => {
    const existing = claim({ subjectId: 1, collectionType: 2 });
    const manga = claim({ subjectId: 2, collectionType: 3, via: 'title-twin' });

    expect(shouldSkipClaim(existing, manga)).toBe(true);
  });
});

describe('applyStatusGuard', () => {
  it('keeps complete under no-downgrade and allows it when off', () => {
    expect(applyStatusGuard('complete', 'progress', 'no-downgrade')).toBe('complete');
    expect(applyStatusGuard('complete', 'progress', 'off')).toBe('progress');
  });

  it('never blocks progress -> complete', () => {
    expect(applyStatusGuard('progress', 'complete', 'no-downgrade')).toBe('complete');
  });
});
