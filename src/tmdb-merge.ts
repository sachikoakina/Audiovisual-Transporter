import { extractTmdbRating } from './const';
import type { TmdbOperationPlan } from './tmdb-mapping';
import type { RatingProfile, TmdbAccountStates } from './types';

/**
 * Pure planning logic: given what TMDB currently says and what the mapping
 * resolves to, decide the minimal set of writes.
 *
 * Kept free of runtime imports so the idempotency rules can be exercised
 * offline (see scripts/verify-tmdb-mapping.ts).
 */

export type TmdbPatch = {
  /** true = add to watchlist, false = remove, null = leave alone. */
  setWatchlist: boolean | null;
  /** Rating to write, or null = write nothing. */
  setRating: number | null;
  shouldWrite: boolean;
  reasons: string[];
};

/**
 * Diff current TMDB state against a resolved operation plan.
 *
 * Idempotency contract — each field is compared before being scheduled:
 *   watchlist already at target  → no watchlist write
 *   already rated (per profile)  → no rating write
 *   plan says skip               → nothing at all
 *
 * `shouldWrite === false` means the caller must issue **no** write requests.
 */
export function planTmdbWrites(
  current: TmdbAccountStates | null,
  plan: TmdbOperationPlan,
  profile: RatingProfile,
): TmdbPatch {
  const reasons: string[] = [];

  if (plan.skip) {
    return {
      setWatchlist: null,
      setRating: null,
      shouldWrite: false,
      reasons: [plan.reason],
    };
  }

  // ── Watchlist ──────────────────────────────────────────────────────────
  let setWatchlist: boolean | null = null;
  if (plan.watchlist !== null) {
    const existing = current?.watchlist ?? false;
    if (existing === plan.watchlist) {
      reasons.push(`watchlist already ${existing}`);
    } else {
      setWatchlist = plan.watchlist;
      reasons.push(`watchlist ${existing} → ${plan.watchlist}`);
    }
  } else {
    reasons.push('watchlist untouched');
  }

  // ── Rating ─────────────────────────────────────────────────────────────
  let setRating: number | null = null;
  if (plan.rating === null) {
    // No rating in the plan: never POST, never DELETE. Deleting would wipe a
    // rating the user set by hand on TMDB.
    reasons.push('rating untouched');
  } else {
    const existingRating = extractTmdbRating(current);
    const keepExisting = profile === 'tmdb_prefer' && existingRating !== null;
    const effective = keepExisting ? existingRating : plan.rating;

    if (effective === existingRating) {
      reasons.push(`rating already ${effective}`);
    } else {
      setRating = effective;
      reasons.push(`rating ${existingRating ?? 'none'} → ${effective}`);
    }
  }

  const shouldWrite = setWatchlist !== null || setRating !== null;

  return { setWatchlist, setRating, shouldWrite, reasons };
}
