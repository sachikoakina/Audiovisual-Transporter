/**
 * The two ⑤ caps: defaults and user overrides.
 * ⑤ 的两道上限：默认值与用户覆盖。
 *
 * `SYNC_MAX_ITEMS` is a shelf×category budget and `NEODB_MAX_PAGES` a per-combination page budget.
 * Both are read from Repository variables in CI, so the contract that matters is "user value wins,
 * absent/invalid falls back to the documented default".
 * `SYNC_MAX_ITEMS` 是书架×分类的条目预算，`NEODB_MAX_PAGES` 是每个组合的分页预算。CI 里两者都来自
 * Repository variables，因此真正要守的契约是「用户值优先，缺失/非法回落文档默认值」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const CAP_KEYS = ['SYNC_MAX_ITEMS', 'NEODB_MAX_PAGES'] as const;

async function loadConfig(env: Partial<Record<(typeof CAP_KEYS)[number], string>>) {
  for (const key of CAP_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../src/sync-config');
}

afterEach(() => {
  for (const key of CAP_KEYS) {
    delete process.env[key];
  }
});

describe('⑤ caps — defaults', () => {
  it('defaults to 50 items per shelf×category and 10 pages per combination', async () => {
    const config = await loadConfig({});

    expect(config.neodbTmdbConfig.maxItems).toBe(50);
    expect(config.neodbConfig.maxPages).toBe(10);
  });
});

describe('⑤ caps — user overrides', () => {
  it('lets Repository variables win over the defaults', async () => {
    const config = await loadConfig({ SYNC_MAX_ITEMS: '5', NEODB_MAX_PAGES: '3' });

    expect(config.neodbTmdbConfig.maxItems).toBe(5);
    expect(config.neodbConfig.maxPages).toBe(3);
  });

  it('falls back to the defaults for empty, zero or non-numeric values', async () => {
    for (const value of ['', '0', 'abc', '-1']) {
      const config = await loadConfig({ SYNC_MAX_ITEMS: value });
      expect(config.neodbTmdbConfig.maxItems, value).toBe(50);
    }
    for (const value of ['', '0', 'abc', '-1']) {
      const config = await loadConfig({ NEODB_MAX_PAGES: value });
      expect(config.neodbConfig.maxPages, value).toBe(10);
    }
  });
});
