import { consola } from 'consola';
import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { type CreatePageParameters } from '@notionhq/client/build/src/api-endpoints';
import scrapeDoubanSubjectPage from '../clients/douban-subject-page';
import {
  NOTION_COLUMN_TYPES,
  PAGE_ICON_EMOJI,
  buildPropertyValue,
  notion,
} from '../clients/notion';
import { sleep } from '../utils';
import {
  ItemCategory,
  DB_PROPERTIES,
  newPathReport,
  type FeedItem,
  type NotionUrlPropType,
  type DB_PROPERTIES_KEYS,
  type FailedItem,
  type PathReport,
} from '../types';
import {
  filterDoubanFeedsByCategory,
  getDataSourceId,
  syncConfig,
} from '../sync-config';
import { printPathSummary } from '../sync-report';

/**
 * `icon` only accepts a fixed union of emoji; `CreatePageParameters` is the authoritative
 * source for that union, so the cast is derived rather than hand-written.
 * https://github.com/makenotion/notion-sdk-js/issues/280#issuecomment-1178523498
 *
 * `icon` 只接受一个固定的 emoji 联合类型，`CreatePageParameters` 是该联合类型的权威来源，
 * 因此这里用「推导」而不是手写断言。
 */
type EmojiRequest = Extract<CreatePageParameters['icon'], { type?: 'emoji' }>['emoji'];

dotenv.config();

/**
 * Path ① — Douban RSS → Notion.
 * 链路① —— 豆瓣 RSS → Notion。
 *
 * One Douban category maps to one Notion database, so the feeds are grouped by category first.
 * 一个豆瓣分类对应一个 Notion 数据库，因此先把条目按分类分组。
 *
 * Failure policy: this path reports failures instead of terminating. It used to call
 * `process.exit(1)` three times, which killed the remaining categories, every later path and the
 * closing summary — failures now travel in the returned `PathReport` and are folded into the exit
 * code by the caller, exactly like every other path in the repo.
 *
 * 失败策略：本链路上报失败而不是终止进程。它原先有 3 处 `process.exit(1)`，会连带杀掉剩余分类、
 * 后续所有链路以及收尾汇总 —— 现在失败记录在返回的 `PathReport` 里，由调用方折算成退出码，
 * 与仓库其余链路一致。
 *
 * @param feeds - Feed items to sync. 待同步的条目。
 * @returns The path's report. 本条链路的报告。
 */
export default async function syncDoubanToNotion(feeds: FeedItem[]): Promise<PathReport> {
  const report = newPathReport('Douban → Notion');

  const filtered = filterDoubanFeedsByCategory(
    feeds,
    syncConfig.doubanNotionCategories,
    'Douban → Notion',
  );
  report.scanned = feeds.length;
  report.skipped = feeds.length - filtered.length;

  const feedsByCategory: Partial<Record<ItemCategory, FeedItem[]>> = filtered.reduce(
    (acc, feed) => {
      if (!acc[feed.category]) {
        acc[feed.category] = [];
      }
      acc[feed.category]!.push(feed);
      return acc;
    },
    {} as Partial<Record<ItemCategory, FeedItem[]>>,
  );

  const failedItems: FailedItem[] = [];

  for (const category in feedsByCategory) {
    const categorizedFeeds = feedsByCategory[category as ItemCategory] as FeedItem[];
    try {
      const outcome = await syncCategoryToNotion(categorizedFeeds, category as ItemCategory);
      // `scanned` is NOT added here on purpose: it is already `feeds.length` (set above), and the
      // categories partition `filtered`, so their `outcome.scanned` sums to `filtered.length` —
      // a subset of `feeds.length`. Adding both double-counted, which the self-check caught as
      // `2+0+0+0+0 = 2 ✘ expected 4` in a real run.
      // 此处刻意**不**累加 `scanned`：它已在上面设为 `feeds.length`，而各分类恰好划分 `filtered`，
      // 其 `outcome.scanned` 之和等于 `filtered.length` —— 是 `feeds.length` 的子集。两处都加会
      // 重复计数，真实运行中正是它让自检打出 `2+0+0+0+0 = 2 ✘ expected 4`。
      report.written += outcome.written;
      report.unchanged += outcome.unchanged;
      report.skipped += outcome.skipped;
      report.failed += outcome.failed;
      failedItems.push(...outcome.failedItems);
    } catch (error) {
      // Count the whole category as failed and keep going: one bad category must not cost the
      // other four, nor the paths after this one. (`scanned` already covers these items.)
      // 整个分类计入「失败」并继续：一个分类出问题，不该连累其余四个分类，也不该连累本条链路
      // 之后的链路。（这些条目已包含在 `scanned` 里。）
      consola.error(`Failed to handle ${category} feeds. `, error);
      report.failed += categorizedFeeds.length;
      for (const feed of categorizedFeeds) {
        failedItems.push({ link: feed.link, title: feed.title ?? '' });
      }
    }
  }

  if (failedItems.length) {
    consola.warn('Failed to handle the following feeds to insert into Notion:');
    for (const item of failedItems) {
      consola.warn(`${item.title}: ${item.link}`);
    }
  }

  printPathSummary(report);
  return report;
}

/** Notion's maximum page size for a query. / Notion 查询允许的最大分页大小。 */
const NOTION_PAGE_SIZE = 100;

/**
 * Collect every `条目链接` already present in a data source, for the given items.
 * 取出这些条目中已经存在于某个 data source 里的全部「条目链接」。
 *
 * Two things this does that a single query cannot:
 *
 *  1. **Batch the filter.** Notion caps how many clauses one `or` can hold, so the items are sent
 *     in chunks of `NOTION_PAGE_SIZE`.
 *  2. **Follow pagination.** The query response is paged; reading only the first page (as this used
 *     to) means items on later pages look "not yet inserted" and get created a second time.
 *
 * 单次查询做不到的两件事：
 *
 *  1. **分批构造过滤条件。** Notion 对单个 `or` 的子句数量有上限，因此条目按 `NOTION_PAGE_SIZE`
 *     分批发送。
 *  2. **翻页。** 查询响应是分页的；只读第一页（原先的做法）会让后面几页的条目看起来「尚未
 *     插入」，从而被重复创建。
 *
 * @throws When a query fails — the caller logs it and counts the category as failed.
 *   查询失败时抛出 —— 由调用方记录并把该分类计入失败。
 */
async function collectAlreadyInsertedLinks(
  dataSourceId: string,
  feeds: FeedItem[],
): Promise<Set<string>> {
  const found = new Set<string>();

  for (let start = 0; start < feeds.length; start += NOTION_PAGE_SIZE) {
    const batch = feeds.slice(start, start + NOTION_PAGE_SIZE);
    let cursor: string | undefined;

    do {
      const page = await notion.dataSources.query({
        data_source_id: dataSourceId,
        page_size: NOTION_PAGE_SIZE,
        start_cursor: cursor,
        filter: {
          or: batch.map((item) => ({
            property: DB_PROPERTIES.ITEM_LINK,
            url: {
              contains: item.id,
            },
          })),
        },
      });

      for (const result of page.results) {
        if ('properties' in result) {
          const url = (result.properties[DB_PROPERTIES.ITEM_LINK] as NotionUrlPropType)
            .url;
          if (url) {
            found.add(url);
          }
        }
      }

      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  return found;
}

/** Per-category counts, aggregated into the path's `PathReport`. / 单个分类的计数，最终汇入链路的 `PathReport`。 */
type CategoryOutcome = {
  scanned: number;
  written: number;
  unchanged: number;
  skipped: number;
  failed: number;
  failedItems: FailedItem[];
};

/**
 * Sync one category's feeds into its Notion data source.
 * 把某个分类的条目同步进它对应的 Notion data source。
 *
 * De-duplication queries the data source in batches of `NOTION_PAGE_SIZE` and follows `has_more`
 * pagination, so items on later pages are still recognised as already inserted.
 * 去重会按 `NOTION_PAGE_SIZE` 分批查询并跟随 `has_more` 翻页，因此后几页的条目也会被识别为已插入。
 *
 * @param categorizedFeeds - Feeds already filtered to one category. 已过滤到单一分类的条目。
 * @param category - That category. 该分类。
 * @returns Counts for this category, satisfying `written + unchanged + skipped + failed = scanned`.
 *   该分类的计数，满足 `written + unchanged + skipped + failed = scanned`。
 * @throws When the de-duplication query itself fails — the caller counts the category and continues.
 *   去重查询本身失败时抛出 —— 由调用方计入该分类并继续。
 */
async function syncCategoryToNotion(
  categorizedFeeds: FeedItem[],
  category: ItemCategory,
): Promise<CategoryOutcome> {
  const emptyOutcome: CategoryOutcome = {
    scanned: 0,
    written: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    failedItems: [],
  };

  if (categorizedFeeds.length === 0) {
    consola.info(`No new ${category} feeds.`);
    return emptyOutcome;
  }

  const dataSourceId = getDataSourceId(category);
  if (!dataSourceId) {
    // No target configured → the items are skipped, not failed.
    // 没有配置目标端 → 这些条目属于「跳过」，不是「失败」。
    consola.warn(`No notion data source id for ${category}`);
    return {
      ...emptyOutcome,
      scanned: categorizedFeeds.length,
      skipped: categorizedFeeds.length,
    };
  }

  consola.start(`Handling ${category} feeds...`);

  // `dataSourceId` is already known to be defined here (checked above).
  // 到这里 `dataSourceId` 已确定有值（上面已检查）。
  let alreadyInsertedLinks: Set<string>;
  try {
    // after @notionhq sdk upgraded to v5.0.0, use dataSource instead of database
    alreadyInsertedLinks = await collectAlreadyInsertedLinks(
      dataSourceId,
      categorizedFeeds,
    );
  } catch (error) {
    consola.error(
      `Failed to query ${category} data source to check already inserted items. `,
      error,
    );
    // Never terminate here: re-throw so the caller counts this category as failed and the
    // remaining categories, paths and the closing summary all still run.
    // 绝不在此终止进程：重新抛出，由调用方把该分类记为失败，其余分类、链路与收尾汇总照常执行。
    throw error;
  }

  // The column list is fetched ONCE per category rather than once per item: the data source schema
  // cannot change mid-run, and this was the most expensive call inside the item loop.
  // 列清单每个分类只取一次，而不是每个条目取一次：data source 的结构不会在一次运行中途变化，
  // 而这是条目循环里最贵的一次调用。
  let availableColumns: Set<string>;
  try {
    const dataSource = await notion.dataSources.retrieve({
      data_source_id: dataSourceId,
    });
    availableColumns = new Set(Object.keys(dataSource.properties));
  } catch (error) {
    consola.error(`Failed to read ${category} data source schema. `, error);
    throw error;
  }

  const feedsToInsert = categorizedFeeds.filter((item) => {
    return !alreadyInsertedLinks.has(item.link);
  });

  consola.info(
    `There are total ${feedsToInsert.length} new ${category} item(s) need to insert.`,
  );

  const outcome: CategoryOutcome = {
    scanned: categorizedFeeds.length,
    written: 0,
    // Already present in Notion → nothing to write.
    // 已存在于 Notion → 无需写入。
    unchanged: categorizedFeeds.length - feedsToInsert.length,
    skipped: 0,
    failed: 0,
    failedItems: [],
  };

  for (const newFeedItem of feedsToInsert) {
    try {
      const itemData = await scrapeDoubanSubjectPage(newFeedItem.link, category);
      itemData[DB_PROPERTIES.ITEM_LINK] = newFeedItem.link;
      itemData[DB_PROPERTIES.RATING] = newFeedItem.rating;
      // `dayjs(undefined)` returns *now*, which would silently stamp today's date as the rating
      // date; `dayjs('')` returns an Invalid Date. Leave it unset unless there is a real value —
      // `addItemToNotion` skips falsy columns.
      // `dayjs(undefined)` 返回的是**当前时间**，会静默把今天当成打分日期；`dayjs('')` 则是
      // Invalid Date。因此只有拿到真实值才设置 —— `addItemToNotion` 会跳过假值列。
      itemData[DB_PROPERTIES.RATING_DATE] = newFeedItem.time
        ? dayjs(newFeedItem.time).format('YYYY-MM-DD')
        : undefined;
      itemData[DB_PROPERTIES.COMMENTS] = newFeedItem.comment;
      const successful = await addItemToNotion(itemData, category, availableColumns);
      if (successful) {
        outcome.written += 1;
      } else {
        outcome.failed += 1;
        outcome.failedItems.push({
          link: newFeedItem.link,
          title: String(itemData[DB_PROPERTIES.NAME] ?? newFeedItem.title ?? ''),
        });
      }
      await sleep(1000);
    } catch (error) {
      // Scrape failures are counted too, so the report matches reality instead of silently
      // dropping the item.
      // 抓取失败同样计入，使报告与实际一致，而不是把该条目静默丢掉。
      consola.error(error);
      outcome.failed += 1;
      outcome.failedItems.push({
        link: newFeedItem.link,
        title: String(newFeedItem.title ?? ''),
      });
    }
  }

  if (outcome.failedItems.length) {
    consola.error(
      `Failed to insert ${outcome.failedItems.length} items into ${category} Notion database.`,
    );
  }
  consola.success(`${category} feeds done.`);
  consola.log('====================');
  return outcome;
}

/**
 * Create one Notion page for a scraped item.
 * 为一条抓取到的条目创建 Notion 页面。
 *
 * @param itemData - Column values keyed by column name. 以列名为键的列值。
 * @param category - Which database (and which page icon) to use. 使用哪个数据库（以及哪个页面图标）。
 * @param availableColumns - Column names that actually exist in the target data source; anything
 *   else is dropped. Fetched once per category by the caller. 目标 data source 上真实存在的列名，
 *   其余会被丢弃。由调用方按分类取一次。
 * @returns `true` when the page was created; `false` on any error (errors are logged, not thrown).
 *   页面创建成功返回 `true`；任何错误返回 `false`（错误只记录，不抛出）。
 */
async function addItemToNotion(
  itemData: {
    [key: string]: string | string[] | number | null | undefined;
  },
  category: ItemCategory,
  availableColumns: Set<string>,
): Promise<boolean> {
  consola.start(
    'Going to insert ',
    itemData[DB_PROPERTIES.RATING_DATE],
    itemData[DB_PROPERTIES.NAME],
  );
  try {
    const properties: Record<string, any> = {};
    // Iterate the TYPE map rather than `cols.json`. `NOTION_COLUMN_TYPES` is typed
    // `Record<DB_PROPERTIES_KEYS, …>` and `DB_PROPERTIES_KEYS` already excludes `NAME`, so no
    // `shift()` is needed — and the result no longer depends on the JSON key ORDER.
    // 遍历**类型表**而不是 `cols.json`。`NOTION_COLUMN_TYPES` 的类型是
    // `Record<DB_PROPERTIES_KEYS, …>`，而 `DB_PROPERTIES_KEYS` 已在类型层面排除 `NAME`，
    // 因此不需要 `shift()`，结果也不再依赖 JSON 的键顺序。
    const keys = Object.keys(NOTION_COLUMN_TYPES) as DB_PROPERTIES_KEYS[];
    keys.forEach((key) => {
      if (itemData[DB_PROPERTIES[key]]) {
        properties[DB_PROPERTIES[key]] = buildPropertyValue(
          itemData[DB_PROPERTIES[key]],
          NOTION_COLUMN_TYPES[key],
          DB_PROPERTIES[key],
        );
      }
    });

    const dataSourceId = getDataSourceId(category);
    if (!dataSourceId) {
      throw new Error('No data source id found for category: ' + category);
    }

    // Drop columns that do not exist in the target data source. The set comes from the caller,
    // which reads the schema once per category instead of once per item.
    // 丢弃目标 data source 上不存在的列。这个集合由调用方传入，它按分类读一次结构，而不是每个
    // 条目读一次。
    for (const prop of Object.keys(properties)) {
      if (!availableColumns.has(prop)) {
        delete properties[prop];
      }
    }

    const createPageRequest: CreatePageParameters = {
      parent: {
        type: 'data_source_id',
        data_source_id: dataSourceId,
      },
      icon: {
        type: 'emoji',
        emoji: PAGE_ICON_EMOJI[category] as EmojiRequest,
      },
      // fill in properties by the format: https://developers.notion.com/reference/page#page-property-value
      properties,
    };

    if (properties[DB_PROPERTIES.POSTER] || properties[DB_PROPERTIES.COVER]) {
      // use poster for the page cover
      createPageRequest.cover = {
        type: 'external',
        external: {
          url: (properties[DB_PROPERTIES.POSTER] || properties[DB_PROPERTIES.COVER])
            ?.files[0]?.external?.url, // cannot be empty string or null
        },
      };
    }

    const response = await notion.pages.create(createPageRequest);
    if (response && response.id) {
      consola.success(
        itemData[DB_PROPERTIES.NAME] +
          `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` +
          ' page inserted into Notion database.',
      );
    }
    return true;
  } catch (error) {
    consola.error(
      'Failed to create ' +
        itemData[DB_PROPERTIES.NAME] +
        `(${itemData[DB_PROPERTIES.ITEM_LINK]})` +
        ' with error: ',
      error,
    );
    return false;
  }
}
