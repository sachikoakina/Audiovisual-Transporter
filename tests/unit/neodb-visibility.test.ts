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
});
