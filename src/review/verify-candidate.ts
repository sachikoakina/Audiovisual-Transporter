/**
 * Read-only verification for review candidates.
 * 待核对候选的只读复核。
 *
 * This module never writes to a target. It only answers "is the original blocker gone?".
 * 本模块从不写目标端，只回答“原来的阻断是否已经消失”。
 */
import {
  bangumiSubjectYear,
  exactBangumiCandidates,
  searchBangumiSubjects,
} from '../clients/bangumi';
import {
  fetchNeodbItemByUrl,
  resolveNeodbItemForBangumiUrlDetailed,
} from '../clients/neodb-catalog';
import { searchTmdb } from '../clients/tmdb';
import { CATEGORY_TO_BANGUMI_TYPES } from '../rules/bangumi-neodb';
import { pickExactTmdbMatch } from '../rules/tmdb-matching';
import { ItemCategory } from '../types';

export type ReviewCandidate = {
  source: string;
  key: string;
  url?: string;
  id?: string;
  title?: string;
  category?: string;
  shelf?: string;
  reason?: string;
};

export type VerifyStatus = 'resolved' | 'still-unresolved' | 'ambiguous' | 'error';

export type VerifyResult = {
  key: string;
  status: VerifyStatus;
  matchedBy?: string;
  targetId?: string;
  message?: string;
};

const CATEGORY_BY_REVIEW: Record<string, ItemCategory> = {
  movie: ItemCategory.Movie,
  tv: ItemCategory.Movie,
  anime: ItemCategory.Movie,
  book: ItemCategory.Book,
  music: ItemCategory.Music,
  game: ItemCategory.Game,
  drama: ItemCategory.Drama,
};

function normalizedCategory(candidate: ReviewCandidate): ItemCategory | undefined {
  return candidate.category ? CATEGORY_BY_REVIEW[candidate.category] : undefined;
}

async function verifyDoubanNeodb(candidate: ReviewCandidate): Promise<VerifyResult> {
  if (!candidate.url) {
    return { key: candidate.key, status: 'still-unresolved', message: 'no Douban URL' };
  }
  const failure: { kind?: 'not-found' | 'temporary' } = {};
  const item = await fetchNeodbItemByUrl(candidate.url, 3, failure);
  if (item) {
    return {
      key: candidate.key,
      status: 'resolved',
      matchedBy: 'douban-url',
      targetId: item.uuid,
    };
  }
  return {
    key: candidate.key,
    status: failure.kind === 'temporary' ? 'error' : 'still-unresolved',
    message: failure.kind ?? 'no catalog item',
  };
}

async function verifyDoubanBangumi(candidate: ReviewCandidate): Promise<VerifyResult> {
  if (!candidate.url && !candidate.title) {
    return {
      key: candidate.key,
      status: 'still-unresolved',
      message: 'no URL or title',
    };
  }

  const category = normalizedCategory(candidate);
  const types = category ? CATEGORY_TO_BANGUMI_TYPES[category] : undefined;
  if (!types?.length) {
    return {
      key: candidate.key,
      status: 'still-unresolved',
      message: 'no Bangumi category for this Douban type',
    };
  }

  const queries = [candidate.title].filter((value): value is string => Boolean(value));
  for (const query of queries) {
    const results = await searchBangumiSubjects(query, types);
    const exact = exactBangumiCandidates(results, query);
    if (exact.length === 1) {
      return {
        key: candidate.key,
        status: 'resolved',
        matchedBy: 'exact-title',
        targetId: String(exact[0].id),
        message: bangumiSubjectYear(exact[0])?.toString(),
      };
    }
    if (exact.length > 1) {
      return {
        key: candidate.key,
        status: 'ambiguous',
        message: `multiple exact candidates: ${exact.map((subject) => subject.id).join(',')}`,
      };
    }
  }

  return {
    key: candidate.key,
    status: 'still-unresolved',
    message: 'no exact Bangumi match',
  };
}

async function verifyBangumiNeodb(candidate: ReviewCandidate): Promise<VerifyResult> {
  if (!candidate.url) {
    return {
      key: candidate.key,
      status: 'still-unresolved',
      message: 'no Bangumi URL',
    };
  }

  const subjectType =
    candidate.category === 'anime'
      ? 2
      : candidate.category === 'book'
        ? 1
        : candidate.category === 'music'
          ? 3
          : candidate.category === 'game'
            ? 4
            : 6;
  const resolution = await resolveNeodbItemForBangumiUrlDetailed(candidate.url, {
    titles: [candidate.title],
    subjectType,
  });
  if (resolution.item) {
    return {
      key: candidate.key,
      status: 'resolved',
      matchedBy: resolution.via,
      targetId: resolution.item.uuid,
    };
  }
  return {
    key: candidate.key,
    status: resolution.failure === 'temporary' ? 'error' : 'still-unresolved',
    message: resolution.failure ?? 'no catalog item',
  };
}

async function verifyNeodbTmdb(candidate: ReviewCandidate): Promise<VerifyResult> {
  if (!candidate.url) {
    return { key: candidate.key, status: 'still-unresolved', message: 'no NeoDB URL' };
  }
  const item = await fetchNeodbItemByUrl(candidate.url);
  if (!item) {
    return { key: candidate.key, status: 'error', message: 'NeoDB item not readable' };
  }

  const mediaType = item.type === 'tv' ? 'tv' : item.type === 'movie' ? 'movie' : null;
  if (!mediaType) {
    return {
      key: candidate.key,
      status: 'still-unresolved',
      message: 'not a TMDB media type',
    };
  }
  const year = item.year ?? item.pub_year;
  const title = candidate.title || item.title || item.display_title;
  if (!year || !title) {
    return {
      key: candidate.key,
      status: 'still-unresolved',
      message: 'missing title or year',
    };
  }

  const results = await searchTmdb(mediaType, title, year);
  const exact = pickExactTmdbMatch(results, title, year, 1);
  if (exact) {
    return {
      key: candidate.key,
      status: 'resolved',
      matchedBy: 'exact-title',
      targetId: String(exact.id),
    };
  }
  return {
    key: candidate.key,
    status: 'still-unresolved',
    message: 'no exact TMDB match',
  };
}

export async function verifyCandidate(
  candidate: ReviewCandidate,
): Promise<VerifyResult> {
  try {
    switch (candidate.source) {
      case 'douban→neodb':
        return await verifyDoubanNeodb(candidate);
      case 'douban→bangumi':
        return await verifyDoubanBangumi(candidate);
      case 'bangumi→neodb':
        return await verifyBangumiNeodb(candidate);
      case 'neodb→tmdb':
        return await verifyNeodbTmdb(candidate);
      default:
        return {
          key: candidate.key,
          status: 'error',
          message: `unknown source ${candidate.source}`,
        };
    }
  } catch (error) {
    return {
      key: candidate.key,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
