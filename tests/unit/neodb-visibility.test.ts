import { describe, expect, it } from 'vitest';
import { planNeodbVisibility } from '../../src/rules/neodb-visibility';

describe('planNeodbVisibility', () => {
  it('uses the configured target value in target mode', () => {
    expect(
      planNeodbVisibility({
        mode: 'target',
        targetVisibility: 2,
        sourcePrivate: false,
      }),
    ).toEqual({ visibility: 2, reason: 'target' });
  });

  it('maps source private to private in source mode', () => {
    expect(
      planNeodbVisibility({
        mode: 'source',
        targetVisibility: 0,
        sourcePrivate: true,
      }),
    ).toEqual({ visibility: 2, reason: 'source-private' });
  });

  it('maps source public to public in source mode', () => {
    expect(
      planNeodbVisibility({
        mode: 'source',
        targetVisibility: 2,
        sourcePrivate: false,
      }),
    ).toEqual({ visibility: 0, reason: 'source-public' });
  });

  it('keeps the existing visibility when the source is missing', () => {
    expect(
      planNeodbVisibility({
        mode: 'source',
        targetVisibility: 2,
        existingVisibility: 1,
      }),
    ).toEqual({ visibility: 1, reason: 'source-missing' });
  });

  it('clamps an out-of-range existing visibility to the configured target', () => {
    // A non-compliant instance could echo 5 (or -1) as `visibility`; echoing it straight back
    // would make the next visibility-only write carry the same out-of-range value.
    // 不合规实例可能把 5（或 -1）当 `visibility` 返回；原样回显会让下一次仅可见性写回
    // 带上同样的越界值。
    expect(
      planNeodbVisibility({
        mode: 'source',
        targetVisibility: 2,
        existingVisibility: 5,
      }),
    ).toEqual({ visibility: 2, reason: 'source-missing' });
  });
});
