/**
 * TMDB write plan — pure diffing of "what TMDB says" against "what the mapping resolves to".
 * TMDB 写入计划 —— 把「TMDB 当前状态」与「映射表解析出的操作」做纯比较。
 *
 * Kept free of runtime imports so the idempotency rules can be exercised offline
 * (see `scripts/verify-tmdb-mapping.ts`).
 * 刻意不含运行时导入，使幂等规则可以离线验证（见 `scripts/verify-tmdb-mapping.ts`）。
 */
import { extractTmdbRating, type TmdbOperationPlan } from './tmdb-mapping';
import type { RatingProfile, TmdbAccountStates } from '../types';

/** The minimal set of TMDB writes the caller must perform. / 调用方必须执行的最小 TMDB 写入集合。 */
export type TmdbPatch = {
  /** true = add to watchlist, false = remove, null = leave alone. / true = 加入 watchlist，false = 移出，null = 保持不动。 */
  setWatchlist: boolean | null;
  /** Rating to write, or null = write nothing. / 要写入的评分，null = 不写。 */
  setRating: number | null;
  /** false means the caller must issue **no** write requests at all. / false 表示调用方**不得**发出任何写入请求。 */
  shouldWrite: boolean;
  /** Why each field was or was not scheduled. / 每个字段为何被排入或未被排入。 */
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
 *
 * 把 TMDB 当前状态与解析好的操作计划做差异比较。
 *
 * 幂等契约 —— 每个字段在排入之前都先比较：
 *   已在目标 watchlist 状态 → 不写 watchlist
 *   已有评分（视 profile 而定）→ 不写评分
 *   计划为 skip           → 什么都不做
 *
 * `shouldWrite === false` 表示调用方**不得**发出任何写入请求。
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
    // 计划里没有评分：既不 POST 也不 DELETE。删除会抹掉用户在 TMDB 上手动设的评分。
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
