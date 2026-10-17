/**
 * Notion client — the single place that talks to Notion and knows its vocabulary.
 * Notion 客户端 —— 与 Notion 通信、并掌握其词汇（列类型 / emoji / 属性载荷）的唯一去处。
 *
 * Three pieces of Notion knowledge used to live in three different files
 * (`NOTION_COLUMN_TYPES` and `PAGE_ICON_EMOJI` in `const.ts`, `buildPropertyValue` in `utils.ts`, the SDK
 * client in the Notion path). They are merged here so that "how a value becomes a Notion
 * property" has exactly one definition.
 * 过去有三处 Notion 知识分散在三个文件里（`NOTION_COLUMN_TYPES`、`PAGE_ICON_EMOJI` 在 `const.ts`，
 * `buildPropertyValue` 在 `utils.ts`，SDK 客户端在 Notion 链路里）。现在合并到此处，
 * 使「一个值如何变成 Notion 属性」只有一处定义。
 */
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { DB_PROPERTIES } from '../types';
import {
  NotionPropTypesEnum,
  type DB_PROPERTIES_KEYS,
  type NotionColPropTypes,
  type NotionDatePropType,
  type NotionFilesPropType,
  type NotionMultiSelectPropType,
  type NotionNumberPropType,
  type NotionRichTextPropType,
  type NotionTitlePropType,
  type NotionUrlPropType,
} from '../types';

// `dotenv.config()` must run before the client reads `NOTION_TOKEN`. Making this module
// self-sufficient means it no longer depends on some other module having loaded `.env` first.
// 必须先 `dotenv.config()` 再让客户端读取 `NOTION_TOKEN`。让本模块自给自足，就不再依赖
// 「某个其他模块恰好先加载了 `.env`」这一偶然条件。
dotenv.config();

/**
 * Shared Notion SDK client. `notionVersion` is pinned explicitly: the installed SDK's default
 * happens to be the same `2025-09-03` today, but pinning keeps this stable across upgrades.
 * 共享的 Notion SDK 客户端。`notionVersion` 显式固定：当前安装的 SDK 默认值恰好也是
 * `2025-09-03`，但固定下来可以让它在 SDK 升级时保持稳定。
 */
export const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: '2025-09-03',
});

/**
 * Notion property type of every column in `cols.json`.
 * `cols.json` 中每一列对应的 Notion 属性类型。
 *
 * Keyed by `DB_PROPERTIES_KEYS`, which is `keyof cols.json` minus `NAME` — so this map is
 * genuinely total over the writable columns, and it can be iterated instead of relying on
 * JSON key order.
 * 以 `DB_PROPERTIES_KEYS` 为键（即 `cols.json` 的键去掉 `NAME`），因此这张表对「可写列」
 * 是全的，可以直接遍历，而不必依赖 JSON 的键顺序。
 */
export const NOTION_COLUMN_TYPES: Record<DB_PROPERTIES_KEYS, NotionPropTypesEnum> = {
  POSTER: NotionPropTypesEnum.FILES,
  MOVIE_TITLE: NotionPropTypesEnum.TITLE,
  MUSIC_TITLE: NotionPropTypesEnum.TITLE,
  BOOK_TITLE: NotionPropTypesEnum.TITLE,
  GAME_TITLE: NotionPropTypesEnum.TITLE,
  DRAMA_TITLE: NotionPropTypesEnum.TITLE,
  COVER: NotionPropTypesEnum.FILES,
  RATING: NotionPropTypesEnum.MULTI_SELECT,
  RATING_DATE: NotionPropTypesEnum.DATE,
  COMMENTS: NotionPropTypesEnum.RICH_TEXT,
  YEAR: NotionPropTypesEnum.NUMBER,
  DIRECTORS: NotionPropTypesEnum.RICH_TEXT,
  SCREENWRITERS: NotionPropTypesEnum.RICH_TEXT,
  ACTORS: NotionPropTypesEnum.RICH_TEXT,
  GENRE: NotionPropTypesEnum.MULTI_SELECT,
  ITEM_LINK: NotionPropTypesEnum.URL,
  IMDB_LINK: NotionPropTypesEnum.URL,
  RELEASE_DATE: NotionPropTypesEnum.DATE,
  MUSICIAN: NotionPropTypesEnum.RICH_TEXT,
  PUBLICATION_DATE: NotionPropTypesEnum.DATE,
  PUBLISHING_HOUSE: NotionPropTypesEnum.RICH_TEXT,
  WRITER: NotionPropTypesEnum.RICH_TEXT,
  ISBN: NotionPropTypesEnum.NUMBER,
};

/** Page icon per Douban category. / 各豆瓣分类对应的页面图标。 */
export const PAGE_ICON_EMOJI = {
  movie: '🎞',
  music: '🎶',
  book: '📖',
  game: '🕹',
  drama: '💃🏻',
};

/**
 * Notion rejects a `rich_text` block longer than 2000 characters with a 400 — and that fails the
 * whole page, not just that one column, so the error looks nothing like its cause.
 *
 * The parser already assumes this cap (see the comment on `musician` in
 * `douban-subject-parsers.ts`); this constant is where it is actually enforced.
 *
 * Notion 对超过 2000 字符的 `rich_text` 返回 400，而且这会让**整页创建失败**（不只是那一列），
 * 于是报错看起来和原因毫无关系。
 *
 * 解析器早已假定这个上限（见 `douban-subject-parsers.ts` 中 `musician` 的注释），而真正执行它的
 * 地方是这个常量。
 */
const NOTION_RICH_TEXT_MAX = 2000;

/**
 * Turn a raw scraped value into a Notion property payload.
 * 把抓取到的原始值转换成 Notion 的属性载荷。
 *
 * @param value - Raw value from the parser. 解析器给出的原始值。
 * @param type - Target Notion property type. 目标 Notion 属性类型。
 * @param key - Column name, needed only to special-case `个人评分` (a single-value
 *   multi_select, whereas `类型` is a real multi-value one). 列名，仅用于特判 `个人评分`
 *   （它承载单值，而 `类型` 才是真正的多值 multi_select）。
 * @returns A Notion property payload, or `undefined` for an unknown type
 *   (the caller then skips that column). 属性载荷；类型未知时返回 `undefined`，调用方会跳过该列。
 */
export function buildPropertyValue(
  value: any,
  type: NotionPropTypesEnum,
  key: string,
): NotionColPropTypes | undefined {
  switch (type) {
    case NotionPropTypesEnum.TITLE:
      return {
        type: NotionPropTypesEnum.TITLE,
        title: [
          {
            text: {
              content: value,
            },
          },
        ],
      } as NotionTitlePropType;
    case NotionPropTypesEnum.FILES:
      return {
        type: NotionPropTypesEnum.FILES,
        files: [
          {
            name: value,
            type: 'external',
            external: {
              url: value,
            },
          },
        ],
      } as NotionFilesPropType;
    case NotionPropTypesEnum.DATE:
      return {
        type: NotionPropTypesEnum.DATE,
        date: {
          start: value,
        },
      } as NotionDatePropType;
    case NotionPropTypesEnum.MULTI_SELECT:
      return key === DB_PROPERTIES.RATING
        ? ({
            type: NotionPropTypesEnum.MULTI_SELECT,
            multi_select: value ? [{ name: value.toString() }] : [],
          } as NotionMultiSelectPropType)
        : ({
            type: NotionPropTypesEnum.MULTI_SELECT,
            multi_select: (value || []).map((g: string) => ({ name: g })),
          } as NotionMultiSelectPropType);
    case NotionPropTypesEnum.RICH_TEXT:
      return {
        type: NotionPropTypesEnum.RICH_TEXT,
        rich_text: [
          {
            type: 'text',
            text: {
              content: String(value || '').slice(0, NOTION_RICH_TEXT_MAX),
            },
          },
        ],
      } as NotionRichTextPropType;
    case NotionPropTypesEnum.NUMBER:
      return {
        type: NotionPropTypesEnum.NUMBER,
        number: value ? Number(value) : null,
      } as NotionNumberPropType;
    case NotionPropTypesEnum.URL:
      return {
        type: NotionPropTypesEnum.URL,
        url: value,
      } as NotionUrlPropType;
    default:
      break;
  }
}
