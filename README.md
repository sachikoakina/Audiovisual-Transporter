# Douban-Shelf-Archivist

个人书影音收藏的**跨平台归档与迁移**工具。它把豆瓣、Bangumi、NeoDB、TMDB 四个平台的收藏标记打通，让你在一个地方记录、在多个地方留档。

技术上延续 [douban-backup](https://github.com/viazure/douban-backup) 的全部能力，并新增 **NeoDB 书架 → TMDB** 单向同步。TypeScript 编写，`tsx` 直跑，无需构建。

![同步链路与开关](docs/sync-paths.svg)

---

## 目录

**理解这个项目**

- [项目定位](#项目定位)
- [核心功能](#核心功能)

**同步规则**

- [五条链路的匹配与映射规则](#五条链路的匹配与映射规则)
- [平台权限与同步范围](#平台权限与同步范围)

**配置与部署**

- [配置项说明](#配置项说明)
- [配置项总表](#配置项总表)
- [GitHub Actions 配置](#github-actions-配置)

**上手**

- [新手入门指南](#新手入门指南)
- [快速开始](#快速开始)

**代码与维护**

- [目录结构](#目录结构)
- [各文件用途](#各文件用途)
- [常见问题](#常见问题)
- [与上游同步](#与上游同步)

---

## 项目定位

### 它解决什么问题

豆瓣是中文书影音记录的主要入口，但数据不在你手里。这个工具做两件事：

1. **留档**——把豆瓣的收藏导出到 Notion（结构化表格）、NeoDB（开放社交平台）、Bangumi（动画/漫画强项），任一平台出问题都不至于全部丢失。
2. **打通**——把 NeoDB 的书架状态镜像到 TMDB，让 TMDB 上的观影记录与评分自动跟随 NeoDB。

### 与 douban-backup 的关系

|          | douban-backup           | 本项目                             |
| -------- | ----------------------- | ---------------------------------- |
| 链路数   | 4 条                    | **5 条**（+ NeoDB → TMDB）         |
| 数据流向 | 豆瓣/Bangumi → 其他平台 | 增加平台之间的横向同步             |
| 代码关系 | —                       | 原有代码**完全保留**，仅追加新模块 |

**如果不需要 TMDB**，把 `SYNC_NEODB_TMDB` 保持为 `0`，行为与 douban-backup 完全一致。

---

## 核心功能

### 五条链路

| #   | 链路               | 开关                  |  默认  | 说明                                      |
| --- | ------------------ | --------------------- | :----: | ----------------------------------------- |
| 1   | 豆瓣 RSS → Notion  | `SYNC_DOUBAN_NOTION`  |   关   | 抓取详情页，仅处理「看过/听过/读过/玩过」 |
| 2   | 豆瓣 RSS → NeoDB   | `SYNC_DOUBAN_NEODB`   | **开** | 写入标记、评分、评论、进度                |
| 3   | 豆瓣 RSS → Bangumi | `SYNC_DOUBAN_BANGUMI` | **开** | 写入收藏标记                              |
| 4   | Bangumi → NeoDB    | `SYNC_BANGUMI_NEODB`  | **开** | 反向补齐 NeoDB，支持全量同步              |
| 5   | **NeoDB → TMDB**   | `SYNC_NEODB_TMDB`     |   关   | 见下方映射规则                            |

取值 `1`/`true`/`yes`/`on` 表示开启。关闭全部 `Douban→*` 时会跳过拉取豆瓣 RSS。

### 三条设计原则

**幂等** — 重复运行任意多次，结果一致。每条记录先读目标平台现状，逐字段比对，不需要的写操作一个都不发。

**保留既有数据** — NeoDB 无评分时**绝不清除** TMDB 上已有的评分。删除会抹掉你手写的数据。

**宁可漏配，不可错配** — 找不到精确匹配的条目直接跳过并记录，绝不「猜最接近的那个」。

---

## 五条链路的匹配与映射规则

这一章覆盖**全部五条链路**：每条如何匹配目标条目、字段如何对应、出错与冲突如何处理。

### 通用约定

**匹配原则**：优先使用平台之间已有的 ID 链接（零猜测），其次才做标题精确匹配。**宁可漏配，不可错配**——匹配不到就跳过并记录，绝不写到"看起来最像"的条目上。

**异常隔离**：单条失败不中断整批；豆瓣链路整体失败也不会挡住后面的 Bangumi → NeoDB。**全仓已无任何 `process.exit()`**——失败一律记在 `PathReport` 上，最后统一折算成退出码。

> ⚠️ **"启用了但跑不了"会算失败。** 若某条链路的开关是开的、但缺少它需要的凭据（例如 `SYNC_DOUBAN_NEODB=1` 却没有 `NEODB_API_TOKEN`），该链路会报告 `aborted` 并让整轮以退出码 1 结束，同时在汇总里显示 `FAILED`。这是刻意的：过去它是静默 no-op，日志看起来和"跑过且无事可做"一模一样。若你确实只想跑部分链路，请把其余开关显式设为 `0`。

**类别过滤**：每条链路都能配类别白名单。填了值却**无可识别类别**时，该链路会拒绝同步任何条目（fail-closed），避免拼写错误演变成意外全量写入。

### 链路 1–3：豆瓣 RSS → Notion / NeoDB / Bangumi

三条链路**同源**——都从豆瓣 RSS 出发，共用同一套解析与状态识别逻辑。因此合并讲解：共性说一次，差异用一张表横向对比。

#### 共同的前置处理

1. 用 `DOUBAN_USER_ID` 拉取豆瓣 RSS（三条链路全关时会跳过，见下方各节开关）
2. 解析条目的状态前缀（`看过` `在看` `想看` `读过` `在听` `玩过` …），归一为三种中间状态：**Complete** / **Progress** / **Wishlist**
3. 按该链路的类别白名单过滤（`SYNC_DOUBAN_*_CATEGORIES`）

#### 三条链路的差异一览

|                  | → Notion                       | → NeoDB                       | → Bangumi                            |
| ---------------- | ------------------------------ | ----------------------------- | ------------------------------------ |
| **开关**         | `SYNC_DOUBAN_NOTION`（默认关） | `SYNC_DOUBAN_NEODB`（默认开） | `SYNC_DOUBAN_BANGUMI`（默认开）      |
| **匹配方式**     | 不匹配，直接追加新行           | 交给 NeoDB 解析豆瓣 URL       | NeoDB 的 Bangumi 链接 → 标题精确搜索 |
| **处理哪些状态** | **仅 Complete**                | 三种全部                      | 三种全部                             |
| **评分换算**     | 原样 1–5 星                    | ×2 得 1–10                    | ×2 得 1–10                           |
| **短评去向**     | `COMMENTS`                     | `comment_text`                | `comment`                            |
| **匹配不到时**   | 不适用（无需匹配）             | 跳过该条                      | 跳过该条                             |
| **失败处理**     | 详情页抓取失败 → 该条不建页面  | 解析失败 → 跳过该条           | 已有「搁置 / 抛弃」→ **跳过不覆盖**  |

#### 链路 1：豆瓣 RSS → Notion

▸ **匹配方式**：不做匹配。Notion 是"追加"型目标，每条新记录创建一行。

▸ **前置过滤**：只处理 `Complete` 状态（看过 / 读过 / 玩过 / 听过）。在看、想看这类半途状态不建页面——因为没有"完成日期"可填。

▸ **字段映射**：

| 来源           | Notion 属性                                           | 说明                                         |
| -------------- | ----------------------------------------------------- | -------------------------------------------- |
| 标题           | 各库 TITLE 属性                                       | 电影 / 音乐 / 图书 / 游戏 / 话剧共五个数据库 |
| 海报           | `POSTER`                                              | 豆瓣封面图（文件属性）                       |
| 评分（1–5 星） | `RATING`                                              | 多选属性，保留原始星数                       |
| 评分日期       | `RATING_DATE`                                         | 即条目完成时间                               |
| 短评           | `COMMENTS`                                            | 富文本，原样写入                             |
| 条目链接       | `ITEM_LINK`                                           | 豆瓣 URL                                     |
| 通用元数据     | `YEAR` `GENRE` `IMDB_LINK` `RELEASE_DATE`             | 从豆瓣详情页抓取                             |
| 电影专属       | `DIRECTORS` `SCREENWRITERS` `ACTORS`                  | 导演 / 编剧 / 演员                           |
| 图书专属       | `WRITER` `PUBLISHING_HOUSE` `ISBN` `PUBLICATION_DATE` | 作者 / 出版社 / ISBN / 出版日期              |
| 音乐专属       | `MUSICIAN`                                            | 音乐人                                       |

> 属性名与类型由项目根目录的 **`cols.json`** 定义，你的 Notion 数据库必须与之一致，否则写入会失败。

▸ **状态映射**：**本链路不做状态映射**——只有 `Complete` 状态会进入，其余在过滤阶段即被排除。这与另外四条链路不同：Notion 是归档表格，不是状态跟踪器。

▸ **异常处理**：详情页抓取失败 → 该条记入失败列表、不建页面，其余继续。

#### 链路 2：豆瓣 RSS → NeoDB

> 官方文档：[NeoDB 开发者页面](https://neodb.social/developer/)

▸ **匹配方式**：把豆瓣条目的 URL 交给 NeoDB 自己解析，调用 `GET /api/catalog/fetch?url=<豆瓣链接>`，由 NeoDB 返回它的 catalog item。

▸ **重试机制（重要）**：NeoDB 完成抓取需要时间。若返回 202 且没有 `uuid`，会**重试 3 次、每次间隔 1.5 秒**。

▸ **字段映射**：

| 豆瓣侧         | NeoDB 侧       | 换算说明                                               |
| -------------- | -------------- | ------------------------------------------------------ |
| 状态           | `shelf_type`   | 见下方状态对照                                         |
| 评分 1–5 星    | `rating_grade` | ×2 得 1–10                                             |
| 短评           | `comment_text` | 原样写入                                               |
| 进度           | progress 字段  | 依类别决定类型（集 / 章 / 曲）                         |
| （无对应字段） | `visibility`   | 由 `NEODB_VISIBILITY` 指定，0 公开 / 1 关注者 / 2 私密 |

▸ **状态对照**：

| 豆瓣状态                  | 中间状态 | 写入 NeoDB `shelf_type` |
| ------------------------- | -------- | ----------------------- |
| 看过 / 读过 / 玩过 / 听过 | Complete | `complete`              |
| 在看 / 在读 / 在玩 / 在听 | Progress | `progress`              |
| 想看 / 想读 / 想玩 / 想听 | Wishlist | `wishlist`              |

> 豆瓣没有「弃看」状态，所以这条链路**不会写入** `dropped`。

▸ **异常处理**：解析失败 → 跳过该条；NeoDB 已有标记 → 走 `mergeNeodbMark` 合并（详见「[双路冲突](#双路冲突豆瓣--neodb-与-bangumi--neodb)」）。

▸ **接口依据**（NeoDB 侧。结构来自官方 API 参考与两个独立客户端类型定义的交叉验证）：

| 端点 / 字段                | 说明                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/me/shelf/{type}` | `type` 是**路径参数**（`wishlist` / `progress` / `complete` / `dropped`），查询参数为 `category`、`page` |
| `GET /api/catalog/fetch`   | 用 `?url=` 传入豆瓣链接，解析出 catalog item（无 `uuid` 时轮询重试）                                     |
| 响应结构                   | `{ data: MarkSchema[], pages, count }`；`MarkSchema` **内联完整 `item`**，无需二次请求                   |
| `rating_grade`             | 0–10 整数，**`0` 表示未评分**                                                                            |
| 年份字段                   | movie / tv 为 `year`，图书为 `pub_year`                                                                  |

运行 `npm run probe:neodb` 可随时复核上述假设。

#### 链路 3：豆瓣 RSS → Bangumi

> 官方文档：[Bangumi API](https://bangumi.github.io/api/)　·　[个人令牌页面](https://next.bgm.tv/demo/access-token)

▸ **匹配方式**（两级递进）：

1. 先看 NeoDB 条目的 `external_resources` 里有没有 Bangumi 链接，有就直接取 subject id
2. 没有则用标题搜索，限定 subject_type 候选（电影会同时试「动画」和「真人」两种），**必须精确匹配标题**

▸ **字段映射**：

| 豆瓣侧      | Bangumi 侧      | 换算说明       |
| ----------- | --------------- | -------------- |
| 状态        | collection type | 见下方状态对照 |
| 评分 1–5 星 | rate            | ×2 得 1–10     |
| 短评        | comment         | 原样写入       |

▸ **状态对照**：

| 豆瓣状态 | Bangumi collection type | Bangumi 显示 |
| -------- | ----------------------- | ------------ |
| 想看     | 1                       | 想看         |
| 看过     | 2                       | 看过         |
| 在看     | 3                       | 在看         |
| （无）   | 4                       | 搁置         |
| （无）   | 5                       | 抛弃         |

> 豆瓣只有三种状态，所以第 4、5 类**只会由反向链路产生**（Bangumi → NeoDB）。

▸ **异常处理（关键保护）**：如果 Bangumi 侧已有状态&#x662F;**「搁置」或「抛弃」**，则**跳过、不覆盖**。因为豆瓣没有这两个状态，用豆瓣的状态去覆盖会抹掉你在 Bangumi 上的真实意图。

▸ **类别限制**：话剧（drama）在 Bangumi 没有对应类型，只有 NeoDB 上已存在 Bangumi 链接时才会同步。

### 链路 4：Bangumi → NeoDB

▸ **匹配方式**：`resolveNeodbItemForBangumiUrl()`，**刻意做了一次"对齐"**：

1. 先用 Bangumi URL 在 NeoDB 取到对应 catalog item
2. 如果该条目上挂了豆瓣链接 → **改用它指向的豆瓣条目**
3. 否则按标题搜索，找一个**既有豆瓣链接、标题又精确相等**的条目
4. 都找不到才用 Bangumi 自己的条目

▸ **为什么要这样对齐**：让 Bangumi → NeoDB 与豆瓣 → NeoDB **落在同一个 NeoDB 条目上**。否则同一部作品会在两个 uuid 下各存一份标记，你在 NeoDB 上会看到重复条目。

▸ **字段映射**：

| Bangumi 侧                 | NeoDB 侧       | 换算说明                   |
| -------------------------- | -------------- | -------------------------- |
| collection type            | `shelf_type`   | 见下方状态对照             |
| rate                       | `rating_grade` | 直接对应（同为 1–10）      |
| comment                    | `comment_text` | 原样写入                   |
| `ep_status` / `vol_status` | progress       | 见下方进度映射             |
| （无对应字段）             | `visibility`   | 由 `NEODB_VISIBILITY` 指定 |

▸ **状态对照**（NeoDB 没有「搁置」态，第 4 类归入 progress）：

| Bangumi collection type | Bangumi 显示 | 写入 NeoDB `shelf_type` |
| ----------------------- | ------------ | ----------------------- |
| 1                       | 想看         | `wishlist`              |
| 2                       | 看过         | `complete`              |
| 3                       | 在看         | `progress`              |
| 4                       | 搁置         | `progress`（无搁置态）  |
| 5                       | 抛弃         | `dropped`               |

▸ **进度映射**（仅 `SYNC_BANGUMI_NEODB_PROGRESS=1` 时执行）：

| Bangumi subject_type | 类别        | NeoDB 进度类型 | 取值来源                           |
| -------------------- | ----------- | -------------- | ---------------------------------- |
| 2 / 6                | 动画 / 真人 | `episode`      | `ep_status`                        |
| 1                    | 书籍        | `chapter`      | `vol_status`，为空则用 `ep_status` |
| 3                    | 音乐        | `track`        | `ep_status`                        |
| 4                    | 游戏        | —              | **跳过**                           |

▸ **异常处理**：

- 进度类型与 NeoDB 条目类别不匹配时**不发请求**（例如给 movie 发 `episode` 会被 NeoDB 以 400 拒绝）
- 零进度不发送，**不会清空**既有进度
- 默认关闭进度同步（`SYNC_BANGUMI_NEODB_PROGRESS=0`）
- **NeoDB 没有对应条目**（日志中的 `ERR_NON_2XX_3XX_RESPONSE` → `NeoDB could not resolve Bangumi URL`）→ 跳过该条，计入 `unresolved`，并写入 `SYNC_UNMATCHED_LOG`。这是**数据缺口而非故障，不会导致非 0 退出码**（详情见 [每次运行输出什么](#每次运行输出什么)）
- 类别白名单只含 `manga` 不含 `book` 时，非漫画书籍**逐条**跳过（这类条目不视为未解析）
- 单条抛异常 → 记录后继续跑完整批，最终以非 0 退出码上报
- 缺少 `BANGUMI_ACCESS_TOKEN` 或 `NEODB_API_TOKEN` → 明确告警并标记该链路为 `aborted`（以非 0 退出码上报），不再静默跳过

### 链路 5：NeoDB → TMDB

> 官方文档：[TMDB API](https://developer.themoviedb.org/docs)

▸ **匹配方式**（三级，越靠前越精确）：

1. **TMDB 链接**——NeoDB 条目的 `external_resources` 里若有 `themoviedb.org/movie/550`，直接取 ID，零猜测
2. **IMDb ID**——有 `tt\d+` 时走 TMDB `/find`，零误匹配
3. **标题 + 年份**——用 `display_title` / `title` / `localized_title` 逐个搜索，**归一化后必须完全相等**，并用年份容差（默认 ±1）佐证

**为什么第三级这么保守**：标题搜索最容易错配（同名作品、译名差异、翻拍），所以只接受**精确匹配**。

▸ **字段映射**：

| NeoDB 字段                                       | 条件                            | TMDB 目标          | 说明                              |
| ------------------------------------------------ | ------------------------------- | ------------------ | --------------------------------- |
| `category`                                       | `movie` / `tv`                  | 条目类型           | 其余类别在发请求前丢弃            |
| `external_resources[].url`                       | 含 `themoviedb.org/{type}/{id}` | 直接定位条目       | 一级匹配依据                      |
| `external_resources[].url`                       | 含 `imdb.com/title/(tt\d+)`     | `/find` 查询       | 二级匹配依据                      |
| `display_title`/`title`/`localized_title[].text` | 前两级失败时                    | `/search` 查询     | 三级匹配依据                      |
| `year` / `pub_year`                              | —                               | 搜索年份佐证       | 容差由 `SYNC_YEAR_TOLERANCE` 控制 |
| `shelf_type` + `rating_grade`                    | 见下方状态映射                  | watchlist / rating | 由 `resolveTmdbOperations()` 决定 |

▸ **状态映射规则**（本章核心。权威定义在 **`src/tmdb-mapping.ts` 的 `resolveTmdbOperations()`**，改行为只改这里）：

| NeoDB 状态      | 条件               | TMDB 操作                           |
| --------------- | ------------------ | ----------------------------------- |
| `wishlist` 想看 | —                  | 加入 watchlist                      |
| `progress` 在看 | —                  | 加入 watchlist（TMDB 无「在看」态） |
| `complete` 看过 | `rating_grade > 0` | **写入评分** ＋ **移出 watchlist**  |
| `complete` 看过 | 无评分             | 加入 watchlist                      |
| `dropped` 弃看  | —                  | **跳过**，不做任何操作              |

**执行顺序固定为「先写评分 → 再调整 watchlist」**。因为 TMDB 的 `add-rating` 本身会隐式把条目移出 watchlist；先评分、后显式移除，最终状态就不依赖这个未写进官方文档的行为。

▸ **冲突处理**：

| 冲突场景                  | 处理方式                            |          可配置          |
| ------------------------- | ----------------------------------- | :----------------------: |
| 两边都有评分              | 默认保留 TMDB 的，可改为 NeoDB 覆盖 | ✅ `SYNC_RATING_PROFILE` |
| NeoDB 无评分、TMDB 有评分 | **绝不清除**（只"不写"，不 DELETE） |            —             |
| 目标状态已满足            | 比对后相同则不发请求                |            —             |
| 同一作品在多个书架        | 运行内按 `mediaType:id` 去重        |            —             |
| TMDB 找不到匹配           | 跳过并记入 `SYNC_UNMATCHED_LOG`     |            —             |
| 单条目失败                | 记录后继续，不影响整批              |            —             |

▸ **异常处理**：

- 匹配不到 → 跳过，计入 `unresolved`，并以 `source: "neodb→tmdb"` 写入 `SYNC_UNMATCHED_LOG`（见 [每次运行输出什么](#每次运行输出什么)）
- 类别为 book / music / game / podcast / performance → **在网络请求之前**就丢弃
- `dropped` → 跳过，不做任何 TMDB 操作
- 单条失败 → 记录后继续，最终以非 0 退出码上报

▸ **执行节奏**：**全量扫描 + 幂等增量写入**。每次运行都完整遍历 NeoDB 书架并逐条匹配（不先看一遍就无法知道哪些需要更新），但匹配后先读 TMDB 现状做差异比对，只写有差异的字段——已符合的条目一个请求都不发。

#### TMDB 能力边界

这套同步**注定是有损的**——TMDB 只有这些能力，超出部分无处安放：

| TMDB 支持                        | 说明                              |
| -------------------------------- | --------------------------------- |
| `watchlist`                      | 想看 ✅                           |
| `rating`                         | 评分 0.5–10，步进 0.5 ✅          |
| `favorite`                       | 收藏（本项目未使用）              |
| 用户自建 List                    | 可承载「看过/在看」，本项目未使用 |
| ~~watched / in progress~~        | **不存在**                        |
| ~~短评~~                         | 无写入接口，会被丢弃              |
| ~~进度~~                         | 无对应字段                        |
| 图书 / 音乐 / 游戏 / 播客 / 演出 | **TMDB 没有这些类型，整条跳过**   |

#### 已知限制

| 限制         | 说明                                                 |
| ------------ | ---------------------------------------------------- |
| 短评丢失     | TMDB 无短评写入接口                                  |
| 进度丢失     | 「看到第几集」在 TMDB 无对应字段                     |
| 非影视类丢失 | 图书/音乐/游戏/播客/演出整条跳过                     |
| 单向         | TMDB 侧改动不回流 NeoDB                              |
| 看过但未评分 | 退化为加入 watchlist，与「想看」无法区分             |
| 在看无区别   | TMDB 无「在看」态，`progress` 与 `wishlist` 表现一致 |

#### 接口依据

TMDB 侧实际调用的端点：

| 端点                                       | 用途                                |
| ------------------------------------------ | ----------------------------------- |
| `GET /3/{movie\|tv}/{id}/account_states`   | 读现状——幂等比对的基准              |
| `POST /3/{movie\|tv}/{id}/rating`          | 写评分                              |
| `POST /3/account/{id}/watchlist`           | 加入 / 移出 watchlist               |
| `GET /3/search/{movie\|tv}`                | 标题搜索（三级匹配的最后一级）      |
| `GET /3/find/{imdb_id}`                    | IMDb ID 精确查找（零误匹配）        |
| `GET /3/account`                           | 解析 account_id，兼作凭证有效性探测 |
| `POST /3/authentication/session/convert/4` | 尝试把 v4 token 换成 session id     |

> NeoDB 侧的响应结构见「[链路 2](#链路-2豆瓣-rss--neodb)」的接口依据。

### 双路冲突：豆瓣 → NeoDB 与 Bangumi → NeoDB

这是唯一存在"两条链路可能写同一个目标"的场景。处理分两层：

**第一层 · 匹配阶段：主动对齐到同一条目**

如链路 4 所述，Bangumi → NeoDB 会刻意寻找"带豆瓣链接的 twin"，让两条链路落到**同一个 uuid**。这是**从源头避免冲突**——不是事后补救。

**第二层 · 写入阶段：`mergeNeodbMark` 合并**

若两条链路确实指向同一条目，写入时按以下规则合并：

- **状态（shelf_type）：永远跟随来源**。后执行的那条会覆盖前一条的状态。
- **评分与短评**：按各自的 merge 配置决定
  - `neodb_prefer`（默认）：NeoDB 上**已有值非空则保留**，只填空缺
  - `overwrite`：总是用来源值覆盖

**执行顺序会造成实际差异**：`index.ts` 中豆瓣链路先跑、Bangumi → NeoDB 后跑。所以同一作品若两边状态不同，**最终以 Bangumi 为准**。

想改变这个结果，有三种做法：

1. 关闭 `SYNC_BANGUMI_NEODB`，只用豆瓣作为状态来源
2. 两条链路的 merge 都设 `overwrite`，状态以最后执行的为准（仍是 Bangumi）
3. 若只想让 Bangumi 补充而不覆盖，把 `SYNC_DOUBAN_NEODB_MERGE` 设为 `overwrite`、`SYNC_BANGUMI_NEODB_MERGE` 保持 `neodb_prefer`

**两种配置的直觉理解**：

- `neodb_prefer` = "NeoDB 上已有的，别动"（保护你手动改过的数据）
- `overwrite` = "以来源为准，覆盖过去"

⚠️ 注意：状态**不受** merge 配置影响——它永远以来源为准。merge 只保护评分和短评。

## 平台权限与同步范围

### 四个平台的读写边界

豆瓣是全只读的——它连写操作列都没有。仅有 RSS /feed/people/{id}/interests 和详情页 HTML 抓取（无官方 API）。

Bangumi 写入的 payload 只有 4 个字段：type / rate / comment / private。所以标记时间写不进去（上游 README 说"无法写入标记时间"，代码层面的原因就是这个 payload 结构）。

NeoDB 写得最全：shelf_type / rating_grade / comment_text / visibility / created_time，另有独立的 progress 端点 /api/me/shelf/item/{uuid}/progress。

TMDB 只能写两个端点：rating 和 watchlist。

本项目对每个平台**只做必要的读写**。下表按代码里实际调用的端点整理——超出这张表的操作不会发生。

**读**

| 平台    | 端点                                 | 用途                           |
| ------- | ------------------------------------ | ------------------------------ |
| 豆瓣    | RSS `/feed/people/{id}/interests`    | 拉取最近收藏                   |
| 豆瓣    | 详情页 HTML                          | 抓取年份 / 导演 / 演员等元数据 |
| Bangumi | `GET /v0/me`                         | 解析用户名                     |
| Bangumi | `GET /v0/users/{u}/collections`      | 收藏列表（分页）               |
| Bangumi | `GET /v0/users/{u}/collections/{id}` | 读单个收藏（幂等基准）         |
| Bangumi | `GET /v0/subjects/{id}`              | 条目详情（判定漫画平台）       |
| Bangumi | `POST /v0/search/subjects`           | 标题搜索（**搜索走 POST**）    |
| NeoDB   | `GET /api/catalog/fetch?url=`        | 用外链解析条目                 |
| NeoDB   | `GET /api/catalog/search`            | 目录搜索                       |
| NeoDB   | `GET /api/me/shelf/{type}`           | 书架列表（分页）               |
| NeoDB   | `GET /api/me/shelf/item/{uuid}`      | 读单个标记                     |
| NeoDB   | `GET /api/me`                        | 验证 token                     |
| TMDB    | `GET /3/account`                     | 解析 account_id                |
| TMDB    | `GET /3/{type}/{id}/account_states`  | 读现状（幂等基准）             |
| TMDB    | `GET /3/search/{type}`               | 标题搜索                       |
| TMDB    | `GET /3/find/{imdb_id}`              | IMDb 精确查找                  |
| TMDB    | `GET /3/{type}/{id}`                 | 按 ID 取详情                   |

**写**

| 平台    | 端点                                      | 可写字段                                                                   | **不能**写                          |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| 豆瓣    | —                                         | **无**（没有写入 API，全程只读）                                           | 一切                                |
| Bangumi | `POST /v0/users/-/collections/{id}`       | `type` 收藏状态、`rate` 评分、`comment` 短评、`private` 可见性             | 标记时间（payload 只含这 4 个字段） |
| NeoDB   | `POST /api/me/shelf/item/{uuid}`          | `shelf_type`、`rating_grade`、`comment_text`、`visibility`、`created_time` | —                                   |
| NeoDB   | `POST /api/me/shelf/item/{uuid}/progress` | `type` / `value`（集 / 章 / 曲）                                           | —                                   |
| TMDB    | `POST /3/{type}/{id}/rating`              | **仅评分**                                                                 | —                                   |
| TMDB    | `POST /3/account/{id}/watchlist`          | **仅 watchlist 增删**                                                      | —                                   |

**TMDB 的字段缺口**——这是整条链路「有损」的根源：

| 想同步的内容                      | TMDB 能否承载 | 实际结果                                   |
| --------------------------------- | ------------- | ------------------------------------------ |
| 状态（想看 / 在看 / 看过 / 弃看） | 部分          | 见 [链路 5](#链路-5neodb--tmdb) 的状态映射 |
| 评分                              | ✅            | 0.5–10，步进 0.5                           |
| 短评                              | ❌            | **丢弃**——无写入接口                       |
| 进度（看到第几集）                | ❌            | **丢弃**——无对应字段                       |
| 图书 / 音乐 / 游戏 / 播客 / 演出  | ❌            | **整条跳过**——TMDB 无这些类型              |
| 反向回写（TMDB 改动回流）         | ❌            | **单向**，不回写                           |

### 同步范围：并不遍历全部收藏

两条链路都**不遍历全部收藏**，但机制不同：

| 链路            | 默认行为                                                 | 全量模式                                             |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Bangumi → NeoDB | **只取第一页**（`BANGUMI_COLLECTION_LIMIT`，默认 50 条） | `BANGUMI_FULL_SYNC=1` 或 `npm run sync:bangumi-full` |
| NeoDB → TMDB    | 逐书架翻页，最多 `NEODB_MAX_PAGES`（默认 10）页 / 书架   | —（没有全量开关）                                    |

#### Bangumi → NeoDB：这 50 条是怎么筛出来的

请求打到 `GET /v0/users/{username}/collections`，**只带 `limit` 与 `offset`，不传 `type` 参数**（见 `src/bangumi.ts` 的 `listBangumiCollections`）。由此产生两个结论：

- **不按状态筛选**：`type` 留空即返回**全部收藏状态**——「想看」「在看」「看过」「搁置」「抛弃」都混在结果里，按 Bangumi API 的默认顺序排列（实践上约等于标记时间倒序），**不是**只取「在看 / 已看 / 想看」三种。它也不做「最新记录」的二次排序，代码没有排序逻辑。
- **不按类别筛选**：类别过滤发生在**取回之后**。`SYNC_BANGUMI_NEODB_CATEGORIES` 先转成 `subject_type` 查询参数（如只填 `anime` 就只请求 subject_type=2），未指定的剩余类型才在本地逐条判断。

> 一个例外：漫画检查。当白名单只含 `manga` 不含 `book` 时，需要额外调 `GET /v0/subjects/{id}` 判断 `platform` 是否为「漫画」，非漫画的书籍跳过——这是**逐条**请求，所以该模式下会显著变慢。

**开启全量后是否覆盖全部收藏**：是。`fullSync` 时的循环会以 `offset += page.data.length` 持续翻页，直到 `offset >= page.total` 或 API 返回空页（见 `src/paths/bangumi-to-neodb.ts` 的分页循环，第 156–210 行）。也就是把该 `subject_type` 下的**全部收藏条目**都走一遍。

但有两点需要注意：

1. **仍然受类别白名单约束**——全量指的是「翻完所有页」，不是「无视白名单」。未在白名单内的类别仍会被跳过。
2. **受状态映射约束**——即使被翻到，「抛弃」状态按映射规则仍会跳过（见 `BANGUMI_TO_NEODB_STATUS`）；无对应 NeoDB 条目的记录也会跳过。

#### NeoDB → TMDB：为什么没有全量开关

它**默认就在尽量翻页**（不像 Bangumi 那样只取第一页），所以「全量」在它这里不是开关，而是**上限**问题：

| 机制               | 作用                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `SYNC_SHELF_TYPES` | 决定跑哪几个书架。默认 `wishlist,progress,complete`，**`dropped` 默认排除** |
| `NEODB_MAX_PAGES`  | 每个书架最多翻几页（默认 10）。翻到上限会打警告说"还有剩余"                 |
| `SYNC_MAX_ITEMS`   | **跨书架、跨类别的总熔断**（默认 200），达到即停止整轮                      |

因此它的范围特征与 Bangumi → NeoDB 有三点本质差异：

1. **覆盖面更广但有硬顶**：默认翻 10 页 / 书架，远超 50 条；但每个书架的上限是硬性的，超出的旧记录不会被检查（会打 `NEODB_MAX_PAGES` 警告）。
2. **受总熔断约束**：`SYNC_MAX_ITEMS` 是全局计数，与 `NEODB_MAX_PAGES` 是**两道独立的闸**，谁先到谁生效。
3. **可以做到「事实全量」**：把 `NEODB_MAX_PAGES` 与 `SYNC_MAX_ITEMS` 同时调大（并确认 `SYNC_SHELF_TYPES` 包含 `dropped`），即可覆盖全部收藏——这与 Bangumi 侧的 `BANGUMI_FULL_SYNC=1` 效果等价，**只是通过调参实现，而非专门的开关**。

> 为什么不直接给个全量开关：`dropped` 在映射里本就被跳过（写了也是空操作），默认排除它是为了**省请求**；而 `wishlist/progress/complete` 三个书架本就该全覆盖，无需开关——真正的限制只在翻页上限，调整它即可。

**为什么默认只取最近一批**：日常使用中变化的总是最近几条，处理「最近的一批」就够，全量留给首次补齐历史。注意 Bangumi 的 `updated_at` 字段**不可靠**（代码注释明确说明），所以「最近」实际依赖 API 返回的默认顺序。

#### 节流与幂等：两条链路的实现并不相同

「三层节流」这个说法**只完整适用于 NeoDB → TMDB**。Bangumi → NeoDB 有三层结构中的第一、第三层，但**没有第二层**——两者的写入前比对机制完全不同：

| 节流层             | NeoDB → TMDB                                           | Bangumi → NeoDB                   |
| ------------------ | ------------------------------------------------------ | --------------------------------- |
| ① 内容指纹跳过     | ✅ `SYNC_INCREMENTAL`，未变化条目**在匹配前**就 return | ❌ 无（每轮都重新解析并比对）     |
| ② 写入前字段级比对 | ✅ 先读 `account_states`，逐字段 diff                  | ⚠️ **有比对，但机制不同**（见下） |
| ③ 熔断上限         | ✅ `SYNC_MAX_ITEMS`（跨书架跨类别总计）                | ❌ 无（由「只取第一页」天然限流） |

**为什么 Bangumi → NeoDB 不需要 `account_states`**：TMDB 的 `account_states` 是**独立的第三方接口**，读它才能知道目标端现状。而 NeoDB 侧读取标记用的是同一个客户端的 `getNeodbMark(uuid)`，返回结构与写入体同源，可直接做字段级比对——**不需要为「读现状」额外设计一套枚举接口**。两者目的相同（避免无差异写入），手段因目标平台的 API 形态而异。

具体比对逻辑见下一节。

#### 写入前到底比对了什么

两条链路都是**先读现状、再逐字段 diff、只写有差异的部分**。下面分别说明。

**NeoDB → TMDB：读 `account_states` 逐字段比对**

写入前先调 `GET /3/{type}/{id}/account_states`，然后 `planTmdbWrites()` 对两个字段分别判断：

| 字段          | 比对依据                                           | 判定规则                         |
| ------------- | -------------------------------------------------- | -------------------------------- |
| **watchlist** | `account_states.watchlist`（布尔）                 | 与计划目标相等 → 不写；不等 → 写 |
| **rating**    | `account_states.rated`（`{value}` **或 `false`**） | 与计划目标相等 → 不写；不等 → 写 |

两个关键细节：

1. **`rated` 是联合类型**——可能是 `{ value: 8 }`，也可能是 `false`（未评分）。`extractTmdbRating()` 统一归一：非对象或非数字一律返回 `null`。
2. **`tmdb_prefer` 下会"锁定"已有评分**——若 TMDB 已有评分且 profile 为 `tmdb_prefer`，则把 TMDB 的现有值当作目标值，与现状自然相等 → **恒不写入**。这就是日志里反复出现 `NeoDB prefer: keeping existing rating` 的成因。

比对结果汇总为 `shouldWrite`：**`false` 时调用方不得发出任何写入请求**（`planTmdbWrites` 的契约注释明确写了这一点）。写入时**按字段分别发请求**——`setRating` 与 `setWatchlist` 各自独立判断，**不存在的字段根本不会出现在 payload 里**，所以不存在"全量覆盖"。

> `plan === null` 的字段（如日志中的 `rating untouched`）表示**映射上就不该动这个字段**，此时既不 POST 也不 DELETE——**绝不删除**用户手动在 TMDB 设的评分。这是刻意的保护。

**Bangumi → NeoDB：读 `getNeodbMark` 逐字段比对**

写入前先调 `getNeodbMark(uuid)` 拿到 NeoDB 现有标记，交由 `mergeNeodbMark()` 比对**四个字段**：

| 字段             | 比对依据                             | 判定规则                                     |
| ---------------- | ------------------------------------ | -------------------------------------------- |
| **shelf_type**   | 现有 `shelf_type`                    | 与来源不等 → 写（**状态永远以来源为准**）    |
| **rating_grade** | 现有 `rating_grade`（`0` = 未评分）  | `neodb_prefer` 下现有非 0 则保留；否则用来源 |
| **comment_text** | 现有 `comment_text`（空串 = 无短评） | `neodb_prefer` 下现有非空则保留；否则用来源  |
| **visibility**   | 现有 `visibility`                    | 与配置的 `NEODB_VISIBILITY` 不等 → 写        |

四个字段**全部相等时 `shouldWrite = false`**，日志打印 `NeoDB mark unchanged, skip`——这正是全量日志中该行批量出现的原因。

**与 TMDB 侧的两个差异**：

1. **没有"独立读现状接口"这一步**——`getNeodbMark` 与写入体同源，省去了一次专门的探测调用。
2. **`neodb_prefer` 是"填空"而非"锁定"**——TMDB 侧是"已有值就整体保留"；NeoDB 侧是"已有非空值才保留"，来源值仍可能填补空缺字段。

**更新时为何不传 `created_time`**：新建标记时会带上 `createdTime`（`collection.updated_at`），但**更新时故意不传**（代码注释：`Do not pass createdTime on update — preserves NeoDB mark date`），以免旧标记的日期被"最近一次同步"刷新。

**NeoDB → TMDB 的三层节流汇总**：

1. **指纹跳过**（`SYNC_INCREMENTAL`，默认开）——用「书架状态 + 评分 + 短评」算内容指纹，**未变化的条目在匹配之前就 return**，零 TMDB 请求
2. **幂等写入**——变化过的条目也要先读 `account_states` 比对，只写有差异的字段
3. **熔断**（`SYNC_MAX_ITEMS`，默认 200）——单次运行的处理上限

所以稳态运行的主要开销是**书架分页读取**（不遍历就无法知道哪些变了），而不是写入。想进一步压低请求量可调小 `NEODB_MAX_PAGES`，代价是较早的条目不再被检查。

> ⚠️ **注意 `SYNC_INCREMENTAL` 在 CI 中的行为**：它默认 `0`（见 [GitHub Actions 配置](#github-actions-配置)）。此时第 ① 层失效，`skippedCached` 恒为 0——但第 ② 层仍然生效，**重复运行依旧不会产生重复写入**，只是每个条目都要多花一次 `account_states` 读取。日志中 `skippedCached: 0` 与 `incremental=false` 同时出现，正是这个原因。

#### 每次运行输出什么

两条链路都会在结束时**先汇总计数、再列出需要人工过目的条目**，最后合成一个总表。同样的内容还会以 Markdown 写入 CI 的作业摘要，供事后回看。

▸ **单条链路**（Bangumi → NeoDB 与 NeoDB → TMDB 各自输出）：

```
[info] Bangumi → NeoDB: scanned 50, written 38, unchanged 6, skipped 0, unresolved 6, failed 0
[info] Bangumi → NeoDB self-check: 38+6+0+6+0 = 50 ✔
[warn] 6 unresolved item(s) — no counterpart at the destination:
[warn]   · 学园奶爸
[warn]   · 剧场版宝可梦: 时拉比 穿梭时空的相遇
[warn]   …（最多列 20 条，超出显示 "… and N more"）
[warn] 6 unmatched item(s) written to .cache/unmatched.json.
```

▸ **运行结束时的总表**（`index.ts` 在所有链路跑完后输出）：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Sync finished — 2 path(s) ran, none failed                                                           │
│                                                                                                      │
│ Bangumi → NeoDB   scanned   50   written   38   unresolved    6   failed    0   ok, 6 unresolved     │
│ NeoDB → TMDB      scanned  200   written    1   unresolved    6   failed    0   capped, 6 unresolved │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

▸ **两个计数的区别**——决定退出码时它们**被区别对待**：

| 计数         | 含义                                | 对退出码的影响 |
| ------------ | ----------------------------------- | -------------- |
| `unresolved` | 目标平台没有对应条目（冷门 OVA 等） | ❌ **不**影响  |
| `failed`     | 条目处理时抛异常                    | ✅ 置为 1      |
| `aborted`    | 链路根本没跑起来（凭证/网络问题）   | ✅ 置为 1      |

`unresolved` 被刻意排除在退出码之外：它是**数据缺口**，不是缺陷。若计入，CI 会因为几条冷门条目在**每次运行**都变红，最终让人对红灯麻木。

▸ **`self-check` 行**是刻意加的一致性校验：`written + unchanged + skipped + unresolved + failed` 应当等于 `scanned`。

- 输出 `✔` → 计数闭合，没有漏算
- 输出 `✘ expected N` → 要么统计逻辑有漏算，要么**日志被截断**了（终端回滚缓冲上限会导致只保存后半段）

▸ **CI 中的额外呈现**（`GITHUB_ACTIONS=true` 时自动启用，本地不输出）：

| 命令                         | 作用                                        |
| ---------------------------- | ------------------------------------------- |
| `::group::` / `::endgroup::` | 把未匹配清单折叠起来，日志默认只占一行      |
| `::notice::`                 | 未匹配条数汇总到运行页顶部的 Annotations 区 |
| `::warning::`                | 有链路失败时同样上报到 Annotations          |

▸ **CI 中的作业摘要**（写入 `$GITHUB_STEP_SUMMARY`；本地该变量不存在，自动跳过）：

运行页顶部会出现一块 **Markdown 面板**，含总表与完整的未匹配清单：

| Path            | Scanned | Written | Unchanged | Skipped | Unresolved | Failed | State                |
| --------------- | ------: | ------: | --------: | ------: | ---------: | -----: | -------------------- |
| Bangumi → NeoDB |      50 |      38 |         6 |       0 |          6 |      0 | ok, 6 unresolved     |
| NeoDB → TMDB    |     200 |       1 |       193 |       0 |          6 |      0 | capped, 6 unresolved |

> **为什么用作业摘要而不是 `actions/upload-artifact`**：GitHub 计费文档明确**日志与作业摘要不计入存储配额**（而 GitHub Free 的工件存储仅 500 MB，且与 GitHub Packages 共享同一配额池）；面板无需下载即可阅读；并且**不需要改动 `sync.yml`**——该变量由 GitHub 注入到运行 `npm run sync` 的那个步骤环境里。唯一代价是不可下载、不可脚本消费；将来真需要脚本消费再补 artifact。

▸ **未匹配条目的留档格式**——两条链路写入**同一个文件**（`SYNC_UNMATCHED_LOG`），用 `source` 区分来源：

```json
[
  {
    "source": "bangumi→neodb",
    "reason": "neodb-unresolved",
    "title": "宝贝老板",
    "externalId": "208044",
    "externalUrl": "https://bgm.tv/subject/208044",
    "subjectType": 2,
    "collectionType": 2,
    "firstSeenAt": "2026-10-01T00:00:00.000Z",
    "lastSeenAt": "2026-10-13T00:00:00.000Z"
  },
  {
    "source": "neodb→tmdb",
    "reason": "no-tmdb-match",
    "uuid": "…",
    "shelfType": "complete",
    "category": "movie",
    "title": "…",
    "titles": ["…"],
    "externalResources": [{ "url": "…" }],
    "firstSeenAt": "2026-10-13T00:00:00.000Z",
    "lastSeenAt": "2026-10-13T00:00:00.000Z"
  }
]
```

> **写入是 upsert，不是盲目追加**。键为 `source::(externalId ?? uuid)`：同一部作品反复失败只保留**一条**记录，刷新 `lastSeenAt`、保留 `firstSeenAt`。这样既能一眼看出「这是新问题（两个时间相同）还是长期存在（`firstSeenAt` 很早）」，文件大小也稳定在**唯一未解析集合**的规模而不会无限增长。
>
> 之所以不是纯追加：同几条冷门条目每轮都会失败，追加只会让文件变大而不增加信息；而且早先的条目**完全没有时间戳**，两条一模一样的记录无法判断哪条更新——那种「历史」是不可用的。
>
> 该文件在 CI 中每轮都是全新的（runner 临时），所以去重只对**本地连续运行**有意义。`.cache` 已被 `.gitignore` 排除，**不会**进仓库。

## 配置项说明

所有配置通过环境变量传入，**代码中不写死任何凭证**。完整模板见 `.env.example`。

本节讲**每个变量的含义与怎么拿到**；按用途分组的**全量速查表**见 [配置项总表](#配置项总表)。

### 路径开关

五条链路**各自独立开关**、互不依赖。完整的「链路 / 开关 / 默认值 / 用途」对照见 [核心功能 · 五条链路](#五条链路)。

取值：`1` / `true` / `yes` / `on` 为开启；`0` / `false` / `off` / 留空为关闭。

> 关闭全部 `Douban→*` 时会跳过拉取豆瓣 RSS（省一次网络请求），此时 `DOUBAN_USER_ID` 可以不填。只想跑其中一条时，把其余四条设为 `0` 即可。

### 凭证

全部凭证都是密钥：GitHub Actions 里放 **Secret**，本地放 `.env`——**不要**放进 Variables，更不要提交进仓库。

| 变量                                                                                                                                                     | 说明                                                                           | 获取方式                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `NEODB_API_TOKEN`                                                                                                                                        | **所有链路**的基础，NeoDB 读写都靠它                                           | 登录你的 NeoDB 实例 → `/developer/` 页面 → Authorize                         |
| `DOUBAN_USER_ID`                                                                                                                                         | 仅 `Douban→*` 链路需要；这几条链路全关时可不填                                 | 豆瓣个人主页 URL 里的数字：`douban.com/people/1234567/` → `1234567`          |
| `BANGUMI_ACCESS_TOKEN`                                                                                                                                   | 仅 Bangumi 相关链路需要。**会过期且无 refresh**，到期需重新生成                | bangumi.tv → 个人设置 → 开放接口                                             |
| `TMDB_API_KEY`                                                                                                                                           | 仅 `SYNC_NEODB_TMDB` 需要                                                      | themoviedb.org → Settings → API → 复制 "API Key (v3 auth)"                   |
| `TMDB_ACCESS_TOKEN`                                                                                                                                      | 同上。写权限与下者**二选一**                                                   | 同页面的 "API Read Access Token"。**user-scoped 的可直接写**（本项目已实测） |
| `TMDB_SESSION_ID`                                                                                                                                        | 同上。写权限与上者**二选一**                                                   | v3 session id，需走三步授权流程换取                                          |
| `NOTION_TOKEN`                                                                                                                                           | 仅 `SYNC_DOUBAN_NOTION` 需要                                                   | Notion Integration Token                                                     |
| `NOTION_MOVIE_DATABASE_ID`<br />`NOTION_MUSIC_DATABASE_ID`<br />`NOTION_BOOK_DATABASE_ID`<br />`NOTION_GAME_DATABASE_ID`<br />`NOTION_DRAMA_DATABASE_ID` | 五个分类库的 ID，分别对应 电影 / 音乐 / 图书 / 游戏 / 话剧。不导某个分类就留空 | Notion 打开该库 → URL 中 `?v=` 前的 32 位字符串                              |

> Notion 数据库的**列名与类型必须与项目根目录的 `cols.json` 一致**，否则写入会失败。  
> Bangumi token 到期时日志会出现 401 /「token 可能已过期」，重新生成并更新即可。

### 行为开关的含义

以下几类变量**只改行为、不碰凭证**。各自的完整清单与默认值见 [配置项总表](#配置项总表) 的对应分组：

| 分组               | 解决的问题                         | 关键约定                                                                                                                                           |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **类别白名单**     | 限制某条链路同步哪些类别           | 留空 = 全部；**填了值但无可识别类别时该链路拒绝同步任何条目**（fail-closed）。`SYNC_CATEGORIES` 例外——TMDB 只存在 movie / tv，它默认即限定为这两类 |
| **合并策略**       | 目标已存在标记时，评分与短评谁优先 | 只影响**评分与短评**；状态永远以来源为准                                                                                                           |
| **服务地址与限流** | 自建实例、镜像代理、请求节奏       | `NEODB_BASE_URL` 是自建实例必改项；两个 `*_REQUEST_DELAY_MS` 控制请求间隔                                                                          |
| **同步引擎行为**   | NeoDB → TMDB 链路的取舍与节奏      | 处理哪些书架、跑到什么程度、冲突怎么判。对应逻辑见 [链路 5](#链路-5neodb--tmdb)                                                                    |

> ⚠️ 「同步引擎行为」中的 `SYNC_INCREMENTAL`，本地默认 `1`，CI 中为 `0`。原因见 [GitHub Actions 配置](#github-actions-配置)。

---

## 配置项总表

把所有可配置变量收敛到一张按用途分组的表中，便于**一次性核对**，也便于直接对照 GitHub Actions 的 Variables 逐项配置。

> **读法**：`默认` 列即代码中不设该变量时的行为。标注「CI」的差异项见 [GitHub Actions 配置](#github-actions-配置)。

### 路径开关

取值 `1` / `true` / `yes` / `on` 为开启；`0` / `false` / `off` / 留空为关闭。

| 变量                  | 默认 | 用途            |
| --------------------- | ---- | --------------- |
| `SYNC_DOUBAN_NOTION`  | `0`  | 豆瓣 → Notion   |
| `SYNC_DOUBAN_NEODB`   | `1`  | 豆瓣 → NeoDB    |
| `SYNC_DOUBAN_BANGUMI` | `1`  | 豆瓣 → Bangumi  |
| `SYNC_BANGUMI_NEODB`  | `1`  | Bangumi → NeoDB |
| `SYNC_NEODB_TMDB`     | `0`  | NeoDB → TMDB    |

### 凭证

全部为密钥，GitHub Actions 中放 **Secret**。说明与获取方式见 [配置项说明 · 凭证](#凭证)。

| 变量                                             | 适用链路             | 可否留空              |
| ------------------------------------------------ | -------------------- | --------------------- |
| `NEODB_API_TOKEN`                                | **所有链路**         | 否                    |
| `DOUBAN_USER_ID`                                 | `Douban→*`           | `Douban→*` 全关时可空 |
| `BANGUMI_ACCESS_TOKEN`                           | Bangumi 相关链路     | 不开则可空            |
| `TMDB_API_KEY`                                   | `SYNC_NEODB_TMDB`    | 不开则可空            |
| `TMDB_ACCESS_TOKEN` / `TMDB_SESSION_ID`          | `SYNC_NEODB_TMDB`    | 二者**二选一**        |
| `NOTION_TOKEN`                                   | `SYNC_DOUBAN_NOTION` | 不开则可空            |
| `NOTION_MOVIE/MUSIC/BOOK/GAME/DRAMA_DATABASE_ID` | `SYNC_DOUBAN_NOTION` | 不导该分类则可空      |

### 类别白名单

留空 = 该链路同步全部类别。**填了值但无可识别类别时该链路拒绝同步任何条目**（fail-closed）。多值用逗号分隔。

| 变量                             | 默认       | 可选值                                       | 适用链路        |
| -------------------------------- | ---------- | -------------------------------------------- | --------------- |
| `SYNC_DOUBAN_NOTION_CATEGORIES`  | 空         | `movie` `music` `book` `game` `drama`        | 豆瓣 → Notion   |
| `SYNC_DOUBAN_NEODB_CATEGORIES`   | 空         | 同上                                         | 豆瓣 → NeoDB    |
| `SYNC_DOUBAN_BANGUMI_CATEGORIES` | 空         | 同上                                         | 豆瓣 → Bangumi  |
| `SYNC_BANGUMI_NEODB_CATEGORIES`  | 空         | `anime` `manga` `book` `music` `game` `real` | Bangumi → NeoDB |
| `SYNC_CATEGORIES`                | `movie,tv` | `movie` `tv`                                 | NeoDB → TMDB    |

> `SYNC_CATEGORIES` 的语义与上面四个略有不同：TMDB 只存在 movie / tv 两类，所以它**不是「留空=全部」**，而是默认就限定为这两类。

### 服务地址与限流

| 变量                     | 默认                           | 说明                                         |
| ------------------------ | ------------------------------ | -------------------------------------------- |
| `NEODB_BASE_URL`         | `https://neodb.social`         | 自建实例改这里                               |
| `NEODB_REQUEST_DELAY_MS` | `300`                          | NeoDB 请求间隔（毫秒）                       |
| `NEODB_MAX_PAGES`        | `10`                           | 每个书架最多翻几页                           |
| `NEODB_VISIBILITY`       | `2`                            | 写入标记可见性：0 公开 / 1 仅关注者 / 2 私密 |
| `TMDB_LANGUAGE`          | `zh-CN`                        | 搜索与详情语言                               |
| `TMDB_REQUEST_DELAY_MS`  | `300`                          | TMDB 请求间隔（毫秒）                        |
| `TMDB_BASE_URL`          | `https://api.themoviedb.org/3` | 走镜像或代理时使用                           |
| `TMDB_INCLUDE_ADULT`     | `false`                        | 搜索是否包含成人内容                         |
| `TMDB_ACCOUNT_ID`        | 自动获取                       | 填了可省一次请求                             |

### 合并策略

| 变量                       | 默认           | 说明                                                          |
| -------------------------- | -------------- | ------------------------------------------------------------- |
| `SYNC_DOUBAN_NEODB_MERGE`  | `neodb_prefer` | `neodb_prefer` 保留 NeoDB 已有非空值 / `overwrite` 用来源覆盖 |
| `SYNC_BANGUMI_NEODB_MERGE` | `neodb_prefer` | 同上                                                          |

### Bangumi 与豆瓣 RSS

| 变量                          | 默认    | 说明                                  |
| ----------------------------- | ------- | ------------------------------------- |
| `BANGUMI_PRIVATE`             | `false` | 收藏是否私密                          |
| `BANGUMI_COLLECTION_LIMIT`    | `50`    | 拉取收藏时每页数量                    |
| `BANGUMI_USER_AGENT`          | 空      | 自定义 UA（被拦截时使用）             |
| `BANGUMI_FULL_SYNC`           | `0`     | 设 `1` 时追加执行全量 Bangumi → NeoDB |
| `SYNC_BANGUMI_NEODB_PROGRESS` | `0`     | 是否同步观看进度（集 / 章 / 曲）      |
| `DOUBAN_RSS_USER_AGENT`       | 空      | 豆瓣 RSS 被拦截时替换 UA              |

### 留档

| 变量                 | 默认                    | 说明                                                                                                                                |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_UNMATCHED_LOG` | `.cache/unmatched.json` | **两条链路共用**的未匹配条目留档位置。按 `source::id` upsert，记录 `firstSeenAt`/`lastSeenAt`。留空则关闭留档（仍会打印计数与清单） |

### 同步引擎（NeoDB → TMDB）

| 变量                  | 默认                         | CI 差异 | 说明                                                          |
| --------------------- | ---------------------------- | ------- | ------------------------------------------------------------- |
| `SYNC_SHELF_TYPES`    | `wishlist,progress,complete` | —       | 处理哪些书架。`dropped` 默认排除                              |
| `SYNC_CATEGORIES`     | `movie,tv`                   | —       | 类别白名单（同「类别白名单」一节）                            |
| `SYNC_DRY_RUN`        | `0`                          | —       | `1` = 只计算并打印计划，不写数据                              |
| `SYNC_MAX_ITEMS`      | `200`                        | —       | 单次运行处理上限（熔断保护）                                  |
| `SYNC_RATING_PROFILE` | `tmdb_prefer`                | —       | 评分冲突：`tmdb_prefer` 保留 TMDB / `overwrite` 用 NeoDB 覆盖 |
| `SYNC_YEAR_TOLERANCE` | `1`                          | —       | 标题匹配时允许的年份差                                        |
| `SYNC_INCREMENTAL`    | `1`                          | **`0`** | 跳过内容指纹未变的条目                                        |
| `SYNC_STATE_FILE`     | `.cache/sync-state.json`     | —       | 增量状态文件位置                                              |

---

## GitHub Actions 配置

配置位置：仓库 → **Settings → Secrets and variables → Actions**。

### Secrets（共 12 个）

即 [配置项说明 · 凭证](#凭证) 列出的全部凭证变量。它们是密钥，**必须放 Secrets**（加密存储、日志自动打码），不要放 Variables。

```
NEODB_API_TOKEN          DOUBAN_USER_ID           BANGUMI_ACCESS_TOKEN
TMDB_API_KEY             TMDB_ACCESS_TOKEN        TMDB_SESSION_ID
NOTION_TOKEN             NOTION_MOVIE_DATABASE_ID NOTION_MUSIC_DATABASE_ID
NOTION_BOOK_DATABASE_ID  NOTION_GAME_DATABASE_ID  NOTION_DRAMA_DATABASE_ID
```

### Variables（共 35 个，明文，只放非敏感开关）

本节不再重复逐项列举——每个变量的名称、默认值与说明已在 **[配置项总表](#配置项总表)** 中完整给出（该表默认值即工作流中 `|| '…'` 的兜底值）。此处只说明**在 CI 中与本地不同的两点**：

> ⚠️ **两点必须注意**
>
> 1. **变量只有在工作流里被引用才会生效**。GitHub 上设了 Variable，如果 `.github/workflows/sync.yml` 没有声明它，程序读到的仍是空值——这是最容易踩的坑，会导致「设置了却没反应」。
> 2. **`SYNC_INCREMENTAL` 在 CI 中默认 `0`**。Actions runner 是临时环境，`.cache/sync-state.json` 不跨次保留，增量指纹在 CI 里没有意义。退回依赖 TMDB 侧幂等（读后比对），行为安全，只是多几次读请求。

---

## 与上游同步

本仓库**独立初始化**，与 `viazure/douban-backup` **没有共同 git 历史**——所以 `git merge` / `rebase` / `pull upstream` 都不可用：缺少共同基线，几乎所有共享文件都会被判为冲突。把上游当作**只读参考源**，按需手动搬运即可。

> 本仓库**只配置了 `origin`**，并没有 `upstream` 远端。因此下面三条命令在首次使用前需要先补上远端（`upstream` 的 fetch 地址设为不可写是刻意的，防止误推）：

```bash
# 一次性：登记只读上游（尚未配置，故 fetch/diff/checkout 在此之前都会失败）
git remote add upstream https://github.com/viazure/douban-backup.git
git remote set-url --push upstream DISABLED_READ_ONLY

git fetch upstream                              # 只读，安全
git diff --stat origin/main..upstream/main      # 看上游都改了什么
git checkout upstream/main -- <file>            # 未改动过的文件直接取
npm run typecheck && npm run verify:mapping     # 必须验证
```

> ⚠️ 由于本项目已做过**文件名与目录重构**（`handle-*.ts` → `clients/` `rules/` `paths/`），上表的旧路径已经对不上：从上游搬运时**不要**直接 `git checkout` 到旧路径，否则会在 `src/` 根目录重新长出一批已被取代的文件。按功能对应到新文件后再合并。

### 文件分类（决定搬运方式）

| 类别       | 文件（当前路径）                                                                                                                                                                                                                                                | 处理         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 与上游一致 | `clients/bangumi.ts` `clients/douban-rss.ts` `paths/douban-to-neodb.ts` `paths/douban-to-notion.ts` `paths/douban-to-bangumi.ts` `rules/neodb-mark-merge.ts`                                                                                                    | 可直接覆盖   |
| 已追加修改 | `types.ts` `utils.ts` `sync-config.ts` `index.ts` `clients/neodb-http.ts` `clients/neodb-catalog.ts` `clients/neodb-shelf.ts` `paths/bangumi-to-neodb.ts` `bangumi-to-neodb-full-cli.ts` `rules/douban.ts` `rules/bangumi-neodb.ts`                             | 手工合并     |
| 本项目独有 | `rules/tmdb-mapping.ts` `rules/tmdb-matching.ts` `rules/tmdb-write-plan.ts` `paths/neodb-to-tmdb.ts` `clients/tmdb.ts` `clients/notion.ts` `clients/douban-subject-page.ts` `clients/douban-subject-parsers.ts` `neodb-to-tmdb-cli.ts` `sync-report.ts` `docs/` | 不受同步影响 |

> 比较文件时**务必用 `diff --ignore-all-space`**：本项目经 prettier 格式化，上游未格式化，直接 diff 会把折行差异误报成大面积冲突。
>
> `paths/bangumi-to-neodb.ts` 起初只与上游有格式化差异，加入未解析条目留档后已属「已追加修改」；`bangumi-to-neodb-full-cli.ts` 同理（改为消费汇总报告）。上游的 `const.ts` 在本项目中已**拆解**为 `rules/douban.ts`、`rules/bangumi-neodb.ts` 与 `clients/notion.ts` 三处，搬运时需要按域对应。

---

## 目录结构

```
Douban-Shelf-Archivist/
├── src/                      核心源码（27 个文件）
│   ├── index.ts              总入口：按开关调度所有链路
│   │
│   ├── sync-config.ts        配置中枢：集中解析全部环境变量
│   ├── types.ts              全部类型定义（含 NeoDB/TMDB）+ cols.json 的唯一入口
│   ├── utils.ts              通用工具 + 增量同步状态管理 + 留档日志
│   ├── sync-report.ts        结果展示层：收尾汇总、自检、Actions 注解
│   ├── bangumi-to-neodb-full-cli.ts  Bangumi 全量入口（原 sync-bangumi-full.ts）
│   ├── neodb-to-tmdb-cli.ts  NeoDB → TMDB 独立入口（原 sync-tmdb-only.ts）
│   │
│   ├── clients/              外部平台：传输 + 各平台自己的线格式
│   │   ├── douban-rss.ts                 解析豆瓣 RSS（原 handle-rss.ts）
│   │   ├── douban-subject-page.ts        抓取豆瓣条目页 + 反爬（原 handle-douban.ts 上半）
│   │   ├── douban-subject-parsers.ts     条目页 → Notion 列值（原 handle-douban.ts 下半）
│   │   ├── neodb-http.ts                 NeoDB 传输层：凭据、请求头、错误助手、节流
│   │   ├── neodb-catalog.ts              目录查询 + 孪生条目解析
│   │   ├── neodb-shelf.ts                条目标记 / 进度 / 书架列表
│   │   ├── bangumi.ts                    Bangumi 客户端
│   │   ├── tmdb.ts                       TMDB 客户端
│   │   └── notion.ts                     Notion 客户端 + 列类型表 + 属性载荷构造
│   │
│   ├── rules/                纯逻辑：零 I/O、零环境读取
│   │   ├── douban.ts                     豆瓣词汇 + 星级换算（原 const.ts 一部分）
│   │   ├── bangumi-neodb.ts              Bangumi ↔ NeoDB 映射与守卫（原 const.ts 一部分）
│   │   ├── neodb-mark-merge.ts           标记合并（原 neodb-merge.ts）
│   │   ├── tmdb-mapping.ts               状态映射定义 ★ 改行为改这里
│   │   ├── tmdb-matching.ts              标题匹配（决定写到哪个真实实体）
│   │   └── tmdb-write-plan.ts            写入计划计算（原 tmdb-merge.ts）
│   │
│   └── paths/                5 条链路编排
│       ├── douban-to-notion.ts           原 handle-notion.ts
│       ├── douban-to-neodb.ts            原 handle-neodb.ts
│       ├── douban-to-bangumi.ts          原 handle-bangumi.ts
│       ├── bangumi-to-neodb.ts           原 handle-bangumi-neodb.ts
│       └── neodb-to-tmdb.ts              原 handle-neodb-tmdb.ts
│
├── scripts/                  辅助脚本
│   ├── probe-neodb-shelf.ts    探测 NeoDB 书架响应结构
│   ├── verify-tmdb-mapping.ts  映射逻辑离线断言（57 项）
│   └── download-douban-note-images.ts  下载豆瓣日记配图（原 db-notes-img-dl.ts）
├── archive/                  已废弃：旧 puppeteer 爬虫 + update-notion.ts
├── userscript/               浏览器用户脚本（手动导出用）
├── archive/                  旧的爬虫脚本，供参考
├── docs/                     README 配图
├── cols.json                 Notion 数据库列定义
├── .github/workflows/        定时同步工作流
├── .env.example              配置模板
└── README.md
```

---

## 各文件用途

### 入口

| 文件                               | 用途                  | 特性                                                             |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `src/index.ts`                     | 总入口                | 按开关依次调度；豆瓣链路的失败会被捕获并继续，其余失败设退出码 1 |
| `src/neodb-to-tmdb-cli.ts`         | NeoDB → TMDB 独立入口 | 只跑这一条链路，不影响原有 cron                                  |
| `src/bangumi-to-neodb-full-cli.ts` | Bangumi 全量入口      | 追加执行，用于首次补齐历史数据（`fullSync = true`）              |

> 失败一律通过 `process.exitCode` 上报，**没有任何链路会调用 `process.exit()`**——那会连同后续
> 链路与收尾汇总一起丢掉。豆瓣→Notion 以「失败条数」返回值上报，由 `index.ts` 折算为退出码。

### 配置与基础

| 文件                 | 用途     | 特性                                                                                               |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `src/sync-config.ts` | 配置中枢 | 集中解析全部环境变量，并把它打印成一行便于审计；含 `syncConfig` 与 `neodbTmdbConfig` 两组          |
| `src/sync-report.ts` | 结果展示 | 收尾汇总、一致性自检、未匹配条目分组列出；Actions 注解仅在 CI 输出                                 |
| `src/types.ts`       | 类型定义 | `NeodbItem` 为两条链路的**合并超集**；`PathReport` 为各链路的结果契约；也是 `cols.json` 的唯一入口 |
| `src/utils.ts`       | 通用工具 | 含增量同步的指纹计算、状态文件读写、未匹配条目留档（upsert + 首末时间戳）                          |

> ⚠️ 关于「唯一的 env 读取点」：**目前并非事实**。`sync-config.ts` 之外仍有 8 个文件直接读
> `process.env`（`utils.ts`、`bangumi.ts`、`clients/neodb-http.ts`、`clients/douban-rss.ts`、
> `sync-report.ts`、`paths/douban-to-notion.ts`、`index.ts`、`clients/neodb-catalog.ts` 等）。
> `sync-config.ts` 是**集中解析开关与配置的中心**，但「所有 env 只此一处」仍是待办目标。

### 客户端（`src/clients/`）

| 文件                                    | 用途           | 特性                                                                   |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `src/clients/neodb-http.ts`             | NeoDB 传输层   | 凭据、鉴权头、错误助手、节流；**两套 base URL 策略在此并列，差异可见** |
| `src/clients/neodb-catalog.ts`          | NeoDB 目录查询 | 按外链/标题解析目录条目，含「豆瓣孪生条目」对齐                        |
| `src/clients/neodb-shelf.ts`            | NeoDB 书架     | 标记读写、进度读写、书架分页；请求带重试与限流                         |
| `src/clients/douban-rss.ts`             | 豆瓣 RSS       | 浏览器 UA + 对 401/403 设上限的重试策略                                |
| `src/clients/douban-subject-page.ts`    | 豆瓣条目页抓取 | sha512 PoW 自解 + 模块级 CookieJar                                     |
| `src/clients/douban-subject-parsers.ts` | 条目页 → 列值  | **纯函数**：5 个 `buildXxxItem`，可直接用 HTML fixture 断言            |
| `src/clients/tmdb.ts`                   | TMDB 客户端    | 会话解析（v4→v3）、账号状态读取、评分/watchlist 写入                   |
| `src/clients/bangumi.ts`                | Bangumi 客户端 | 收藏读写（沿用上游实现）                                               |
| `src/clients/notion.ts`                 | Notion 客户端  | SDK 客户端 + 列类型表 + emoji + 属性载荷构造，Notion 知识只此一处      |

### 编排（`src/paths/`）与纯逻辑（`src/rules/`）

| 文件                            | 用途             | 特性                                                               |
| ------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `src/rules/tmdb-mapping.ts`     | **状态映射定义** | 纯函数，无 I/O；`complete` 的评分分支在此                          |
| `src/rules/tmdb-write-plan.ts`  | 写入计划计算     | 纯函数，把「想要的状态」与「TMDB 现状」做差分，**幂等的核心**      |
| `src/rules/tmdb-matching.ts`    | 标题匹配         | 纯函数，决定评分写到**哪个真实实体**；`normalizeTitleKey` 与之共用 |
| `src/rules/neodb-mark-merge.ts` | 标记合并         | 纯函数，处理评分/评论冲突                                          |
| `src/rules/douban.ts`           | 豆瓣词汇与换算   | 纯函数/字面量表；星级换算全仓只此一处                              |
| `src/rules/bangumi-neodb.ts`    | Bangumi ↔ NeoDB  | 纯函数/字面量表；含两张「不覆盖对方表达不了的状态」的守卫表        |
| `src/paths/*.ts`                | 5 条链路编排     | 负责调度与错误隔离，**不含业务规则**                               |

> `src/rules/` 的「零 I/O、零环境读取」不是口号，而是一条可执行的门禁：
> `grep -rnE "got|jsdom|@notionhq|process\.env|node:fs" src/rules/` 必须为空。因此这 6 个模块
> 都能离线跑断言验证。

### 辅助

| 文件                                        | 用途                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/probe-neodb-shelf.ts`              | 打印 NeoDB 真实响应结构，存原始 JSON 到 `.cache/`                                                                               |
| `scripts/verify-tmdb-mapping.ts`            | 57 项离线断言：NeoDB→TMDB 映射与写入幂等                                                                                        |
| `scripts/verify-rules.ts`                   | 100 项离线断言：豆瓣词汇、星级换算、Bangumi↔NeoDB 状态与进度映射、标记合并、标题匹配、Notion 载荷                               |
| `scripts/verify-douban-parsers.ts`          | 75 项离线断言：`extractItemInfo` + 5 个 `buildXxxItem`（对着 `tests/fixtures/*.html` 跑）                                       |
| `scripts/download-douban-note-images.ts`    | 下载豆瓣日记配图（**仍不可运行**：`image-downloader` 未安装；类型已在 `scripts/image-downloader.d.ts` 声明，故 `tsc` 会检查它） |
| `userscript/*.user.js`                      | 浏览器用户脚本，手动导出豆瓣数据                                                                                                |
| `archive/*.js` + `archive/update-notion.ts` | 早期爬虫与历史回填脚本，**已废弃**，仅作追溯                                                                                    |

### 离线断言（共 232 项）

```bash
npm run verify:all      # 依次跑上面三个脚本；CI 在同步之前先跑它
```

- 全部**不需要网络、不需要凭据、不引入测试框架**，几秒内跑完。
- `npm run verify:mapping` / `verify:rules` / `verify:parsers` 可单独运行。
- **关于 `tests/fixtures/*.html` 的诚实说明**：这五个 fixture 的标记结构是**由解析器使用的选择器反推
  构造**的，并非从豆瓣抓取。它们能让每个分支都有用例、并把期望值（含若干「怪癖」）精确钉住，
  因此任何改变解析行为的编辑都会立刻失败；但它们**无法**证明这些选择器今天仍与线上一致。
  下次改动解析器时，请用真实抓取的 HTML 替换它们 —— 那是唯一能补上这一点的升级。

---

## 常见问题

### 为什么「看过但没评分」的条目反而进了 watchlist？

TMDB 没有「已看」字段，评分是唯一能表达它的东西。所以一条看过但未打分的记录无处可去，只能退化为 watchlist——**看起来和「想看」一样**。

这是映射规则的推论，不是 bug。若不能接受，在 NeoDB 上给该条目补一个评分，它就会走「写评分 + 移出 watchlist」的正路。

### 同步报 401，说 TMDB 无法写入？

说明凭证是 app-level 而非 user-level。**注意**：JWT 里出现 `"scopes":["api_read"]` 不能作为判据——已验证带该字段的 user-scoped token 仍可正常写入。

真正的判据是能否读到账号：用 `Authorization: Bearer <token>` 调 `GET /3/account`，返回账号信息即为 user-scoped ✓，返回 401 则是 app-level。

解决方案：换用 user-scoped 的 `TMDB_ACCESS_TOKEN`，或创建 v3 session id 填到 `TMDB_SESSION_ID`。

### 重复运行会重复写入吗？

不会。三层保障：

1. **增量指纹**——状态文件记录内容指纹，未变化直接跳过，零请求
2. **读后比对**——先读 `account_states`，逐字段比对，已满足的字段不发请求
3. **运行内去重**——同一作品出现在多个书架时只处理一次

### 为什么有中文条目匹配不上 TMDB？

标题搜索依赖精确匹配（归一化后完全相等，并用年份 ±1 佐证）。中文译名差异大时可能失败。

优先路径是**平台链接**：NeoDB 条目的 `external_resources` 里若有 TMDB 或 IMDb 链接，会直接取 ID，零猜测。匹配失败的条目会写入 `SYNC_UNMATCHED_LOG`，可据此人工处理。

### 豆瓣 RSS 拉不到数据？

豆瓣的 RSS 接口对 User-Agent 敏感。设置 `DOUBAN_RSS_USER_AGENT` 为常见浏览器 UA 再试。

另外注意：**豆瓣 RSS 每次只返回最近约 10 条**（含「想*」状态）。这是**豆瓣侧的限制**，不是本项目截断——所以单次运行能同步的就这么多。集中标记过多时可能漏掉较早的记录，可手动触发 workflow，或把定时任务改密一些。

### GitHub Actions 里增量同步为什么不生效？

Actions 的 runner 每次都是全新环境，`.cache/sync-state.json` 不会跨次保留。若需要跨次增量，把 `SYNC_INCREMENTAL` 设为 `0`——退化为完全依赖 TMDB 侧幂等，**行为依然安全**，只是会多几次读请求。

### 会覆盖我手动在 TMDB 上做的修改吗？

默认**不会**覆盖已有评分（`tmdb_prefer`）。但状态类操作会以 NeoDB 为准，比如你在 TMDB 加进 watchlist、而 NeoDB 标记为「看过且有评分」，下一次运行会把它移出 watchlist。

### 会不会把我的凭证提交上去？

不会。`.gitignore` 已排除 `.env`、`.cache/`、`probe-output/`。在 CI 中请使用 GitHub Actions **Secrets**（见 [GitHub Actions 配置](#github-actions-配置)）。

---

## 新手入门指南

从零到跑通，按这三步走。

### 第一步 · 决定开哪条链路

五条链路**各自独立开关**、互不依赖。完整的「链路 — 开关 — 默认值 — 用途」对照见 [核心功能 · 五条链路](#五条链路)。

**操作方式**

- **开启**：设为 `1`（也接受 `true` / `yes` / `on`）
- **关闭**：设为 `0`（也接受 `false` / `off`，或留空）

**开箱即用的三条**：豆瓣 → NeoDB、豆瓣 → Bangumi、Bangumi → NeoDB —— 默认即开启，填好凭证就能跑。

**需要显式开启的两条**：豆瓣 → Notion、NeoDB → TMDB —— 默认关闭，必须先设为 `1`。

**只跑其中一条**：把其余四条都设为 `0` 即可。

⚠️ 如果 `Douban→*` 三条全部关闭，程序会跳过拉取豆瓣 RSS（省一次网络请求），此时 `DOUBAN_USER_ID` 可以不填。

### 第二步 · 填写参数

#### 必填项

按你**实际开启的链路**决定要填哪些。完整的「变量 / 说明 / 获取方式」三列对照见 [配置项说明 · 凭证](#凭证)，这里只给结论：

- **无论开哪条链路都要填**：`NEODB_API_TOKEN`
- **开 `Douban→*` 才需要**：`DOUBAN_USER_ID`
- **开 `SYNC_NEODB_TMDB` 才需要**：`TMDB_API_KEY` ＋（`TMDB_ACCESS_TOKEN` 或 `TMDB_SESSION_ID` 二选一）
- **开 Bangumi 相关链路才需要**：`BANGUMI_ACCESS_TOKEN`
- **开 `SYNC_DOUBAN_NOTION` 才需要**：`NOTION_TOKEN` ＋ 至少一个 `NOTION_*_DATABASE_ID`

#### 可选项

都有合理默认值，**不填也能跑**。完整清单（变量 / 默认值 / 取值 / 适用链路）见 [配置项说明](#配置项说明)——下面只提示按什么顺序考虑。

**① 先确认凭证类**（只在你启用对应链路时才需要）

- Notion：`NOTION_TOKEN` + 五个 `NOTION_*_DATABASE_ID`
- Bangumi：`BANGUMI_ACCESS_TOKEN`
- TMDB：`TMDB_API_KEY` + （`TMDB_ACCESS_TOKEN` 或 `TMDB_SESSION_ID`）

**② 再决定要不要调整默认行为**

- 想**限制同步范围** → 类别白名单（`SYNC_DOUBAN_*_CATEGORIES` / `SYNC_BANGUMI_NEODB_CATEGORIES` / `SYNC_CATEGORIES`）
- 想**保护 NeoDB 上已有的评分与短评** → 合并策略（`SYNC_*_MERGE`；默认 `neodb_prefer` 已提供保护，通常不用动）
- 想**控制 NeoDB 标记的可见性** → `NEODB_VISIBILITY`（默认 `2` 私密）
- 用的是**自建 NeoDB 实例** → 必须改 `NEODB_BASE_URL`
- 只跑 TMDB 链路 → 关注 `SYNC_SHELF_TYPES`、`SYNC_RATING_PROFILE`、`SYNC_MAX_ITEMS`
- 想同步**观看进度**（集 / 章 / 曲）→ `SYNC_BANGUMI_NEODB_PROGRESS`（默认关）

**③ 首次运行建议先空跑**：`SYNC_DRY_RUN=1`，确认计划符合预期后再正式执行。

⚠️ 类别白名单有个 **fail-closed** 行为：填了值但其中没有任何可识别类别时，该链路会**拒绝同步任何条目**，而不是退化成全量——防止拼写错误造成意外的大量写入。

### 第三步 · 验证

```bash
npm run verify:mapping        # 离线自测，不联网，57 项断言
SYNC_DRY_RUN=1 npm run sync   # 空跑：只打印将要执行的操作
npm run sync                  # 正式执行
```

### 最小配置示例

**场景一 · 只跑 NeoDB → TMDB**

```env
NEODB_API_TOKEN=你的token
TMDB_API_KEY=你的key
TMDB_ACCESS_TOKEN=你的token

SYNC_NEODB_TMDB=1
SYNC_DOUBAN_NOTION=0
SYNC_DOUBAN_NEODB=0
SYNC_DOUBAN_BANGUMI=0
SYNC_BANGUMI_NEODB=0
```

**场景二 · 只要豆瓣备份到 NeoDB**

```env
DOUBAN_USER_ID=1234567
NEODB_API_TOKEN=你的token
# 其余保持默认：Douban→NeoDB 默认即开启
```

**场景三 · 全都要（含 TMDB 与 Notion）**

```env
DOUBAN_USER_ID=1234567
NEODB_API_TOKEN=你的token
TMDB_API_KEY=你的key
TMDB_ACCESS_TOKEN=你的token
NOTION_TOKEN=你的token

SYNC_NEODB_TMDB=1
SYNC_DOUBAN_NOTION=1
NOTION_MOVIE_DATABASE_ID=你的数据库ID
NOTION_BOOK_DATABASE_ID=你的数据库ID
```

---

## 快速开始

### 1. 环境要求

- Node.js ≥ 20
- 一个 NeoDB 账号（官方实例或自建实例均可）
- 一个 TMDB 账号
- 豆瓣用户 ID（仅使用 `Douban→*` 链路时需要）

### 2. 安装

```bash
git clone <your-repo-url> Douban-Shelf-Archivist
cd Douban-Shelf-Archivist
npm ci
cp .env.example .env      # Windows: copy .env.example .env
```

### 3. 配置

编辑 `.env`，**最少填三项**：

```env
NEODB_API_TOKEN=      # NeoDB 实例的 /developer/ 页面授权获取
TMDB_API_KEY=         # themoviedb.org → Settings → API
TMDB_SESSION_ID=      # 见下方说明
```

> ⚠️ **TMDB 写权限**：评分和 watchlist 都是写操作，需要 user-scoped 凭证，两条路二选一：
> ▸ `TMDB_SESSION_ID`（v3 session id）
> ▸ `TMDB_ACCESS_TOKEN`（user-scoped 的 v4 token）
>
> **一处实测更正**：token 里出现 `"scopes":["api_read"]` **不代表它只能读**——已验证带该字段的 user-scoped token 仍能正常写入。
> 程序会先尝试把它换成 session id；若该转换端点不适用（返回 400），会**自动回退为 Bearer 模式**，无需人工干预。

### 4. 运行

```bash
npm run verify:mapping        # 离线自测映射逻辑，57 项断言
npm run probe:neodb           # 探测 NeoDB 真实响应，结果存 .cache/
SYNC_DRY_RUN=1 npm run sync   # 空跑：只打印计划，不写任何数据
npm run sync                  # 正式同步全部链路
```

建议顺序执行，尤其是**先空跑再实跑**。

### 常用命令

| 命令                        | 用途                     |
| --------------------------- | ------------------------ |
| `npm run sync`              | 按开关执行全部链路       |
| `npm run sync:neodb-tmdb`   | 只跑 NeoDB → TMDB        |
| `npm run sync:bangumi-full` | Bangumi → NeoDB 全量同步 |
| `npm run probe:neodb`       | 打印 NeoDB 真实响应结构  |
| `npm run verify:mapping`    | 映射逻辑离线自测         |
| `npm run typecheck`         | 类型检查                 |
| `npm run lint`              | 代码检查                 |
| `npm run format`            | 格式化                   |

---

## License

MIT
