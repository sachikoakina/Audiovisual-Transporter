import Parser from 'rss-parser';
import dotenv from 'dotenv';
import got from 'got';
import { JSDOM } from 'jsdom';
import { consola } from 'consola';
import {
  ALL_STATUS,
  STATUS_TITLE_PREFIX,
  RATING_TEXT,
  SeeState,
  ReadState,
  PlayState,
  ListenState,
} from './const';
import { ItemCategory, ItemStatus, type RSSFeedItem, type FeedItem } from './types';

type ItemInfo = {
  category: ItemCategory;
  id: string;
  status: ItemStatus;
};

dotenv.config();

const DOUBAN_RSS_UA =
  process.env.DOUBAN_RSS_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchRSSFeeds(): Promise<RSSFeedItem[]> {
  const DOUBAN_USER_ID = process.env.DOUBAN_USER_ID;
  if (!DOUBAN_USER_ID) {
    throw new Error('DOUBAN_USER_ID is not set');
  }

  const url = `https://www.douban.com/feed/people/${DOUBAN_USER_ID}/interests`;
  const parser = new Parser();

  try {
    // Douban often 403s bare requests from CI; use a browser-like UA via got.
    // Timeouts / transient 5xx are common on Actions — retry a few times.
    const xml = await got(url, {
      headers: {
        'User-Agent': DOUBAN_RSS_UA,
        Accept:
          'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://www.douban.com/',
      },
      timeout: { request: 60000 },
      retry: {
        limit: 3,
        methods: ['GET'],
        statusCodes: [401, 403, 408, 413, 429, 500, 502, 503, 504],
        errorCodes: [
          'ETIMEDOUT',
          'ECONNRESET',
          'EADDRINUSE',
          'ECONNREFUSED',
          'EPIPE',
          'ENOTFOUND',
          'ENETUNREACH',
          'EAI_AGAIN',
        ],
        calculateDelay: ({ attemptCount, error, computedValue }) => {
          // Cap 401/403 retries — often permanent WAF blocks.
          const status = error?.response?.statusCode;
          if ((status === 401 || status === 403) && attemptCount <= 2) {
            return attemptCount * 2500;
          }
          if (status === 401 || status === 403) {
            return 0;
          }
          return computedValue;
        },
      },
    }).text();

    const feeds = await parser.parseString(xml);
    return feeds.items;
  } catch (error: any) {
    const status = error?.response?.statusCode;
    if (status === 401 || status === 403) {
      consola.error(
        `Douban RSS returned ${status} (blocked or need browser session). ` +
          'CI/机房 IP 常被拦；可设 DOUBAN_RSS_USER_AGENT，或暂时只开 SYNC_BANGUMI_NEODB。',
      );
    } else {
      consola.error('Failed to parse RSS url: ', error);
    }
    throw error;
  }
}

/**
 * Normalize the given array of RSS feed items.
 *
 * @param {RSSFeedItem[]} feeds - The array of RSS feed items to be normalized.
 * @return {FeedItem[]} The normalized array of feed items.
 */
export function handleRSSFeeds(feeds: RSSFeedItem[]): FeedItem[] {
  const normalizedFeeds: FeedItem[] = [];

  feeds.forEach((item) => {
    const itemInfo = extractItemInfo(item.title!, item.link!);
    if (!itemInfo) {
      return;
    }
    const { category, id, status } = itemInfo;
    const dom = new JSDOM(item.content!.trim());
    const contents = [...dom.window.document.querySelectorAll('td p')];
    const ratingElements = contents.filter((el) => el.textContent!.startsWith('推荐'));
    let ratingNumber = 0;
    if (ratingElements.length) {
      const rating = ratingElements[0].textContent!.replace(/^推荐: /, '').trim();
      ratingNumber = RATING_TEXT[rating as keyof typeof RATING_TEXT];
    }
    const commentElements = contents.filter((el) => el.textContent!.startsWith('备注'));
    let comment = '';
    if (commentElements.length) {
      comment = commentElements[0].textContent!.replace(/^备注: /, '').trim();
    }
    const title = (item.title || '').replace(STATUS_TITLE_PREFIX, '').trim();
    const result = {
      id,
      link: item.link,
      title,
      rating: ratingNumber || null,
      comment: typeof comment === 'string' ? comment : null, // 备注：XXX -> 短评
      time: item.isoDate, // '2021-05-30T06:49:34.000Z'
      status,
      category,
    } as FeedItem;
    normalizedFeeds.push(result);
  });

  return normalizedFeeds;
}

/**
 * Extracts the category, ID, and status from the given title and link
 * which are from RSS feed item.
 *
 * @param {string} title - The title to extract the information from.
 * @param {string} link - The link to extract the information from.
 * @return {ItemInfo} An object containing the extracted category, ID, and status.
 */
export function extractItemInfo(title: string, link: string): ItemInfo | undefined {
  const m = title.match(ALL_STATUS)?.[1];

  if (!m) {
    return;
  }

  if (Object.keys(SeeState).includes(m)) {
    const isMovie =
      link.startsWith('http://movie.douban.com/') ||
      link.startsWith('https://movie.douban.com/');
    return {
      category: isMovie ? ItemCategory.Movie : ItemCategory.Drama,
      id: isMovie
        ? (link.match(/movie\.douban\.com\/subject\/(\d+)\/?/)?.[1] ?? '')
        : (link.match(/www\.douban\.com\/location\/drama\/(\d+)\/?/)?.[1] ?? ''),
      status: SeeState[m as keyof typeof SeeState],
    };
  } else if (Object.keys(ReadState).includes(m)) {
    return {
      category: ItemCategory.Book,
      id: link.match(/book\.douban\.com\/subject\/(\d+)\/?/)?.[1] ?? '',
      status: ReadState[m as keyof typeof ReadState],
    };
  } else if (Object.keys(ListenState).includes(m)) {
    return {
      category: ItemCategory.Music,
      id: link.match(/music\.douban\.com\/subject\/(\d+)\/?/)?.[1] ?? '',
      status: ListenState[m as keyof typeof ListenState],
    };
  } else if (Object.keys(PlayState).includes(m)) {
    return {
      category: ItemCategory.Game,
      id: link.match(/www\.douban\.com\/game\/(\d+)\/?/)?.[1] ?? '',
      status: PlayState[m as keyof typeof PlayState],
    };
  }

  return;
}
