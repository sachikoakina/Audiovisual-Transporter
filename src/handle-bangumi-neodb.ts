import dotenv from 'dotenv';
import { consola } from 'consola';
import {
  newPathReport,
  type BangumiCollectionType,
  type BangumiSubjectType,
  type PathReport,
} from './types';
import {
  BANGUMI_TO_NEODB_STATUS,
  bangumiCollectionToNeodbProgress,
  neodbItemSupportsProgress,
} from './const';
import {
  bangumiCollectionLimit,
  bangumiSubjectUrl,
  bangumiThrottle,
  bangumiToken,
  getBangumiMe,
  getBangumiSubject,
  listBangumiCollections,
  type BangumiCollection,
} from './bangumi';
import {
  getNeodbMark,
  getNeodbProgress,
  markNeodbItem,
  neodbToken,
  neodbVisibility,
  resolveNeodbItemForBangumiUrl,
  setNeodbProgress,
  type NeodbItem,
} from './neodb';
import { mergeNeodbMark } from './neodb-merge';
import {
  bangumiSubjectTypesForAllowlist,
  needsBangumiMangaPlatformCheck,
  syncConfig,
  unmatchedLogFile,
} from './sync-config';
import { upsertReviewEntry } from './utils';
import { printPathSummary } from './sync-report';

dotenv.config();

const LABEL = 'Bangumi → NeoDB';

/**
 * What happened to one collection. The four cases partition every scanned
 * collection, which is what lets `printPathSummary` self-check the totals.
 */
type CollectionOutcome = 'written' | 'unchanged' | 'skipped-platform' | 'unresolved';

/** Counters for this path, mirroring the shape of `SyncCounters`. */
type BangumiCounters = {
  scanned: number;
  written: number;
  unchanged: number;
  /** Non-manga books dropped by a manga-only category allowlist. */
  skippedPlatform: number;
  /** Collections NeoDB has no catalog entry for. */
  unresolved: number;
  /** Collections that threw — a bug or an outage, not a data gap. */
  failed: number;
};

function newBangumiCounters(): BangumiCounters {
  return {
    scanned: 0,
    written: 0,
    unchanged: 0,
    skippedPlatform: 0,
    unresolved: 0,
    failed: 0,
  };
}

/**
 * Sync recent (or all) Bangumi collections to NeoDB.
 * Requires both BANGUMI_ACCESS_TOKEN and NEODB_API_TOKEN.
 *
 * @returns a report of what happened. Unresolved entries are a data gap and do
 * not fail the run; `failed` and `aborted` do — the caller decides via
 * `pathHasFailed`.
 */
export default async function handleBangumiToNeodb(
  fullSync = false,
): Promise<PathReport> {
  const report = newPathReport(LABEL);
  const counters = newBangumiCounters();

  if (!bangumiToken || !neodbToken) {
    // This used to be a silent `return`. A path that is switched on but cannot
    // run must say so, or the log reads as a successful no-op.
    consola.warn(
      'Bangumi → NeoDB needs both BANGUMI_ACCESS_TOKEN and NEODB_API_TOKEN; skip.',
    );
    report.aborted = true;
    return report;
  }

  const me = await getBangumiMe();
  if (!me?.username) {
    consola.error('Cannot resolve Bangumi username; skip Bangumi → NeoDB');
    report.aborted = true;
    return report;
  }

  const allowlist = syncConfig.bangumiNeodbCategories;
  const subjectTypes = bangumiSubjectTypesForAllowlist(allowlist);

  if (subjectTypes && subjectTypes.length === 0) {
    consola.warn('Bangumi → NeoDB category allowlist is empty; skip.');
    return report;
  }

  consola.start(
    fullSync
      ? 'Going to full-sync Bangumi → NeoDB...'
      : 'Going to sync recent Bangumi → NeoDB...',
  );

  const mangaPlatformCheck = needsBangumiMangaPlatformCheck(allowlist);

  // null = mixed fetch (all types); otherwise one pass per subject_type
  const typePasses: Array<BangumiSubjectType | undefined> = subjectTypes
    ? subjectTypes
    : [undefined];

  for (const subjectType of typePasses) {
    let offset = 0;
    const limit = bangumiCollectionLimit;

    while (true) {
      const page = await listBangumiCollections({
        username: me.username,
        limit,
        offset,
        subjectType,
      });

      if (!page.data.length) {
        break;
      }

      for (const collection of page.data) {
        counters.scanned += 1;
        // One bad item must never abort the batch.
        try {
          const outcome = await syncCollectionToNeodb(collection, mangaPlatformCheck);
          switch (outcome) {
            case 'written':
              counters.written += 1;
              break;
            case 'unchanged':
              counters.unchanged += 1;
              break;
            case 'skipped-platform':
              counters.skippedPlatform += 1;
              break;
            case 'unresolved':
              counters.unresolved += 1;
              recordUnresolved(collection, report);
              break;
          }
        } catch (error) {
          counters.failed += 1;
          consola.error(
            `Item failed, continuing: ${collectionTitle(collection)} —`,
            error instanceof Error ? error.message : error,
          );
        }
        await bangumiThrottle();
      }

      if (!fullSync) {
        break;
      }

      offset += page.data.length;
      if (offset >= page.total) {
        break;
      }
    }
  }

  report.scanned = counters.scanned;
  report.written = counters.written;
  report.unchanged = counters.unchanged;
  report.skipped = counters.skippedPlatform;
  report.unresolved = counters.unresolved;
  report.failed = counters.failed;

  // Kept verbatim: this counts collections that resolved and were processed —
  // written *or* already up to date. `printPathSummary` breaks the two apart.
  consola.success(
    `Bangumi → NeoDB synced (${counters.written + counters.unchanged} items) ✨`,
  );
  printPathSummary(report);

  return report;
}

/** Append the entry to the review log and remember it for the closing listing. */
function recordUnresolved(collection: BangumiCollection, report: PathReport): void {
  const title = collectionTitle(collection);

  report.unresolvedTitles.push(title);
  report.reviewLog = unmatchedLogFile;

  upsertReviewEntry(unmatchedLogFile, {
    source: 'bangumi→neodb',
    reason: 'neodb-unresolved',
    title,
    externalId: String(collection.subject_id),
    externalUrl: bangumiSubjectUrl(collection.subject_id),
    subjectType: collection.subject_type,
    collectionType: collection.type,
  });
}

function collectionTitle(collection: BangumiCollection): string {
  return (
    collection.subject?.name_cn ||
    collection.subject?.name ||
    `subject/${collection.subject_id}`
  );
}

async function syncCollectionToNeodb(
  collection: BangumiCollection,
  mangaPlatformCheck: boolean,
): Promise<CollectionOutcome> {
  const url = bangumiSubjectUrl(collection.subject_id);
  const title = collectionTitle(collection);
  consola.info('Bangumi → NeoDB: ', `${title}[${url}]`);

  if (
    mangaPlatformCheck &&
    collection.subject_type === 1 &&
    !(await isBangumiManga(collection.subject_id, title))
  ) {
    return 'skipped-platform';
  }

  const neodbItem = await resolveNeodbItemForBangumiUrl(url, {
    titles: [collection.subject?.name_cn, collection.subject?.name],
    subjectType: collection.subject_type,
  });
  if (!neodbItem?.uuid) {
    consola.warn('NeoDB could not resolve Bangumi URL, skip: ', url);
    return 'unresolved';
  }

  const shelfType = BANGUMI_TO_NEODB_STATUS[collection.type as BangumiCollectionType];
  const ratingGrade = collection.rate || 0;
  const comment = collection.comment || '';
  // Bangumi updated_at is unreliable; only used when creating a new NeoDB mark.
  const createdTime = collection.updated_at || undefined;

  const mark = await getNeodbMark(neodbItem.uuid);
  let markWritten: boolean;

  if (!mark) {
    await markNeodbItem(neodbItem, {
      shelfType,
      comment,
      ratingGrade,
      createdTime,
    });
    markWritten = true;
  } else {
    const merged = mergeNeodbMark(
      mark,
      { shelfType, ratingGrade, comment },
      syncConfig.bangumiNeodbMerge,
      neodbVisibility,
    );

    if (!merged.shouldWrite) {
      consola.info('NeoDB mark unchanged, skip: ', title);
      markWritten = false;
    } else {
      if (merged.keptRating || merged.keptComment) {
        consola.info(
          'NeoDB prefer: keeping existing ',
          [merged.keptRating ? 'rating' : null, merged.keptComment ? 'comment' : null]
            .filter(Boolean)
            .join('+'),
          ' on ',
          title,
        );
      }
      // Do not pass createdTime on update — preserves NeoDB mark date.
      await markNeodbItem(neodbItem, {
        shelfType: merged.shelfType,
        comment: merged.comment,
        ratingGrade: merged.ratingGrade,
      });
      markWritten = true;
    }
  }

  // Progress can move even when the mark itself did not, so it counts as a
  // write on its own — otherwise "unchanged" would hide a real update.
  const progressWritten = syncConfig.bangumiNeodbProgress
    ? await syncProgressToNeodb(collection, neodbItem, title)
    : false;

  return markWritten || progressWritten ? 'written' : 'unchanged';
}

async function isBangumiManga(subjectId: number, title: string): Promise<boolean> {
  const subject = await getBangumiSubject(subjectId);
  const platform = subject?.platform?.trim() || '';
  if (platform === '漫画') {
    return true;
  }
  consola.info(
    'Bangumi → NeoDB: skip non-manga book: ',
    `${title} (platform=${platform || 'unknown'})`,
  );
  return false;
}

/** @returns true when a progress value was actually written. */
async function syncProgressToNeodb(
  collection: BangumiCollection,
  neodbItem: NeodbItem,
  title: string,
): Promise<boolean> {
  const progress = bangumiCollectionToNeodbProgress(collection);
  if (!progress) {
    return false;
  }

  if (!neodbItemSupportsProgress(neodbItem, progress)) {
    consola.info(
      'NeoDB progress not applicable for catalog category, skip: ',
      `${title} (${neodbItem.category}/${progress.type})`,
    );
    return false;
  }

  const existing = await getNeodbProgress(neodbItem.uuid);
  if (
    existing &&
    existing.type === progress.type &&
    String(existing.value ?? '') === progress.value
  ) {
    consola.info('NeoDB progress unchanged, skip: ', title);
    return false;
  }

  await setNeodbProgress(neodbItem, progress);
  return true;
}
