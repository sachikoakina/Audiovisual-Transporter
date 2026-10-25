/**
 * Notion property payloads — how one scraped value becomes one property object.
 * Notion 属性载荷 —— 一个抓取到的值如何变成一个属性对象。
 *
 * Pure by construction: no SDK client, no `dotenv`, no `process.env`. That is what lets
 * `scripts/verify-rules.ts` assert the payloads without importing the Notion SDK at all — before
 * this split, asserting `buildPropertyValue` also constructed a `Client` and read `.env`.
 * 构造上就是纯的：没有 SDK 客户端、没有 `dotenv`、不读 `process.env`。正是这一点让
 * `scripts/verify-rules.ts` 不导入 Notion SDK 也能断言载荷 —— 拆分之前，断言
 * `buildPropertyValue` 会顺带构造一个 `Client` 并读取 `.env`。
 */
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
  // One deliberate `any`: the value comes from a scraper and is fed to a switch that narrows it
  // per property type (`string` for text, `number` for NUMBER). Typing it `unknown` here would
  // only move a dozen casts into the branches, where they are harder to review than this line.
  // 唯一一处刻意的 `any`：这个值来自抓取器，交给一个按属性类型逐类窄化的 switch（文本用
  // `string`，NUMBER 用 `number`）。在这里写 `unknown` 只会把十几个断言挪进各分支，
  // 那些地方比这一行更难审。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
