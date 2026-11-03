# GitHub Actions 与运行配置

本页只记录 Actions 的触发、输入、凭据、产物与排障；本地命令见 [README](../README.md)。

## `sync` 工作流

`.github/workflows/sync.yml` 每周一、三、五 **08:00 UTC** 定时运行，也支持手动触发。作业使用 Node.js 24，执行 `npm ci` 与 `npm run verify:all`，验证通过后才运行同步。

手动输入：

| 输入                | 影响链路        | 行为                                                                |
| ------------------- | --------------- | ------------------------------------------------------------------- |
| `full_sync`         | NeoDB → TMDB    | 取消 `SYNC_MAX_ITEMS` / `NEODB_MAX_PAGES`，并在本次运行关闭增量跳过 |
| `bangumi_full_sync` | Bangumi → NeoDB | 遍历全部收藏页，并通过游标续跑                                      |

两项默认关闭；它们解决的是不同的“全量”：

- ⑤ 的 `full_sync` 取消条数/页数上限并关闭增量；
- ④ 的 `bangumi_full_sync` 只改变分页范围，④ 本来每轮就逐条比对。

工作流权限只有 `contents: read`，并设置 `concurrency: sync`、`cancel-in-progress: false`，避免两次同步争用 `.cache` 状态或重复写入。

## Secrets 与 Variables

仅为启用的链路配置凭据：

| 凭据                                           | 用途                     |
| ---------------------------------------------- | ------------------------ |
| `DOUBAN_USER_ID`                               | 读取个人豆瓣 RSS         |
| `NOTION_TOKEN` + `NOTION_*_DATABASE_ID`        | 创建 Notion 页面         |
| `NEODB_API_TOKEN`                              | 读取/写入 NeoDB          |
| `BANGUMI_ACCESS_TOKEN`                         | 读取/更新 Bangumi 收藏   |
| `TMDB_API_KEY`                                 | 访问 TMDB API            |
| `TMDB_SESSION_ID` 或用户级 `TMDB_ACCESS_TOKEN` | 写入 TMDB 评分/watchlist |

开关、分类白名单、合并策略、节流、上限与状态文件路径通过仓库 Variables 传入。完整名称、默认值与可选项以 [`.env.example`](../.env.example) 为准，`npm run verify:docs` 会做双向核对。

## 作业摘要与 artifact

同步结束时，即使失败也会尝试发布 `$GITHUB_STEP_SUMMARY`。JSON 报告上传为：

```text
sync-report-<run_id>-<YYYYMMDDTHHmmssZ>   保留 7 天
```

随后 `review-queue` 在 `sync` 完成事件后运行：

1. 读取该次 `Run the sync` 日志与 `sync-report.json`；
2. 恢复上一轮 `review-state-*`（旧命名不兼容）；
3. 合并新增/移除/未覆盖条目，写 `review-state`；
4. 上传 `review-state-<sync_run_id>-<UTC>-stock`，保留 90 天。

摘要中的“本轮运行”同时显示 UTC 与上海时间；机器字段、artifact 名和排序只用 UTC。

## 缓存与游标

同步状态、年份缓存和全量游标在临时 runner 上不会自动持久化。工作流只为 Bangumi 全量模式恢复/保存游标；review-state artifact 承载的是待核对名单状态，与 `.cache` 同步缓存用途不同。

## 排障顺序

1. **`Run the sync` 日志**：看第一个 `failed` / `aborted` / `No TMDB match` / `duplicate target`。
2. **`sync-report.json`**：看 `failedItems`、`unresolvedItems`、`capped`、`truncated`。
3. **Job Summary**：看每条链路的 `scanned/written/unchanged/skipped/unresolved/failed` 是否对账。
4. **review-state**：看条目是否进入待核对名单、`missedRuns` 是否已满足移除条件。
5. **Review Queue 日志**：看解析器是否漏掉日志行、是否还在读旧 artifact 名。

认证失败先换对应 Secret；单条 4xx 看 `failedItems.reason`；目标端无条目属于 `unresolved`，不是 CI 故障。

## 常见失败分类

| 现象               | 含义               | 处理                                            |
| ------------------ | ------------------ | ----------------------------------------------- |
| `401/403`          | 凭据失效           | 更新对应 Secret；该路径本轮中止                 |
| `failed`           | 单条请求/写入失败  | 看 reason；可重跑                               |
| `unresolved`       | 目标端没有确认匹配 | 人工核对/补目录；不单独失败                     |
| `capped`           | 本轮达到条数预算   | 属正常；需要全量时手动触发 `full_sync`          |
| `truncated`        | 分页未走完         | 看 `NEODB_MAX_PAGES` 或分页错误；该路径冻结老化 |
| `review-state` 404 | 旧 artifact 不兼容 | 从新命名 `review-state-*` 开始                  |
