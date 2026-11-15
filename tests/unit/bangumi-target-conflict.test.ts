/**
 * Pure conflict rules: status beats status, and a guard only protects an existing complete mark.
 * 纯冲突规则：状态等级裁决；guard 只保护目标端已有的“看过”。
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
    collectionType: 2,
    ...over,
  };
}

describe('compareClaims', () => {
  it('ranks complete over progress', () => {
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
    const weaker = claim({ subjectId: 2, collectionType: 3 });

    expect(shouldSkipClaim(existing, weaker)).toBe(true);
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
