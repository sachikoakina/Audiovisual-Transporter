# Audiovisual Transporter

按开关在豆瓣 RSS、Bangumi、NeoDB、Notion 与 TMDB 之间同步影音收藏。程序是 TypeScript 命令行工具，只写入配置明确开启的目标端；未匹配不单独导致失败，认证失败会中止相关链路。

## 在 GitHub Actions 中运行

`.github/workflows/sync.yml` 每天**上海时间 23:30**（当日 15:30 UTC）运行，也可在 Actions 页面手动触发。运行顺序固定：`npm ci` → `npm run verify:all` → `npm run sync` → 发布作业摘要与 JSON 报告 → `review-queue` 读取日志与报告、更新待核对名单。

手动运行有两个相互独立的选项：

| 输入                      | 影响链路        | 行为                                    |
| ------------------------- | --------------- | --------------------------------------- |
| `neodb_tmdb_full_sync`    | NeoDB → TMDB    | 取消条数/页数上限，并关闭本次增量跳过   |
| `bangumi_neodb_full_sync` | Bangumi → NeoDB | 遍历 Bangumi 全部收藏页，并通过游标续跑 |

两项默认关闭。Sync 作业使用 Node.js 24，权限只有 `contents: read`，并禁止两次同步重叠；review-queue 使用 Node.js 22 和 `actions: read`，不写仓库。⑤ 默认书架为 `wishlist,progress,complete,dropped`。

### 需要的 Secrets

| Secret                                                             | 用途                          |
| ------------------------------------------------------------------ | ----------------------------- |
| `DOUBAN_USER_ID`                                                   | 读取个人豆瓣 RSS              |
| `NOTION_TOKEN` + `NOTION_*_DATABASE_ID`                            | 创建 Notion 页面              |
| `NEODB_API_TOKEN`                                                  | 读取/写入 NeoDB               |
| `BANGUMI_ACCESS_TOKEN`                                             | 读取/更新 Bangumi 收藏        |
| `TMDB_API_KEY` + `TMDB_SESSION_ID`（或用户级 `TMDB_ACCESS_TOKEN`） | 匹配 TMDB、写入评分/watchlist |

运行开关、分类白名单、合并策略、节流与上限通过仓库 Variables 传入。完整变量名与默认值以 [`.env.example`](.env.example) 为准；`npm run verify:docs` 会检查代码读取项与模板是否双向一致。

### 产物与排查

- `sync-report-<run_id>-<UTC>`：运行报告，保留 7 天；
- `review-state-<run_id>-<UTC>-stock`：跨轮待核对名单，保留 90 天；
- 作业摘要写入 Actions Job Summary；控制台完整日志在 `Run the sync` 步骤；
- 摘要的“本轮运行”同时标注 UTC 与上海时间，机器字段和时间排序仍只用 UTC。

失败时先看 `Run the sync` 日志，再对照 `sync-report.json` 的 `failedItems` / `unresolvedItems`，最后看 review-state 是否已进入待核对名单。

## 五条链路

| #   | 链路               | 匹配方式（简）                                                     | 写入                             |
| --- | ------------------ | ------------------------------------------------------------------ | -------------------------------- |
| ①   | 豆瓣 RSS → Notion  | 按豆瓣条目链接查重                                                 | 新建页面，仅提交目标数据源已有列 |
| ②   | 豆瓣 RSS → NeoDB   | 豆瓣条目 URL 解析 NeoDB 目录                                       | 书架状态、评分、短评             |
| ③   | 豆瓣 RSS → Bangumi | NeoDB 的 Bangumi 外链优先；否则按分类精确标题，动画/真人年份软过滤 | 收藏状态、评分、短评             |
| ④   | Bangumi → NeoDB    | Bangumi URL 直链 → 豆瓣孪生 → 同分类精确标题 + 年份                | 状态、评分、短评；可选进度       |
| ⑤   | NeoDB → TMDB       | TMDB 外链 → IMDb → 精确标题+必需年份 → TV 季父剧标题               | TMDB 评分、watchlist             |

豆瓣 RSS 只抓一次，①②③复用同一份归一化结果；④⑤分别读取自己的平台书架。逐链路的匹配顺序、状态映射与异常分类见[链路说明](docs/sync-paths.md)。

## 关键规则

- **状态**：Bangumi `1/2/3/4/5` 映射 NeoDB `wishlist/complete/progress/progress/dropped`；NeoDB `wishlist/progress/dropped` 都映射 TMDB watchlist。`complete` 有评分时写评分并移出 watchlist，无评分时只能加入 watchlist。
- **进度**：仅 ④ 写入。Bangumi 动画/真人 → `episode`，书籍 → `chapter`，音乐 → `track`，游戏不写；零值不会清除已有进度，默认关闭。
- **年份**：③④⑤ 的标题匹配都要求双方年份可用时不超过 1 年；年份缺失不会退化成“只按标题写”。

### 评分与短评

评分和短评各自独立判断，但共用一次目标端写请求。

| 链路            | 评分（默认 / 覆盖）                                             | 短评（默认 / 覆盖）                                               |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| ① 豆瓣→Notion   | 仅新建页面写入 RSS 评分；无覆盖开关                             | 仅新建页面写入 RSS 短评；无覆盖开关                               |
| ② 豆瓣→NeoDB    | 目标非 0 分优先<br>覆盖：`SYNC_DOUBAN_NEODB_RATING=overwrite`   | 目标非空短评优先<br>覆盖：`SYNC_DOUBAN_NEODB_COMMENT=overwrite`   |
| ③ 豆瓣→Bangumi  | 目标非 0 分优先<br>覆盖：`SYNC_DOUBAN_BANGUMI_RATING=overwrite` | 目标非空短评优先<br>覆盖：`SYNC_DOUBAN_BANGUMI_COMMENT=overwrite` |
| ④ Bangumi→NeoDB | 目标非 0 分优先<br>覆盖：`SYNC_BANGUMI_NEODB_RATING=overwrite`  | 目标非空短评优先<br>覆盖：`SYNC_BANGUMI_NEODB_COMMENT=overwrite`  |
| ⑤ NeoDB→TMDB    | 目标非 0 分优先<br>覆盖：`SYNC_RATING_PROFILE=overwrite`        | 不写；无覆盖开关                                                  |

默认的“目标优先”含义：

- 评分：目标已有非 0 分 → 保留；目标为 0 → 才用来源评分填充；来源无分不清空目标。
- 短评：目标已有非空短评 → 保留；目标为空 → 才用来源短评填充；来源为空不清空目标。
- `overwrite` 只覆盖对应字段：评分覆盖不影响短评，短评覆盖不影响评分。

**触发条件**：满足任一条件即写入。

- 新建目标记录；
- 状态不同（①没有状态字段，③④受各自状态保护规则约束）；
- 最终评分与目标现有评分不同；
- 最终短评与目标现有短评不同；
- ②④ 可见性与配置目标不同；
- ⑤ watchlist 状态不同。

注意：默认目标优先时，来源评分/短评变化本身**不会**触发写入，因为最终值仍等于目标现值。只有目标为空、或用 `overwrite` 时，来源变化才会改变最终值。

**更新流程**：

1. 读取目标记录；读取失败则本条 `failed`，不写入；
2. 按链路映射来源状态、评分、短评；
3. 分别按评分开关和短评开关计算最终值；
4. 与目标现有值逐字段比较，并叠加状态、可见性/watchlist 条件；
5. 全部相同 → `unchanged`，零请求；
6. 任一不同 → 发送一次写请求，带上全部最终字段；
7. 时间字段按各链路规则处理：② 用豆瓣 RSS `time`，③ 由 Bangumi 服务端写 `updated_at`，④ 按 `SYNC_BANGUMI_NEODB_CREATED_TIME`，⑤ 不写时间。

**与其他规则的关系**：

- 状态始终按各链路映射；③④ 的 4/5、`no-downgrade` 等保护先于评分/短评写入；
- 评分和短评不共用开关，但共用一次写请求；一个字段触发写入时，另一个字段仍按自己的目标保护规则取值；
- ②④ 同时启用时，② 先写、④ 后写；④ 的评分/短评开关决定最终字段；
- ⑤ 没有短评字段；`complete` 无评分时只加 watchlist，不删除已有评分。
- **读取保护**：目标端读取失败不会被当成“空记录”写入；401/403 中止相关链路，单条失败继续处理后续条目。
- **未匹配**：目标目录没有确认对应项，记为 `unresolved`，不单独让任务失败。

## 运行结果与退出码

每条链路返回统一 `PathReport`，按 `scanned / written / unchanged / skipped / unresolved / failed` 计数，并满足：

```text
scanned = written + unchanged + skipped + unresolved + failed
```

`failed` 或 `aborted` 会让退出码非零；`SYNC_DOUBAN_REQUIRED=0` 可把豆瓣 RSS 故障标为容忍，仍展示但不参与退出码。dry-run 只输出计划，不代表已向目标端提交。

## 配置

五个链路开关的默认值：

| 变量                  | 默认 | 链路               |
| --------------------- | ---- | ------------------ |
| `SYNC_DOUBAN_NOTION`  | `0`  | 豆瓣 RSS → Notion  |
| `SYNC_DOUBAN_NEODB`   | `1`  | 豆瓣 RSS → NeoDB   |
| `SYNC_DOUBAN_BANGUMI` | `1`  | 豆瓣 RSS → Bangumi |
| `SYNC_BANGUMI_NEODB`  | `1`  | Bangumi → NeoDB    |
| `SYNC_NEODB_TMDB`     | `0`  | NeoDB → TMDB       |

分类白名单、合并策略、节流、状态文件路径等完整配置见 [`.env.example`](.env.example)。Actions 使用仓库 Secrets/Variables，不依赖提交 `.env` 文件。

## 本地运行

```bash
npm ci
cp .env.example .env
npm run sync
```

单独跑全量入口：`npm run sync:bangumi-neodb-full-sync`、`npm run sync:neodb-tmdb-full-sync`。两者都会访问目标服务并可能写入数据；首次执行前先确认账号、凭据与 dry-run 设置。

## 开发校验

```bash
npm run typecheck
npm run lint
npm run verify:all
```

`verify:all` 包含单元测试、TMDB 映射、规则、豆瓣解析器、文档链接与日志契约。改动匹配、状态或日志文案时，同时核对对应 verify 项。

## 文档

- [架构与模块职责](docs/architecture.md)
- [五条同步链路](docs/sync-paths.md)
- [GitHub Actions 与运行配置](docs/github-actions.md)
- [配置参数说明](docs/configuration.md)
- [接口、错误与运行数据参考](docs/reference.md)

## License

MIT

## 致谢

本项目的想法与最初的实现思路来自下面的项目，感谢原作者与维护者：

- [bambooom/douban-backup](https://github.com/bambooom/douban-backup) —— 原版「豆瓣 → Notion / NeoDB」备份工具，本项目留档思路的来源；
- [viazure/douban-backup](https://github.com/viazure/douban-backup) —— 在上者基础上增加了 Bangumi 支持的 fork，本项目 Bangumi 相关链路即由此而来。

本仓库在此基础上做了模块化重构，并新增 NeoDB 书架 → TMDB 的单向同步。
