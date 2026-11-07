# 架构与模块职责

本文只描述运行结构与模块边界；五条链路的匹配细节见[链路说明](sync-paths.md)，Actions 操作见[运行配置](github-actions.md)。

## 运行结构

```text
GitHub Actions: sync
      │
      ├─ npm ci + verify:all
      ├─ src/index.ts
      │    ├─ 豆瓣 RSS（抓取一次）
      │    │    ├─ ① Notion
      │    │    ├─ ② NeoDB
      │    │    └─ ③ Bangumi
      │    ├─ ④ Bangumi → NeoDB
      │    └─ ⑤ NeoDB → TMDB
      │
      ├─ PathReport → 控制台 / Markdown / JSON artifact
      └─ review-queue（workflow_run）
           └─ 日志 + report → review-state artifact
```

`src/index.ts` 按上述顺序执行启用的路径。豆瓣 RSS 只抓一次，①②③复用归一化结果；④⑤读取各自平台书架，不依赖本轮豆瓣 feed。

**失败域（按 `src/index.ts` 的实际实现）**：`fetchRSSFeeds` 与 ①②③ 三个 `await` 包在**同一个 `try`** 里。其中任一环节抛出，都会被同一个 `catch` 捕获，记为一条名为 `Douban RSS` 的 `aborted` 报告，然后**继续执行 ④⑤**。因此实际语义是「失败会中断该链路**及其后尚未运行的**同组链路」，而不是「① 失败会跳过 ②③」——②③ 若已在 ① 之前跑完，其结果不受影响。④⑤ 各自独立 `try`，失败只影响自己的报告。`SYNC_DOUBAN_REQUIRED=0` 会把那条 `Douban RSS` 报告标为 `tolerated`，仍显示但不参与退出码。

## 模块关系

```text
index
  └─ paths/*       编排读取、匹配、规则判断与写入
       ├─ clients/*    平台请求与响应解码
       ├─ rules/*      纯匹配、状态映射、进度与写入计划
       └─ read-guards  found / absent / error 三态读取
sync-report / sync-summary-markdown
  └─ PathReport
review-queue
  └─ 工作流日志 + sync-report.json + 上一轮 state
```

## 目录职责

| 路径                                                 | 职责                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `src/index.ts`                                       | 读取开关、调度五条路径、汇总报告、设置退出码              |
| `src/paths/`                                         | 单条链路编排；不直接实现平台协议                          |
| `src/clients/`                                       | 豆瓣、Notion、Bangumi、NeoDB、TMDB 请求与类型             |
| `src/rules/`                                         | 标题/ID 匹配、状态/进度映射、评分合并、冲突裁决、写入计划 |
| `src/sync-config.ts`                                 | 环境变量、开关、分类白名单、上限与路径                    |
| `src/types.ts`                                       | API 数据类型、`PathReport`、`ReviewDetail`                |
| `src/utils.ts`                                       | 进程级工具、状态/缓存文件、留档日志、共享平台判断         |
| `src/read-guards.ts`                                 | `ReadResult` 与读取失败/空记录保护                        |
| `src/sync-report.ts`、`src/sync-summary-markdown.ts` | 终端摘要与 Actions 作业摘要                               |
| `scripts/review-queue.mjs`                           | 汇总日志与报告，合并跨轮待核对名单                        |
| `scripts/` 中的 verify 脚本                          | 离线规则/解析器/文档/日志契约校验                         |

## 外部写入边界

| 平台    | 代码允许的写入                                     |
| ------- | -------------------------------------------------- |
| 豆瓣    | 只读 RSS 与条目页；不写                            |
| Notion  | 创建页面；先按条目链接查重，只提交目标数据源已有列 |
| NeoDB   | 创建/更新书架标记；按配置写进度                    |
| Bangumi | 创建/更新收藏状态、评分、短评                      |
| TMDB    | 更新评分、watchlist；只处理 movie/tv               |

## 错误与退出码

每条路径返回 `PathReport`，按六类计数：

```text
scanned = written + unchanged + skipped + unresolved + failed
```

- `unresolved`：目标目录没有确认对应项，是数据缺口，不单独失败；
- `failed`：单条写入/读取失败，继续处理后续条目；
- `aborted`：整条路径无法继续（如认证失效），记录后结束该路径；
- 401/403 视为认证问题，中止依赖该凭据的路径；
- `SYNC_DOUBAN_REQUIRED=0` 时豆瓣 RSS 故障标为 tolerated，不参与退出码；
- dry-run 只输出计划，不代表已写入。

## 状态文件

六个 `.cache/*` 文件的**唯一出处**是 [`reference.md` 的状态文件与留档表](reference.md#状态文件与留档)，那里同时列出每个文件对应的环境变量、默认路径与用途。这里不重复表的内容，只记一条结构性事实：

写入采用同目录临时文件再改名（`writeJsonAtomic`），避免进程中断留下半份 JSON。`review-queue` 的 `review-state` artifact 是另一套跨轮状态，不使用这些文件。
