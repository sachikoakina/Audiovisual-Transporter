/**
 * Mark-time policies: status / initial-source / always-source.
 * 标记时间策略：status / initial-source / always-source。
 */
import { describe, expect, it } from 'vitest';
import { normalizeMarkTime, planNeodbMarkTime } from '../../src/rules/neodb-mark-time';

const SOURCE = '2026-01-01T00:00:00Z';
const TARGET = '2024-01-01T00:00:00Z';

describe('normalizeMarkTime', () => {
  it('normalizes an offset timestamp to UTC', () => {
    expect(normalizeMarkTime('2026-01-01T00:00:00+08:00')).toBe(
      '2025-12-31T16:00:00.000Z',
    );
  });

  it('rejects empty and invalid values', () => {
    expect(normalizeMarkTime('')).toBeUndefined();
    expect(normalizeMarkTime('not-a-date')).toBeUndefined();
    expect(normalizeMarkTime(undefined)).toBeUndefined();
  });
});

describe('planNeodbMarkTime', () => {
  it('seeds every policy from the source when the mark is new', () => {
    for (const policy of ['status', 'initial-source', 'always-source'] as const) {
      expect(
        planNeodbMarkTime({
          policy,
          isNew: true,
          statusChanged: true,
          sourceRaw: SOURCE,
        }),
      ).toEqual({
        markTime: '2026-01-01T00:00:00.000Z',
        reason: 'new',
      });
    }
  });

  it('status keeps the target time while the status is unchanged', () => {
    expect(
      planNeodbMarkTime({
        policy: 'status',
        isNew: false,
        statusChanged: false,
        sourceRaw: SOURCE,
        targetRaw: TARGET,
      }),
    ).toEqual({
      markTime: '2024-01-01T00:00:00.000Z',
      reason: 'same-status',
    });
  });

  it('status uses the source time when the status changes', () => {
    expect(
      planNeodbMarkTime({
        policy: 'status',
        isNew: false,
        statusChanged: true,
        sourceRaw: SOURCE,
        targetRaw: TARGET,
      }),
    ).toEqual({
      markTime: '2026-01-01T00:00:00.000Z',
      reason: 'status-changed',
    });
  });

  it('initial-source always keeps the target time after creation', () => {
    expect(
      planNeodbMarkTime({
        policy: 'initial-source',
        isNew: false,
        statusChanged: true,
        sourceRaw: SOURCE,
        targetRaw: TARGET,
      }),
    ).toEqual({
      markTime: '2024-01-01T00:00:00.000Z',
      reason: 'initial-source',
    });
  });

  it('always-source uses the source time even when the status is unchanged', () => {
    expect(
      planNeodbMarkTime({
        policy: 'always-source',
        isNew: false,
        statusChanged: false,
        sourceRaw: SOURCE,
        targetRaw: TARGET,
      }),
    ).toEqual({
      markTime: '2026-01-01T00:00:00.000Z',
      reason: 'always-source',
    });
  });

  it('omits a missing target time instead of backfilling it', () => {
    expect(
      planNeodbMarkTime({
        policy: 'status',
        isNew: false,
        statusChanged: false,
        sourceRaw: SOURCE,
      }),
    ).toEqual({ reason: 'missing' });
  });

  it('never invents a time when the source is invalid', () => {
    expect(
      planNeodbMarkTime({
        policy: 'status',
        isNew: false,
        statusChanged: true,
        sourceRaw: 'bad',
        targetRaw: TARGET,
      }),
    ).toEqual({ reason: 'missing' });
  });
});
