# GitHub Actions 与运行配置

本页只记录 Actions 的触发、输入、凭据、产物与排障；本地命令见 [README](../README.md)。

## `sync` 工作流

`.github/workflows/sync.yml` 每天**上海时间 03:15**（前一日 19:15 UTC）定时运行，也支持手动触发。作业使用 Node.js 24，执行 `npm ci` 与 `npm run verify:all`，验证通过后才运行同步。

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

## 待核对名单的移出规则

名单由 `scripts/review-queue.mjs` 的 `merge()` 维护。条目不会因为“本轮没出现在日志里”就立即删除；必须同时满足：

1. 上一份 `review-state` 中存在该条目；
2. 本轮日志没有再次出现同一个 key；
3. 本轮没有触发 `degraded` 冻结；
4. 该条目所属链路在 `sync-report` 中有 coverage；
5. 条目身份在该链路的 `scannedIds` 中；
6. `missedRuns + 1 >= 2`，即连续第二轮“被扫描到但未再出现”。

```text
上一份条目
  ├─ 本轮再次出现 → 保留，missedRuns = 0
  └─ 本轮未出现
       ├─ degraded → 冻结，不计缺席
       ├─ 无 coverage / identity 不在 scannedIds → 冻结，missedRuns = 0
       └─ 有 coverage 且 identity 在 scannedIds
            ├─ missedRuns = 1 → 保留
            └─ missedRuns = 2 → 移出
```

### 会触发移出的场景

| 场景                          | 说明                                             |
| ----------------------------- | ------------------------------------------------ |
| 连续两轮扫描到但不再报错      | 条目已修复、已匹配，或不再产生该档位记录         |
| `unresolved` 变为可匹配       | 日志不再输出 `No ... match` / `neodb-unresolved` |
| `failed` / `skipped` 恢复正常 | 本轮被扫描到，但没有再次失败或跳过               |
| 目标端已存在对应条目          | ②③④⑤ 的匹配成功后不再进入名单                    |

`MIN_ROUNDS` 只决定条目何时显示为已入名单，不改变移出条件。

### 不会移出的场景

| 场景                                      | 行为                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| 没有 `sync-report.json`                   | `coverage = null`，全部冻结                                          |
| 链路未启用 / report 中没有该链路          | 无 coverage，全部冻结                                                |
| identity 不在 `scannedIds`                | 未真正检查到，冻结且 `missedRuns = 0`                                |
| `SYNC_MAX_ITEMS` / `NEODB_MAX_PAGES` 截断 | 只有被扫描到的条目可能移出；未扫描的冻结                             |
| 链路 `aborted` / 401 / 403                | 未扫描的条目冻结；已扫描的仍按规则处理                               |
| `degraded`                                | 本轮 observed 为空、上一份非空、report 仍统计 unresolved>0；整轮冻结 |
| 本轮再次出现                              | `missedRuns` 清零，保留                                              |
| 中间夹一轮未覆盖                          | 未覆盖轮把 streak 清零，需要重新连续两轮                             |
| 上一份 state 为空                         | 没有可移出条目                                                       |
| state 丢失/损坏                           | `loadState()` 返回空数组；这是“未恢复”，不是“移出全部”               |

注意：`capped` / `truncated` / `aborted` 不会整体冻结链路；代码只检查该条目是否在 `scannedIds` 中。**被扫描到的条目仍可能移出，没扫描到的才冻结。**

### 判断时应核对

| 字段                | 含义                                                       |
| ------------------- | ---------------------------------------------------------- |
| `removed`           | 本轮真正移出的条目                                         |
| `uncovered`         | 因未扫描而冻结的条目数                                     |
| `degraded`          | 是否因解析异常整轮冻结                                     |
| `coverage.sources`  | 有覆盖信息的链路数                                         |
| `coverage.complete` | 是否所有链路都完整扫描；仅用于摘要说明，不参与单条移出判断 |
| `missedRuns`        | 单条连续缺席次数                                           |
| `scannedIds`        | 该链路本轮真正检查过的 identity                            |

快速判断：

```text
removed > 0
  → 条目连续两轮在 scannedIds 中但未再出现

removed = 0，uncovered > 0
  → 多数是没扫描到，不是修好了

removed = 0，degraded 非空
  → 日志解析异常，整轮冻结

removed = 0，无 coverage
  → 没有 report，无法判断，全部冻结

removed 很大，missedRuns 普遍为 2
  → 真实老化/修复，或 scannedIds 覆盖范围异常
```

没有代码层的“手动移出”入口；直接编辑 `review-state` 或删除 artifact 不属于同步规则。

### 定向复核（可选）

`REVIEW_VERIFY_MODE` 开启后，review-queue 在 `merge` 之后、写 state 之前复核候选：

```text
只读日志 + report
  → 选出“已覆盖但未再出现”的 unresolved 候选
  → 调 scripts/review-verify.ts（tsx）
  → 逐条查目标端
  → 写回结果
```

| 模式      | 行为                                       |
| --------- | ------------------------------------------ |
| `off`     | 不执行，保持现有两轮规则                   |
| `shadow`  | 查询并记录统计，不修改名单                 |
| `enforce` | resolved 移出；其余保留并重置 `missedRuns` |

复核条件：

- `kind = unresolved`；
- 本轮 `scannedIds` 覆盖；
- 日志未再次出现；
- 未达到 `REVIEW_VERIFY_RETRY_DAYS` 的条目不重复查询；
- 无 `sync-report`、`degraded`、sync 未成功时不执行。

结果：

| 结果               | 动作                 |
| ------------------ | -------------------- |
| `resolved`         | 移出                 |
| `still-unresolved` | `missedRuns=0`，保留 |
| `ambiguous`        | 保留，标记歧义       |
| `error`            | 保留，下一轮重试     |

复核只读，不写 NeoDB/Bangumi/TMDB/Notion；失败不阻断 state 上传。  
review-queue 需要 `npm ci` 和只读凭据；配置见 [配置说明](configuration.md)。

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
