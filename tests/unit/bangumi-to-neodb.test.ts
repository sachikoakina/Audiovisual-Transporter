/**
 * Path ④, driven end to end with client doubles — the layer where three review rounds' worth of
 * defects actually lived.
 * 链路④，用客户端替身端到端驱动 —— 三轮评审里那些缺陷真正居住的那一层。
 *
 * The three cases below are the three ways `syncCollectionToNeodb` can end, and they are the
 * three that were wrong at some point in this repo's history:
 *
 *   1. NeoDB refuses the write → the item must be `failed`, with a detail, and the self-check
 *      must still add up (`611f3f3`).
 *   2. The read fails for one item → **nothing is written** and the item is `failed`
 *      (`b35595b`, the fail-closed rule).
 *   3. The read fails on credentials → the path aborts instead of failing every remaining item
 *      (`b35595b`, the `auth` scope).
 *
 * 下面三种情形就是 `syncCollectionToNeodb` 的全部出口，也正是本仓库历史上各自出过错的那三种：
 *   1. NeoDB 拒绝写入 → 该条必须 `failed` 且有明细，且自检仍然对得上（`611f3f3`）。
 *   2. 单条读取失败 → **什么都不写**，该条计入 `failed`（`b35595b` 的 fail-closed 规则）。
 *   3. 凭据读取失败 → 整条链路 abort，而不是让剩下每一条都失败一遍（`b35595b` 的 `auth`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listBangumiCollections = vi.fn();
const markNeodbItem = vi.fn();
const getNeodbMark = vi.fn();
const resolveNeodbItemForBangumiUrl = vi.fn();

vi.mock('../../src/clients/bangumi', () => ({
  bangumiCollectionLimit: 50,
  bangumiSubjectUrl: (id: number) => `https://bgm.tv/subject/${id}`,
  bangumiThrottle: async () => {},
  bangumiToken: 'test-token',
  getBangumiMe: async () => ({ username: 'tester' }),
  getBangumiSubject: async () => ({ status: 'found', value: { platform: '漫画' } }),
  listBangumiCollections: (...args: unknown[]) => listBangumiCollections(...args),
  searchBangumiSubjects: async () => [],
  pickExactBangumiMatch: () => null,
  upsertBangumiCollection: async () => true,
  bangumiPrivate: false,
}));

vi.mock('../../src/clients/neodb-http', () => ({
  neodbToken: 'test-token',
  neodbVisibility: 0,
}));

vi.mock('../../src/clients/neodb-catalog', () => ({
  resolveNeodbItemForBangumiUrl: (...args: unknown[]) =>
    resolveNeodbItemForBangumiUrl(...args),
}));

vi.mock('../../src/clients/neodb-shelf', () => ({
  getNeodbMark: (...args: unknown[]) => getNeodbMark(...args),
  markNeodbItem: (...args: unknown[]) => markNeodbItem(...args),
  getNeodbProgress: async () => null,
  setNeodbProgress: async () => false,
}));

vi.mock('../../src/sync-config', () => ({
  unmatchedLogFile: '',
  syncConfig: {
    bangumiNeodbCategories: { mode: 'all' },
    bangumiNeodbMerge: 'neodb_prefer',
    bangumiNeodbProgress: false,
  },
  bangumiSubjectTypesForAllowlist: () => undefined,
  needsBangumiMangaPlatformCheck: () => false,
}));

vi.mock('../../src/utils', () => ({
  upsertReviewEntry: () => false,
}));

vi.mock('../../src/sync-report', () => ({
  printPathSummary: () => {},
}));

const { default: syncBangumiToNeodb } =
  await import('../../src/paths/bangumi-to-neodb');

const collection = {
  subject_id: 12345,
  subject_type: 2,
  rate: 8,
  type: 2,
  comment: '好看',
  updated_at: '2026-01-01T00:00:00Z',
  private: false,
  subject: { id: 12345, type: 2, name: 'Title', name_cn: '标题' },
};

/** The value `printPathSummary` checks: the five buckets must partition `scanned`. */
function selfCheckHolds(report: {
  scanned: number;
  written: number;
  unchanged: number;
  skipped: number;
  unresolved: number;
  failed: number;
}): boolean {
  return (
    report.written +
      report.unchanged +
      report.skipped +
      report.unresolved +
      report.failed ===
    report.scanned
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listBangumiCollections.mockResolvedValue({ total: 1, data: [collection] });
  resolveNeodbItemForBangumiUrl.mockResolvedValue({
    uuid: 'uuid-1',
    title: '标题',
    display_title: '标题',
  });
});

describe('④ Bangumi → NeoDB', () => {
  it('counts a refused mark as failed, names it, and keeps the self-check honest', async () => {
    getNeodbMark.mockResolvedValue({ status: 'absent' });
    markNeodbItem.mockResolvedValue(false); // NeoDB said no

    const report = await syncBangumiToNeodb(false);

    expect(report.failed).toBe(1);
    expect(report.written).toBe(0);
    expect(report.failedItems).toHaveLength(1);
    expect(report.failedItems[0].reason).toContain('NeoDB rejected the new mark');
    expect(selfCheckHolds(report)).toBe(true);
  });

  it('writes nothing when the mark cannot be read (fail-closed, not "not marked yet")', async () => {
    getNeodbMark.mockResolvedValue({ status: 'error', scope: 'item', message: '500' });

    const report = await syncBangumiToNeodb(false);

    // The write is the assertion: a failed read must never reach `markNeodbItem`.
    // 关键断言在写入上：读取失败绝不能走到 `markNeodbItem`。
    expect(markNeodbItem).not.toHaveBeenCalled();
    expect(report.failed).toBe(1);
    expect(report.written).toBe(0);
    expect(report.failedItems[0].reason).toBe('item-threw: NeoDB mark: 500');
    expect(selfCheckHolds(report)).toBe(true);
  });

  it('aborts the path on a credential failure instead of failing every item', async () => {
    getNeodbMark.mockResolvedValue({ status: 'error', scope: 'auth', message: '401' });

    const report = await syncBangumiToNeodb(false);

    expect(report.aborted).toBe(true);
    // Stopped after the first page: one page request, not one per item, and no writes at all.
    // 停在第一页之后：只请求一次分页，按条目不重复请求，且一条都没写。
    expect(listBangumiCollections).toHaveBeenCalledTimes(1);
    expect(markNeodbItem).not.toHaveBeenCalled();
    expect(report.failed).toBe(0);
  });
});
