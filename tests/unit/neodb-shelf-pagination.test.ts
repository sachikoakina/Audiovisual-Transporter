/**
 * `walkShelfPages`: when the walk stops because the visitor is done vs because the read failed.
 * `walkShelfPages`：遍历是因为访问者处理完了，还是因为读取失败。
 *
 * The distinction is what keeps a capped run from being labelled `partial`: a visitor returning
 * false stops on purpose and must not set `truncated`; a failed page or the page budget must.
 * 这正是「封顶」不被误标成 `partial` 的关键：访问者返回 false 是主动停止，不得置 `truncated`；
 * 失败页或页数预算才置位。
 */
import { describe, expect, it, vi } from 'vitest';
import type { NeodbPagedMark } from '../../src/types';

vi.mock('../../src/clients/neodb-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/clients/neodb-http')>()),
  neodbToken: 'test-token',
  neodbThrottle: async () => {},
}));

const { walkShelfPages } = await import('../../src/clients/neodb-shelf');

function paged(data: unknown[], pages = 5): NeodbPagedMark {
  return { data, pages, count: data.length } as unknown as NeodbPagedMark;
}

describe('walkShelfPages', () => {
  it('stops when the visitor returns false and does not call it truncated', async () => {
    const fetchPage = vi.fn(async ({ page }) => paged([{ uuid: `u${page}` }]));
    const visit = vi.fn(async () => false);

    const result = await walkShelfPages('wishlist', undefined, 10, visit, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(visit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ truncated: false });
  });

  it('marks a failed page as truncated', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(paged([{ uuid: 'u1' }]))
      .mockResolvedValueOnce(null);
    const visit = vi.fn(async () => true);

    const result = await walkShelfPages('wishlist', undefined, 10, visit, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ truncated: true });
  });

  it('marks the page budget as truncated when more pages remain', async () => {
    const fetchPage = vi.fn(async ({ page: n }) => paged([{ uuid: `u${n}` }], 5));
    const visit = vi.fn(async () => true);

    const result = await walkShelfPages('wishlist', undefined, 2, visit, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ truncated: true });
  });

  it('treats an empty page as a natural end, not truncation', async () => {
    const fetchPage = vi.fn(async () => paged([], 1));
    const visit = vi.fn(async () => true);

    const result = await walkShelfPages('wishlist', undefined, 10, visit, fetchPage);

    expect(visit).not.toHaveBeenCalled();
    expect(result).toEqual({ truncated: false });
  });

  it('hands the whole page to the visitor', async () => {
    const marks = [{ uuid: 'a' }, { uuid: 'b' }];
    const fetchPage = vi.fn(async () => paged(marks, 1));
    const visit = vi.fn(async () => true);

    await walkShelfPages('wishlist', 'movie', 10, visit, fetchPage);

    expect(visit).toHaveBeenCalledWith(marks);
  });
});
