import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'SYNC_DOUBAN_BANGUMI_VISIBILITY',
  'SYNC_BANGUMI_NEODB_STATUS_GUARD',
] as const;

async function loadConfig() {
  vi.resetModules();
  return import('../../src/sync-config');
}

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

describe('strict config parsers / 严格配置解析', () => {
  it('accepts only the literal true for Bangumi visibility', async () => {
    process.env.SYNC_DOUBAN_BANGUMI_VISIBILITY = '1';
    expect((await loadConfig()).syncConfig.doubanBangumiPrivate).toBe(false);

    process.env.SYNC_DOUBAN_BANGUMI_VISIBILITY = 'true';
    expect((await loadConfig()).syncConfig.doubanBangumiPrivate).toBe(true);
  });

  it('keeps the documented status guard values and falls back to off', async () => {
    process.env.SYNC_BANGUMI_NEODB_STATUS_GUARD = 'no-downgrade';
    expect((await loadConfig()).syncConfig.bangumiNeodbStatusGuard).toBe(
      'no-downgrade',
    );

    process.env.SYNC_BANGUMI_NEODB_STATUS_GUARD = 'on';
    expect((await loadConfig()).syncConfig.bangumiNeodbStatusGuard).toBe('off');
  });
});
