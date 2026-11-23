/**
 * Title twins stay inside the subject category; movie and TV may share an identity.
 * 标题孪生限定在 subject 分类内；movie 与 TV 可共享同一作品身份。
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

  it('uses the direct item when it already declares a Douban link', async () => {
    const direct = item({
      uuid: 'direct-with-douban',
      category: 'tv',
      external_resources: [{ url: 'https://movie.douban.com/subject/34857400/' }],
    });
    neodbClient.mockClear();
    neodbClient.mockImplementation(() => ({
      json: async () => direct,
    }));

    const result = await resolveNeodbItemForBangumiUrlDetailed(
      'https://bgm.tv/subject/365366',
    );

    expect(result.item?.uuid).toBe('direct-with-douban');
    expect(result.via).toBe('direct');
    expect(result.doubanLinkPresent).toBe(true);
    expect(neodbClient).toHaveBeenCalledTimes(1);
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

  it('allows a movie candidate for a TV direct item', () => {
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

    expect(result.item?.uuid).toBe('movie');
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

  it('rejects a generic season title when a real title exists', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'agatha',
            category: 'tv',
            title: 'Agatha Raisin Season 1',
            display_title: 'Agatha Raisin Season 1',
            localized_title: [{ lang: 'en', text: 'Season 1' }],
            year: 2016,
            external_resources: [{ url: 'https://movie.douban.com/subject/2/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'direct',
        category: 'tv',
        title: 'Season1',
        display_title: 'Season1',
        year: 2015,
      }),
      ['狐妖小红娘1 下沙篇'],
      'tv',
      2015,
    );

    expect(twin).toBeNull();
  });

  it('rejects an authoritative candidate whose missing search year is wrong in detail', async () => {
    neodbClient.mockImplementation(
      (path: string) =>
        ({
          json: async () =>
            path === 'api/catalog/search'
              ? {
                  data: [
                    item({
                      uuid: 'wrong-season',
                      category: 'tv',
                      title: '狐妖小红娘3 月红篇',
                      display_title: '狐妖小红娘3 月红篇',
                      api_url: 'https://neodb.social/api/tv/season/wrong-season',
                      external_resources: [
                        { url: 'https://movie.douban.com/subject/3/' },
                      ],
                    }),
                  ],
                }
              : {
                  uuid: 'wrong-season',
                  category: 'tv',
                  year: 2024,
                },
        }) as never,
    );

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'direct',
        category: 'tv',
        title: '狐妖小红娘3 月红篇',
        year: 2016,
      }),
      ['狐妖小红娘3 月红篇'],
      'tv',
      2016,
    );

    expect(twin).toBeNull();
  });

  it('allows a generic season title when there is no authoritative title and year is exact', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'season-twin',
            category: 'tv',
            title: 'Season 1',
            display_title: 'Season 1',
            localized_title: [{ lang: 'en', text: 'Season 1' }],
            year: 2015,
            external_resources: [{ url: 'https://movie.douban.com/subject/4/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'direct',
        category: 'tv',
        title: 'Season1',
        display_title: 'Season1',
        year: 2015,
      }),
      [],
      'tv',
      2015,
    );

    expect(twin?.uuid).toBe('season-twin');
  });

  it('rejects a TV candidate from another season', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'fox-spirit-1',
            category: 'tv',
            title: 'Fox Spirit Matchmaker 1',
            display_title: 'Fox Spirit Matchmaker 1',
            localized_title: [{ lang: 'zh-cn', text: '狐妖小红娘 月红篇' }],
            year: 2016,
            external_resources: [{ url: 'https://movie.douban.com/subject/281272/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'fox-spirit-3',
        category: 'tv',
        title: '狐妖小红娘3 月红篇',
        display_title: '狐妖小红娘3 月红篇',
        year: 2016,
      }),
      ['狐妖小红娘3 月红篇'],
      'tv',
      2016,
    );

    expect(twin).toBeNull();
  });

  it('accepts a TV candidate from the same season', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'fox-spirit-3-twin',
            category: 'tv',
            title: '狐妖小红娘3 月红篇',
            display_title: '狐妖小红娘3 月红篇',
            year: 2016,
            external_resources: [{ url: 'https://movie.douban.com/subject/281272/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'fox-spirit-3',
        category: 'tv',
        title: '狐妖小红娘3 月红篇',
        display_title: '狐妖小红娘3 月红篇',
        year: 2016,
      }),
      ['狐妖小红娘3 月红篇'],
      'tv',
      2016,
    );

    expect(twin?.uuid).toBe('fox-spirit-3-twin');
  });

  it('finds a movie title twin for a TV season', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'movie-twin',
            category: 'movie',
            title: '驯龙高手：归家',
            display_title: '驯龙高手：归家',
            year: 2019,
            external_resources: [{ url: 'https://movie.douban.com/subject/34857400/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'tv-direct',
        category: 'tv',
        title: '驯龙高手：归家',
        year: 2019,
      }),
      ['驯龙高手：归家'],
      'movie,tv',
      2019,
    );

    expect(twin?.uuid).toBe('movie-twin');
  });

  it('rejects a movie candidate when IMDb conflicts', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'movie-conflict',
            category: 'movie',
            title: 'Same Title',
            year: 2019,
            external_resources: [
              { url: 'https://movie.douban.com/subject/10/' },
              { url: 'https://www.imdb.com/title/tt2222222/' },
            ],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'movie-direct',
        category: 'movie',
        title: 'Same Title',
        year: 2019,
        external_resources: [{ url: 'https://www.imdb.com/title/tt1111111/' }],
      }),
      ['Same Title'],
      'movie',
      2019,
    );

    expect(twin).toBeNull();
  });

  it('accepts a movie candidate when IMDb matches even if the title differs', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'movie-match',
            category: 'movie',
            title: 'Different Title',
            year: 2019,
            external_resources: [
              { url: 'https://movie.douban.com/subject/11/' },
              { url: 'https://www.imdb.com/title/tt1111111/' },
            ],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'movie-direct',
        category: 'movie',
        title: 'Same Title',
        year: 2019,
        external_resources: [{ url: 'https://www.imdb.com/title/tt1111111/' }],
      }),
      ['Same Title'],
      'movie',
      2019,
    );

    expect(twin?.uuid).toBe('movie-match');
  });

  it('ignores conflicting IMDb for a TV candidate', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'tv-ignore-imdb',
            category: 'tv',
            title: 'Same Title',
            year: 2019,
            external_resources: [
              { url: 'https://movie.douban.com/subject/12/' },
              { url: 'https://www.imdb.com/title/tt2222222/' },
            ],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'tv-direct',
        category: 'tv',
        title: 'Same Title',
        year: 2019,
        external_resources: [{ url: 'https://www.imdb.com/title/tt1111111/' }],
      }),
      ['Same Title'],
      'tv',
      2019,
    );

    expect(twin?.uuid).toBe('tv-ignore-imdb');
  });

  it('rejects a book when ISBN conflicts', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'book-conflict',
            category: 'book',
            title: 'Same Title',
            pub_year: 2020,
            isbn: '9783161484100',
            external_resources: [{ url: 'https://book.douban.com/subject/13/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'book-direct',
        category: 'book',
        title: 'Same Title',
        pub_year: 2020,
        isbn: '9780306406157',
      }),
      ['Same Title'],
      'book',
      2020,
    );

    expect(twin).toBeNull();
  });

  it('rejects a cross-class book/movie candidate', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'movie-opposite',
            category: 'movie',
            title: 'Same Title',
            year: 2020,
            external_resources: [{ url: 'https://movie.douban.com/subject/14/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'book-direct',
        category: 'book',
        title: 'Same Title',
        pub_year: 2020,
      }),
      ['Same Title'],
      'book',
      2020,
    );

    expect(twin).toBeNull();
  });

  it('honors a zero year tolerance for title candidates', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'year-off-by-one',
            category: 'movie',
            title: 'Same Title',
            year: 2021,
            external_resources: [{ url: 'https://movie.douban.com/subject/15/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'movie-direct',
        category: 'movie',
        title: 'Same Title',
        year: 2020,
      }),
      ['Same Title'],
      'movie',
      2020,
      0,
    );

    expect(twin).toBeNull();
  });

  it('rejects a TV candidate with a conflicting parent_uuid', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'wrong-parent',
            category: 'tv',
            parent_uuid: 'parent-b',
            title: 'Same Title',
            display_title: 'Same Title',
            year: 2024,
            external_resources: [{ url: 'https://movie.douban.com/subject/16/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'direct-with-parent',
        category: 'tv',
        parent_uuid: 'parent-a',
        title: 'Same Title',
        display_title: 'Same Title',
        year: 2024,
      }),
      ['Same Title'],
      'tv',
      2024,
    );

    expect(twin).toBeNull();
  });

  it('prefers a TV season over a same-title movie adaptation', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'correct-tv-season',
            category: 'tv',
            parent_uuid: 'tv-parent',
            title: '约定的梦幻岛 第 1 季',
            display_title: '约定的梦幻岛 第 1 季',
            year: 2019,
            external_resources: [{ url: 'https://movie.douban.com/subject/30206430/' }],
          }),
          item({
            uuid: 'movie-adaptation',
            category: 'movie',
            title: '约定的梦幻岛',
            display_title: '约定的梦幻岛',
            year: 2020,
            external_resources: [
              { url: 'https://movie.douban.com/subject/34792372/' },
              { url: 'https://www.imdb.com/title/tt11027510/' },
            ],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'base-tv-entry',
        category: 'tv',
        title: '约定的梦幻岛',
        display_title: '约定的梦幻岛',
        year: 2019,
      }),
      ['约定的梦幻岛'],
      'movie,tv',
      2019,
    );

    expect(twin?.uuid).toBe('correct-tv-season');
  });

  it('does not use a generic season alias when the source has an authoritative title', async () => {
    neodbClient.mockImplementation(() => ({
      json: async () => ({
        data: [
          item({
            uuid: 'sense8-season-2',
            category: 'tv',
            title: '超感猎杀 第二季',
            display_title: '超感猎杀 第二季',
            localized_title: [{ lang: 'en', text: 'Season 2' }],
            year: 2017,
            external_resources: [{ url: 'https://movie.douban.com/subject/17/' }],
          }),
        ],
      }),
    }));

    const twin = await findDoubanLinkedTwinByTitle(
      item({
        uuid: 'ggbond-season-2',
        category: 'tv',
        title: '猪猪侠第二部：武侠2008',
        display_title: '猪猪侠第二部：武侠2008',
        localized_title: [{ lang: 'en', text: 'Season 2' }],
        year: undefined,
      }),
      ['猪猪侠第二部：武侠2008'],
      'tv',
      undefined,
    );

    expect(twin).toBeNull();
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
