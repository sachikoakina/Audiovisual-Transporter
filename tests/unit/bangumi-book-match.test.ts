import { describe, expect, it } from 'vitest';
import { pickBookByIsbn } from '../../src/rules/bangumi-book-match';
import type { BangumiSubject } from '../../src/clients/bangumi';

function book(over: Partial<BangumiSubject>): BangumiSubject {
  return {
    id: 1,
    type: 1,
    name: 'same title',
    name_cn: '同名书',
    ...over,
  };
}

function withIsbn(id: number, isbn: string): BangumiSubject {
  return book({ id, infobox: [{ key: 'ISBN', value: isbn }] });
}

describe('pickBookByIsbn', () => {
  it('returns no-candidate for an empty list', () => {
    expect(pickBookByIsbn([], '9784047376465').status).toBe('no-candidate');
  });

  it('does not guess when the source ISBN is missing', () => {
    const picked = pickBookByIsbn([book({ id: 1 }), book({ id: 2 })], null);

    expect(picked).toMatchObject({
      status: 'ambiguous',
      reason: 'missing-source-isbn',
    });
  });

  it('matches the unique ISBN candidate', () => {
    const picked = pickBookByIsbn(
      [withIsbn(1, '9784047376465'), withIsbn(2, '9787513356756')],
      '9784047376465',
    );

    expect(picked).toMatchObject({ status: 'matched', subject: { id: 1 } });
  });

  it('treats duplicate ISBN hits as ambiguous', () => {
    const picked = pickBookByIsbn(
      [withIsbn(1, '9784047376465'), withIsbn(2, '9784047376465')],
      '9784047376465',
    );

    expect(picked).toMatchObject({
      status: 'ambiguous',
      reason: 'duplicate-isbn',
    });
  });

  it('does not fall back to the first candidate when no ISBN matches', () => {
    const picked = pickBookByIsbn(
      [withIsbn(1, '9784047376465'), withIsbn(2, '9787513356756')],
      '9780306406157',
    );

    expect(picked).toMatchObject({
      status: 'ambiguous',
      reason: 'no-matching-isbn',
    });
  });

  it('ignores non-book candidates when applying ISBN', () => {
    const anime = book({
      id: 9,
      type: 2,
      infobox: [{ key: 'ISBN', value: '9784047376465' }],
    });
    const picked = pickBookByIsbn([anime], '9784047376465');

    expect(picked.status).toBe('ambiguous');
  });
});
