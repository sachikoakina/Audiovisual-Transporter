/**
 * Path ⑤'s year gate — the branch that decides whether the title-search level runs at all.
 * 链路⑤ 的年份闸门 —— 决定标题搜索那一级到底跑不跑的那个分支。
 *
 * Why this is its own file: the six known wrong writes all came through one line,
 * `pickExactTmdbMatch` treating a missing year as a pass. The behaviour that replaced it has two
 * halves, and both are tested here:
 *
 *   1. the NeoDB side now gets a year at all (the shelf payload never carries one, so it is fetched
 *      from the item's own `api_url` and cached per uuid);
 *   2. when no year can be had, the level is **skipped** rather than relaxed to "title only".
 *
 * 为什么单独一个文件：已知的六次错写全部经由同一行 —— `pickExactTmdbMatch` 把「没有年份」当成
 * 通过。取代它的行为有两半，都在这里测：
 *   1. NeoDB 这一侧终于能拿到年份（书架载荷从不带，所以从条目自身的 `api_url` 取并按 uuid 缓存）；
 *   2. 拿不到年份时，这一级**整级跳过**，而不是放宽成「只比标题」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the imports, so the paths they read must be hoisted too.
// `vi.mock` 的工厂会被提升到 import 之前，因此它读取的路径也必须一起提升。
const paths = vi.hoisted(() => ({ yearCache: '', state: '' }));

const fetchShelf = vi.fn();
const getNeodbItemDetail = vi.fn();
const searchTmdb = vi.fn();
const getTmdbById = vi.fn();
const getTmdbAccountStates = vi.fn();
const upsertReviewEntry = vi.fn();

vi.mock('../../src/clients/neodb-http', () => ({
  neodbToken: 'test-token',
  neodbThrottle: async () => {},
}));

vi.mock('../../src/clients/neodb-shelf', () => ({
  fetchShelf: (...args: unknown[]) => fetchShelf(...args),
  getNeodbMe: async () => ({ username: 'tester' }),
  verifyNeodbToken: async () => true,
}));

vi.mock('../../src/clients/neodb-catalog', () => ({
  getNeodbItemDetail: (...args: unknown[]) => getNeodbItemDetail(...args),
}));

vi.mock('../../src/clients/tmdb', () => ({
  findTmdbByImdbId: async () => [],
  getTmdbAccount: async () => ({ id: 1 }),
  getTmdbAccountStates: (...args: unknown[]) => getTmdbAccountStates(...args),
  getTmdbById: (...args: unknown[]) => getTmdbById(...args),
  resolveTmdbAuth: async () => ({ kind: 'session', sessionId: 'test' }),
  searchTmdb: (...args: unknown[]) => searchTmdb(...args),
  setTmdbRating: async () => true,
  setTmdbWatchlist: async () => true,
  targetKey: (target: { mediaType: string; id: number }) =>
    `${target.mediaType}:${target.id}`,
  tmdbThrottle: async () => {},
}));

vi.mock('../../src/sync-config', () => ({
  neodbTmdbConfig: {
    enabled: true,
    shelfTypes: ['complete'],
    categories: [],
    dryRun: false,
    maxItems: 200,
    ratingProfile: 'overwrite',
    yearTolerance: 1,
    incremental: false,
    fullSync: false,
    unmatchedLogFile: '',
    // Getters, not values: each test points them at its own temp files.
    // 用 getter 而不是值：每个用例把它们指向自己的临时文件。
    get stateFile() {
      return paths.state;
    },
    get itemYearCacheFile() {
      return paths.yearCache;
    },
    neodb: { baseUrl: 'https://neodb.social', requestDelayMs: 0, maxPages: 10 },
    tmdb: { apiKey: 'k', baseUrl: '', language: 'zh-CN', requestDelayMs: 0 },
  },
  describeNeodbTmdbConfig: () => 'test-config',
  resolveNeodbTmdbRunMode: (fullSync: boolean) => ({
    fullSync,
    maxItems: 200,
    maxPages: 10,
    incremental: false,
  }),
  resolveTargetCategories: () => ['movie'],
  validateNeodbTmdbCredentials: () => ({ ok: true, problems: [] }),
}));

// Partial: the year-cache helpers run for real (plain fs), only the review log is captured.
// 部分替换：年份缓存读写用真实现（就是普通 fs），只把留档写入换成捕获。
vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>();
  return {
    ...actual,
    upsertReviewEntry: (...args: unknown[]) => upsertReviewEntry(...args),
  };
});

vi.mock('../../src/sync-report', () => ({
  printPathSummary: () => {},
}));

const { default: runNeodbToTmdb } = await import('../../src/paths/neodb-to-tmdb');

/** One shelf mark around a catalogue item; the item's fields are what these tests vary. */
function mark(item: Record<string, unknown>): unknown {
  return {
    shelf_type: 'complete',
    rating_grade: 8,
    item: {
      id: '1',
      type: 'Movie',
      uuid: 'u1',
      url: 'https://neodb.social/movie/u1',
      api_url: '/api/movie/u1',
      category: 'movie',
      display_title: 'Poirot: The Lost Mine',
      title: 'Poirot: The Lost Mine',
      brief: '',
      description: '',
      cover_image_url: '',
      rating: 0,
      rating_count: 0,
      external_resources: [],
      ...item,
    },
  };
}

/** The archive entry `upsertReviewEntry` was last called with. / 留档写入最后一次拿到的条目。 */
function lastReviewEntry(): Record<string, unknown> {
  const calls = upsertReviewEntry.mock.calls;
  return (calls[calls.length - 1]?.[1] ?? {}) as Record<string, unknown>;
}

let dir = '';

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neodb-year-'));
  paths.yearCache = path.join(dir, 'years.json');
  paths.state = path.join(dir, 'state.json');
  upsertReviewEntry.mockReturnValue(true);
  fetchShelf.mockResolvedValue([]);
  // `ReadResult`, not a bare object: the path passes this through `readValueOrThrow`, which is what
  // makes "could not read" distinct from "nothing on TMDB yet".
  // 是 `ReadResult` 而不是裸对象：链路要把它交给 `readValueOrThrow`，那个区分「读不到」与
  // 「TMDB 上还没有」的地方。
  getTmdbAccountStates.mockResolvedValue({
    status: 'found',
    value: { id: 1, favorite: false, watchlist: false, rated: false },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  paths.yearCache = '';
  paths.state = '';
});

describe('⑤ year resolution / ⑤ 的年份解析', () => {
  it('uses the year the shelf payload already carries, and never asks the catalogue', async () => {
    fetchShelf.mockResolvedValue([mark({ year: 1990 })]);
    searchTmdb.mockResolvedValue([]);

    const report = await runNeodbToTmdb(false);

    // The whole point of checking `item.year` first: a shelf that does carry it costs nothing extra.
    // 先看 `item.year` 的全部意义：带了年份的书架不产生任何额外请求。
    expect(getNeodbItemDetail).not.toHaveBeenCalled();
    expect(searchTmdb).toHaveBeenCalledWith('movie', 'Poirot: The Lost Mine', 1990);
    expect(report.unresolved).toBe(1);
  });

  it('fetches the year from `api_url` when the shelf payload has none, and caches it', async () => {
    fetchShelf.mockResolvedValue([mark({})]);
    getNeodbItemDetail.mockResolvedValue({ uuid: 'u1', year: 1990 });
    searchTmdb.mockResolvedValue([]);

    await runNeodbToTmdb(false);

    expect(getNeodbItemDetail).toHaveBeenCalledTimes(1);
    expect(getNeodbItemDetail).toHaveBeenCalledWith('/api/movie/u1');
    expect(searchTmdb).toHaveBeenCalledWith('movie', 'Poirot: The Lost Mine', 1990);
    // The cache is what keeps the next run free; without it every run pays again.
    // 缓存是下一轮免费的原因；没有它，每轮都要再付一次。
    const saved = JSON.parse(fs.readFileSync(paths.yearCache, 'utf8'));
    expect(saved.years).toEqual({ u1: 1990 });
    expect(saved.version).toBe(1);
  });

  it('reuses a cached year instead of asking the catalogue again', async () => {
    fs.writeFileSync(
      paths.yearCache,
      JSON.stringify({ version: 1, updatedAt: '', years: { u1: 1990 } }),
    );
    fetchShelf.mockResolvedValue([mark({})]);
    searchTmdb.mockResolvedValue([]);

    await runNeodbToTmdb(false);

    expect(getNeodbItemDetail).not.toHaveBeenCalled();
    expect(searchTmdb).toHaveBeenCalledWith('movie', 'Poirot: The Lost Mine', 1990);
  });
});

describe('⑤ no year means no title search / ⑤ 没有年份就不搜标题', () => {
  it('skips the search entirely when the catalogue has no year for the item', async () => {
    fetchShelf.mockResolvedValue([mark({})]);
    getNeodbItemDetail.mockResolvedValue({ uuid: 'u1' });

    const report = await runNeodbToTmdb(false);

    // The one assertion that matters: no request went to TMDB's search endpoint.
    // 唯一重要的断言：一次请求都没发到 TMDB 的搜索端点上。
    expect(searchTmdb).not.toHaveBeenCalled();
    expect(report.unresolved).toBe(1);
    expect(lastReviewEntry().reason).toBe('no-neodb-year');
  });

  it('separates a failed catalogue read from a real gap', async () => {
    fetchShelf.mockResolvedValue([mark({})]);
    getNeodbItemDetail.mockResolvedValue(null); // the request itself failed

    const report = await runNeodbToTmdb(false);

    expect(searchTmdb).not.toHaveBeenCalled();
    expect(report.unresolved).toBe(1);
    // An outage must not be filed as "TMDB has no counterpart": the fix for each is different.
    // 故障不能被记成「TMDB 没有对应物」：两者的处置方式完全不同。
    expect(lastReviewEntry().reason).toBe('no-neodb-year-fetch-failed');
  });

  it('rejects a same-title, wrong-decade candidate (the 矿藏之谜 case)', async () => {
    fetchShelf.mockResolvedValue([
      mark({ year: 1990, display_title: '矿藏之谜', title: '矿藏之谜' }),
    ]);
    searchTmdb.mockResolvedValue([
      { id: 323208, title: '矿藏之谜', release_date: '1959-09-01' },
    ]);

    const report = await runNeodbToTmdb(false);

    // 31 years apart — the arithmetic that never used to run.
    // 相差 31 年 —— 那行以前从未被执行的算术。
    expect(report.unresolved).toBe(1);
    expect(getTmdbAccountStates).not.toHaveBeenCalled();
    expect(lastReviewEntry().reason).toBe('no-tmdb-match');
  });
});
