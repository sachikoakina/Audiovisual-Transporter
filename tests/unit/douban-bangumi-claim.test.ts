import { describe, expect, it } from 'vitest';
import {
  shouldSkipDoubanClaim,
  type DoubanTargetClaim,
} from '../../src/rules/douban-bangumi-claim';

function claim(over: Partial<DoubanTargetClaim>): DoubanTargetClaim {
  return {
    subjectId: 1,
    sourceId: 'https://book.douban.com/subject/1/',
    via: 'title',
    status: 'progress',
    ...over,
  };
}

describe('shouldSkipDoubanClaim', () => {
  it('keeps a direct link over a title claim even with weaker status', () => {
    const incumbent = claim({ via: 'link', status: 'wishlist', sourceId: 'a' });
    const incoming = claim({ via: 'title', status: 'complete', sourceId: 'b' });

    expect(shouldSkipDoubanClaim(incumbent, incoming)).toBe(true);
  });

  it('keeps complete over progress/wishlist when confidence is equal', () => {
    const incumbent = claim({ status: 'complete', sourceId: 'a' });
    const incoming = claim({ status: 'progress', sourceId: 'b' });

    expect(shouldSkipDoubanClaim(incumbent, incoming)).toBe(true);
    expect(shouldSkipDoubanClaim(incoming, incumbent)).toBe(false);
  });

  it('treats progress and wishlist as the same status tier', () => {
    const incumbent = claim({ status: 'progress', sourceId: 'a' });
    const incoming = claim({ status: 'wishlist', sourceId: 'b' });

    expect(shouldSkipDoubanClaim(incumbent, incoming)).toBe(true);
    expect(shouldSkipDoubanClaim(incumbent, claim({ sourceId: '0' }))).toBe(false);
  });

  it('lets the stronger claim replace an incumbent', () => {
    const weak = claim({ via: 'title', status: 'dropped', sourceId: 'a' });
    const strong = claim({ via: 'isbn', status: 'dropped', sourceId: 'z' });

    expect(shouldSkipDoubanClaim(weak, strong)).toBe(false);
  });

  it('does not block the same source from correcting itself', () => {
    const incumbent = claim({ status: 'complete', sourceId: 'same' });
    const incoming = claim({ status: 'wishlist', sourceId: 'same' });

    expect(shouldSkipDoubanClaim(incumbent, incoming)).toBe(false);
  });
});
