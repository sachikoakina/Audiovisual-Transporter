/**
 * Title twins must stay inside the category implied by the Bangumi subject type.
 * 标题孪生必须限定在 Bangumi subject type 对应的分类内。
 */
import { describe, expect, it, vi } from 'vitest';

const neodbClient = vi.fn();

vi.mock('../../src/clients/neodb-http', () => ({
  neodbClient: (...args: unknown[]) => neodbClient(...args),
  neodbFailureCode: () => 'test',
}));

const {
  findDoubanLinkedTwinByTitle,
  pickDoubanLinkedTwin,
  resolveNeodbItemForBangumiUrlDetailed,
} = await import('../../src/clients/neodb-catalog');

function item(over: Record<string, unknown>) {
  return {
    id: 'id',
    type: 'Movie',
    uuid: 'uuid',
    url: '',
    api_url: '',
    category: 'movie',
    parent_uuid: null,
    title: 'Same Title',
    display_title: 'Same Title',
    description: '',
    cover_image_url: '',
    rating: 0,
    rating_count: 0,
    external_resources: [],
    ...over,
  } as never;
}

describe('findDoubanLinkedTwinByTitle', () => {
  it('does not fall back to other categories when the book search is empty', async () => {
    // The movie is only visible when the search has no category filter. The old implementation
    // made exactly that second call and returned the film for a novel subject.
    // 只有在不带分类过滤时才会看到这部电影。旧实现正是发了第二次全分类搜索，把电影返回给了小说。
    neodbClient.mockImplementation(
      (_path: string, options: { searchParams: Record<string, string> }) => ({
        json: async () =>
          options.searchParams.category
            ? { data: [] }
            : {
                data: [
                  item({
                    uuid: 'movie-uuid',
                    category: 'movie',
                    external_resources: [
                      { url: 'https://movie.douban.com/subject/1/' },
                    ],
                  }),
                ],
              },
      }),
    );

    const fromBangumi = item({
      uuid: 'book-uuid',
      category: 'book',
      external_resources: [],
    });

    const twin = await findDoubanLinkedTwinByTitle(fromBangumi, ['Same Title'], 'book');

    expect(twin).toBeNull();
    const categories = neodbClient.mock.calls.map(
      (call) => call[1].searchParams.category,
    );
    expect(categories).toEqual(['book']);
  });

  it('rejects a same-title twin from another decade', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'book-twin',
            category: 'book',
            pub_year: 1990,
            external_resources: [{ url: 'https://book.douban.com/subject/1/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({ uuid: 'book-uuid', category: 'book' }),
      ['Same Title'],
      'book',
      2020,
    );

    expect(twin).toBeNull();
  });

  it('falls back to the direct item when title twins are ambiguous', async () => {
    const direct = item({ uuid: 'direct', category: 'movie' });
    neodbClient.mockImplementation((path: string) => {
      if (path === 'api/catalog/fetch') {
        return { json: async () => direct };
      }
      return {
        json: async () => ({
          data: [
            item({
              uuid: 'twin-a',
              category: 'movie',
              external_resources: [{ url: 'https://movie.douban.com/subject/1/' }],
            }),
            item({
              uuid: 'twin-b',
              category: 'movie',
              external_resources: [{ url: 'https://movie.douban.com/subject/2/' }],
            }),
          ],
        }),
      };
    });

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/25552',
    );

    expect(result.item?.uuid).toBe('direct');
    expect(result.via).toBe('direct');
    expect(result.ambiguous).toBe(true);
  });

  it('reports a 404 as not-found instead of a generic unresolved', async () => {
    neodbClient.mockImplementationOnce(() => ({
      json: async () => {
        throw { response: { statusCode: 404 } };
      },
    }));

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/404',
    );

    expect(result.item).toBeNull();
    expect(result.failure).toBe('not-found');
  });

  it('picks the candidate matching the expected year instead of the first hit', () => {
    const direct = item({ uuid: 'direct', category: 'movie', pub_year: 2007 });
    const result = pickDoubanLinkedTwin(
      [
        item({ uuid: 'wrong', category: 'movie', pub_year: 2014 }),
        item({ uuid: 'right', category: 'movie', pub_year: 2007 }),
      ],
      direct,
      2007,
    );

    expect(result.item?.uuid).toBe('right');
    expect(result.ambiguous).toBe(false);
  });

  it('does not let a movie twin replace a TV direct item', () => {
    const direct = item({
      uuid: 'tv',
      category: 'tv',
      url: 'https://neodb.social/tv/season/x',
    });
    const result = pickDoubanLinkedTwin(
      [item({ uuid: 'movie', category: 'movie', pub_year: 2007 })],
      direct,
      2007,
    );

    expect(result.item).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('marks multiple same-year candidates as ambiguous', () => {
    const direct = item({ uuid: 'direct', category: 'movie', pub_year: 2007 });
    const result = pickDoubanLinkedTwin(
      [
        item({ uuid: 'a', category: 'movie', pub_year: 2007 }),
        item({ uuid: 'b', category: 'movie', pub_year: 2007 }),
      ],
      direct,
      2007,
    );

    expect(result.item).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it('accepts a same-category twin when the year is within tolerance', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'book-twin',
            category: 'book',
            pub_year: 2020,
            external_resources: [{ url: 'https://book.douban.com/subject/1/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({ uuid: 'book-uuid', category: 'book' }),
      ['Same Title'],
      'book',
      2021,
    );

    expect(twin?.uuid).toBe('book-twin');
  });
});
