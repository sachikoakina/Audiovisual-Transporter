# Audiovisual-Transporter

把豆瓣与 Bangumi 的书影音标记单向同步到 Notion、NeoDB、Bangumi 与 TMDB。
每条链路先读目标端现状，再逐字段比对，只写差异，因此重复运行不会产生重复数据。

![五条同步链路及其对应开关](docs/sync-paths.svg)

> **阅读分工**：本文件是使用说明与整体结构。平台读写边界、接口依据、数据格式样例、每次运行输出的逐字段契约，见[参考手册](docs/reference.md)。

## 总览

五条链路全部**单向、幂等**：①②③ 同源（豆瓣 RSS，任一豆瓣链路开启时抓取一次），④⑤ 独立读取各自的源。

```mermaid
flowchart LR
    RSS["豆瓣 RSS<br/>任一豆瓣链路开启时抓取一次"] --> P1["① Notion<br/>仅 Complete"]
    RSS --> P2["② NeoDB<br/>三种状态"]
    RSS --> P3["③ Bangumi<br/>三种状态"]
    BG["Bangumi 收藏<br/>默认只读第一页"] --> P4["④ NeoDB"]
    P1 --> NO[("Notion")]
    P2 --> N[("NeoDB")]
    P4 --> N
    P3 --> BM[("Bangumi")]
    N --> P5["⑤ TMDB<br/>读 NeoDB 自己的书架"]
    P5 --> T[("TMDB")]
```

## 快速开始

**GitHub Actions（推荐）**：`sync` 工作流每周一 / 三 / 五 08:00 UTC 自动运行，按仓库配置的开关执行；
手动触发时可勾选 `full_sync`（⑤ 取消单轮上限）或 `bangumi_full_sync`（④ 遍历全部分页）。
每次运行结束后 `review-queue` 工作流自动汇总「待核对名单」，无需本地环境。

**本地运行**：要求 Node.js 20 或以上。

```bash
npm ci
cp .env.example .env          # 填写当前链路所需的 token
npm run verify:all            # 离线：单元测试 + 五项断言脚本
SYNC_DRY_RUN=1 npm run sync   # 空跑，不写任何目标端
```

PowerShell 中设置临时变量：

```powershell
$env:SYNC_DRY_RUN=1; npm run sync
```

确认空跑输出后再正式执行。全量导入：

```bash
npm run sync:bangumi-full      # Bangumi → NeoDB，遍历全部分页
npm run sync:neodb-tmdb-full   # NeoDB → TMDB，取消单轮条数与页数上限
```

## 五条链路

| #   | 源                      | 目标    | 默认 | 写入方式                             |
| --- | ----------------------- | ------- | ---- | ------------------------------------ |
| ①   | 豆瓣 RSS（仅 complete） | Notion  | 关   | 按分类建页，先查库内已有链接         |
| ②   | 豆瓣 RSS（全部状态）    | NeoDB   | 开   | `mergeNeodbMark` 四字段比对后 upsert |
| ③   | 豆瓣 RSS（全部状态）    | Bangumi | 开   | 外链 → 精确同名 → 年份软过滤         |
| ④   | Bangumi 收藏            | NeoDB   | 开   | 四字段合并，可选同步进度             |
| ⑤   | NeoDB 书架              | TMDB    | 关   | 读 `account_states` 后逐字段 diff    |

开关：`SYNC_DOUBAN_NOTION`、`SYNC_DOUBAN_NEODB`、`SYNC_DOUBAN_BANGUMI`、`SYNC_BANGUMI_NEODB`、`SYNC_NEODB_TMDB`。

### ① 豆瓣 RSS → Notion

```mermaid
flowchart TD
    A["豆瓣 RSS（仅 complete）"] --> B["类别白名单过滤"]
    B --> C["按分类分组，每组一个 Notion 数据源"]
    C --> D["查库内已有条目链接<br/>100 条一批构造 or 条件，并跟随翻页"]
    D --> E["差集 = 待插入"]
    E --> F["每分类读一次库结构<br/>不在库里的列直接丢弃"]
    F --> G["逐条：抓豆瓣条目页（PoW 自解）<br/>→ 建页 → 间隔 1s"]
    G --> H["PathReport<br/>自检：五项计数之和 = scanned"]
```

### ② 豆瓣 RSS → NeoDB

```mermaid
flowchart TD
    A["豆瓣条目"] --> B["按链接取 NeoDB 条目<br/>无 uuid 时重试 3 次"]
    B -->|始终无| U["unresolved · 数据缺口"]
    B -->|取到| C["读现有标记：found / absent / error"]
    C -->|error| X["绝不覆盖<br/>单条失败或整链中止"]
    C -->|absent| D["新建标记"]
    C -->|found| E{"现有状态豆瓣能否表达？"}
    E -->|否| S["skipped · 不覆盖"]
    E -->|是| F["mergeNeodbMark 四字段比对"]
    F -->|无差异| G["unchanged"]
    F -->|有差异| H["更新标记"]
```

### ③ 豆瓣 RSS → Bangumi

```mermaid
flowchart TD
    A["豆瓣条目 + 其 NeoDB 条目"] --> B{"外链已带 Bangumi 链接？"}
    B -->|是| C["直接取 subject id"]
    B -->|否| D{"话剧？"}
    D -->|是| U["unresolved"]
    D -->|否| E["标题搜索（限定类型）<br/>→ 精确同名 + 年份软过滤"]
    E -->|未命中| U
    E -->|命中| F["读现有收藏：found / absent / error"]
    F --> G{"Bangumi 已有评分？"}
    G -->|是| H["保留既有评分，只比对其余字段"]
    G -->|否| I["写入豆瓣评分"]
    H --> J["写 / unchanged / skipped（搁置·抛弃）"]
    I --> J
```

### ④ Bangumi 收藏 → NeoDB

```mermaid
flowchart TD
    A["Bangumi 收藏"] --> B["uuid 归一：优先带豆瓣外链的孪生条目<br/>（外链 → 标题搜索）"]
    B --> C["读现有标记：found / absent / error"]
    C -->|absent| D["新建标记"]
    C -->|found| E["mergeNeodbMark 四字段比对"]
    E -->|有差异| F["更新标记<br/>不带 createdTime，保留原标记日期"]
    E -->|无差异| G["unchanged"]
    D --> H{"SYNC_BANGUMI_NEODB_PROGRESS？"}
    F --> H
    G --> H
    H -->|开| I["比对并同步进度"]
    H -->|关| Z["计数"]
    I --> Z
```

### ⑤ NeoDB 书架 → TMDB

```mermaid
flowchart TD
    A["NeoDB 书架标记"] --> B{"分类能映射 TMDB？<br/>（movie / tv）"}
    B -->|否| S["skipped"]
    B -->|是| C{"内容指纹未变？（增量模式）"}
    C -->|是| S2["skipped · 零请求"]
    C -->|否| D["三级匹配：TMDB 外链 → IMDb → 标题 + 年份"]
    D -->|未命中| U["unresolved"]
    D -->|命中| E["读 account_states：found / error"]
    E --> F["planTmdbWrites 逐字段 diff"]
    F -->|无差异| G["unchanged"]
    F -->|有差异| H["写评分 / watchlist"]
```

## 同步规则

三条规则适用于所有链路。

1. **先读后写**。目标端读取分 `found`、`absent`、`error` 三态；`error` 时一律不写，遇到 401/403 中止该链路。
2. **只写差异**。字段逐个比较，相同就跳过；`unchanged` 计数不代表出错。
3. **失败记录在报告里**。单条失败不影响同链路的其他条目；凭据失效等常见故障会被折成 `aborted`，其余链路继续。

三态由统一的分类规则判定：

```mermaid
flowchart TD
    A["读取目标端现状<br/>4 个读原语统一返回三态"] --> B{"HTTP 结果？"}
    B -->|2xx| C["found · 携带数据"]
    B -->|404| D{"该端点上 404 的含义？"}
    D -->|"「还没有标记」"| E["absent · 允许新建"]
    D -->|"「记录本身不存在」"| F["error"]
    B -->|"401 / 403"| G["auth · 凭据失效"]
    B -->|超时 · 5xx 等| H["item · 单条读取失败"]
    G --> I["整条链路中止<br/>其余链路继续"]
    F --> J["本条失败 · 绝不覆盖"]
    H --> J
```

各链路的调用节奏：

| 链路 | 节流                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| ①    | 建页间隔 1s（固定）                                                              |
| ②③④  | NeoDB 间隔 300ms（`NEODB_REQUEST_DELAY_MS`）；③④ 另有 Bangumi 间隔 400ms（固定） |
| ⑤    | TMDB 间隔 300ms（`TMDB_REQUEST_DELAY_MS`）+ 换分类时 NeoDB 间隔 300ms            |

## 结果与退出码

每轮结束后每条链路输出六个计数，`scanned` 是分母：

```mermaid
flowchart TD
    S["scanned<br/>进入本链路的每一条"] --> W["written · 实际写出"]
    S --> U["unchanged · 读完无差异"]
    S --> K["skipped · 规则内跳过"]
    S --> R["unresolved · 找不到对应条目"]
    S --> F["failed · 读取或写入出错"]
```

| 计数         | 含义           |
| ------------ | -------------- |
| `scanned`    | 检查过的条目   |
| `written`    | 实际写出       |
| `unchanged`  | 读完无差异     |
| `skipped`    | 规则内跳过     |
| `failed`     | 读取或写入出错 |
| `unresolved` | 找不到目标条目 |

满足 `written + unchanged + skipped + unresolved + failed = scanned`（按条目计，不按字段计）。

任一条路 `aborted` 或 `failed > 0` 时退出码为 1；`SYNC_DOUBAN_REQUIRED=0` 时豆瓣侧的失败标记为 `TOLERATED`，只展示、不参与退出码。

## 待核对名单

同步中「没把握」的条目会沉淀成一份跨轮维护的名单，由 `review-queue` 工作流在每次 `sync` 结束后自动生成：

```mermaid
sequenceDiagram
    participant T as 触发
    participant S as sync job
    participant A as Artifacts
    participant Q as review-queue job
    participant M as 待核对名单
    T->>S: 周一/三/五 08:00 UTC 或手动勾选全量
    S->>S: verify:all → 五条链路
    S->>A: sync-report-<run_id>-<UTC>（保留 7 天）
    Note over A: 作业摘要随 run 发布，失败轮也可见
    Q->>A: 取上一轮 review-state + 本轮日志 + 运行报表
    Q->>Q: 解析日志 → 覆盖集合 → 合并 → 渲染
    Q->>M: 名单追加到作业摘要
    Q->>A: review-state-<run_id>-<UTC>-stock（保留 90 天，供下一轮携带）
```

名单按 `链路 → 结果 → 类型 → 状态` 四级分组，条目保留标题、可点链接、reason 与已存在天数；
顶部另有「本轮新增 / 本轮移除 / 观察中」摘要块与「运行报表」对账小节：

```mermaid
flowchart TD
    T["名单合计 + 新增 / 移除 / 观察中"] --> H1["# 链路（① → ⑤）"]
    H1 --> H2["## 结果：unresolved / failed / skipped"]
    H2 --> H3["### 条目类型：电影 / 电视剧 / 动画 / 书籍 …"]
    H3 --> H4["#### 用户状态：想看 / 在看 / 看过 / 搁置 / 抛弃"]
    H4 --> E["条目行：标题 — 链接 · reason · 已存在 N 天"]
```

条目的去留由状态机决定——**「没被扫到」永远不等于「修好了」**：

```mermaid
stateDiagram-v2
    state "观察中（首次观测）" as O
    state "已入名单" as L
    state "冻结（本轮未覆盖）" as F
    state "已移除" as R
    [*] --> O
    O --> L: 连续出现满观察期（failed 需 2 轮）
    L --> L: 再次观测 · 续期
    L --> R: 被扫描到且连续两轮缺席
    L --> F: 本轮不在扫描集合
    F --> L: 重新被扫描到
    O --> F: 未被扫描到
    R --> [*]
```

⑤ 的条目以**绝对化的 NeoDB 页面链接**为身份与匹配依据。解析器失效时名单整体冻结并在摘要顶部标红，绝不悄悄清空；
名单同时受运行报表对账：报表计得比日志解析出的多时，摘要会点名差异。
本地运行时未匹配条目另记录到 `.cache/unmatched.json`（CI 上置空不写）。

## 配置

完整变量与默认值见 [`.env.example`](.env.example)。常用项：

| 变量                              | 默认                                 | 说明                                                    |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `SYNC_DRY_RUN`                    | `0`                                  | `1` 时只打印计划，不写目标端                            |
| `SYNC_SHELF_TYPES`                | `wishlist,progress,complete,dropped` | ⑤ 处理的书架                                            |
| `SYNC_CATEGORIES`                 | `movie,tv`                           | ⑤ 处理的分类                                            |
| `SYNC_MAX_ITEMS`                  | `50`                                 | ⑤ 每个书架×分类的条目上限（默认 4×2×50=400）            |
| `SYNC_RATING_PROFILE`             | `tmdb_prefer`                        | 评分冲突时保留 TMDB；`neodb_prefer` 用 NeoDB 覆盖       |
| `SYNC_INCREMENTAL`                | `1`                                  | ⑤ 跳过内容未变的条目；CI 固定为 `0`                     |
| `SYNC_DOUBAN_REQUIRED`            | `1`                                  | `0` 时豆瓣失败不参与退出码                              |
| `SYNC_BANGUMI_NEODB_STATUS_GUARD` | `off`                                | `no-downgrade` 时不让 Bangumi 的想看/在读覆盖已看       |
| `SYNC_BANGUMI_NEODB_CREATED_TIME` | `target`                             | `source` / `source-newer` 才用 Bangumi 时间覆盖标记日期 |

注意 `neodb_prefer` 在两处的含义不同：⑤ 的 `SYNC_RATING_PROFILE` 表示用 NeoDB 覆盖 TMDB；②④ 的 `SYNC_*_NEODB_MERGE` 表示保留 NeoDB 已有的非空值。默认的 `neodb_prefer` 是**目标端优先**，只有 `overwrite` 才是源端覆盖。

## 目录结构

```text
src/
  index.ts                  入口，按开关依次执行链路
  sync-config.ts            环境变量解析
  sync-report.ts            控制台汇总
  sync-summary-markdown.ts  作业摘要
  read-guards.ts            读取三态与 401/403 处理
  types.ts                  共享类型与计数
  paths/                    各链路编排
  clients/                  平台客户端
  rules/                    映射、比对、匹配等纯逻辑
  bangumi-to-neodb-full-cli.ts
  neodb-to-tmdb-full-cli.ts
scripts/
  review-queue.mjs          待核对名单生成
  verify-*.ts               离线断言
tests/unit/                 单元测试
docs/reference.md           接口、输出与计数契约
cols.json                   Notion 列名映射
```

分层的依赖方向是单向的：`rules/` 不依赖任何模块（零 I/O、零环境变量），`clients/` 只依赖 `rules/` 与配置，`paths/` 编排两者，入口层只看报告。

| 层     | 模块                        | 职责                                                              |
| ------ | --------------------------- | ----------------------------------------------------------------- |
| 入口   | `index.ts` + 2 个全量 cli   | 按开关调度链路，折叠报告，决定退出码                              |
| 编排   | `paths/`（5 条链路）        | 每条链路的读取 → 比对 → 写入循环，产出 `PathReport`               |
| 客户端 | `clients/`（9 个平台模块）  | HTTP、鉴权、重试、节流；读原语统一返回三态                        |
| 规则   | `rules/`（10 个纯函数模块） | 状态映射、合并与写计划、标题匹配、名单词表                        |
| 支撑   | 配置 · 展示 · 状态          | `sync-config` · `sync-report` + `sync-summary-markdown` · `utils` |
| 翻译   | `read-guards.ts`            | 三态 → 值或异常：auth 中止整链，其余单条失败                      |
| 脚本   | `scripts/`                  | 待核对名单（读日志 + 报表）与离线契约断言                         |

## 已知限制

| 限制                        | 影响                                                      |
| --------------------------- | --------------------------------------------------------- |
| 豆瓣 RSS 每页约 10 条       | 两次运行间新增过多会漏                                    |
| 豆瓣可能拒绝 CI 出口 IP     | Actions 上豆瓣链路可能失败，可设 `SYNC_DOUBAN_REQUIRED=0` |
| Bangumi token 无 refresh    | 过期后 ③④ 返回 401，需重新生成                            |
| 完全单向                    | 源端删除不会传播到目标端                                  |
| TMDB 只承载评分与 watchlist | 短评、进度、图书/音乐/游戏等无法同步                      |
| 默认不全量                  | 老收藏可能长期轮不到，需显式跑全量入口                    |

## 开发

```bash
npm run sync                  # 按开关执行全部链路
npm run typecheck
npm run lint
npm run format:check
npm run verify:all
```

- `tests/unit/` 使用 vitest，覆盖 `paths/` 的接线与规则。
- `scripts/verify-*.ts` 是无框架断言，覆盖映射、解析器、日志与文档契约（`verify:all` = vitest + 五项断言脚本）。
- 新增链路：在 `src/paths/` 新建文件 → `src/index.ts` 调度 → `types.ts` 计数 → 对应测试与断言。

## 文档

- [`docs/reference.md`](docs/reference.md)：平台边界、接口依据、数据格式、运行输出与留档契约。

## 致谢

本项目的想法与技术路线来自 [bambooom/douban-backup](https://github.com/bambooom/douban-backup) 与 [viazure/douban-backup](https://github.com/viazure/douban-backup)，感谢两个项目的作者与贡献者。

## License

MIT
