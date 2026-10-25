/**
 * Notion client — the SDK client, and nothing else.
 * Notion 客户端 —— 只有 SDK 客户端，别无其他。
 *
 * The vocabulary (`NOTION_COLUMN_TYPES`, `PAGE_ICON_EMOJI`, `buildPropertyValue`) moved to
 * `rules/notion-payload.ts`, because asserting it used to mean importing this module and thereby
 * constructing a `Client` and reading `.env` — a pure rule held hostage by a live SDK object.
 * 词汇部分（`NOTION_COLUMN_TYPES`、`PAGE_ICON_EMOJI`、`buildPropertyValue`）已移至
 * `rules/notion-payload.ts`：过去要断言它就得导入本模块，于是顺带构造 `Client` 并读 `.env`
 * —— 一条纯规则被一个活着的 SDK 对象绑住。
 */
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';

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
