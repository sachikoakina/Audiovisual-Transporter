/*
 * Verify the pure rules offline: Douban vocabulary, scale conversion, Bangumi↔NeoDB status and
 * progress mapping, the NeoDB mark merge, title matching, how a failed read is classified, and
 * the Notion property payload builder. No network, no framework — run with the tsx already in
 * devDependencies.
 *
 * Every assertion here is against a literal input and needs no fixture, so it pins the behaviour
 * completely: if one of these fails, the rule genuinely changed.
 *
 * USAGE: npm run verify:rules   (or `npm run verify:all` for every verify script)
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 离线验证纯规则：豆瓣词汇、分制换算、Bangumi↔NeoDB 的状态与进度映射、NeoDB 标记合并、
 * 标题匹配、读取失败的归类、以及 Notion 属性载荷构造。
 * 不需要网络、不引入测试框架 —— 直接用 devDependencies 里已有的 tsx 运行。
 *
 * 这里每条断言都针对字面量输入、不需要 fixture，因此能**完整地**钉住行为：
 * 其中任何一条失败，都说明规则真的变了。
 *
 * 用法：npm run verify:rules（或 `npm run verify:all` 跑全部验证脚本）
 */

import {
  ANY_STATUS_PREFIX,
  DOUBAN_EXPRESSED_STATUSES,
  LISTEN_STATUS_MAP,
  PLAY_STATUS_MAP,
  RATING_TEXT_TO_STARS,
  READ_STATUS_MAP,
  SEE_STATUS_MAP,
  STRIP_STATUS_PREFIX,
  doubanStarsToTenPoint,
} from '../src/rules/douban';
import {
  BANGUMI_STATUSES_ABSENT_FROM_DOUBAN,
  BANGUMI_TO_NEODB_STATUS,
  CATEGORY_TO_BANGUMI_TYPES,
  NEODB_TO_BANGUMI_COLLECTION,
  bangumiCollectionToNeodbProgress,
  bangumiSubjectTypesForCategories,
  neodbItemSupportsProgress,
  resolveBangumiCollectionWrite,
} from '../src/rules/bangumi-neodb';
import { mergeNeodbMark } from '../src/rules/neodb-mark-merge';
import { classifyReadFailure } from '../src/rules/read-result';
import { extractItemInfo } from '../src/clients/douban-rss';
import {
  ItemReadError,
  PathAbortedError,
  readOptionalOrThrow,
  readValueOrThrow,
} from '../src/paths/read';
import { normalizeTitleKey, pickExactTmdbMatch } from '../src/rules/tmdb-matching';
import {
  NEODB_CATEGORIES_WITHOUT_TMDB,
  NEODB_TO_TMDB_MEDIA_TYPE,
  collectTitles,
  extractImdbIdFromNeodb,
  extractNeodbYear,
  extractTmdbTargetFromNeodb,
  toShelfType,
} from '../src/rules/tmdb-mapping';
import {
  NOTION_COLUMN_TYPES,
  PAGE_ICON_EMOJI,
  buildPropertyValue,
} from '../src/rules/notion-payload';
import {
  DB_PROPERTIES,
  ItemCategory,
  ItemStatus,
  NotionPropTypesEnum,
  type NeodbItem,
  type NotionNumberPropType,
  type NotionRichTextPropType,
  type NotionUrlPropType,
  type ReviewDetail,
  type TmdbSearchResult,
} from '../src/types';
import { groupByReason, renderDetailLines } from '../src/rules/review-detail';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL   ${name}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function neodbItem(over: Partial<NeodbItem> = {}): NeodbItem {
  return {
    id: 'item-1',
    type: 'Movie',
    uuid: 'uuid-1',
    url: '/movie/uuid-1',
    api_url: '/api/movie/uuid-1',
    category: 'movie',
    parent_uuid: null,
    display_title: '搏击俱乐部',
    title: '搏击俱乐部',
    brief: '',
    description: '',
    cover_image_url: '',
    rating: 0,
    rating_count: 0,
    external_resources: [],
    ...over,
  };
}

function searchResult(over: Partial<TmdbSearchResult> = {}): TmdbSearchResult {
  return { id: 550, media_type: 'movie', title: '搏击俱乐部', ...over };
}

// ───────────────────────────────────────────────────────────────────────────
// Star conversion
// 星制换算
// ───────────────────────────────────────────────────────────────────────────

section('doubanStarsToTenPoint — 1–5 星 → 0–10 分');

check('5 stars → 10', doubanStarsToTenPoint(5) === 10);
check('1 star → 2', doubanStarsToTenPoint(1) === 2);
check('3 stars → 6', doubanStarsToTenPoint(3) === 6);
check(
  '0 / null / undefined all mean unrated → 0',
  doubanStarsToTenPoint(0) === 0 &&
    doubanStarsToTenPoint(null) === 0 &&
    doubanStarsToTenPoint(undefined) === 0,
);

// ───────────────────────────────────────────────────────────────────────────
// Douban status vocabulary
// 豆瓣状态词汇
// ───────────────────────────────────────────────────────────────────────────

section('Douban status vocabulary / 豆瓣状态词汇');

check(
  'ANY_STATUS_PREFIX matches 看过 / 最近在看 / 想读 / 玩过',
  ['看过 肖申克的救赎', '最近在看 某剧', '想读 某书', '玩过 某游戏'].every((t) =>
    Boolean(t.match(ANY_STATUS_PREFIX)?.[1]),
  ),
);
check(
  'ANY_STATUS_PREFIX captures the status word itself',
  '看过 肖申克的救赎'.match(ANY_STATUS_PREFIX)?.[1] === '看过',
);
check(
  'ANY_STATUS_PREFIX does not match a title with no status word',
  ANY_STATUS_PREFIX.test('肖申克的救赎') === false,
);
check(
  'STRIP_STATUS_PREFIX removes the prefix and its trailing space',
  '看过 肖申克的救赎'.replace(STRIP_STATUS_PREFIX, '') === '肖申克的救赎',
);
check(
  'STRIP_STATUS_PREFIX also removes 最近',
  '最近在看 某剧'.replace(STRIP_STATUS_PREFIX, '') === '某剧',
);
check(
  'RATING_TEXT_TO_STARS covers all five star words',
  Object.keys(RATING_TEXT_TO_STARS).length === 5 &&
    RATING_TEXT_TO_STARS.很差 === 1 &&
    RATING_TEXT_TO_STARS.力荐 === 5,
);
check(
  'SEE_STATUS_MAP covers 看过 / 在看 / 想看',
  SEE_STATUS_MAP.看过 === ItemStatus.Complete &&
    SEE_STATUS_MAP.在看 === ItemStatus.Progress &&
    SEE_STATUS_MAP.想看 === ItemStatus.Wishlist,
);
check(
  'READ_STATUS_MAP covers 读过 / 在读 / 想读',
  READ_STATUS_MAP.读过 === ItemStatus.Complete &&
    READ_STATUS_MAP.在读 === ItemStatus.Progress &&
    READ_STATUS_MAP.想读 === ItemStatus.Wishlist,
);
check(
  'PLAY_STATUS_MAP covers 玩过 / 在玩 / 想玩',
  PLAY_STATUS_MAP.玩过 === ItemStatus.Complete &&
    PLAY_STATUS_MAP.在玩 === ItemStatus.Progress &&
    PLAY_STATUS_MAP.想玩 === ItemStatus.Wishlist,
);
check(
  'LISTEN_STATUS_MAP covers 听过 / 在听 / 想听',
  LISTEN_STATUS_MAP.听过 === ItemStatus.Complete &&
    LISTEN_STATUS_MAP.在听 === ItemStatus.Progress &&
    LISTEN_STATUS_MAP.想听 === ItemStatus.Wishlist,
);
check(
  'DOUBAN_EXPRESSED_STATUSES has exactly wishlist/progress/complete',
  DOUBAN_EXPRESSED_STATUSES.size === 3 &&
    DOUBAN_EXPRESSED_STATUSES.has(ItemStatus.Wishlist) &&
    DOUBAN_EXPRESSED_STATUSES.has(ItemStatus.Progress) &&
    DOUBAN_EXPRESSED_STATUSES.has(ItemStatus.Complete),
);
check(
  'DOUBAN_EXPRESSED_STATUSES excludes dropped',
  DOUBAN_EXPRESSED_STATUSES.has(ItemStatus.Dropped) === false,
);
// The four maps must not overlap: 看过 must never be reachable from a book title.
check(
  'the four status maps are disjoint',
  Object.keys(SEE_STATUS_MAP).every(
    (k) =>
      !(k in READ_STATUS_MAP) && !(k in PLAY_STATUS_MAP) && !(k in LISTEN_STATUS_MAP),
  ),
);

// ───────────────────────────────────────────────────────────────────────────
// Bangumi ↔ NeoDB status mapping
// Bangumi ↔ NeoDB 状态映射
// ───────────────────────────────────────────────────────────────────────────

section('Bangumi ↔ NeoDB status mapping / 状态映射');

check(
  'NEODB_TO_BANGUMI_COLLECTION maps the four statuses',
  NEODB_TO_BANGUMI_COLLECTION[ItemStatus.Wishlist] === 1 &&
    NEODB_TO_BANGUMI_COLLECTION[ItemStatus.Complete] === 2 &&
    NEODB_TO_BANGUMI_COLLECTION[ItemStatus.Progress] === 3 &&
    NEODB_TO_BANGUMI_COLLECTION[ItemStatus.Dropped] === 5,
);
check(
  'BANGUMI_TO_NEODB_STATUS maps 1/2/3/5 back',
  BANGUMI_TO_NEODB_STATUS[1] === ItemStatus.Wishlist &&
    BANGUMI_TO_NEODB_STATUS[2] === ItemStatus.Complete &&
    BANGUMI_TO_NEODB_STATUS[3] === ItemStatus.Progress &&
    BANGUMI_TO_NEODB_STATUS[5] === ItemStatus.Dropped,
);
check(
  'BANGUMI_TO_NEODB_STATUS folds 4 (搁置) into progress',
  BANGUMI_TO_NEODB_STATUS[4] === ItemStatus.Progress,
);
check(
  'round-trip wishlist/complete/progress/dropped is stable',
  [
    ItemStatus.Wishlist,
    ItemStatus.Complete,
    ItemStatus.Progress,
    ItemStatus.Dropped,
  ].every((s) => BANGUMI_TO_NEODB_STATUS[NEODB_TO_BANGUMI_COLLECTION[s]] === s),
);
check(
  'BANGUMI_STATUSES_ABSENT_FROM_DOUBAN is exactly {4, 5}',
  BANGUMI_STATUSES_ABSENT_FROM_DOUBAN.size === 2 &&
    BANGUMI_STATUSES_ABSENT_FROM_DOUBAN.has(4) &&
    BANGUMI_STATUSES_ABSENT_FROM_DOUBAN.has(5),
);
check(
  'every Douban category except drama has Bangumi subject types',
  [ItemCategory.Movie, ItemCategory.Book, ItemCategory.Music, ItemCategory.Game].every(
    (c) => (CATEGORY_TO_BANGUMI_TYPES[c] ?? []).length > 0,
  ),
);
check(
  'drama deliberately has no Bangumi subject type',
  CATEGORY_TO_BANGUMI_TYPES[ItemCategory.Drama] === undefined,
);
check(
  'movie searches both anime (2) and real (6)',
  JSON.stringify(CATEGORY_TO_BANGUMI_TYPES[ItemCategory.Movie]) === '[2,6]',
);

// ───────────────────────────────────────────────────────────────────────────
// Category allowlist → subject_type
// 分类白名单 → subject_type
// ───────────────────────────────────────────────────────────────────────────

section('bangumiSubjectTypesForCategories / 分类白名单 → subject_type');

check(
  'an empty category set needs no subject_type',
  bangumiSubjectTypesForCategories([]).length === 0,
);
check(
  'game maps to subject_type 4 (games are a first-class category)',
  JSON.stringify(bangumiSubjectTypesForCategories(['game'])) === '[4]',
);
check(
  'anime + real map to 2 and 6, sorted',
  JSON.stringify(bangumiSubjectTypesForCategories(['real', 'anime'])) === '[2,6]',
);
check(
  'manga maps to the book subject_type 1',
  JSON.stringify(bangumiSubjectTypesForCategories(['manga'])) === '[1]',
);
check(
  'book + music map to 1 and 3',
  JSON.stringify(bangumiSubjectTypesForCategories(['music', 'book'])) === '[1,3]',
);
check(
  'book + manga collapse to a single 1',
  JSON.stringify(bangumiSubjectTypesForCategories(['book', 'manga'])) === '[1]',
);

// ───────────────────────────────────────────────────────────────────────────
// Progress mapping
// 进度映射
// ───────────────────────────────────────────────────────────────────────────

section('bangumiCollectionToNeodbProgress / 进度映射');

check(
  'anime (2) with ep_status 12 → episode 12',
  bangumiCollectionToNeodbProgress({ subject_type: 2, ep_status: 12 })?.type ===
    'episode' &&
    bangumiCollectionToNeodbProgress({ subject_type: 2, ep_status: 12 })?.value ===
      '12',
);
check(
  'real (6) with ep_status 1 → episode 1',
  bangumiCollectionToNeodbProgress({ subject_type: 6, ep_status: 1 })?.value === '1',
);
check(
  'anime with ep_status 0 → null (do not clear progress)',
  bangumiCollectionToNeodbProgress({ subject_type: 2, ep_status: 0 }) === null,
);
check(
  'book (1) prefers vol_status → chapter',
  bangumiCollectionToNeodbProgress({ subject_type: 1, vol_status: 3, ep_status: 9 })
    ?.type === 'chapter' &&
    bangumiCollectionToNeodbProgress({ subject_type: 1, vol_status: 3, ep_status: 9 })
      ?.value === '3',
);
check(
  'book falls back to ep_status when vol_status is 0',
  bangumiCollectionToNeodbProgress({ subject_type: 1, vol_status: 0, ep_status: 5 })
    ?.value === '5',
);
check(
  'book with nothing set → null',
  bangumiCollectionToNeodbProgress({ subject_type: 1 }) === null,
);
check(
  'music (3) with ep_status 4 → track 4',
  bangumiCollectionToNeodbProgress({ subject_type: 3, ep_status: 4 })?.type === 'track',
);
check(
  'game (4) is never mapped → null',
  bangumiCollectionToNeodbProgress({ subject_type: 4, ep_status: 20 }) === null,
);

section('neodbItemSupportsProgress / 进度类型与目标分类的兼容性');

check(
  'episode + tv → allowed',
  neodbItemSupportsProgress({ category: 'tv' }, { type: 'episode', value: '1' }),
);
check(
  'episode + movie → refused (movie shares subject_type 6 with TV)',
  neodbItemSupportsProgress({ category: 'movie' }, { type: 'episode', value: '1' }) ===
    false,
);
check(
  'chapter + book → allowed',
  neodbItemSupportsProgress({ category: 'book' }, { type: 'chapter', value: '1' }),
);
check(
  'chapter + movie → refused',
  neodbItemSupportsProgress({ category: 'movie' }, { type: 'chapter', value: '1' }) ===
    false,
);
check(
  'page + book → allowed',
  neodbItemSupportsProgress({ category: 'book' }, { type: 'page', value: '1' }),
);
check(
  'track + music → allowed',
  neodbItemSupportsProgress({ category: 'music' }, { type: 'track', value: '1' }),
);
check(
  'track + book → refused',
  neodbItemSupportsProgress({ category: 'book' }, { type: 'track', value: '1' }) ===
    false,
);
check(
  'unknown type + movie (by category or type field) → refused',
  neodbItemSupportsProgress({ category: 'movie' }, { type: 'cycle', value: '1' }) ===
    false &&
    neodbItemSupportsProgress({ type: 'movie' }, { type: 'cycle', value: '1' }) ===
      false,
);
check(
  'unknown type + book → allowed (do not silently drop the progress)',
  neodbItemSupportsProgress({ category: 'book' }, { type: 'cycle', value: '1' }),
);
check(
  'category matching is case-insensitive',
  neodbItemSupportsProgress({ category: 'TV' }, { type: 'episode', value: '1' }),
);

// ───────────────────────────────────────────────────────────────────────────
// Douban → Bangumi write plan (rating retention)
// 豆瓣 → Bangumi 写入计划（评分保留）
// ───────────────────────────────────────────────────────────────────────────

section('resolveBangumiCollectionWrite / 豆瓣 → Bangumi 写入计划');

const keptRate = resolveBangumiCollectionWrite({
  desiredType: 2,
  desiredRate: 6,
  desiredComment: '好看',
  existing: { type: 2, rate: 8, comment: '好看' },
});
check(
  'an existing rate of 8 wins over the incoming 6',
  keptRate.rate === 8 && keptRate.keepExistingRate,
);
check(
  'same type/comment plus the kept rate → unchanged (so it does not rewrite every run)',
  keptRate.unchanged,
);

const keptRateStatusChange = resolveBangumiCollectionWrite({
  desiredType: 3,
  desiredRate: 6,
  desiredComment: '好看',
  existing: { type: 2, rate: 8, comment: '好看' },
});
check(
  'a status change still writes, and still keeps the rate',
  keptRateStatusChange.unchanged === false && keptRateStatusChange.rate === 8,
);

const zeroExistingRate = resolveBangumiCollectionWrite({
  desiredType: 2,
  desiredRate: 6,
  desiredComment: '',
  existing: { type: 2, rate: 0, comment: '' },
});
check(
  'an empty (0) existing rate is filled from Douban',
  zeroExistingRate.rate === 6 && zeroExistingRate.keepExistingRate === false,
);
check(
  'rate 0 differs from the incoming 6 → it must write',
  zeroExistingRate.unchanged === false,
);

const freshCollection = resolveBangumiCollectionWrite({
  desiredType: 1,
  desiredRate: 4,
  desiredComment: '',
  existing: null,
});
check(
  'no existing collection → create with the Douban rate',
  freshCollection.rate === 4 && freshCollection.unchanged === false,
);

const unratedDouban = resolveBangumiCollectionWrite({
  desiredType: 2,
  desiredRate: 0,
  desiredComment: '',
  existing: { type: 2, rate: 8, comment: '' },
});
check(
  'Douban without a rating cannot clear the Bangumi one',
  unratedDouban.rate === 8 && unratedDouban.unchanged,
);

// ───────────────────────────────────────────────────────────────────────────
// NeoDB mark merge
// NeoDB 标记合并
// ───────────────────────────────────────────────────────────────────────────

section('mergeNeodbMark / 标记合并');

const source = { shelfType: 'complete', ratingGrade: 8, comment: '来自豆瓣' };

{
  const merged = mergeNeodbMark(null, source, 'neodb_prefer', 2);
  check('no existing mark → write source values', merged.shouldWrite);
  check('no existing mark → rating/comment come from source', merged.ratingGrade === 8);
  check(
    'no existing mark → keptRating/keptComment are false',
    !merged.keptRating && !merged.keptComment,
  );
}

{
  const existing = {
    shelf_type: 'complete',
    visibility: 2,
    rating_grade: 10,
    comment_text: 'NeoDB 原有',
  };
  const merged = mergeNeodbMark(existing, source, 'neodb_prefer', 2);
  check('neodb_prefer keeps the existing rating', merged.ratingGrade === 10);
  check('neodb_prefer keeps the existing comment', merged.comment === 'NeoDB 原有');
  check(
    'neodb_prefer reports which fields were kept',
    merged.keptRating && merged.keptComment,
  );
  check(
    'neodb_prefer with identical status → no write needed',
    merged.shouldWrite === false,
  );
}

{
  const existing = {
    shelf_type: 'progress',
    visibility: 2,
    rating_grade: 0,
    comment_text: '',
  };
  const merged = mergeNeodbMark(existing, source, 'neodb_prefer', 2);
  check(
    'neodb_prefer with an empty existing rating still takes the source rating',
    merged.ratingGrade === 8,
  );
  check(
    'neodb_prefer fills an empty comment from source',
    merged.comment === '来自豆瓣',
  );
  check(
    'kept flags stay false when nothing was kept',
    !merged.keptRating && !merged.keptComment,
  );
  check('a status change forces a write', merged.shouldWrite);
}

{
  const existing = {
    shelf_type: 'wishlist',
    visibility: 2,
    rating_grade: 3,
    comment_text: 'x',
  };
  const merged = mergeNeodbMark(existing, source, 'overwrite', 2);
  check('overwrite replaces the rating', merged.ratingGrade === 8);
  check('overwrite replaces the comment', merged.comment === '来自豆瓣');
  check(
    'overwrite never reports kept fields',
    !merged.keptRating && !merged.keptComment,
  );
}

{
  const existing = {
    shelf_type: 'complete',
    visibility: 0,
    rating_grade: 8,
    comment_text: '来自豆瓣',
  };
  const merged = mergeNeodbMark(existing, source, 'overwrite', 2);
  check(
    'a visibility mismatch forces a write even when everything else matches',
    merged.shouldWrite,
  );
}

{
  const existing = {
    shelf_type: 'complete',
    visibility: 2,
    rating_grade: 8,
    comment_text: '来自豆瓣',
  };
  const merged = mergeNeodbMark(existing, source, 'overwrite', 2);
  check(
    'fully identical mark → shouldWrite false (idempotent)',
    merged.shouldWrite === false,
  );
}

{
  const merged = mergeNeodbMark(
    { shelf_type: 'complete', rating_grade: 0, comment_text: '' },
    source,
    'overwrite',
    2,
  );
  check(
    'a missing existing visibility is compared against target visibility, not treated as absent',
    merged.shouldWrite === true,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Title matching
// 标题匹配
// ───────────────────────────────────────────────────────────────────────────

section('normalizeTitleKey / pickExactTmdbMatch / 标题匹配');

check('normalizeTitleKey folds case', normalizeTitleKey('The Matrix') === 'thematrix');
check(
  'normalizeTitleKey strips all whitespace, including inner runs',
  normalizeTitleKey('  The   Matrix  ') === 'thematrix',
);
check(
  'different spacing/case collide on the same key',
  normalizeTitleKey('Fight Club') === normalizeTitleKey('fight  club'),
);
check(
  'pickExactTmdbMatch accepts an exact normalised title',
  pickExactTmdbMatch([searchResult()], '搏击俱乐部')?.id === 550,
);
check(
  'pickExactTmdbMatch is case-insensitive',
  pickExactTmdbMatch([searchResult({ title: 'Fight Club' })], 'fight club')?.id === 550,
);
check(
  'pickExactTmdbMatch never settles for a near match',
  pickExactTmdbMatch([searchResult({ title: '搏击俱乐部 2' })], '搏击俱乐部') === null,
);
check(
  'pickExactTmdbMatch returns null for an empty title',
  pickExactTmdbMatch([searchResult()], '   ') === null,
);
check(
  'year within tolerance (±1) is accepted',
  pickExactTmdbMatch([searchResult({ release_date: '1999-10-15' })], '搏击俱乐部', 2000)
    ?.id === 550,
);
check(
  'year outside tolerance is rejected',
  pickExactTmdbMatch(
    [searchResult({ release_date: '1980-01-01' })],
    '搏击俱乐部',
    2000,
  ) === null,
);
check(
  'a result with no date is rejected when a year is expected',
  pickExactTmdbMatch([searchResult()], '搏击俱乐部', 2000) === null,
);
check(
  'a result with no date is accepted when no year is expected',
  pickExactTmdbMatch([searchResult()], '搏击俱乐部')?.id === 550,
);
check(
  'TV results are matched via `name`',
  pickExactTmdbMatch([searchResult({ title: undefined, name: '某剧' })], '某剧')?.id ===
    550,
);

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB extractors (the rest are covered by verify-tmdb-mapping)
// NeoDB → TMDB 提取函数（其余由 verify-tmdb-mapping 覆盖）
// ───────────────────────────────────────────────────────────────────────────

section('NeoDB extractors / NeoDB 提取函数');

check(
  'NEODB_TO_TMDB_MEDIA_TYPE only knows movie and tv',
  Object.keys(NEODB_TO_TMDB_MEDIA_TYPE).length === 2 &&
    NEODB_TO_TMDB_MEDIA_TYPE.movie === 'movie' &&
    NEODB_TO_TMDB_MEDIA_TYPE.tv === 'tv',
);
check(
  'NEODB_CATEGORIES_WITHOUT_TMDB lists the five unsyncable categories',
  NEODB_CATEGORIES_WITHOUT_TMDB.size === 5 &&
    NEODB_CATEGORIES_WITHOUT_TMDB.has('book') &&
    NEODB_CATEGORIES_WITHOUT_TMDB.has('performance'),
);
check(
  'toShelfType accepts the four shelf types',
  toShelfType('wishlist') === 'wishlist' &&
    toShelfType('progress') === 'progress' &&
    toShelfType('complete') === 'complete' &&
    toShelfType('dropped') === 'dropped',
);
check('toShelfType rejects anything else', toShelfType('watched') === null);
check(
  'extractNeodbYear prefers `year`',
  extractNeodbYear(neodbItem({ year: 1999, pub_year: 2001 })) === 1999,
);
check(
  'extractNeodbYear falls back to `pub_year` for books',
  extractNeodbYear(neodbItem({ pub_year: 2001 })) === 2001,
);
check(
  'extractNeodbYear ignores 0 and negative values',
  extractNeodbYear(neodbItem({ year: 0 })) === undefined,
);
check(
  'extractImdbIdFromNeodb reads the tt id',
  extractImdbIdFromNeodb(
    neodbItem({
      external_resources: [{ url: 'https://www.imdb.com/title/tt0137523/' }],
    }),
  ) === 'tt0137523',
);
check(
  'extractImdbIdFromNeodb returns null without an IMDb link',
  extractImdbIdFromNeodb(neodbItem({ external_resources: [] })) === null,
);
check(
  'extractTmdbTargetFromNeodb parses both media types',
  extractTmdbTargetFromNeodb(
    neodbItem({ external_resources: [{ url: 'https://www.themoviedb.org/tv/1399' }] }),
  )?.mediaType === 'tv',
);
check(
  'extractTmdbTargetFromNeodb returns null without a TMDB link',
  extractTmdbTargetFromNeodb(neodbItem()) === null,
);
check(
  'collectTitles de-duplicates and keeps display_title first',
  JSON.stringify(
    collectTitles(
      neodbItem({
        display_title: '搏击俱乐部',
        title: '搏击俱乐部',
        localized_title: [{ text: 'Fight Club' }],
      }),
    ),
  ) === JSON.stringify(['搏击俱乐部', 'Fight Club']),
);

// ───────────────────────────────────────────────────────────────────────────
// Notion property payloads
// Notion 属性载荷
// ───────────────────────────────────────────────────────────────────────────

section('buildPropertyValue / Notion 属性载荷');

check(
  'NOTION_COLUMN_TYPES covers every column except NAME',
  Object.keys(NOTION_COLUMN_TYPES).length === Object.keys(DB_PROPERTIES).length - 1 &&
    !('NAME' in NOTION_COLUMN_TYPES),
);
check(
  'PAGE_ICON_EMOJI has one icon per Douban category',
  Object.keys(PAGE_ICON_EMOJI).length === 5 && PAGE_ICON_EMOJI.movie === '🎞',
);

check(
  'TITLE → {title:[{text:{content}}]}',
  JSON.stringify(buildPropertyValue('标题', NotionPropTypesEnum.TITLE, 'k')) ===
    JSON.stringify({
      type: 'title',
      title: [{ text: { content: '标题' } }],
    }),
);
check(
  'FILES → an external file whose url is the value',
  (
    buildPropertyValue(
      'https://img1.doubanio.com/a.jpg',
      NotionPropTypesEnum.FILES,
      'k',
    ) as any
  ).files[0].external.url === 'https://img1.doubanio.com/a.jpg',
);
check(
  'DATE → {date:{start}}',
  (buildPropertyValue('1999-10-15', NotionPropTypesEnum.DATE, 'k') as any).date
    .start === '1999-10-15',
);
check(
  'URL → {url}',
  (
    buildPropertyValue(
      'https://example.com',
      NotionPropTypesEnum.URL,
      'k',
    ) as NotionUrlPropType
  ).url === 'https://example.com',
);
check(
  'MULTI_SELECT for 个人评分 carries a single value, not an array',
  (
    buildPropertyValue(
      '5',
      NotionPropTypesEnum.MULTI_SELECT,
      DB_PROPERTIES.RATING,
    ) as any
  ).multi_select[0].name === '5',
);
check(
  'MULTI_SELECT for 个人评分 with no value → empty list (never [undefined])',
  (
    buildPropertyValue(
      null,
      NotionPropTypesEnum.MULTI_SELECT,
      DB_PROPERTIES.RATING,
    ) as any
  ).multi_select.length === 0,
);
check(
  'MULTI_SELECT for 类型 maps an array of names',
  (
    buildPropertyValue(
      ['剧情', '犯罪'],
      NotionPropTypesEnum.MULTI_SELECT,
      DB_PROPERTIES.GENRE,
    ) as any
  ).multi_select.length === 2,
);
check(
  'RICH_TEXT → a single text block',
  (
    buildPropertyValue(
      '短评',
      NotionPropTypesEnum.RICH_TEXT,
      'k',
    ) as NotionRichTextPropType
  ).rich_text[0].text.content === '短评',
);
check(
  'RICH_TEXT with an empty value → empty string, not undefined',
  (
    buildPropertyValue(
      undefined,
      NotionPropTypesEnum.RICH_TEXT,
      'k',
    ) as NotionRichTextPropType
  ).rich_text[0].text.content === '',
);
check(
  'RICH_TEXT is truncated to 2000 characters (Notion 400s above that)',
  (
    buildPropertyValue(
      'x'.repeat(3000),
      NotionPropTypesEnum.RICH_TEXT,
      'k',
    ) as NotionRichTextPropType
  ).rich_text[0].text.content.length === 2000,
);
check(
  'RICH_TEXT keeps a 2000-character value intact',
  (
    buildPropertyValue(
      'x'.repeat(2000),
      NotionPropTypesEnum.RICH_TEXT,
      'k',
    ) as NotionRichTextPropType
  ).rich_text[0].text.content.length === 2000,
);
check(
  'NUMBER keeps a positive integer',
  (buildPropertyValue(9, NotionPropTypesEnum.NUMBER, 'k') as NotionNumberPropType)
    .number === 9,
);
check(
  'NUMBER maps 0 to null (so Notion does not render a literal 0)',
  (buildPropertyValue(0, NotionPropTypesEnum.NUMBER, 'k') as NotionNumberPropType)
    .number === null,
);
check(
  'an unknown property type yields undefined, so the caller skips that column',
  buildPropertyValue('x', 'not-a-type' as NotionPropTypesEnum, 'k') === undefined,
);

// ───────────────────────────────────────────────────────────────────────────
// Review detail listing — the arithmetic that has to agree with the counters
// 待核对明细清单 —— 必须与计数器对得上的那部分算术
//
// These assertions exist because the failure mode is silent: a truncated list that claims
// "… and 3 more" while hiding 40 entries reads exactly like a complete one. The invariant under
// test is `listed + omitted === items.length` for every shape of input.
// 这些断言针对的是一种**无声**的失效：一份截断后声称「… and 3 more」却藏了 40 条的清单，
// 读起来与完整的一模一样。被测的不变式是：对任意输入形状，`listed + omitted === items.length`。
// ───────────────────────────────────────────────────────────────────────────

const detailMixed: ReviewDetail[] = [
  { title: 'a', url: '', reason: 'r1' },
  { title: 'b', url: '', reason: 'r2' },
  { title: 'c', url: '', reason: 'r1' },
];

check(
  'groupByReason keeps first-appearance order, not sorted-by-count order',
  groupByReason(detailMixed)
    .map((group) => group.reason)
    .join(',') === 'r1,r2',
);
check(
  'groupByReason merges entries sharing a reason',
  groupByReason(detailMixed)[0]?.items.length === 2,
);
check(
  'a small reason group expands to one line per entry',
  renderDetailLines(detailMixed).lines.length === 3,
);
check(
  'the expanded lines carry `label — reason`',
  renderDetailLines(detailMixed).lines[0] === 'a — r1',
);
check(
  'a url is composed into `标题[链接]`, the shape the console has always printed',
  renderDetailLines([{ title: '某书', url: 'https://book.douban.com/subject/1/', reason: 'r' }])
    .lines[0] === '某书[https://book.douban.com/subject/1/] — r',
);
check(
  'no url means no brackets, not an empty pair',
  renderDetailLines([{ title: '某书', url: '', reason: 'r' }]).lines[0] === '某书 — r',
);
check(
  'an entry with no title and no url is named (unnamed) rather than printed as an empty bullet',
  renderDetailLines([{ title: '  ', url: ' ', reason: 'r' }]).lines[0] === '(unnamed) — r',
);
check(
  'a url with no title still gets rendered, because it is the only handle there is',
  renderDetailLines([{ title: '', url: 'https://bgm.tv/subject/1', reason: 'r' }]).lines[0] ===
    'https://bgm.tv/subject/1 — r',
);

const manySame: ReviewDetail[] = Array.from({ length: 9 }, (_, index) => ({
  title: `item ${index + 1}`,
  url: '',
  reason: 'bulk',
}));
const collapsed = renderDetailLines(manySame);
check(
  'a reason group above the inline limit collapses into a single line',
  collapsed.lines.length === 1,
);
check(
  'the collapsed line carries the count and the first three examples',
  collapsed.lines[0] === 'bulk × 9（例：item 1、item 2、item 3 …）',
);
check(
  'a collapsed group still counts as fully listed',
  collapsed.listed === 9 && collapsed.omitted === 0,
);

const forty: ReviewDetail[] = ['r1', 'r2', 'r3', 'r4', 'r5'].flatMap((reason) =>
  Array.from({ length: 8 }, (_, index) => ({
    title: `${reason}-${index + 1}`,
    url: '',
    reason,
  })),
);
const capped = renderDetailLines(forty);
check(
  'the line budget stops before a reason group would be shown partially',
  capped.lines.length === 16,
);
check(
  'omitted counts every entry the budget cut, so listed + omitted === items.length',
  capped.listed + capped.omitted === forty.length && capped.omitted === 24,
);
check('an empty detail list renders nothing', renderDetailLines([]).lines.length === 0);

// ───────────────────────────────────────────────────────────────────────────
// extractItemInfo — the (status vocabulary, category, link shape) table
// extractItemInfo —— 那张（状态词汇、分类、链接形状）表
//
// This one imports the RSS client because the function lives there; nothing in it touches the
// network at import time. The five rows below are the table's contract: `看过` resolved by link
// host, and one row each for book / music / game.
// 这里导入 RSS 客户端只因为这个函数住在那里；它在导入期不碰网络。下面五行就是那张表的契约：
// `看过` 由链接域名决定，其余图书 / 音乐 / 游戏各一行。
// ───────────────────────────────────────────────────────────────────────────

check(
  '看过 + a film link resolves to movie',
  extractItemInfo('看过 海边的曼彻斯特', 'https://movie.douban.com/subject/26340039/')
    ?.category === ItemCategory.Movie,
);
check(
  '看过 + a stage-drama link resolves to drama',
  extractItemInfo('看过 如梦之梦', 'https://www.douban.com/location/drama/12103559/')
    ?.category === ItemCategory.Drama,
);
check(
  '读过 + a book link resolves to book, with the id',
  extractItemInfo('读过 三体', 'https://book.douban.com/subject/2567698/')?.id ===
    '2567698',
);
check(
  '听过 + a music link resolves to music',
  extractItemInfo('听过 依然', 'https://music.douban.com/subject/1395438/')
    ?.category === ItemCategory.Music,
);
check(
  '玩过 + a game link resolves to game',
  extractItemInfo('玩过 塞尔达传说', 'https://www.douban.com/game/26817171/')
    ?.category === ItemCategory.Game,
);
check(
  'an unrecognisable title yields nothing',
  extractItemInfo('随便写的标题', 'https://movie.douban.com/subject/1/') === undefined,
);

// ───────────────────────────────────────────────────────────────────────────
// classifyReadFailure — which failed reads may be written over
// classifyReadFailure —— 哪些读取失败允许被覆盖
//
// The whole point of the tri-state read is that only `absent` may be written over. If a 500 ever
// classifies as `absent`, the write that follows silently overwrites a rating the user set by
// hand, which is the bug `ReadResult` exists to prevent.
// 三态读取的全部要点就是：只有 `absent` 允许被覆盖。一旦 500 被归成 `absent`，接下来的写入
// 就会静默覆盖用户手设的评分 —— 那正是 `ReadResult` 要防的那个 bug。
// ───────────────────────────────────────────────────────────────────────────

check(
  '404 is "no mark here", the only answer a create may rest on',
  classifyReadFailure(404) === 'absent',
);
check(
  '404 on an endpoint that cannot answer "absent" is an item failure',
  classifyReadFailure(404, 'item') === 'item',
);
check('401 is the credentials, not the item', classifyReadFailure(401) === 'auth');
check(
  '403 is the same story as 401 for the caller',
  classifyReadFailure(403) === 'auth',
);
check(
  'a 500 is an item failure and must never be written over',
  classifyReadFailure(500) === 'item',
);
check(
  'no response at all is an item failure, not an absent record',
  classifyReadFailure(null) === 'item',
);

// `paths/read.ts` is where that classification turns into control flow. These assertions matter
// because the whole point is *which* exception comes out: `auth` must stop the path, everything
// else must merely fail one item.
// `paths/read.ts` 是把归类变成控制流的地方。这几条要钉的是**抛出哪一个**异常：`auth` 必须让整条
// 链路停下，其余只失败一条。
function caughtThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

check(
  'a found read hands the value back',
  readOptionalOrThrow({ status: 'found', value: 7 }, 'x') === 7,
);
check(
  'an absent read is the only one that yields null',
  readOptionalOrThrow({ status: 'absent' }, 'x') === null,
);
check(
  'an auth failure raises PathAbortedError, not an item error',
  caughtThrow(() =>
    readOptionalOrThrow({ status: 'error', scope: 'auth', message: '401' }, 'x'),
  ) instanceof PathAbortedError,
);
check(
  'an item failure raises ItemReadError',
  caughtThrow(() =>
    readOptionalOrThrow({ status: 'error', scope: 'item', message: '500' }, 'x'),
  ) instanceof ItemReadError,
);
check(
  'readValueOrThrow treats absent as an error too',
  caughtThrow(() => readValueOrThrow({ status: 'absent' }, 'x')) instanceof
    ItemReadError,
);

// ───────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
