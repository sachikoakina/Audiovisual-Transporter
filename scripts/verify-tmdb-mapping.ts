/*
 * Verify the mapping and the write planner offline.
 * No network, no framework — run with the tsx already in devDependencies.
 *
 * USAGE: npm run verify:mapping
 */

import {
  extractImdbIdFromNeodb,
  extractNeodbYear,
  extractTmdbTargetFromNeodb,
  neodbGradeToTmdbRating,
  toShelfType,
} from '../src/const';
import { resolveTmdbOperations } from '../src/tmdb-mapping';
import { planTmdbWrites } from '../src/tmdb-merge';
import type { NeodbItem, TmdbAccountStates } from '../src/types';

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

function item(over: Partial<NeodbItem> = {}): NeodbItem {
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

function states(over: Partial<TmdbAccountStates> = {}): TmdbAccountStates {
  return { id: 550, favorite: false, rated: false, watchlist: false, ...over };
}

// ───────────────────────────────────────────────────────────────────────────
section('THE MAPPING — shelf_type → TMDB operations');

{
  // wishlist → add to watchlist
  const plan = resolveTmdbOperations('wishlist', 0);
  check('wishlist: not skipped', plan.skip === false);
  check('wishlist: adds to watchlist', plan.watchlist === true);
  check('wishlist: writes no rating', plan.rating === null);
}

{
  // progress → add to watchlist (TMDB has no "in progress")
  const plan = resolveTmdbOperations('progress', 0);
  check('progress: not skipped', plan.skip === false);
  check('progress: adds to watchlist', plan.watchlist === true);
  check('progress: writes no rating', plan.rating === null);
}

{
  // progress ignores any grade it happens to carry
  const plan = resolveTmdbOperations('progress', 8);
  check(
    'progress: still only touches watchlist',
    plan.rating === null && plan.watchlist === true,
  );
}

{
  // complete + rating > 0 → set rating, remove from watchlist
  const plan = resolveTmdbOperations('complete', 8);
  check('complete(rated): not skipped', plan.skip === false);
  check('complete(rated): writes the rating', plan.rating === 8);
  check('complete(rated): removes from watchlist', plan.watchlist === false);
}

{
  const plan = resolveTmdbOperations('complete', 10);
  check('complete(10): writes 10', plan.rating === 10);
}

{
  // complete + no rating → add to watchlist (documented fallback)
  const plan = resolveTmdbOperations('complete', 0);
  check('complete(unrated): not skipped', plan.skip === false);
  check('complete(unrated): writes no rating', plan.rating === null);
  check('complete(unrated): falls back to watchlist', plan.watchlist === true);
}

{
  const plan = resolveTmdbOperations('complete', undefined);
  check('complete(undefined grade): falls back to watchlist', plan.watchlist === true);
}
{
  const plan = resolveTmdbOperations('complete', null);
  check('complete(null grade): falls back to watchlist', plan.watchlist === true);
}

{
  // dropped → skip entirely
  const plan = resolveTmdbOperations('dropped', 9);
  check('dropped: is skipped', plan.skip === true);
  check('dropped: touches no watchlist', plan.watchlist === null);
  check('dropped: writes no rating', plan.rating === null);
}

{
  // every branch must explain itself
  for (const shelf of ['wishlist', 'progress', 'complete', 'dropped'] as const) {
    const plan = resolveTmdbOperations(shelf, 6);
    check(
      `${shelf}: has a reason`,
      typeof plan.reason === 'string' && plan.reason.length > 0,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
section('rating conversion (NeoDB 0–10 → TMDB 0.5–10)');

check('0 means unrated → null', neodbGradeToTmdbRating(0) === null);
check('undefined → null', neodbGradeToTmdbRating(undefined) === null);
check('null → null', neodbGradeToTmdbRating(null) === null);
check('8 → 8', neodbGradeToTmdbRating(8) === 8);
check('9 → 9', neodbGradeToTmdbRating(9) === 9);
check('8.3 snaps to 8.5', neodbGradeToTmdbRating(8.3) === 8.5);
check('above range clamps to 10', neodbGradeToTmdbRating(999) === 10);
check('tiny value clamps to 0.5', neodbGradeToTmdbRating(0.2) === 0.5);

// ───────────────────────────────────────────────────────────────────────────
section('extracting targets from external_resources');

check(
  'TMDB movie link parsed',
  JSON.stringify(
    extractTmdbTargetFromNeodb(
      item({ external_resources: [{ url: 'https://www.themoviedb.org/movie/550' }] }),
    ),
  ) === JSON.stringify({ mediaType: 'movie', id: 550 }),
);
check(
  'TMDB tv link parsed',
  JSON.stringify(
    extractTmdbTargetFromNeodb(
      item({ external_resources: [{ url: 'https://www.themoviedb.org/tv/1399' }] }),
    ),
  ) === JSON.stringify({ mediaType: 'tv', id: 1399 }),
);
check(
  'IMDb id parsed',
  extractImdbIdFromNeodb(
    item({ external_resources: [{ url: 'https://www.imdb.com/title/tt0137523/' }] }),
  ) === 'tt0137523',
);
check(
  'douban link is not mistaken for imdb',
  extractImdbIdFromNeodb(
    item({
      external_resources: [{ url: 'https://movie.douban.com/subject/1292000/' }],
    }),
  ) === null,
);
check('no external resources → null', extractTmdbTargetFromNeodb(item()) === null);

// ───────────────────────────────────────────────────────────────────────────
section('year extraction (year for movie/tv, pub_year for books)');

check('movie year', extractNeodbYear(item({ year: 1999 })) === 1999);
check(
  'book pub_year',
  extractNeodbYear(item({ category: 'book', pub_year: 2005 })) === 2005,
);
check('missing year → undefined', extractNeodbYear(item()) === undefined);

// ───────────────────────────────────────────────────────────────────────────
section('shelf type parsing');

check('valid shelf type kept', toShelfType('complete') === 'complete');
check('dropped is a real shelf type', toShelfType('dropped') === 'dropped');
check('unknown shelf type → null', toShelfType('nonsense') === null);

// ───────────────────────────────────────────────────────────────────────────
section('idempotency — no redundant writes');

{
  // complete, rated, already removed from watchlist
  const plan = resolveTmdbOperations('complete', 8);
  const patch = planTmdbWrites(
    states({ rated: { value: 8 }, watchlist: false }),
    plan,
    'tmdb_prefer',
  );
  check('already-synced complete item issues no writes', patch.shouldWrite === false);
  check('no duplicate rating POST', patch.setRating === null);
  check('no duplicate watchlist change', patch.setWatchlist === null);
}

{
  // wishlist, already on the watchlist
  const plan = resolveTmdbOperations('wishlist', 0);
  const patch = planTmdbWrites(states({ watchlist: true }), plan, 'tmdb_prefer');
  check('already-in-watchlist issues no add', patch.setWatchlist === null);
  check('already-in-watchlist issues no writes', patch.shouldWrite === false);
}

{
  // complete, unrated, already on the watchlist
  const plan = resolveTmdbOperations('complete', 0);
  const patch = planTmdbWrites(states({ watchlist: true }), plan, 'tmdb_prefer');
  check(
    'unrated complete already watchlisted issues no writes',
    patch.shouldWrite === false,
  );
}

{
  // dropped never produces writes, whatever TMDB currently holds
  const plan = resolveTmdbOperations('dropped', 7);
  const patch = planTmdbWrites(
    states({ rated: { value: 7 }, watchlist: true }),
    plan,
    'tmdb_prefer',
  );
  check('dropped writes nothing', patch.shouldWrite === false);
  check('dropped does not clear the rating', patch.setRating === null);
  check('dropped does not touch the watchlist', patch.setWatchlist === null);
}

// ───────────────────────────────────────────────────────────────────────────
section('rating conflict profile');

{
  const plan = resolveTmdbOperations('complete', 6);
  const keep = planTmdbWrites(states({ rated: { value: 9 } }), plan, 'tmdb_prefer');
  check('tmdb_prefer keeps the existing TMDB rating', keep.setRating === null);

  const override = planTmdbWrites(states({ rated: { value: 9 } }), plan, 'overwrite');
  check('overwrite pushes the NeoDB rating', override.setRating === 6);
}

{
  // A missing/0 grade must never delete an existing TMDB rating.
  const plan = resolveTmdbOperations('complete', 0);
  const patch = planTmdbWrites(states({ rated: { value: 9 } }), plan, 'overwrite');
  check('unrated source never clears an existing rating', patch.setRating === null);
}

// ───────────────────────────────────────────────────────────────────────────
section('transition scenarios');

{
  // was on the watchlist (wishlist), now completed with a rating
  const plan = resolveTmdbOperations('complete', 8);
  const patch = planTmdbWrites(states({ watchlist: true }), plan, 'tmdb_prefer');
  check('wishlist → complete(rated): pushes rating', patch.setRating === 8);
  check('wishlist → complete(rated): leaves watchlist', patch.setWatchlist === false);
}

{
  // was on the watchlist (wishlist or progress), now completed unrated
  const plan = resolveTmdbOperations('complete', 0);
  const patch = planTmdbWrites(states({ watchlist: true }), plan, 'tmdb_prefer');
  check(
    'wishlist → complete(unrated): watchlist stays untouched',
    patch.shouldWrite === false,
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
