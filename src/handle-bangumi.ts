import dotenv from 'dotenv';
import { consola } from 'consola';
import type { FeedItem } from './types';
import { ItemCategory } from './types';
import {
  BANGUMI_STATUSES_ABSENT_FROM_DOUBAN,
  CATEGORY_TO_BANGUMI_TYPES,
  NEODB_TO_BANGUMI_COLLECTION,
} from './const';
import {
  extractBangumiIdFromNeodb,
  fetchNeodbItemByUrl,
  type NeodbItem,
} from './neodb';
import {
  bangumiPrivate,
  bangumiToken,
  bangumiThrottle,
  doubanRatingToBangumi,
  getBangumiCollection,
  getBangumiMe,
  pickExactBangumiMatch,
  searchBangumiSubjects,
  upsertBangumiCollection,
} from './bangumi';
import { filterDoubanFeedsByCategory, syncConfig } from './sync-config';

dotenv.config();

/**
 * Sync Douban RSS feed items to Bangumi collections.
 * Matching: NeoDB external_resources first, then exact title search.
 */
export default async function handleBangumi(feeds: FeedItem[]): Promise<void> {
  if (!bangumiToken) {
    return;
  }

  const me = await getBangumiMe();
  if (!me?.username) {
    consola.error('Cannot resolve Bangumi username; skip Douban → Bangumi');
    return;
  }

  const filtered = filterDoubanFeedsByCategory(
    feeds,
    syncConfig.doubanBangumiCategories,
    'Douban → Bangumi',
  );

  consola.start('Going to sync Douban → Bangumi...');
  for (const item of filtered) {
    await syncFeedItemToBangumi(item, me.username);
    await bangumiThrottle();
  }
  consola.success('Bangumi synced ✨');
}

async function syncFeedItemToBangumi(item: FeedItem, username: string): Promise<void> {
  const label = `${item.title || item.id}[${item.link}]`;
  consola.info('Douban → Bangumi: ', label);

  const neodbItem = await fetchNeodbItemByUrl(item.link);
  const subjectId = await resolveBangumiSubjectId(item, neodbItem);

  if (!subjectId) {
    consola.warn('No Bangumi match, skip: ', label);
    return;
  }

  const desiredType = NEODB_TO_BANGUMI_COLLECTION[item.status];
  const desiredRate = doubanRatingToBangumi(item.rating);
  const desiredComment = item.comment || '';

  const existing = await getBangumiCollection(username, subjectId);
  if (existing && BANGUMI_STATUSES_ABSENT_FROM_DOUBAN.has(existing.type)) {
    consola.info(
      'Bangumi has Douban-absent status (搁置/抛弃), skip overwrite: ',
      `subject/${subjectId} type=${existing.type}`,
    );
    return;
  }

  if (
    existing &&
    existing.type === desiredType &&
    (existing.rate || 0) === desiredRate &&
    (existing.comment || '') === desiredComment
  ) {
    consola.info('Bangumi collection unchanged, skip: ', `subject/${subjectId}`);
    return;
  }

  consola.info(
    existing ? 'Updating Bangumi collection: ' : 'Creating Bangumi collection: ',
    `subject/${subjectId}`,
  );

  await upsertBangumiCollection(subjectId, {
    type: desiredType,
    rate: desiredRate,
    comment: desiredComment,
    private: bangumiPrivate,
  });
}

async function resolveBangumiSubjectId(
  item: FeedItem,
  neodbItem: NeodbItem | null,
): Promise<number | null> {
  if (neodbItem) {
    const fromNeodb = extractBangumiIdFromNeodb(neodbItem);
    if (fromNeodb) {
      consola.info('Matched Bangumi via NeoDB external_resources: ', fromNeodb);
      return fromNeodb;
    }
  }

  // Drama has no Bangumi type; only sync when NeoDB already linked it.
  if (item.category === ItemCategory.Drama) {
    return null;
  }

  const keyword = neodbItem?.display_title || neodbItem?.title || item.title;
  if (!keyword) {
    return null;
  }

  const types = CATEGORY_TO_BANGUMI_TYPES[item.category];
  const results = await searchBangumiSubjects(keyword, types);
  const exact = pickExactBangumiMatch(results, keyword);
  if (exact) {
    consola.info('Matched Bangumi via exact title search: ', exact.id);
    return exact.id;
  }

  // Also try FeedItem.title if NeoDB title differed
  if (item.title && item.title !== keyword) {
    const again = pickExactBangumiMatch(results, item.title);
    if (again) {
      consola.info('Matched Bangumi via FeedItem title: ', again.id);
      return again.id;
    }
    const secondSearch = await searchBangumiSubjects(item.title, types);
    const secondExact = pickExactBangumiMatch(secondSearch, item.title);
    if (secondExact) {
      consola.info('Matched Bangumi via second title search: ', secondExact.id);
      return secondExact.id;
    }
  }

  return null;
}
