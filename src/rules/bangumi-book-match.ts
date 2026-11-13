/**
 * Book-specific candidate adjudication.
 *
 * A single exact-title candidate keeps the existing behaviour. Multiple exact candidates are not
 * ordered by API response: only a unique ISBN match may settle them. Missing or ambiguous ISBNs
 * become `ambiguous` so the caller records an unresolved item instead of writing to a random
 * edition.
 *
 * 书籍候选裁决：唯一精确同名候选保持现有行为；多个候选时不再取第一个，只有唯一 ISBN 命中才
 * 定案。缺少 ISBN 或命中多个时返回 ambiguous，交给待核对名单，而不是写到随机版次。
 */
import type { BangumiSubject } from '../clients/bangumi';
import { extractIsbns } from './isbn';

export type BookMatchResult =
  | { status: 'matched'; subject: BangumiSubject }
  | {
      status: 'ambiguous';
      reason: 'duplicate-isbn' | 'no-matching-isbn' | 'missing-source-isbn';
      candidates: BangumiSubject[];
    }
  | { status: 'no-candidate' };

/**
 * Pick a book by exact ISBN over already fully-read candidates.
 *
 * `sourceIsbn` must be normalized; `candidates` must carry `infobox` when available. A missing
 * source ISBN is not evidence against any candidate, but it also cannot disambiguate them, so
 * multiple candidates become ambiguous rather than first-hit.
 *
 * 用已归一化的源 ISBN 在**完整读取**的候选里裁决。源 ISBN 缺失不是反对证据，但无法消歧，
 * 因此多候选转为 ambiguous，而不是 first-hit。
 */
export function pickBookByIsbn(
  candidates: BangumiSubject[],
  sourceIsbn: string | null,
): BookMatchResult {
  if (!candidates.length) {
    return { status: 'no-candidate' };
  }
  if (!sourceIsbn) {
    return {
      status: 'ambiguous',
      reason: 'missing-source-isbn',
      candidates,
    };
  }

  const hits = candidates.filter(
    (candidate) => candidate.type === 1 && extractIsbns(candidate).includes(sourceIsbn),
  );
  if (hits.length === 1) {
    return { status: 'matched', subject: hits[0]! };
  }
  if (hits.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'duplicate-isbn',
      candidates: hits,
    };
  }
  return {
    status: 'ambiguous',
    reason: 'no-matching-isbn',
    candidates,
  };
}
