# 迁移与血缘（历史）

> 本文是 README 的下沉附录：只用于追溯，不参与日常操作。现行架构见 [`../../README.md`](../../README.md)。

## 与 douban-backup 的关系

|          | douban-backup           | 本项目                                                           |
| -------- | ----------------------- | ---------------------------------------------------------------- |
| 链路数   | 4 条                    | **5 条**（+ NeoDB → TMDB）                                       |
| 数据流向 | 豆瓣/Bangumi → 其他平台 | 增加平台之间的横向同步                                           |
| 代码关系 | —                       | 行为延续；代码经模块化重构（分层 / 拆文件 / 改名），并追加新模块 |

> **血缘**：[bambooom/douban-backup](https://github.com/bambooom/douban-backup) 是原版（豆瓣 → Notion / NeoDB），
> [viazure/douban-backup](https://github.com/viazure/douban-backup) 是增加 Bangumi 功能的 fork —— 本项目的
> Bangumi 链路即来自这一支。Bangumi 客户端的默认 UA 仍标识上游项目（`src/clients/bangumi.ts`，可用
> `BANGUMI_USER_AGENT` 覆盖）；这是**刻意保留的运行时值**。

如果不需要 TMDB，把 `SYNC_NEODB_TMDB` 保持为 `0`，四条豆瓣 / Bangumi 链路的行为与 douban-backup 一致。

## 更名对照（历史文件名 → 现行位置）

`handle-notion.ts → paths/douban-to-notion.ts` · `handle-neodb.ts → paths/douban-to-neodb.ts` ·
`handle-bangumi.ts → paths/douban-to-bangumi.ts` · `handle-bangumi-neodb.ts → paths/bangumi-to-neodb.ts` ·
`handle-neodb-tmdb.ts → paths/neodb-to-tmdb.ts` · `handle-rss.ts → clients/douban-rss.ts` ·
`handle-douban.ts → clients/douban-subject-page.ts + douban-subject-parsers.ts` ·
`const.ts → rules/douban.ts + rules/bangumi-neodb.ts` · `neodb-merge.ts → rules/neodb-mark-merge.ts` ·
`tmdb-merge.ts → rules/tmdb-write-plan.ts` · `sync-tmdb-only.ts → neodb-to-tmdb-full-cli.ts`
（中间名 `neodb-to-tmdb-cli.ts`，已并入全量入口） · `sync-bangumi-full.ts → bangumi-to-neodb-full-cli.ts`。

> 旧的 `scripts/update-notion.ts`、`scripts/db-notes-img-dl.ts`（后改名 `download-douban-note-images.ts`）
> 及其 `userscript/` 导出工具已于 2026-10-29 删除；需要时从 Git 标签 `legacy-archive-2026-10-29` 取回。
