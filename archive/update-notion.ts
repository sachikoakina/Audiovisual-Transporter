/*
 * ARCHIVED — moved here from `scripts/update-notion.ts`; not maintained, not type-checked,
 * not linted. Kept for provenance of the one-off historical backfill.
 * 已归档 —— 从 `scripts/update-notion.ts` 移来；不再维护，不参与类型检查，也不参与 lint。
 * 保留它是为了给「一次性历史回填」留下可追溯的原始实现。
 *
 * What it does / 作用: read a CSV exported from Douban, scrape each movie's subject page, and
 * CREATE Notion pages directly. Superseded by the regular path `src/paths/douban-to-notion.ts`,
 * which does the same job during normal syncs — and additionally handles Douban's PoW challenge,
 * which this script does not.
 * 读取从豆瓣导出的 csv，逐个抓取电影条目页，并**直接创建** Notion 页面。它已被常规链路
 * `src/paths/douban-to-notion.ts` 取代 —— 后者在常态同步中完成同样的事情，并且额外处理了
 * 豆瓣的 PoW 挑战页，而本脚本没有。
 *
 * USAGE — as written this is a `.ts` file in an ESM package, so the original invocation line was
 * wrong twice over. The correct form is:
 * 用法 —— 本文件是 ESM 包里的 `.ts` 文件，因此原来的调用示例错了两处。正确写法是：
 *
 *   npx tsx archive/update-notion.ts db-movie-20210527.csv [skipMode=0/1]
 *
 *   skipMode = 0 表示不按日期跳过已导入的数据
 *   skipMode = 0 means do not skip already-imported rows by date
 *
 * Note / 注意: it mixes two generations of the Notion API — it QUERIES with `data_source_id`
 * (Notion API v5) but CREATES pages with `parent: { database_id }` (v4 style).
 * 它混用了两代 Notion API —— 查询走 `data_source_id`（v5），建页却用 `parent: { database_id }`
 * （v4 写法）。
 */

import fs from 'node:fs';
import dotenv from 'dotenv';
import csv from 'fast-csv';
import { Client, LogLevel } from '@notionhq/client';
import type {
  QueryDataSourceResponse,
  PageObjectResponse,
  CreatePageParameters,
} from '@notionhq/client/build/src/api-endpoints';
import dayjs from 'dayjs';
import got from 'got';
import { JSDOM } from 'jsdom';
import { sleep } from '../src/utils';
import DB_PROPERTIES from '../cols.json';
import type { NotionDatePropType } from '../src/types';

dotenv.config();

// Initializing a client
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  logLevel: LogLevel.DEBUG,
});

// example: https://github.com/makenotion/notion-sdk-js/blob/main/examples/database-update-send-email/index.js

const databaseId = process.env.NOTION_MOVIE_DATABASE_ID as string;
// read csv file to csvData, and these are going to be filled in notion database
const csvData: Record<string, any>[] = [];

async function main() {
  // get input csv file from cli arg
  const [inputFile, skipMode = 1] = process.argv.slice(2);
  if (!inputFile) {
    console.error('Input csv file is not provided');
    return;
  }
  const splitted = inputFile.split('.');
  if (splitted.length > 1) {
    const ext = splitted.slice(-1)[0];
    if (ext !== 'csv') {
      console.error('Input file is not .csv format');
      return;
    }
  }

  // query current db last inserted item
  const lastMovieItem: QueryDataSourceResponse = await notion.dataSources.query({
    data_source_id: databaseId,
    sorts: [
      {
        property: DB_PROPERTIES.RATING_DATE,
        direction: 'descending',
      },
    ],
    page_size: 1,
  });

  // console.log(lastMovieItem.results[0].properties[DB_PROPERTIES.GENRE]);

  // get the last inserted item's date
  const lastDate = (
    (lastMovieItem.results[0] as PageObjectResponse).properties[
      DB_PROPERTIES.RATING_DATE
    ] as NotionDatePropType
  ).date.start; // '2021-01-19'

  let skip = false;
  const rs = fs.createReadStream(inputFile);
  rs.pipe(csv.parse({ headers: true, discardUnmappedColumns: true, trim: true }))
    .on('error', (error) => console.error(error))
    .on('data', (row: Record<string, any>) => {
      if (Number(skipMode)) {
        if (skip) {
          return;
        }
        row[DB_PROPERTIES.RATING_DATE] = row[DB_PROPERTIES.RATING_DATE].replace(
          /\//g,
          '-',
        );
        if (dayjs(row[DB_PROPERTIES.RATING_DATE]).isAfter(dayjs(lastDate))) {
          csvData.push(row); // only save the items after the lastDate
        } else {
          skip = true;
        }
      } else {
        row[DB_PROPERTIES.RATING_DATE] = row[DB_PROPERTIES.RATING_DATE].replace(
          /\//g,
          '-',
        );
        csvData.push(row);
      }
    })
    .on('end', async (rowCount: number) => {
      console.log(
        `Parsed ${rowCount} rows, there are ${csvData.length} new items need to be handled.`,
      );
      await handleNewItems();
    });
}

async function handleNewItems() {
  csvData.reverse();
  for (let i = 0; i < csvData.length; i++) {
    const row = csvData[i]; // reverse the array
    const link = row[DB_PROPERTIES.ITEM_LINK];
    delete row['上映日期'];

    let itemData;
    try {
      itemData = await fetchItem(link); // https://movie.douban.com/subject/1291552/
      itemData = { ...itemData, ...row }; // merge all data
    } catch (error) {
      console.error(row[DB_PROPERTIES.MOVIE_TITLE], error);
    }

    if (itemData) {
      await addToNotion(itemData);
      await sleep(3000); // wait for 3s to avoid blocking from douban
    }
  }
}

async function fetchItem(link) {
  const itemData = {};
  const response = await got(link);
  const dom = new JSDOM(response.body);
  itemData[DB_PROPERTIES.YEAR] = dom.window.document
    .querySelector('#content h1 .year')
    ?.textContent?.slice(1, -1);
  itemData[DB_PROPERTIES.POSTER] = (
    dom.window.document.querySelector('#mainpic img') as HTMLImageElement
  ).src.replace(/\.webp$/, '.jpg');
  itemData[DB_PROPERTIES.DIRECTORS] =
    dom.window.document.querySelector('#info .attrs')?.textContent;
  itemData[DB_PROPERTIES.ACTORS] = [
    ...dom.window.document.querySelectorAll('#info .actor .attrs a'),
  ]
    .slice(0, 5)
    .map((i) => i.textContent)
    .join(' / ');
  itemData[DB_PROPERTIES.GENRE] = [
    ...dom.window.document.querySelectorAll('#info [property="v:genre"]'),
  ].map((i) => i.textContent); // array
  const imdbInfo = [...dom.window.document.querySelectorAll('#info span.pl')].filter(
    (i) => i.textContent?.startsWith('IMDb'),
  );
  if (imdbInfo.length) {
    itemData[DB_PROPERTIES.IMDB_LINK] =
      'https://www.imdb.com/title/' + imdbInfo[0].nextSibling?.textContent?.trim();
  }
  return itemData;
}

async function addToNotion(itemData) {
  console.log(
    'Going to insert ',
    itemData[DB_PROPERTIES.RATING_DATE],
    itemData[DB_PROPERTIES.MOVIE_TITLE],
  );
  try {
    const response = await notion.pages.create({
      parent: {
        database_id: databaseId,
      },
      properties: {
        // fill in properties by the format: https://developers.notion.com/reference/page#page-property-value
        [DB_PROPERTIES.POSTER]: {
          files: [
            {
              name: itemData[DB_PROPERTIES.POSTER],
            },
          ],
        },
        [DB_PROPERTIES.MOVIE_TITLE]: {
          title: [
            {
              text: {
                content: itemData[DB_PROPERTIES.MOVIE_TITLE],
              },
            },
          ],
        },
        [DB_PROPERTIES.RATING]: {
          multi_select: itemData[DB_PROPERTIES.RATING]
            ? [
                {
                  name: itemData[DB_PROPERTIES.RATING].toString(),
                },
              ]
            : [], // if no rating, then this multi_select should be an empty array
        },
        [DB_PROPERTIES.RATING_DATE]: {
          date: {
            start: itemData[DB_PROPERTIES.RATING_DATE],
          },
        },
        [DB_PROPERTIES.COMMENTS]: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: itemData[DB_PROPERTIES.COMMENTS] || '',
              },
            },
          ],
        },
        [DB_PROPERTIES.YEAR]: {
          number: Number(itemData[DB_PROPERTIES.YEAR]),
        },
        [DB_PROPERTIES.DIRECTORS]: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: itemData[DB_PROPERTIES.DIRECTORS],
              },
            },
          ],
        },
        [DB_PROPERTIES.SCREENWRITERS]: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: itemData[DB_PROPERTIES.SCREENWRITERS],
              },
            },
          ],
        },
        [DB_PROPERTIES.ACTORS]: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: itemData[DB_PROPERTIES.ACTORS],
              },
            },
          ],
        },
        [DB_PROPERTIES.GENRE]: {
          // array
          multi_select: (itemData[DB_PROPERTIES.GENRE] || []).map((g) => ({
            name: g, // @Q: if the option is not created before, can not use it directly here?
          })),
        },
        [DB_PROPERTIES.ITEM_LINK]: {
          url: itemData[DB_PROPERTIES.ITEM_LINK],
        },
        [DB_PROPERTIES.IMDB_LINK]: {
          url: itemData[DB_PROPERTIES.IMDB_LINK] || null,
        },
      },
    } as CreatePageParameters);
    if (response && response.id) {
      console.log(
        itemData[DB_PROPERTIES.MOVIE_TITLE] +
          `(${itemData[DB_PROPERTIES.ITEM_LINK]})` +
          ' page created.',
      );
    }
  } catch (error) {
    console.warn(
      'Failed to create ' +
        itemData[DB_PROPERTIES.MOVIE_TITLE] +
        `(${itemData[DB_PROPERTIES.ITEM_LINK]})` +
        ' with error: ',
      error,
    );
  }
}

main();
