/**
 * Strict identity checks between a Bangumi-linked NeoDB item and a Douban-linked NeoDB item.
 *
 * A title/year match is never enough on its own. The only accepted outcomes are:
 * - the same uuid;
 * - an exact IMDb id (movies/TV) or ISBN (books);
 * - reciprocal external links plus exact title/year/type.
 *
 * When the evidence is insufficient, the caller keeps the Bangumi item.
 * 严格的身份判断：仅靠标题/年份不足以合并；只有同一 uuid、IMDb/ISBN 强匹配，
 * 或双向外部链接加严格弱条件时才接受映射；证据不足时保留 Bangumi 条目。
 */
import type { NeodbItem } from '../types';
import { normalizeIsbn } from './isbn';
import { normalizeTitleKey } from './tmdb-matching';

export type NeodbMediaForm = 'movie' | 'tv' | 'book' | 'music' | 'game' | 'other';

export type NeodbIdentityLevel =
  'same-uuid' | 'strong-id' | 'reciprocal-link' | 'unverified' | 'conflict';

export type NeodbIdentityDecision = {
  level: NeodbIdentityLevel;
  canonicalUuid: string;
  reason:
    | 'same-uuid'
    | 'imdb-match'
    | 'isbn-match'
    | 'reciprocal-link-verified'
    | 'missing-strong-id'
    | 'strong-id-conflict'
    | 'media-form-mismatch'
    | 'title-mismatch'
    | 'year-mismatch'
    | 'bangumi-link-missing'
    | 'weak-only';
  strong: {
    imdbA?: string;
    imdbB?: string;
    isbnA?: string[];
    isbnB?: string[];
  };
  weak: {
    titleA?: string;
    titleB?: string;
    yearA?: number;
    yearB?: number;
    formA?: NeodbMediaForm;
    formB?: NeodbMediaForm;
  };
};

export type NeodbIdentityOptions = {
  bangumiUrl: string;
  doubanUrl: string;
};

function mediaFormOf(item: NeodbItem): NeodbMediaForm {
  switch (item.category) {
    case 'movie':
    case 'tv':
    case 'book':
    case 'music':
    case 'game':
      return item.category;
    default:
      if (/\/movie\//.test(item.url || '')) return 'movie';
      if (/\/tv\//.test(item.url || '')) return 'tv';
      if (/\/book\//.test(item.url || '')) return 'book';
      if (/\/music\//.test(item.url || '')) return 'music';
      if (/\/game\//.test(item.url || '')) return 'game';
      return 'other';
  }
}

function formsCompatible(a: NeodbMediaForm, b: NeodbMediaForm): boolean {
  if (a === 'other' || b === 'other') return false;
  if (a === b) return true;
  return (a === 'movie' && b === 'tv') || (a === 'tv' && b === 'movie');
}

function imdbIdOf(item: NeodbItem): string | undefined {
  for (const resource of item.external_resources || []) {
    const match = resource.url?.match(/imdb\.com\/title\/(tt\d+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function isbnsOf(item: NeodbItem): string[] {
  const values = new Set<string>();
  for (const raw of [item.isbn]) {
    const normalized = normalizeIsbn(raw);
    if (normalized) values.add(normalized);
  }
  return [...values];
}

function bangumiIdOf(item: NeodbItem): number | undefined {
  for (const resource of item.external_resources || []) {
    const match = resource.url?.match(/(?:bgm\.tv|bangumi\.tv)\/subject\/(\d+)/i);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function titleKeysOf(item: NeodbItem): Set<string> {
  const keys = new Set<string>();
  for (const raw of [
    item.title,
    item.display_title,
    ...(item.localized_title || []).map((entry) => entry.text),
  ]) {
    if (raw?.trim()) keys.add(normalizeTitleKey(raw));
  }
  return keys;
}

function yearOf(item: NeodbItem): number | undefined {
  return item.year ?? item.pub_year;
}

/**
 * Decide whether two different NeoDB uuids may represent the same work.
 * The caller must only pass two different uuids; same-uuid is checked first.
 *
 * 判断两个不同 NeoDB uuid 是否可以视为同一作品。调用方只在 uuid 不同时调用；
 * 相同 uuid 由调用方直接接受，不进入此函数。
 */
export function evaluateNeodbIdentity(
  bangumiItem: NeodbItem,
  doubanItem: NeodbItem,
  options: NeodbIdentityOptions,
): NeodbIdentityDecision {
  if (bangumiItem.uuid === doubanItem.uuid) {
    return {
      level: 'same-uuid',
      canonicalUuid: bangumiItem.uuid,
      reason: 'same-uuid',
      strong: {},
      weak: {},
    };
  }

  const formA = mediaFormOf(bangumiItem);
  const formB = mediaFormOf(doubanItem);
  const titleA = bangumiItem.title || bangumiItem.display_title || '';
  const titleB = doubanItem.title || doubanItem.display_title || '';
  const yearA = yearOf(bangumiItem);
  const yearB = yearOf(doubanItem);
  const imdbA = imdbIdOf(bangumiItem);
  const imdbB = imdbIdOf(doubanItem);
  const isbnA = isbnsOf(bangumiItem);
  const isbnB = isbnsOf(doubanItem);

  const strong: NeodbIdentityDecision['strong'] = {
    ...(imdbA ? { imdbA } : {}),
    ...(imdbB ? { imdbB } : {}),
    ...(isbnA.length ? { isbnA } : {}),
    ...(isbnB.length ? { isbnB } : {}),
  };
  const weak: NeodbIdentityDecision['weak'] = {
    ...(titleA ? { titleA } : {}),
    ...(titleB ? { titleB } : {}),
    ...(yearA != null ? { yearA } : {}),
    ...(yearB != null ? { yearB } : {}),
    formA,
    formB,
  };

  if (!formsCompatible(formA, formB)) {
    return {
      level: 'conflict',
      canonicalUuid: bangumiItem.uuid,
      reason: 'media-form-mismatch',
      strong,
      weak,
    };
  }

  if (imdbA && imdbB) {
    if (imdbA !== imdbB) {
      return {
        level: 'conflict',
        canonicalUuid: bangumiItem.uuid,
        reason: 'strong-id-conflict',
        strong,
        weak,
      };
    }
  }

  if (isbnA.length && isbnB.length) {
    const overlap = isbnA.some((isbn) => isbnB.includes(isbn));
    if (!overlap) {
      return {
        level: 'conflict',
        canonicalUuid: bangumiItem.uuid,
        reason: 'strong-id-conflict',
        strong,
        weak,
      };
    }
  }

  const strongMatch =
    (imdbA != null && imdbB != null && imdbA === imdbB) ||
    (isbnA.length > 0 && isbnA.some((isbn) => isbnB.includes(isbn)));

  const bangumiId = Number(options.bangumiUrl.match(/\/subject\/(\d+)/)?.[1]);
  const doubanItemHasBangumi = Number.isFinite(bangumiId)
    ? bangumiIdOf(doubanItem) === bangumiId
    : false;
  const bangumiItemHasDouban =
    extractDoubanUrl(bangumiItem) === options.doubanUrl ||
    extractDoubanUrl(bangumiItem) != null;

  const titleMatch = [...titleKeysOf(bangumiItem)].some((key) =>
    titleKeysOf(doubanItem).has(key),
  );
  const yearMatch = yearA != null && yearB != null && yearA === yearB;

  if (strongMatch) {
    if (!doubanItemHasBangumi) {
      return {
        level: 'strong-id',
        canonicalUuid: bangumiItem.uuid,
        reason: 'bangumi-link-missing',
        strong,
        weak,
      };
    }
    return {
      level: 'strong-id',
      canonicalUuid: doubanItem.uuid,
      reason: imdbA ? 'imdb-match' : 'isbn-match',
      strong,
      weak,
    };
  }

  if (bangumiItemHasDouban && doubanItemHasBangumi && titleMatch && yearMatch) {
    return {
      level: 'reciprocal-link',
      canonicalUuid: doubanItem.uuid,
      reason: 'reciprocal-link-verified',
      strong,
      weak,
    };
  }

  if (!bangumiItemHasDouban && !doubanItemHasBangumi) {
    return {
      level: 'unverified',
      canonicalUuid: bangumiItem.uuid,
      reason: 'missing-strong-id',
      strong,
      weak,
    };
  }

  return {
    level: 'unverified',
    canonicalUuid: bangumiItem.uuid,
    reason: 'weak-only',
    strong,
    weak,
  };
}

function extractDoubanUrl(item: NeodbItem): string | null {
  for (const resource of item.external_resources || []) {
    const url = resource.url;
    if (
      url &&
      (/(?:movie|book|music)\.douban\.com\/subject\/\d+/i.test(url) ||
        /(?:www\.)?douban\.com\/(?:game|location\/drama)\/\d+/i.test(url))
    ) {
      return url;
    }
  }
  return null;
}
