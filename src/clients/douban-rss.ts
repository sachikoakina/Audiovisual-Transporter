/**
 * Douban RSS client — fetch the interests feed and normalize it into `FeedItem[]`.
 * 豆瓣 RSS 客户端 —— 抓取「我的广播」兴趣流，并归一化为 `FeedItem[]`。
 *
 * Douban blocks bare requests from CI/data-centre IPs, hence the browser UA plus a retry policy
 * that caps 401/403 (usually a permanent WAF block, so retrying hard only wastes time).
 * 豆瓣会拦截来自 CI/机房 IP 的裸请求，因此这里使用浏览器 UA，并采用「对 401/403 设定重试上限」
 * 的策略（那通常是永久性 WAF 拦截，猛重试只会浪费时间）。
 */
import Parser from 'rss-parser';
import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { JSDOM } from 'jsdom';
import { consola } from 'consola';
import {
  ANY_STATUS_PREFIX,
  STRIP_STATUS_PREFIX,
  RATING_TEXT_TO_STARS,
  SEE_STATUS_MAP,
  READ_STATUS_MAP,
  PLAY_STATUS_MAP,
  LISTEN_STATUS_MAP,
} from '../rules/douban';
import { ItemCategory, ItemStatus, type RSSFeedItem, type FeedItem } from '../types';

/** Category + subject id + status decoded from one feed entry's title and link. / 从单条 feed 的标题与链接解出的分类、条目 id 与状态。 */
type ItemInfo = {
  category: ItemCategory;
  id: string;
  status: ItemStatus;
};

dotenv.config();

/** Browser-like UA; override with `DOUBAN_RSS_USER_AGENT` when Douban changes its WAF. / 浏览器 UA；豆瓣调整 WAF 时可用 `DOUBAN_RSS_USER_AGENT` 覆盖。 */
const DOUBAN_RSS_UA =
  process.env.DOUBAN_RSS_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch the user's Douban interests feed as raw feed items.
 * 抓取用户的豆瓣兴趣流，返回原始 feed 条目。
 *
 * @throws When `DOUBAN_USER_ID` is unset, or when the feed cannot be fetched/parsed.
 *   `DOUBAN_USER_ID` 未设置，或 feed 无法抓取/解析时抛出。
 */
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
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : undefined;
    if (status === 401 || status === 403) {
      // A 401/403 is one of the three messages that deliberately speak the user's own language
      // and name the exact fix (see `neodb-http.ts#logNeodbUnauthorized`). It used to be the only
      // line in the repo that was half English and half Chinese in the same sentence.
      // 401/403 属于刻意使用用户语言、并给出确切修复步骤的三条消息之一
      // （见 `neodb-http.ts#logNeodbUnauthorized`）。它曾是全仓唯一在同一句里中英混排的一行。
      consola.error(
        `豆瓣 RSS 返回 ${status}：被拦截，或需要浏览器会话。` +
          'CI / 机房 IP 常被拦；可设 DOUBAN_RSS_USER_AGENT 换 UA，或暂时只开 SYNC_BANGUMI_NEODB。',
      );
    } else {
      consola.error('Failed to parse RSS url: ', error);
    }
    throw error;
  }
}

/**
 * Normalize raw feed items into the shape the sync paths consume.
 * 把原始 feed 条目归一化为各同步链路消费的结构。
 *
 * The star wording and the short comment are scraped out of the entry's HTML body with JSDOM,
 * and the status prefix is stripped from the title.
 * 星级措辞与短评都通过 JSDOM 从条目正文 HTML 中抠出；标题里的状态前缀会被剥掉。
 *
 * @param feeds - Raw feed items. 原始 feed 条目。
 * @returns Normalized items; entries whose title carries no recognizable status are dropped.
 *   归一化后的条目；标题中状态不可识别的条目会被丢弃。
 */
export function normalizeRssFeeds(feeds: RSSFeedItem[]): FeedItem[] {
  const normalizedFeeds: FeedItem[] = [];

  feeds.forEach((item) => {
    // Narrow field by field instead of asserting the whole object. The old closing
    // `as FeedItem` is what let a missing `link` / `isoDate` through: the type said `string`,
    // the runtime value was `undefined`, and every `item.link!` downstream was papering over it.
    // 逐字段窄化，而不是把整个对象一次断言。正是末尾那句 `as FeedItem` 让缺失的 `link` /
    // `isoDate` 静默通过：类型说是 `string`，运行时却是 `undefined`，下游每个 `item.link!`
    // 都在替它遮丑。
    const link = item.link?.trim();
    const time = item.isoDate;
    const content = item.content;
    if (!item.title || !link || !time || !content) {
      return;
    }

    const itemInfo = extractItemInfo(item.title, link);
    if (!itemInfo) {
      return;
    }
    const { category, id, status } = itemInfo;
    const dom = new JSDOM(content.trim());
    const contents = [...dom.window.document.querySelectorAll('td p')];
    // `textContent` is `string | null` on the DOM side; `?? ''` is the honest narrowing, and it
    // replaces four non-null assertions that only silenced the compiler.
    // `textContent` 在 DOM 侧是 `string | null`；`?? ''` 才是诚实的窄化，它替掉了四个只是
    // 让编译器闭嘴的非空断言。
    const ratingElements = contents.filter((el) =>
      (el.textContent ?? '').startsWith('推荐'),
    );
    let stars = 0;
    if (ratingElements.length) {
      const rating = (ratingElements[0].textContent ?? '')
        .replace(/^推荐: /, '')
        .trim();
      stars = RATING_TEXT_TO_STARS[rating as keyof typeof RATING_TEXT_TO_STARS];
    }
    const commentElements = contents.filter((el) =>
      (el.textContent ?? '').startsWith('备注'),
    );
    let comment = '';
    if (commentElements.length) {
      comment = (commentElements[0].textContent ?? '').replace(/^备注: /, '').trim();
    }
    const title = item.title.replace(STRIP_STATUS_PREFIX, '').trim();
    normalizedFeeds.push({
      id,
      link,
      title,
      rating: stars || null,
      comment, // 备注：XXX -> 短评
      time, // '2021-05-30T06:49:34.000Z'
      status,
      category,
    });
  });

  return normalizedFeeds;
}

/**
 * Decode the category, subject id and status out of one feed entry's title and link.
 * 从单条 feed 的标题与链接中解出分类、条目 id 与状态。
 *
 * Pure and dependency-free, which is why it is the natural first target for offline assertions.
 * 纯函数且无依赖，因此它是离线断言最自然的首选目标。
 *
 * A `看*` status is ambiguous by design: Douban uses it for both films and stage dramas, so the
 * link host decides — `movie.douban.com` is a film, anything else is treated as a stage drama.
 * `看*` 状态天然有二义性：豆瓣用它同时表示电影与舞台剧，因此由链接域名决定 ——
 * `movie.douban.com` 视为电影，其余视为舞台剧。
 *
 * @param title - Feed entry title, e.g. `看过 海边的曼彻斯特`. 条目标题，如 `看过 海边的曼彻斯特`。
 * @param link - Feed entry link. 条目链接。
 * @returns The decoded info, or `undefined` when the title carries no recognizable status.
 *   解出的信息；标题中状态不可识别时返回 `undefined`。
 */
/**
 * One row per (status vocabulary, category, link shape). The four `if/else` branches this
 * replaces were identical apart from those three things, and the COPY is what made the film /
 * stage-drama split easy to get wrong: `看过` is one vocabulary pointing at two categories.
 * 每行一个（状态词汇、分类、链接形状）三元组。它替掉的四段 `if/else` 除了这三样之外完全一样，
 * 而正是**复制**让「电影 / 舞台剧」这一分叉容易出错：`看过` 是同一套词汇指向两个分类。
 *
 * Order matters only for `看*`: the film pattern wins because it is listed first.
 * 顺序只对 `看*` 有意义：电影模式在前，因此它优先。
 */
const ITEM_RULES: ReadonlyArray<{
  statuses: Record<string, ItemStatus>;
  category: ItemCategory;
  idPattern: RegExp;
}> = [
  {
    statuses: SEE_STATUS_MAP,
    category: ItemCategory.Movie,
    idPattern: /movie\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: SEE_STATUS_MAP,
    category: ItemCategory.Drama,
    idPattern: /www\.douban\.com\/location\/drama\/(\d+)\/?/,
  },
  {
    statuses: READ_STATUS_MAP,
    category: ItemCategory.Book,
    idPattern: /book\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: LISTEN_STATUS_MAP,
    category: ItemCategory.Music,
    idPattern: /music\.douban\.com\/subject\/(\d+)\/?/,
  },
  {
    statuses: PLAY_STATUS_MAP,
    category: ItemCategory.Game,
    idPattern: /www\.douban\.com\/game\/(\d+)\/?/,
  },
];

export function extractItemInfo(title: string, link: string): ItemInfo | undefined {
  const m = title.match(ANY_STATUS_PREFIX)?.[1];

  if (!m) {
    return;
  }

  for (const rule of ITEM_RULES) {
    const status = rule.statuses[m];
    if (status === undefined) {
      continue;
    }
    const id = link.match(rule.idPattern)?.[1];
    if (!id) {
      continue;
    }
    return { category: rule.category, id, status };
  }

  // A `看*` title whose link is neither a film nor a stage drama still resolves to a drama with
  // an empty id — which is what this function has always returned. Dropping it here would be a
  // silent loss; downstream, an empty id fails loudly instead.
  // 链接既不是电影也不是舞台剧的 `看*` 标题，仍解析为「分类=舞台剧、id 为空」—— 这也是本函数
  // 一直以来的返回。在这里丢掉它是无声的损失；交给下游，空 id 会响亮地失败。
  const seenStatus = SEE_STATUS_MAP[m as keyof typeof SEE_STATUS_MAP];
  if (seenStatus !== undefined) {
    return { category: ItemCategory.Drama, id: '', status: seenStatus };
  }

  return;
}
