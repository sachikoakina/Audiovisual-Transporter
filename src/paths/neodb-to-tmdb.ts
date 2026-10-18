/**
 * Path ⑤ — NeoDB shelf → TMDB.
 * 链路⑤ —— NeoDB 书架 → TMDB。
 *
 * The only path whose source is NeoDB's own shelf rather than the Douban RSS feed, which is why
 * it runs last and independently: nothing above it can change how it behaves.
 * 这是唯一以 NeoDB 自身书架（而非豆瓣 RSS）为数据源的链路，因此它最后独立执行：它上面的任何链路
 * 都不会改变它的行为。
 *
 * Read the mapping table in `rules/tmdb-mapping.ts` before changing anything here — it is the
 * single source of truth for what this path does. Also worth knowing:
 *   - every write is preceded by a read (`getTmdbAccountStates`), which is what makes it idempotent;
 *   - `SYNC_DRY_RUN=1` prints the plan and issues no writes at all, so it is safe to run repeatedly;
 *   - `fullSync` (env `NEODB_TMDB_FULL_SYNC`, or the dedicated full entry) lifts `SYNC_MAX_ITEMS`
 *     and `NEODB_MAX_PAGES` and turns incremental off for that run; the shelf and category
 *     selections still apply — "full" means "no per-run truncation", not "ignore your filters";
 *   - matching failures are recorded as `unresolved`, not `failed` — a missing counterpart on TMDB
 *     is a data gap, not an error, and must not turn CI red.
 *
 * 改动这里之前请先读 `rules/tmdb-mapping.ts` 的映射表 —— 它是本链路行为的唯一真源。另外值得知道：
 *   - 每次写入之前都先读一次（`getTmdbAccountStates`），这正是它幂等的来源；
 *   - `SYNC_DRY_RUN=1` 只打印计划、完全不写入，因此可以反复运行；
 *   - `fullSync`（环境变量 `NEODB_TMDB_FULL_SYNC`，或专用的全量入口）在该次运行中取消
 *     `SYNC_MAX_ITEMS` 与 `NEODB_MAX_PAGES` 并关闭增量；书架与分类的选择仍然生效 ——
 *     「全量」指的是「单轮不截断」，不是「无视你的过滤条件」；
 *   - 匹配失败记为 `unresolved` 而不是 `failed` —— TMDB 没有对应条目是数据缺口，不是错误，
 *     不应让 CI 变红。
 */
import { consola } from 'consola';
import {
  NEODB_CATEGORIES_WITHOUT_TMDB,
  NEODB_TO_TMDB_MEDIA_TYPE,
  collectTitles,
  extractImdbIdFromNeodb,
  extractNeodbYear,
  extractTmdbTargetFromNeodb,
  resolveTmdbOperations,
  toShelfType,
} from '../rules/tmdb-mapping';
import { pickExactTmdbMatch } from '../rules/tmdb-matching';
import {
  neodbTmdbConfig,
  describeNeodbTmdbConfig,
  resolveNeodbTmdbRunMode,
  resolveTargetCategories,
  validateNeodbTmdbCredentials,
  type NeodbTmdbRunMode,
} from '../sync-config';
import { neodbThrottle } from '../clients/neodb-http';
import { fetchShelf, getNeodbMe, verifyNeodbToken } from '../clients/neodb-shelf';
import {
  findTmdbByImdbId,
  getTmdbAccount,
  getTmdbAccountStates,
  getTmdbById,
  targetKey,
  resolveTmdbAuth,
  searchTmdb,
  setTmdbRating,
  setTmdbWatchlist,
  tmdbThrottle,
  type TmdbAuth,
} from '../clients/tmdb';
import { planTmdbWrites, type TmdbPatch } from '../rules/tmdb-write-plan';
import {
  fingerprintMark,
  readState,
  stateKey,
  upsertReviewEntry,
  writeState,
  type SyncState,
} from '../utils';
import {
  newPathReport,
  newSyncCounters,
  pathHasFailed,
  type NeodbShelfMark,
  type PathReport,
  type ShelfType,
  type SyncCounters,
  type TmdbMediaType,
  type TmdbTarget,
} from '../types';
import { printPathSummary } from '../sync-report';

const LABEL = 'NeoDB → TMDB';

type SyncContext = {
  /** Effective limits for this run, full-sync intent already folded in. / 本次运行的实际上限，全量意图已折算。 */
  mode: NeodbTmdbRunMode;
  auth: TmdbAuth;
  accountId: number;
  /** `${mediaType}:${id}` seen this run, to dedupe across shelves/categories. */
  seen: Set<string>;
  counters: SyncCounters;
  state: SyncState;
  stateDirty: boolean;
  /**
   * `SYNC_MAX_ITEMS` cut the run short; more items remain unwalked and roll over to the next run.
   *
   * `SYNC_MAX_ITEMS` 提前中止了本轮；仍有条目未走到，顺延到下一轮。
   */
  capped: boolean;
  /** Labels of unmatched items, in encounter order, for the closing listing. */
  unmatchedTitles: string[];
};

// ───────────────────────────────────────────────────────────────────────────

/**
 * NeoDB shelf → TMDB, one-way.
 *
 * Each mark is resolved through `resolveTmdbOperations` (see mapping.ts) into a plan, then diffed
 * against the live TMDB state so that re-running is always safe. Nothing here encodes mapping
 * knowledge.
 *
 * `fullSync` lifts `SYNC_MAX_ITEMS` / `NEODB_MAX_PAGES` and skips the incremental store for this
 * run. It defaults to the `NEODB_TMDB_FULL_SYNC` switch, so `index.ts` needs no argument; the
 * dedicated full entry passes `true` explicitly, which wins over the environment.
 *
 * 单向的 NeoDB 书架 → TMDB。
 *
 * 每条标记都先经 `resolveTmdbOperations`（见 mapping.ts）解析成计划，再与 TMDB 的实时状态做差分，
 * 因此重复运行始终安全。这里不包含任何映射知识。
 *
 * `fullSync` 在本次运行中取消 `SYNC_MAX_ITEMS` / `NEODB_MAX_PAGES` 并跳过增量存储。默认取
 * `NEODB_TMDB_FULL_SYNC` 开关，因此 `index.ts` 无需传参；专用的全量入口显式传入 `true`，
 * 优先级高于环境变量。
 *
 * @returns a report of what happened. The caller decides the exit code from it (`pathHasFailed`),
 *   and `index.ts` folds it into the closing summary.
 */
export default async function runNeodbToTmdb(
  fullSync: boolean = neodbTmdbConfig.fullSync,
): Promise<PathReport> {
  const report = newPathReport(LABEL);
  const mode = resolveNeodbTmdbRunMode(fullSync);

  consola.info('NeoDB → TMDB sync: ', describeNeodbTmdbConfig(mode));

  const credentials = validateNeodbTmdbCredentials();
  if (!credentials.ok) {
    for (const problem of credentials.problems) {
      consola.error(problem);
    }
    report.aborted = true;
    return report;
  }

  const me = await getNeodbMe();
  if (!(await verifyNeodbToken())) {
    report.aborted = true;
    return report;
  }
  consola.info(`NeoDB account: ${me?.username ?? '(unknown)'}`);

  const auth = await resolveTmdbAuth();
  if (!auth) {
    consola.error(
      'No usable TMDB credential. Provide TMDB_SESSION_ID, or a user-scoped TMDB_ACCESS_TOKEN.',
    );
    report.aborted = true;
    return report;
  }

  const account = await getTmdbAccount(auth);
  if (!account?.id) {
    consola.error('Could not resolve the TMDB account id.');
    report.aborted = true;
    return report;
  }

  const ctx: SyncContext = {
    mode,
    auth,
    accountId: account.id,
    seen: new Set<string>(),
    counters: newSyncCounters(),
    // Read through the *resolved* mode: a full run must not consult (or update) the store, even
    // when `SYNC_INCREMENTAL` happens to be on in the environment.
    // 用**折算后**的 mode 判断：全量运行不读也不写增量存储，即使环境里 `SYNC_INCREMENTAL` 是开的。
    state: mode.incremental
      ? readState(neodbTmdbConfig.stateFile)
      : { version: 1, updatedAt: '', synced: {} },
    stateDirty: false,
    capped: false,
    unmatchedTitles: [],
  };

  for (const shelfType of neodbTmdbConfig.shelfTypes) {
    await syncShelf(shelfType, ctx);
  }

  if (ctx.stateDirty && !neodbTmdbConfig.dryRun) {
    writeState(neodbTmdbConfig.stateFile, ctx.state);
  }

  fillReport(report, ctx);
  printCounterBreakdown(ctx);
  printPathSummary(report);

  if (pathHasFailed(report)) {
    consola.error('NeoDB → TMDB finished with errors.');
  } else {
    consola.success('NeoDB → TMDB finished.');
  }

  return report;
}

/** Fold the fine-grained counters into the shape the summary prints. */
function fillReport(report: PathReport, ctx: SyncContext): void {
  const c = ctx.counters;
  report.scanned = c.scanned;
  report.written = c.writtenRating + c.writtenWatchlist;
  report.unchanged = c.unchanged;
  report.skipped =
    c.skippedCategory + c.skippedShelf + c.skippedCached + c.skippedDuplicate;
  report.unresolved = c.unmatched;
  report.failed = c.failed;
  report.capped = ctx.capped;
  report.unresolvedTitles = [...ctx.unmatchedTitles];
  report.reviewLog = c.unmatched > 0 ? neodbTmdbConfig.unmatchedLog : '';
}

// ───────────────────────────────────────────────────────────────────────────

async function syncShelf(shelfType: ShelfType, ctx: SyncContext): Promise<void> {
  consola.start(`Shelf "${shelfType}"`);

  for (const category of resolveTargetCategories()) {
    const marks = await fetchShelf(shelfType, category, ctx.mode.maxPages);
    consola.info(`  ${shelfType}/${category}: ${marks.length} mark(s).`);

    for (const mark of marks) {
      // The cap counts items that reached TMDB (`processed`), not marks walked (`scanned`):
      // counting `scanned` lets unchanged marks at the head of a shelf fill the quota without any
      // of them being processed, so an incremental run would never get past them.
      // Full mode sets `maxItems` to Infinity, so this branch never fires there.
      //
      // 配额计的是真正进入 TMDB 的条数（`processed`），不是走过的标记数（`scanned`）：用 `scanned`
      // 会让书架头部那些「未变化」的标记在一条都没被处理的情况下吃满配额，增量运行永远推不过它们。
      // 全量模式把 `maxItems` 设为 Infinity，因此这里不会触发。
      if (ctx.counters.processed >= ctx.mode.maxItems) {
        // Warn once: every remaining shelf hits the same wall, and repeating the message for each
        // of them would bury the number that explains what happened.
        // 只警告一次：其余书架会撞到同一面墙，逐个重复只会把解释原因的那个数字淹没。
        if (!ctx.capped) {
          ctx.capped = true;
          consola.warn(
            `Reached SYNC_MAX_ITEMS (${ctx.mode.maxItems}) after ${ctx.counters.processed} item(s); ` +
              'the remaining shelves/categories roll over to the next run. ' +
              'For a one-off full import set NEODB_TMDB_FULL_SYNC=1 (or run `npm run sync:neodb-tmdb-full`).',
          );
        }
        return;
      }

      // One bad item must never abort the batch.
      try {
        await syncMark(mark, shelfType, ctx);
      } catch (error) {
        ctx.counters.failed += 1;
        consola.error(
          `Item failed, continuing: ${mark.item?.title ?? mark.item?.uuid} —`,
          error instanceof Error ? error.message : error,
        );
      }
      await tmdbThrottle();
    }
    await neodbThrottle();
  }
}

async function syncMark(
  mark: NeodbShelfMark,
  expectedShelf: ShelfType,
  ctx: SyncContext,
): Promise<void> {
  ctx.counters.scanned += 1;
  const item = mark.item;
  const label = item?.display_title || item?.title || item?.uuid || '(unknown)';

  if (!item?.uuid) {
    ctx.counters.failed += 1;
    consola.warn('Mark without a catalog item; skipping.');
    return;
  }

  // 1) Resolve the mapping for this shelf state.
  const shelfType =
    toShelfType(String(mark.shelf_type ?? expectedShelf)) ?? expectedShelf;
  const plan = resolveTmdbOperations(shelfType, mark.rating_grade);

  if (plan.skip) {
    ctx.counters.skippedShelf += 1;
    consola.debug(`${label}: ${plan.reason}`);
    return;
  }

  // 2) Category gate — zero network cost for items TMDB cannot hold.
  const category = String(item.category ?? '');
  if (NEODB_CATEGORIES_WITHOUT_TMDB.has(category)) {
    ctx.counters.skippedCategory += 1;
    consola.debug(`Category "${category}" has no TMDB counterpart; skip ${label}.`);
    return;
  }
  const mediaType =
    NEODB_TO_TMDB_MEDIA_TYPE[category as keyof typeof NEODB_TO_TMDB_MEDIA_TYPE];
  if (!mediaType) {
    ctx.counters.skippedCategory += 1;
    consola.debug(`Unknown category "${category}"; skip ${label}.`);
    return;
  }

  // 3) Incremental de-duplication — unchanged marks cost zero TMDB requests.
  const cacheKey = stateKey(shelfType, item.uuid);
  const fingerprint = fingerprintMark(mark);
  if (ctx.mode.incremental && ctx.state.synced[cacheKey]?.fp === fingerprint) {
    ctx.counters.skippedCached += 1;
    consola.debug(`Unchanged since last run; skip ${label}.`);
    return;
  }

  // This mark will actually be resolved against TMDB, so it counts against `SYNC_MAX_ITEMS`.
  // Placed after the gates and the incremental skip on purpose — see the note on `processed`.
  // 这条标记将真正拿去 TMDB 解析，因此计入 `SYNC_MAX_ITEMS`。刻意放在各闸门与增量跳过之后 ——
  // 原因见 `processed` 上的注释。
  ctx.counters.processed += 1;

  // 4) Resolve to a concrete TMDB item.
  const target = await resolveTmdbTarget(item, mediaType, ctx);
  if (!target) {
    ctx.counters.unmatched += 1;
    ctx.unmatchedTitles.push(label);
    consola.warn(`No TMDB match; skip ${label}.`);
    upsertReviewEntry(neodbTmdbConfig.unmatchedLog, {
      source: 'neodb→tmdb',
      reason: 'no-tmdb-match',
      uuid: item.uuid,
      shelfType,
      category,
      title: label,
      titles: collectTitles(item),
      externalResources: item.external_resources,
    });
    return;
  }

  // 5) Run-local dedupe — the same item can appear in several shelves.
  const identity = targetKey(target);
  if (ctx.seen.has(identity)) {
    ctx.counters.skippedDuplicate += 1;
    return;
  }
  ctx.seen.add(identity);

  // 6) Read current state; this GET is what makes the writes idempotent.
  const states = await getTmdbAccountStates(target, ctx.auth);
  const patch = planTmdbWrites(states, plan, neodbTmdbConfig.ratingProfile);

  if (!patch.shouldWrite) {
    ctx.counters.unchanged += 1;
    consola.info(`Already up to date; skip ${label} — ${patch.reasons.join('; ')}`);
    recordSynced(ctx, cacheKey, fingerprint);
    return;
  }

  const ok = await applyPatch(target, patch, ctx, label);
  if (ok) {
    recordSynced(ctx, cacheKey, fingerprint);
  }
}

function recordSynced(ctx: SyncContext, key: string, fingerprint: string): void {
  if (!ctx.mode.incremental) {
    return;
  }
  ctx.state.synced[key] = { fp: fingerprint, at: new Date().toISOString() };
  ctx.stateDirty = true;
}

/**
 * Apply the planned writes: rating first, then watchlist.
 *
 * The order matters for `complete` with a rating — it sets both `rating` and
 * `watchlist: false`. TMDB's add-rating implicitly drops the item from the
 * watchlist, but the explicit removal still runs afterwards so the final state
 * never depends on that undocumented side effect.
 */
async function applyPatch(
  target: TmdbTarget,
  patch: TmdbPatch,
  ctx: SyncContext,
  label: string,
): Promise<boolean> {
  if (neodbTmdbConfig.dryRun) {
    for (const reason of patch.reasons) {
      consola.info(`[dry-run] ${reason} — ${targetKey(target)} ${label}`);
    }
    if (patch.setRating !== null) ctx.counters.writtenRating += 1;
    if (patch.setWatchlist !== null) ctx.counters.writtenWatchlist += 1;
    return true;
  }

  let ok = true;

  // 1) Rating.
  if (patch.setRating !== null) {
    if (await setTmdbRating(target, patch.setRating, ctx.auth)) {
      ctx.counters.writtenRating += 1;
    } else {
      ok = false;
      ctx.counters.failed += 1;
    }
  }

  // 2) Watchlist.
  if (patch.setWatchlist !== null) {
    if (await setTmdbWatchlist(target, patch.setWatchlist, ctx.auth, ctx.accountId)) {
      ctx.counters.writtenWatchlist += 1;
    } else {
      ok = false;
      ctx.counters.failed += 1;
    }
  }

  return ok;
}

/**
 * NeoDB item → TMDB target, cheapest-exact first:
 *   1) the item's own TMDB link (external_resources) — exact, no lookup guess
 *   2) its IMDb id → /3/find                       — exact, zero false positives
 *   3) title + year → /3/search                    — strict exact-title comparison
 */
async function resolveTmdbTarget(
  item: NeodbShelfMark['item'],
  mediaType: TmdbMediaType,
  ctx: SyncContext,
): Promise<TmdbTarget | null> {
  const tmdbLink = extractTmdbTargetFromNeodb(item);
  if (tmdbLink) {
    const target = await getTmdbById(tmdbLink.mediaType, tmdbLink.id);
    if (target) {
      ctx.counters.matchedTmdbLink += 1;
      consola.info(`Matched via NeoDB TMDB link: ${targetKey(target)}`);
      return target;
    }
  }

  const imdbId = extractImdbIdFromNeodb(item);
  if (imdbId) {
    const hits = await findTmdbByImdbId(imdbId);
    // Only accept a hit of the SAME media type. One IMDb id can resolve to both a movie and a TV
    // entry, and the old `?? hits[0]` fallback would then write the rating onto a different entity.
    // Writing nothing is the lesser harm — matching has to be wrong-never, not best-effort.
    // 只接受**同一媒体类型**的命中。同一个 IMDb id 可能同时解析出电影与剧集，而原先的
    // `?? hits[0]` 回退会把评分写到另一个实体上。什么都不写，危害更小 —— 匹配宁可漏配，
    // 不可错配。
    const hit = hits.find((candidate) => candidate.mediaType === mediaType);
    if (hit) {
      ctx.counters.matchedImdb += 1;
      consola.info(`Matched via IMDb ${imdbId}: ${targetKey(hit)}`);
      return hit;
    }
    consola.warn(
      `IMDb ${imdbId} resolved to no ${mediaType} entry; falling through to title search.`,
    );
  }

  const year = extractNeodbYear(item);
  for (const title of collectTitles(item)) {
    const results = await searchTmdb(mediaType, title, year);
    const hit = pickExactTmdbMatch(results, title, year, neodbTmdbConfig.yearTolerance);
    if (hit) {
      ctx.counters.matchedSearch += 1;
      consola.info(`Matched via search "${title}": ${mediaType}:${hit.id}`);
      return { mediaType, id: hit.id, title: hit.title ?? hit.name };
    }
    await tmdbThrottle();
  }

  return null;
}

/**
 * The fine-grained counters, unchanged in spirit from the original summary but
 * with `writtenRating`/`writtenWatchlist` spelled out — the old `rating` /
 * `watchlist` labels read as if they held a rating *value* rather than a write
 * count, and `watchlist` collided with the `SYNC_RATING_PROFILE` vocabulary.
 * The aggregated view lives in `printPathSummary`.
 */
function printCounterBreakdown(ctx: SyncContext): void {
  const c = ctx.counters;
  consola.info('Sync summary:', {
    scanned: c.scanned,
    processed: c.processed,
    skippedCategory: c.skippedCategory,
    skippedShelf: c.skippedShelf,
    skippedCached: c.skippedCached,
    skippedDuplicate: c.skippedDuplicate,
    matchedTmdbLink: c.matchedTmdbLink,
    matchedImdb: c.matchedImdb,
    matchedSearch: c.matchedSearch,
    unmatched: c.unmatched,
    writtenRating: c.writtenRating,
    writtenWatchlist: c.writtenWatchlist,
    unchanged: c.unchanged,
    failed: c.failed,
  });

  if (neodbTmdbConfig.dryRun) {
    consola.warn('DRY RUN — nothing was written to TMDB.');
  }
}
