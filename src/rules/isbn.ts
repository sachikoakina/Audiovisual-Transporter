/**
 * ISBN normalization and extraction — pure functions, no IO.
 *
 * ISBN is a strong identity key for a book edition: a matching ISBN can settle a candidate
 * without falling back to publication year, which differs between reprints and translations.
 * Its coverage is incomplete (art books, independent publications, some older books), so it is
 * only positive evidence: a missing ISBN stays neutral and must never reject a candidate.
 *
 * 书籍版次的强身份键：ISBN 命中即可定案，不必再用出版年兜底（再版/译本年份必然有差）。
 * 但 ISBN 覆盖不完整，因此它只做正证据：缺失时保持中性，绝不否决候选。
 */
import type { BangumiSubject } from '../clients/bangumi';

/** ISBN-13 check digit: first 12 digits weighted 1/3, padded to a multiple of 10. / ISBN-13 校验位。 */
function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function isValidIsbn13(digits: string): boolean {
  return isbn13CheckDigit(digits.slice(0, 12)) === digits[12];
}

/** ISBN-10 check: weights 10..1, sum divisible by 11; X counts as 10. / ISBN-10 校验。 */
function isValidIsbn10(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = digits[i]!;
    const value = char === 'X' ? 10 : Number(char);
    if (!Number.isInteger(value)) return false;
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

/** Convert ISBN-10 to ISBN-13 so both forms compare directly. / 10 位转 13 位。 */
function isbn10To13(digits: string): string {
  const first12 = `978${digits.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

/**
 * Normalize: strip separators, convert 10 digits to 13, validate the check digit.
 * Invalid input returns null — dirty data must mean "no ISBN", not a wrong comparison.
 *
 * 归一化：去分隔符、10 位转 13 位、校验位验证。非法值返回 null，脏数据应当被视为「没有 ISBN」。
 */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 10) {
    return isValidIsbn10(digits) ? isbn10To13(digits) : null;
  }
  if (digits.length === 13) {
    return isValidIsbn13(digits) ? digits : null;
  }
  return null;
}

function pushIsbn(out: string[], raw: unknown): void {
  if (typeof raw !== 'string') return;
  const normalized = normalizeIsbn(raw);
  if (normalized && !out.includes(normalized)) {
    out.push(normalized);
  }
}

/**
 * All ISBNs a Bangumi candidate declares: the main infobox ISBN plus every matching ISBN under
 * `版本:*` entries. Edition sub-items must be included: a NeoDB Chinese edition may not use the
 * same ISBN as the Japanese main infobox, yet both describe the same work.
 *
 * 候选的全部 ISBN：主 infobox 的 ISBN，以及所有「版本:*」子项中的 ISBN。版本子项必须一起收，
 * 否则中文版/日文版会被误判成不同作品。
 */
export function extractIsbns(subject: BangumiSubject): string[] {
  const out: string[] = [];
  for (const item of subject.infobox ?? []) {
    const key = item?.key?.trim() ?? '';
    if (!key) continue;
    if (key === 'ISBN') {
      pushIsbn(out, item.value);
      continue;
    }
    if (key.startsWith('版本') && Array.isArray(item.value)) {
      for (const entry of item.value) {
        if (entry?.k?.trim() === 'ISBN') {
          pushIsbn(out, entry.v);
        }
      }
    }
  }
  return out;
}
