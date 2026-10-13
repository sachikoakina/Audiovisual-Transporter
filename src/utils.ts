import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { consola } from 'consola';
import DB_PROPERTIES from '../cols.json';
import {
  ItemCategory,
  NotionPropTypesEnum,
  type NeodbShelfMark,
  type NotionRichTextPropType,
  type NotionTitlePropType,
  type NotionFilesPropType,
  type NotionDatePropType,
  type NotionMultiSelectPropType,
  type NotionNumberPropType,
  type NotionUrlPropType,
  type NotionColPropTypes,
} from './types';

dotenv.config();

/**
 * Retrieves the data source ID for the given category.
 *
 * @param {ItemCategory} category - The category of the item.
 * @returns {string} The corresponding database ID.
 */
export function getDataSourceId(category: ItemCategory): string {
  const databasesMap = {
    [ItemCategory.Movie]: process.env.NOTION_MOVIE_DATABASE_ID,
    [ItemCategory.Music]: process.env.NOTION_MUSIC_DATABASE_ID,
    [ItemCategory.Book]: process.env.NOTION_BOOK_DATABASE_ID,
    [ItemCategory.Game]: process.env.NOTION_GAME_DATABASE_ID,
    [ItemCategory.Drama]: process.env.NOTION_DRAMA_DATABASE_ID,
  };
  return databasesMap[category] as string;
}

/**
 * Delays the execution of a function by a specified number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to sleep
 * @return {Promise<void>} A Promise that resolves after the specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generates the value for a property based on the given parameters, ready to insert
 * into notion database.
 *
 * @param {any} value - the value to be processed
 * @param {NotionPropTypesEnum} type - the type of the Notion database property
 * @param {string} key - the key associated with the property
 * @return {any} the generated value for the property later will be sent to notion to create an item
 */
export function buildPropertyValue(
  value: any,
  type: NotionPropTypesEnum,
  key: string,
): NotionColPropTypes | undefined {
  switch (type) {
    case NotionPropTypesEnum.TITLE:
      return {
        type: NotionPropTypesEnum.TITLE,
        title: [
          {
            text: {
              content: value,
            },
          },
        ],
      } as NotionTitlePropType;
    case NotionPropTypesEnum.FILES:
      return {
        type: NotionPropTypesEnum.FILES,
        files: [
          {
            name: value,
            type: 'external',
            external: {
              url: value,
            },
          },
        ],
      } as NotionFilesPropType;
    case NotionPropTypesEnum.DATE:
      return {
        type: NotionPropTypesEnum.DATE,
        date: {
          start: value,
        },
      } as NotionDatePropType;
    case NotionPropTypesEnum.MULTI_SELECT:
      return key === DB_PROPERTIES.RATING
        ? ({
            type: NotionPropTypesEnum.MULTI_SELECT,
            multi_select: value ? [{ name: value.toString() }] : [],
          } as NotionMultiSelectPropType)
        : ({
            type: NotionPropTypesEnum.MULTI_SELECT,
            multi_select: (value || []).map((g: string) => ({ name: g })),
          } as NotionMultiSelectPropType);
    case NotionPropTypesEnum.RICH_TEXT:
      return {
        type: NotionPropTypesEnum.RICH_TEXT,
        rich_text: [
          {
            type: 'text',
            text: {
              content: value || '',
            },
          },
        ],
      } as NotionRichTextPropType;
    case NotionPropTypesEnum.NUMBER:
      return {
        type: NotionPropTypesEnum.NUMBER,
        number: value ? Number(value) : null,
      } as NotionNumberPropType;
    case NotionPropTypesEnum.URL:
      return {
        type: NotionPropTypesEnum.URL,
        url: value,
      } as NotionUrlPropType;
    default:
      break;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path: incremental sync state
//
// Records a content fingerprint per (shelf, item) so an unchanged mark costs
// zero TMDB requests on later runs. Kept as a plain JSON file so it is easy to
// inspect and delete.
// ───────────────────────────────────────────────────────────────────────────

export type StateEntry = {
  /** Content fingerprint: changes whenever the mark changes. */
  fp: string;
  /** When this entry was last written, for pruning. */
  at: string;
};

export type SyncState = {
  version: number;
  updatedAt: string;
  /** key = `${shelfType}:${itemUuid}` */
  synced: Record<string, StateEntry>;
};

const STATE_VERSION = 1;
/** Keep the state file bounded; oldest entries are dropped first. */
const MAX_STATE_ENTRIES = 20000;

export function emptyState(): SyncState {
  return { version: STATE_VERSION, updatedAt: new Date().toISOString(), synced: {} };
}

export function readState(file: string): SyncState {
  if (!file) {
    return emptyState();
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as SyncState;
    if (parsed?.version !== STATE_VERSION || typeof parsed.synced !== 'object') {
      consola.warn(`State file ${file} has an unexpected shape; starting fresh.`);
      return emptyState();
    }
    return parsed;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      consola.warn(`Could not read state file ${file}: ${error?.message ?? error}`);
    }
    return emptyState();
  }
}

export function writeState(file: string, state: SyncState): void {
  if (!file) {
    return;
  }
  try {
    const pruned = pruneState(state);
    pruned.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8');
  } catch (error: any) {
    consola.error(`Could not write state file ${file}: ${error?.message ?? error}`);
  }
}

function pruneState(state: SyncState): SyncState {
  const keys = Object.keys(state.synced);
  if (keys.length <= MAX_STATE_ENTRIES) {
    return state;
  }

  const kept = keys
    .sort((a, b) =>
      (state.synced[b]?.at ?? '').localeCompare(state.synced[a]?.at ?? ''),
    )
    .slice(0, MAX_STATE_ENTRIES);

  const synced: Record<string, StateEntry> = {};
  for (const key of kept) {
    synced[key] = state.synced[key]!;
  }
  consola.info(`State pruned: ${keys.length} → ${kept.length} entries.`);
  return { ...state, synced };
}

export function stateKey(shelfType: string, itemUuid: string): string {
  return `${shelfType}:${itemUuid}`;
}

/**
 * Content fingerprint of a mark. Only the fields this sync actually pushes are
 * included, so an unrelated field change does not force a re-sync.
 */
export function fingerprintMark(mark: NeodbShelfMark): string {
  const payload = [
    mark.shelf_type ?? '',
    String(mark.rating_grade ?? 0),
    mark.comment_text ?? '',
  ].join('\u0001');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Fields every entry carries. Path-specific fields are added on top. */
export type ReviewLogEntry = Record<string, unknown> & {
  /** Which path wrote it, e.g. `bangumi→neodb` / `neodb→tmdb`. */
  source: string;
  /** Why it could not be processed, e.g. `neodb-unresolved`. */
  reason: string;
  /** ISO timestamp of the first run that reported this entry. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent run that still reported it. */
  lastSeenAt: string;
};

/**
 * Identity of an entry: which path, and which item on that path.
 * Both writers always supply one of these ids, so the title fallback only
 * matters for hand-edited files.
 */
function reviewKey(entry: Record<string, unknown>): string {
  const id = entry.externalId ?? entry.uuid ?? entry.title ?? '';
  return `${String(entry.source ?? '')}::${String(id)}`;
}

function readReviewLog(file: string): ReviewLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item) => typeof item === 'object' && item !== null,
    ) as ReviewLogEntry[];
  } catch {
    // Missing on the first run, or hand-edited into invalid JSON — start over.
    return [];
  }
}

/**
 * Record an entry that could not be processed, keyed so re-running does not
 * duplicate it. Best effort: never throws.
 *
 * This is an upsert rather than an append on purpose. The same few obscure
 * items fail on every run, so appending would grow the file without bound
 * while telling you nothing new — and, because entries carried no timestamp,
 * the "history" it appeared to preserve could not even be ordered: two runs
 * produced two identical records with no way to say which was newer.
 * Re-recording refreshes `lastSeenAt` and leaves `firstSeenAt` alone, which is
 * what separates a long-standing gap from a newly appeared one.
 */
export function upsertReviewEntry(
  file: string,
  entry: Record<string, unknown> & { source: string; reason: string },
  now: string = new Date().toISOString(),
): void {
  if (!file) {
    return;
  }
  try {
    const key = reviewKey(entry);
    const existing = readReviewLog(file);
    const index = existing.findIndex((item) => reviewKey(item) === key);

    if (index >= 0) {
      const previous = existing[index]!;
      existing[index] = {
        ...entry,
        // Keep the original sighting; only the trailing edge moves.
        firstSeenAt: previous.firstSeenAt ?? now,
        lastSeenAt: now,
      } as ReviewLogEntry;
    } else {
      existing.push({ ...entry, firstSeenAt: now, lastSeenAt: now } as ReviewLogEntry);
    }

    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  } catch (error: any) {
    consola.warn(`Could not update review log ${file}: ${error?.message ?? error}`);
  }
}
