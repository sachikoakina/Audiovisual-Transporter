import { describe, expect, it } from 'vitest';
import { evaluateNeodbIdentity } from '../../src/rules/neodb-identity';

const BANGUMI_URL = 'https://bgm.tv/subject/281272';
const DOUBAN_URL = 'https://movie.douban.com/subject/1/';

function item(over: Record<string, unknown> = {}) {
  return {
    uuid: 'uuid',
    category: 'tv',
    title: 'Title',
    display_title: 'Title',
    url: 'https://neodb.social/tv/uuid',
    api_url: 'https://neodb.social/api/tv/uuid',
    year: 2016,
    external_resources: [],
    ...over,
  } as never;
}

function evaluate(a: ReturnType<typeof item>, b: ReturnType<typeof item>) {
  return evaluateNeodbIdentity(a, b, {
    bangumiUrl: BANGUMI_URL,
    doubanUrl: DOUBAN_URL,
  });
}

describe('evaluateNeodbIdentity', () => {
  it('accepts the same uuid without further checks', () => {
    const a = item({
      uuid: 'same',
      category: 'tv',
      external_resources: [{ url: DOUBAN_URL }],
    });
    const b = item({ uuid: 'same', category: 'movie' });

    const result = evaluate(a, b);

    expect(result.level).toBe('same-uuid');
    expect(result.canonicalUuid).toBe('same');
  });

  it('accepts an exact IMDb match when the Douban item carries the Bangumi link', () => {
    const a = item({
      category: 'tv',
      external_resources: [
        { url: DOUBAN_URL },
        { url: 'https://www.imdb.com/title/tt1234567/' },
      ],
    });
    const b = item({
      uuid: 'douban',
      category: 'tv',
      external_resources: [
        { url: 'https://www.imdb.com/title/tt1234567/' },
        { url: BANGUMI_URL },
      ],
    });

    const result = evaluate(a, b);

    expect(result.level).toBe('strong-id');
    expect(result.canonicalUuid).toBe('douban');
    expect(result.reason).toBe('imdb-match');
  });

  it('keeps the Bangumi item when the strong match lacks a Bangumi link on the candidate', () => {
    const a = item({
      category: 'tv',
      external_resources: [
        { url: DOUBAN_URL },
        { url: 'https://www.imdb.com/title/tt1234567/' },
      ],
    });
    const b = item({
      uuid: 'douban',
      category: 'tv',
      external_resources: [{ url: 'https://www.imdb.com/title/tt1234567/' }],
    });

    const result = evaluate(a, b);

    expect(result.canonicalUuid).toBe('uuid');
    expect(result.reason).toBe('bangumi-link-missing');
  });

  it('rejects conflicting strong identifiers', () => {
    const a = item({
      external_resources: [
        { url: DOUBAN_URL },
        { url: 'https://www.imdb.com/title/tt1111111/' },
      ],
    });
    const b = item({
      uuid: 'douban',
      external_resources: [
        { url: 'https://www.imdb.com/title/tt2222222/' },
        { url: BANGUMI_URL },
      ],
    });

    const result = evaluate(a, b);

    expect(result.level).toBe('conflict');
    expect(result.canonicalUuid).toBe('uuid');
    expect(result.reason).toBe('strong-id-conflict');
  });

  it('accepts an exact ISBN match for books', () => {
    const a = item({
      category: 'book',
      isbn: '9780306406157',
      external_resources: [{ url: 'https://book.douban.com/subject/1/' }],
    });
    const b = item({
      uuid: 'douban-book',
      category: 'book',
      isbn: '9780306406157',
      external_resources: [{ url: BANGUMI_URL }],
    });

    const result = evaluate(a, b);

    expect(result.level).toBe('strong-id');
    expect(result.canonicalUuid).toBe('douban-book');
    expect(result.reason).toBe('isbn-match');
  });

  it('rejects a different media form', () => {
    const a = item({ category: 'book' });
    const b = item({ uuid: 'douban', category: 'movie' });

    const result = evaluate(a, b);

    expect(result.level).toBe('conflict');
    expect(result.reason).toBe('media-form-mismatch');
  });

  it('accepts reciprocal links with exact weak evidence', () => {
    const a = item({ external_resources: [{ url: DOUBAN_URL }] });
    const b = item({
      uuid: 'douban',
      external_resources: [{ url: BANGUMI_URL }],
    });

    // Same title/year, but neither side has a strong ID. Reciprocal links alone are
    // accepted by the strict L2 path; this test keeps the documented title/year match.
    const result = evaluate(a, b);

    expect(result.level).toBe('reciprocal-link');
    expect(result.canonicalUuid).toBe('douban');
  });

  it('returns unverified when there is no strong ID and no reciprocal link', () => {
    const a = item({ external_resources: [{ url: DOUBAN_URL }] });
    const b = item({ uuid: 'douban' });

    const result = evaluate(a, b);

    expect(result.level).toBe('unverified');
    expect(result.canonicalUuid).toBe('uuid');
  });
});
