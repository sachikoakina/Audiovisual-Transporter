/**
 * Bangumi → NeoDB target resolution is direct-only: the Bangumi URL selects the item, and a
 * Douban link already present on that item is metadata, never a reason to fetch or choose another.
 * Bangumi → NeoDB 目标解析只认直链：Bangumi URL 决定条目；条目已有的豆瓣链接只是元数据，
 * 绝不据此请求或改选其他条目。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const neodbClient = vi.hoisted(() => vi.fn());

vi.mock('../../src/clients/neodb-http', () => ({
  neodbClient: (...args: unknown[]) => neodbClient(...args),
  neodbFailureCode: () => 'test',
}));

const { resolveNeodbItemForBangumiUrlDetailed } =
  await import('../../src/clients/neodb-catalog');

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'id',
    type: 'Movie',
    uuid: 'direct',
    url: 'https://neodb.social/movie/direct',
    api_url: 'https://neodb.social/api/movie/direct',
    category: 'movie',
    parent_uuid: null,
    title: 'Title',
    display_title: 'Title',
    description: '',
    cover_image_url: '',
    rating: 0,
    rating_count: 0,
    external_resources: [],
    ...over,
  } as never;
}

describe('resolveNeodbItemForBangumiUrlDetailed', () => {
  beforeEach(() => {
    neodbClient.mockReset();
  });

  it('uses the Bangumi-linked item when it has no Douban link', async () => {
    neodbClient.mockReturnValueOnce({ json: async () => item() });

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/1',
    );

    expect(result.item?.uuid).toBe('direct');
    expect(result.doubanLinkPresent).toBe(false);
    expect(neodbClient).toHaveBeenCalledTimes(1);
  });

  it('keeps the Bangumi-linked item when it already has a Douban link', async () => {
    neodbClient.mockReturnValueOnce({
      json: async () =>
        item({
          external_resources: [{ url: 'https://movie.douban.com/subject/1/' }],
        }),
    });

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/1',
    );

    expect(result.item?.uuid).toBe('direct');
    expect(result.doubanLinkPresent).toBe(true);
    expect(neodbClient).toHaveBeenCalledTimes(1);
  });

  it('does not request a second catalog item when the direct item lacks one', async () => {
    neodbClient.mockReturnValueOnce({ json: async () => item() });

    await resolveNeodbItemForBangumiUrlDetailed('https://bgm.tv/subject/1');

    expect(neodbClient).toHaveBeenCalledTimes(1);
    expect(neodbClient.mock.calls[0]?.[0]).toBe('api/catalog/fetch');
  });

  it('reports a 404 as not-found', async () => {
    neodbClient.mockReturnValueOnce({
      json: async () => {
        throw { response: { statusCode: 404 } };
      },
    });

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/404',
    );

    expect(result.item).toBeNull();
    expect(result.failure).toBe('not-found');
  });
});
