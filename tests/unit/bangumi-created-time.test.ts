/**
 * `created_time` mode: target keeps NeoDB, source uses Bangumi, source-newer only moves forward.
 * `created_time` 模式：target 保留 NeoDB，source 用 Bangumi，source-newer 只向前移动。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeCreatedTime,
  resolveCreatedTime,
} from '../../src/rules/bangumi-created-time';

describe('normalizeCreatedTime', () => {
  it('normalizes an offset timestamp to UTC', () => {
    expect(normalizeCreatedTime('2026-01-01T00:00:00+08:00')).toBe(
      '2025-12-31T16:00:00.000Z',
    );
  });

  it('rejects empty and invalid values', () => {
    expect(normalizeCreatedTime('')).toBeUndefined();
    expect(normalizeCreatedTime('not-a-date')).toBeUndefined();
    expect(normalizeCreatedTime(undefined)).toBeUndefined();
  });
});

describe('resolveCreatedTime', () => {
  const source = '2026-01-01T00:00:00Z';
  const olderTarget = '2024-01-01T00:00:00Z';

  it('seeds a new mark from Bangumi in every mode', () => {
    for (const mode of ['target', 'source', 'source-newer'] as const) {
      expect(resolveCreatedTime({ mode, isNew: true, sourceRaw: source })).toBe(
        '2026-01-01T00:00:00.000Z',
      );
    }
  });

  it('keeps the target date for existing marks in target mode', () => {
    expect(
      resolveCreatedTime({
        mode: 'target',
        isNew: false,
        sourceRaw: source,
        targetRaw: olderTarget,
      }),
    ).toBeUndefined();
  });

  it('uses the source date in source mode', () => {
    expect(
      resolveCreatedTime({
        mode: 'source',
        isNew: false,
        sourceRaw: source,
        targetRaw: olderTarget,
      }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('only moves forward in source-newer mode', () => {
    expect(
      resolveCreatedTime({
        mode: 'source-newer',
        isNew: false,
        sourceRaw: source,
        targetRaw: olderTarget,
      }),
    ).toBe('2026-01-01T00:00:00.000Z');
    expect(
      resolveCreatedTime({
        mode: 'source-newer',
        isNew: false,
        sourceRaw: olderTarget,
        targetRaw: source,
      }),
    ).toBeUndefined();
    expect(
      resolveCreatedTime({
        mode: 'source-newer',
        isNew: false,
        sourceRaw: source,
        targetRaw: source,
      }),
    ).toBeUndefined();
  });

  it('falls back to source when the target date is missing or invalid', () => {
    expect(
      resolveCreatedTime({
        mode: 'source-newer',
        isNew: false,
        sourceRaw: source,
        targetRaw: 'bad',
      }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not invent a date when the source is invalid', () => {
    expect(
      resolveCreatedTime({
        mode: 'source',
        isNew: false,
        sourceRaw: 'bad',
        targetRaw: olderTarget,
      }),
    ).toBeUndefined();
  });
});
