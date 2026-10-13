import { consola } from 'consola';
import {
  NEODB_CATEGORIES_WITHOUT_TMDB,
  NEODB_TO_TMDB_MEDIA_TYPE,
  collectTitles,
  extractImdbIdFromNeodb,
  extractNeodbYear,
  extractTmdbTargetFromNeodb,
  toShelfType,
} from './const';
import {
  neodbTmdbConfig,
  describeNeodbTmdbConfig,
  resolveTargetCategories,
  validateNeodbTmdbCredentials,
} from './sync-config';
import { resolveTmdbOperations, type TmdbOperationPlan } from './tmdb-mapping';
import { fetchShelf, getNeodbMe, neodbThrottle, verifyNeodbToken } from './neodb';
import {
  findTmdbByImdbId,
  getTmdbAccount,
  getTmdbAccountStates,
  getTmdbById,
  memberKey,
  pickExactTmdbMatch,
  resolveTmdbAuth,
  searchTmdb,
  setTmdbRating,
  setTmdbWatchlist,
  tmdbThrottle,
  type TmdbAuth,
} from './tmdb';
import { planTmdbWrites, type TmdbPatch } from './tmdb-merge';
import {
  fingerprintMark,
  readState,
  stateKey,
  upsertReviewEntry,
  writeState,
  type SyncState,
} from './utils';
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
} from './types';
import { printPathSummary } from './sync-report';

const LABEL = 'NeoDB → TMDB';

type SyncContext = {
  auth: TmdbAuth;
  accountId: number;
  /** `${mediaType}:${id}` seen this run, to dedupe across shelves/categories. */
  seen: Set<string>;
  counters: SyncCounters;
  state: SyncState;
  stateDirty: boolean;
  /** `SYNC_MAX_ITEMS` cut the run short; more items remain unwalked. */
  capped: boolean;
  /** Labels of unmatched items, in encounter order, for the closing listing. */
  unmatchedTitles: string[];
};

// ───────────────────────────────────────────────────────────────────────────

/**
 * NeoDB shelf → TMDB, one-way.
 *
 * Each mark is resolved through `resolveTmdbOperations` (see mapping.ts) into a
 * plan, then diffed against the live TMDB state so that re-running is always
 * safe. Nothing here encodes mapping knowledge.
 *
 * @returns a report of what happened. The caller decides the exit code from it
 * (`pathHasFailed`), and `index.ts` folds it into the closing summary.
 */
export default async function runSync(): Promise<PathReport> {
  const report = newPathReport(LABEL);

  consola.info('NeoDB → TMDB sync: ', describeNeodbTmdbConfig());

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
    auth,
    accountId: account.id,
    seen: new Set<string>(),
    counters: newSyncCounters(),
    state: neodbTmdbConfig.incremental
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
  printSummary(ctx);
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
    const marks = await fetchShelf(shelfType, category);
    consola.info(`  ${shelfType}/${category}: ${marks.length} mark(s).`);

    for (const mark of marks) {
      if (ctx.counters.scanned >= neodbTmdbConfig.maxItems) {
        ctx.capped = true;
        consola.warn(`Reached SYNC_MAX_ITEMS (${neodbTmdbConfig.maxItems}); stopping.`);
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
  if (neodbTmdbConfig.incremental && ctx.state.synced[cacheKey]?.fp === fingerprint) {
    ctx.counters.skippedCached += 1;
    consola.debug(`Unchanged since last run; skip ${label}.`);
    return;
  }

  // 4) Resolve to a concrete TMDB item.
  const target = await resolveTarget(item, mediaType, ctx);
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
  const identity = memberKey(target);
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
  if (!neodbTmdbConfig.incremental) {
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
      consola.info(`[dry-run] ${reason} — ${memberKey(target)} ${label}`);
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
async function resolveTarget(
  item: NeodbShelfMark['item'],
  mediaType: TmdbMediaType,
  ctx: SyncContext,
): Promise<TmdbTarget | null> {
  const tmdbLink = extractTmdbTargetFromNeodb(item);
  if (tmdbLink) {
    const target = await getTmdbById(tmdbLink.mediaType, tmdbLink.id);
    if (target) {
      ctx.counters.matchedTmdbLink += 1;
      consola.info(`Matched via NeoDB TMDB link: ${memberKey(target)}`);
      return target;
    }
  }

  const imdbId = extractImdbIdFromNeodb(item);
  if (imdbId) {
    const hits = await findTmdbByImdbId(imdbId);
    const hit = hits.find((candidate) => candidate.mediaType === mediaType) ?? hits[0];
    if (hit) {
      ctx.counters.matchedImdb += 1;
      consola.info(`Matched via IMDb ${imdbId}: ${memberKey(hit)}`);
      return hit;
    }
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
function printSummary(ctx: SyncContext): void {
  const c = ctx.counters;
  consola.info('Sync summary:', {
    scanned: c.scanned,
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

// Re-exported for tests and future callers.
export type { TmdbOperationPlan };
