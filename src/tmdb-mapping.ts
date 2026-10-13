import { neodbGradeToTmdbRating } from './const';
import type { ShelfType } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MAPPING — NeoDB shelf_type → TMDB operations.
 *
 *  This is the single source of truth for sync behaviour. To change what the
 *  sync does, change this table; nothing else encodes mapping knowledge.
 *
 *  | shelf_type | TMDB operation                                              |
 *  |------------|-------------------------------------------------------------|
 *  | wishlist   | add to watchlist                                            |
 *  | progress   | add to watchlist (TMDB has no "in progress" state)          |
 *  | complete   | rating_grade > 0 → set rating, remove from watchlist        |
 *  |            | otherwise        → add to watchlist                        |
 *  | dropped    | skip — do nothing on TMDB                                   |
 *
 *  Two consequences worth knowing:
 *
 *  1. `progress` adds to the watchlist rather than removing it. TMDB cannot
 *     express "in progress", so an in-progress item is treated as still-to-watch.
 *
 *  2. `complete` with no rating ALSO adds to the watchlist. TMDB has no
 *     "watched" flag, and rating is the closest available expression of having
 *     watched something — so an unrated completed item has no way to say
 *     "watched", and falls back to the watchlist. This means a watched-but-
 *     unrated item ends up looking like "want to watch". It is what the
 *     mapping specifies; it is called out here so it is never a surprise.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The TMDB operations a shelf state resolves to. */
export type TmdbOperationPlan = {
  /** true = perform no TMDB operation at all. */
  skip: boolean;
  /** true = add to watchlist, false = remove from watchlist, null = leave alone. */
  watchlist: boolean | null;
  /** TMDB rating to write (0.5–10), or null = write no rating. */
  rating: number | null;
  /** Human-readable explanation, surfaced in logs and dry-run output. */
  reason: string;
};

/**
 * Resolve a NeoDB shelf state into TMDB operations.
 *
 * Pure and reusable: same inputs always produce the same plan, no I/O, no
 * config access. `ratingGrade` is only consulted for `complete`.
 */
export function resolveTmdbOperations(
  shelfType: ShelfType,
  ratingGrade: number | null | undefined,
): TmdbOperationPlan {
  switch (shelfType) {
    case 'wishlist':
      return {
        skip: false,
        watchlist: true,
        rating: null,
        reason: '想看 → 加入 watchlist',
      };

    case 'progress':
      return {
        skip: false,
        // TMDB has no "in progress" state, so it is treated as still-to-watch.
        watchlist: true,
        rating: null,
        reason: '在看 → TMDB 无该状态，归入 watchlist',
      };

    case 'complete': {
      // 0 / null / undefined all mean "unrated" and normalise to null.
      const rating = neodbGradeToTmdbRating(ratingGrade);

      if (rating !== null) {
        return {
          skip: false,
          // The rating itself carries "watched", so the item leaves the watchlist.
          watchlist: false,
          rating,
          reason: `看过(评分 ${ratingGrade}) → 写入评分 ${rating} 并移出 watchlist`,
        };
      }

      return {
        skip: false,
        // No rating → nothing can express "watched" → fall back to watchlist.
        watchlist: true,
        rating: null,
        reason: '看过但无评分 → TMDB 无"已看"态，退化为加入 watchlist',
      };
    }

    case 'dropped':
      return {
        skip: true,
        watchlist: null,
        rating: null,
        reason: '弃看 → 跳过，不产生任何 TMDB 操作（不当作想看）',
      };
  }
}

/** Whether this plan would touch TMDB at all. */
export function planHasOperations(plan: TmdbOperationPlan): boolean {
  return !plan.skip && (plan.watchlist !== null || plan.rating !== null);
}
