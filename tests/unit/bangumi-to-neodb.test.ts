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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the imports, so the path they read has to be hoisted too.
// `vi.mock` 的工厂会被提升到 import 之前，因此它读取的路径也必须一起提升。
const cursorPath = vi.hoisted(() => ({ value: '' }));

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
    // A getter, not a value: each test points it at its own temp file.
    // 用 getter 而不是值：每个用例把它指向自己的临时文件。
    get bangumiFullSyncState() {
      return cursorPath.value;
    },
  },
  bangumiSubjectTypesForAllowlist: () => undefined,
  needsBangumiMangaPlatformCheck: () => false,
}));

// Partial: the cursor helpers run for real (they are plain fs), only the review log is stubbed.
// 部分替换：游标读写用真实现（就是普通 fs 调用），只有留档日志被替换。
vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>();
  return { ...actual, upsertReviewEntry: () => false };
});

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

describe('④ full-sync cursor / 全量游标', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-cursor-'));
    cursorPath.value = path.join(dir, 'cursor.json');
    getNeodbMark.mockResolvedValue({ status: 'absent' });
    markNeodbItem.mockResolvedValue(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    cursorPath.value = '';
  });

  it('resumes a full walk at the stored offset instead of starting at the head', async () => {
    fs.writeFileSync(
      cursorPath.value,
      JSON.stringify({ version: 1, updatedAt: '', offsets: { mixed: 50 } }),
    );

    await syncBangumiToNeodb(true);

    // The first request is the assertion: a resumed walk must not re-read the first page.
    // 关键断言在第一个请求上：续跑的全量不该重读第一页。
    expect(listBangumiCollections.mock.calls[0][0]).toMatchObject({ offset: 50 });
  });

  it('ignores the cursor for a capped run, whose window is the newest page', async () => {
    fs.writeFileSync(
      cursorPath.value,
      JSON.stringify({ version: 1, updatedAt: '', offsets: { mixed: 50 } }),
    );

    await syncBangumiToNeodb(false);

    // A cron run must always start at the head — honouring a stale cursor there would hide the
    // new marks the run exists to catch.
    // 常规运行必须永远从头部开始 —— 在那里沿用旧游标会藏掉这一轮本来要抓的新标记。
    expect(listBangumiCollections.mock.calls[0][0]).toMatchObject({ offset: 0 });
  });

  it('advances the offset page by page, then drops the pass cursor at the end', async () => {
    listBangumiCollections.mockResolvedValue({ total: 3, data: [collection] });

    await syncBangumiToNeodb(true);

    expect(listBangumiCollections.mock.calls.map((call) => call[0].offset)).toEqual([
      0, 1, 2,
    ]);
    // One page was left over after each of the first two; the third reached the total and cleared
    // the key, so the next full run starts from the head again.
    // 前两页各留下一格进度；第三页走完即清键，下一次全量从头部重新开始。
    const saved = JSON.parse(fs.readFileSync(cursorPath.value, 'utf8'));
    expect(saved.offsets).toEqual({});
    expect(saved.version).toBe(1);
  });
});

describe('④ cursor past the end / 游标指到末尾之外', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-cursor-'));
    cursorPath.value = path.join(dir, 'cursor.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    cursorPath.value = '';
  });

  it('drops a cursor that points past the last page, so the walk is not a permanent no-op', async () => {
    fs.writeFileSync(
      cursorPath.value,
      JSON.stringify({ version: 1, updatedAt: '', offsets: { mixed: 100 } }),
    );
    // The shelf shrank (or the kill landed mid-page): one request, no data.
    // 书架变短了（或中断正好落在页中）：一次请求，没有数据。
    listBangumiCollections.mockResolvedValue({ total: 3, data: [] });

    const report = await syncBangumiToNeodb(true);

    expect(listBangumiCollections.mock.calls).toHaveLength(1);
    expect(report.failed).toBe(0);
    const saved = JSON.parse(fs.readFileSync(cursorPath.value, 'utf8'));
    expect(saved.offsets).toEqual({});
  });
});
