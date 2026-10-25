# 参考手册 · 平台边界、接口依据与运行输出

> 主文档见 [README](../README.md)。本文件收纳三类**查阅型**内容：平台读写边界、接口依据、每次运行的输出。
> 所有条目均取自代码实际调用，超出本文所列的端点与字段不会被使用。

---

## 目录

- [1. 平台读写边界](#1-平台读写边界)
- [2. 接口依据](#2-接口依据)
- [3. 数据格式示例](#3-数据格式示例)
- [4. 每次运行输出什么](#4-每次运行输出什么)
- [5. 节流与写入前比对](#5-节流与写入前比对)

---

## 1. 平台读写边界

### 读

| 平台    | 端点                                     | 用途                                             |
| ------- | ---------------------------------------- | ------------------------------------------------ |
| 豆瓣    | RSS `/feed/people/{id}/interests`        | 拉取最近收藏                                     |
| 豆瓣    | 详情页 HTML                              | 抓取年份 / 导演 / 演员等元数据                   |
| Notion  | `POST /v1/data_sources/{id}/query`       | 按 `ITEM_LINK` 查重（分批 or 条件 + 翻页）       |
| Notion  | `GET /v1/data_sources/{id}`              | 读该库真实列名（每分类一次，不在条目循环里重复） |
| Bangumi | `GET /v0/me`                             | 解析用户名                                       |
| Bangumi | `GET /v0/users/{u}/collections`          | 收藏列表（分页）                                 |
| Bangumi | `GET /v0/users/{u}/collections/{id}`     | 读单个收藏（幂等基准）                           |
| Bangumi | `GET /v0/subjects/{id}`                  | 条目详情（判定漫画平台）                         |
| Bangumi | `POST /v0/search/subjects`               | 标题搜索（**搜索走 POST**）                      |
| NeoDB   | `GET /api/catalog/fetch?url=`            | 用外链解析条目                                   |
| NeoDB   | `GET /api/catalog/search`                | 目录搜索                                         |
| NeoDB   | `GET /api/me/shelf/{type}`               | 书架列表（分页）                                 |
| NeoDB   | `GET /api/me/shelf/item/{uuid}`          | 读单个标记                                       |
| NeoDB   | `GET /api/me/shelf/item/{uuid}/progress` | 读单个进度                                       |
| NeoDB   | `GET /api/me`                            | 当前账号                                         |
| NeoDB   | `GET /api/token`                         | 凭据探测                                         |
| TMDB    | `GET /3/account`                         | 解析 account_id，兼作凭证探测                    |
| TMDB    | `GET /3/{type}/{id}/account_states`      | 读现状（幂等基准）                               |
| TMDB    | `GET /3/search/{type}`                   | 标题搜索                                         |
| TMDB    | `GET /3/find/{imdb_id}`                  | IMDb 精确查找                                    |
| TMDB    | `GET /3/{type}/{id}`                     | 按 ID 取详情                                     |

### 写

| 平台    | 端点                                      | 可写字段                                                                   | **不能**写                                       |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| 豆瓣    | —                                         | **无**（没有写入 API，全程只读）                                           | 一切                                             |
| Notion  | `POST /v1/pages`                          | 建页（`parent` 为 `data_source_id`，海报/封面同时设为页面 cover）          | 更新与删除页面；目标库中不存在的列（写入前丢弃） |
| Bangumi | `POST /v0/users/-/collections/{id}`       | `type` 收藏状态、`rate` 评分、`comment` 短评、`private` 可见性             | 标记时间（payload 只含这 4 个字段）              |
| NeoDB   | `POST /api/me/shelf/item/{uuid}`          | `shelf_type`、`rating_grade`、`comment_text`、`visibility`、`created_time` | —                                                |
| NeoDB   | `POST /api/me/shelf/item/{uuid}/progress` | `type` / `value`（集 / 章 / 曲）                                           | —                                                |
| TMDB    | `POST /3/{type}/{id}/rating`              | **仅评分**                                                                 | —                                                |
| TMDB    | `POST /3/account/{id}/watchlist`          | **仅 watchlist 增删**                                                      | —                                                |

> NeoDB 写入体里 `post_to_fediverse` 固定为 `false`（`src/clients/neodb-shelf.ts:109`），所以同步永远不会向联邦宇宙发帖。

### TMDB：能力边界

这套同步**注定是有损的**。状态类内容的有损方式见主文档的[状态映射表](../README.md#链路-5neodb--tmdb)；下表覆盖**状态之外**的内容，两者合起来就是「有损」的全部来源：

| 想同步的内容                     | TMDB 能否承载 | 实际结果                        |
| -------------------------------- | ------------- | ------------------------------- |
| 评分                             | ✅            | 0.5–10，步进 0.5                |
| 短评                             | ❌            | **丢弃**——无写入接口            |
| 进度（看到第几集）               | ❌            | **丢弃**——无对应字段            |
| 图书 / 音乐 / 游戏 / 播客 / 演出 | ❌            | **整条跳过**——TMDB 无这些类型   |
| 反向回写（TMDB 改动回流）        | ❌            | **单向**，不回写                |
| `favorite` 收藏                  | ✅ 但未使用   | TMDB 支持，本项目不用           |
| 用户自建 List                    | ✅ 但未使用   | 可承载「看过/在看」，本项目不用 |

---

## 2. 接口依据

与上一节的分工：上一节按**读 / 写**列出端点，这里补充**响应结构与字段口径**——同样的端点不重复第二遍。

### NeoDB 侧

结构来自官方 API 参考与两个独立客户端类型定义的交叉验证。

| 端点 / 字段                | 说明                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/me/shelf/{type}` | `type` 是**路径参数**（`wishlist` / `progress` / `complete` / `dropped`），查询参数为 `category`、`page` |
| `GET /api/catalog/fetch`   | 用 `?url=` 传入豆瓣链接，解析出 catalog item（无 `uuid` 时轮询重试）                                     |
| 响应结构                   | `{ data: MarkSchema[], pages, count }`；`MarkSchema` **内联完整 `item`**，无需二次请求                   |
| `rating_grade`             | 0–10 整数，**`0` 表示未评分**                                                                            |
| 年份字段                   | movie / tv 为 `year`，图书为 `pub_year`                                                                  |

运行 `npm run probe:neodb` 可随时复核上述假设（原始响应存 `.cache/`）。

### Bangumi 侧

| 依据                                              | 说明                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /v0/users/{u}/collections` 的 `subject_type` | 省略即返回**全部类型**；本项目按类别白名单折算成具体取值（`anime→2`、`book/manga→1`、`music→3`、`game→4`、`real→6`） |
| `ep_status` 的适用范围                            | 官方 API 说明「只能用于修改**书籍**条目进度」——这正是游戏/影视不写进度的依据                                         |
| `collection.type` 取值                            | `1` 想看 / `2` 看过 / `3` 在看 / `4` 搁置 / `5` 抛弃                                                                 |

### TMDB 侧

| 端点                                       | 用途                                |
| ------------------------------------------ | ----------------------------------- |
| `GET /3/{movie\|tv}/{id}/account_states`   | 读现状——幂等比对的基准              |
| `POST /3/{movie\|tv}/{id}/rating`          | 写评分                              |
| `POST /3/account/{id}/watchlist`           | 加入 / 移出 watchlist               |
| `GET /3/search/{movie\|tv}`                | 标题搜索（三级匹配的最后一级）      |
| `GET /3/find/{imdb_id}`                    | IMDb ID 精确查找（零误匹配）        |
| `GET /3/account`                           | 解析 account_id，兼作凭证有效性探测 |
| `POST /3/authentication/session/convert/4` | 尝试把 v4 token 换成 session id     |

写权限需要 v3 session id 或 user-scoped 的 v4 token；判据与排错步骤见[常见问题 · 401](../README.md#同步报-401说-tmdb-无法写入)——注意 JWT 里的 `scopes:["api_read"]` **不能**作为判据。

---

## 3. 数据格式示例

以下示例全部取自**代码中实际读取/写入的字段**（类型定义见 `src/types.ts`、`src/clients/bangumi.ts`、`cols.json`），未列出的字段代码不消费。

<details>
<summary><b>豆瓣 RSS · 原始条目</b></summary>

<pre>
#竹子哟竹子#✨ 的收藏
{
  creator: '#竹子哟竹子#✨',
  title: '想看白蛇传·情',
  link: 'http://movie.douban.com/subject/34825976/',
  pubDate: 'Mon, 31 May 2021 15:14:58 GMT',
  'dc:creator': '#竹子哟竹子#✨',
  content:
    '&lt;table&gt;&lt;tr&gt; &lt;td width="80px"&gt;&lt;a href="https://movie.douban.com/subject/34825976/" title="白蛇传·情"&gt; &lt;img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2645106865.webp" alt="白蛇传·情"&gt;&lt;/a&gt;&lt;/td&gt; &lt;td&gt; &lt;p&gt;推荐: 很差/较差/还行/推荐/力荐&lt;/p&gt; &lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;',
  contentSnippet: '',
  guid: 'https://www.douban.com/people/MoNoMilky/interests/2898270366',
  isoDate: '2021-05-31T15:14:58.000Z'
}
</pre>

</details>

<details>
<summary><b>豆瓣 RSS · 解析之后的 FeedItem</b>（<code>normalizeRssFeeds()</code> 的输出，三条豆瓣链路的共同输入）</summary>

<pre>
{
  id: '34825976',                          // 从链接中提取的条目 id
  link: 'http://movie.douban.com/subject/34825976/',
  title: '白蛇传·情',                       // 已剥掉「想看」状态前缀
  rating: 5,                               // 力荐 → 5；未评分则为 null
  comment: null,                           // 正文里没有「备注:」时为 null
  time: '2021-05-31T15:14:58.000Z',         // 即 isoDate
  status: 'wishlist',                      // 想看 → wishlist
  category: 'movie'                        // 由链接域名判定（movie / music / book / game / drama）
}
</pre>

</details>

<details>
<summary><b>Notion 数据库 properties 样例数据</b></summary>

<pre>
{
  '条目链接': { id: '=jBf', type: 'url', url: 'https://movie.douban.com/subject/26277363/' },
  'IMDb 链接': { id: '@ME}', type: 'url', url: 'https://www.imdb.com/title/tt5419278' },
  '主演': { id: 'X{lL', type: 'rich_text', rich_text: [[Object]] },
  '个人评分': {
    id: 'Z^ph',
    type: 'multi_select',
    multi_select: [ { id: 'FRXk', name: '5', color: 'pink' } ]
    // multi_select: [], // empty array if no value for rating
  },
  '打分日期': { id: 'e\\{[', type: 'date', date: { start: '2021-01-19', end: null } },
  '类型': { id: 'pzY>', type: 'multi_select', multi_select: [[Object], [Object]] },
  '海报': {
    id: 't@Fv',
    type: 'files',
    files: [ { name: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2524998570.jpg' } ]
  },
  '我的短评': { id: 'wG?R', type: 'rich_text', rich_text: [[Object]] },
  '上映年份': { id: 'xghA', type: 'number', number: 2016 },
  '导演': { id: 'y]UL', type: 'rich_text', rich_text: [[Object]] },
  '标题': { id: 'title', type: 'title', title: [[Object]] }
}
</pre>

</details>

<details>
<summary><b>Bangumi · 单个收藏</b>（<code>GET /v0/users/{u}/collections/{id}</code>，链路③的幂等基准、链路④的读取来源）</summary>

<pre>
{
  subject_id: 543360,
  subject_type: 2,                  // 1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元
  rate: 8,                          // 0–10；0 表示未评分
  type: 3,                          // 1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃
  comment: '补标记',
  tags: [],
  ep_status: 12,                    // 看到第几集
  vol_status: 0,                    // 读到第几卷
  updated_at: '2026-10-15T12:00:00+08:00',
  private: false,
  subject: {
    id: 543360,
    type: 2,
    name: '上伊那牡丹，酒醉身姿似百合花',
    name_cn: '上伊那牡丹，酒醉身姿似百合花',
    platform: 'TV'
  }
}
</pre>

</details>

<details>
<summary><b>NeoDB · 书架标记</b>（<code>GET /api/me/shelf/{type}</code> 返回的 <code>data[]</code> 元素，链路②④的写入目标、链路⑤的读取来源）</summary>

<pre>
{
  shelf_type: 'complete',           // wishlist / progress / complete / dropped
  visibility: 2,                    // 0 公开 / 1 关注者 / 2 私密
  post_id: 12345678,
  comment_text: 'NeoDB 上的短评',
  rating_grade: 8,                  // 0–10 整数；0 表示未评分
  tags: [],
  created_time: '2026-10-01T00:00:00+00:00',
  item: {
    id: '…',
    type: 'Movie',
    uuid: '…',
    url: 'https://movie.douban.com/subject/1292052/',
    api_url: 'https://neodb.social/api/movie/…',
    category: 'movie',              // book / movie / tv / music / game / podcast / performance
    parent_uuid: null,
    display_title: '肖申克的救赎',
    title: 'The Shawshank Redemption',
    brief: '',
    description: '…',
    cover_image_url: '…',
    rating: 4.5,
    rating_count: 100,
    localized_title: [{ lang: 'zh', text: '肖申克的救赎' }],
    external_resources: [          // 一级/二级匹配的依据
      { url: 'https://www.themoviedb.org/movie/278' },
      { url: 'https://www.imdb.com/title/tt0111161/' }
    ],
    year: 1994                      // 图书条目用 pub_year
  }
}
</pre>

</details>

<details>
<summary><b>TMDB · 账号状态与搜索结果</b>（<code>account_states</code> 与 <code>/search</code>）</summary>

<pre>
// account_states —— rated 是联合类型：未评分时是 false 而不是 { value: 0 }
{
  id: 278,
  favorite: false,
  rated: { value: 8 },
  watchlist: false
}

// search/movie 结果中的一个元素（此处仅列代码实际读取的字段）
{
  id: 278,
  media_type: 'movie',
  title: '肖申克的救赎',
  original_title: 'The Shawshank Redemption',
  release_date: '1994-09-23'
}
</pre>

</details>

---

## 4. 每次运行输出什么

所有链路结束时**先汇总计数、再列出需要人工过目的条目**，最后合成一个总表。同样的内容还会以 Markdown 写入 CI 的作业摘要。

### 单条链路

```
[info] Bangumi → NeoDB: scanned 50, written 38, unchanged 6, skipped 2, unresolved 6, failed 1
[info] Bangumi → NeoDB self-check: 38+6+2+6+1 = 53 ✘ expected 50      ← 故意造错时的样子
[warn] 6 unresolved item(s) — no counterpart at the destination:
[warn]   · 学园奶爸
[warn]   · 剧场版宝可梦: 时拉比 穿梭时空的相遇
[warn]   …（最多列 20 条，超出显示 "… and N more"）
[warn] 6 unmatched item(s) written to D://项目路径//.cache//unmatched.json.
[warn] 1 failed item(s) — the write was attempted and rejected:
[warn]   · 某条目 — item-threw: socket hang up
[warn] 2 skipped item(s) — deliberately not written:
[warn]   · 某漫画 — platform-mismatch
[warn]   · bulk × 400（例：第 1 部作品、第 2 部作品、第 3 部作品 …）
```

三档的顺序固定为 **unresolved → failed → skipped**：越靠前越需要人动手。`unresolved` 逐条列出；`failed` / `skipped` 按**原因**分组 —— 同一原因超过 8 条就折叠成一行（带条数与最多 3 个示例），因为一轮完整运行里 `unchanged-since-last-run` 这类机械跳过动辄数百条，逐条展开会把真正该看的几条埋掉。折叠行的数字与节标题同源，且清单行数加「… and N more」永远等于计数；万一对不上，会额外打一行 `(detail has M entr(ies), count is N — the count is authoritative)`：M 少于 N 说明链路没能点名，M 多于 N 说明有一处被数了两遍，无论哪种都以计数为准。

### 运行结束时的总表

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Sync finished — 5 path(s) ran, none failed                                                     │
│                                                                                                │
│ Douban → Notion    scanned    4   written    2   unresolved    0   failed    0   ok           │
│ Douban → NeoDB     scanned   10   written    0   unresolved    0   failed    0   ok           │
│ Douban → Bangumi   scanned   10   written    0   unresolved    3   failed    0   ok, 3 unreso… │
│ Bangumi → NeoDB    scanned   50   written    3   unresolved    2   failed    0   ok, 2 unreso… │
│ NeoDB → TMDB       scanned  200   written    5   unresolved   44   failed    0   capped, 44 u… │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

`self-check` 行是刻意加的一致性校验：`written + unchanged + skipped + unresolved + failed` 应当等于 `scanned`。

- 输出 `✔` → 计数闭合，没有漏算
- 输出 `✘ expected N` → 要么统计逻辑有漏算，要么**日志被截断**了（终端回滚缓冲上限会导致只保存后半段）；把输出重定向到文件（`npm run sync > run.log 2>&1`）重跑即可排除截断因素

### 六个计数分别统计什么

总表、单链路汇总与 CI 作业摘要用的是同一套口径。

| 计数           | 中文含义                               | 统计口径（具体数的是什么）                                                                                                                 | 常见触发原因                                                                                |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Scanned**    | 本次从源端读取并**尝试处理**的条目总数 | 各链路进入处理循环的条数：① = RSS 归一化后的条目数；④ = 实际翻到的收藏条数（默认只第一页）；⑤ = 遍历到的书架标记数，**含被前置闸门挡下的** | 上游返回多少就计多少，与写入结果无关                                                        |
| **Written**    | 成功写入目标端的条目数，含新建与更新   | 写请求实际成功：① 建页成功；②④ 标记写入（或进度写入）成功；③ `upsert` 成功；⑤ 按字段计（见下）                                             | 目标端没有该记录，或已有但比对出差异                                                        |
| **Unchanged**  | 目标端已有且内容一致，**未发写请求**   | 写入前比对全等：① 链接已在库；②④ 四字段全同；③ 三字段全同；⑤ 实时状态无差异                                                                | 重复运行、上一轮刚写过、你已在目标端手工改好                                                |
| **Skipped**    | 被同步规则**主动跳过**，不计为失败     | 规则判定「不处理」，连写请求都不发                                                                                                         | 分类白名单排除、类型不支持（话剧）、搁置/抛弃守卫、本轮重复目标、增量指纹命中、书架开关排除 |
| **Unresolved** | 无法自动确定目标端对应实体             | 匹配阶段失败，从未进入写入                                                                                                                 | 搜索无结果、标题歧义、缺外部 ID、NeoDB 没有该条目（冷门 OVA 等）                            |
| **Failed**     | 处理过程中**实际出错**的条目           | 单条抛错或被目标端拒绝                                                                                                                     | API 报错、网络超时、401/权限不足、写入被拒、解析异常                                        |

**它们之间是否重合？**

- ①–④：**互不重合**，五者是对 `Scanned` 的完备划分 —— `written + unchanged + skipped + unresolved + failed = scanned`，`self-check` 行就在校验这一点。
- ⑤（NeoDB → TMDB）是唯一例外：它的 `Written` 与 `Failed` 按**字段**计（评分、watchlist 各一次），同一部作品最多贡献 2，也可能「评分写失败、watchlist 写成功」而同时出现在 `Failed` 与 `Written` 里。因此在两项都发生写入时，该链路的等式可能不成立（日志会显示 `✘`），这不是漏算。
- `aborted` **不属于**这六个计数：它表示链路根本没跑起来（缺凭据等），单独出现在 `State` 列。`TOLERATED` 是它的一个变体 —— 失败可见，但不参与退出码（`SYNC_DOUBAN_REQUIRED=0`）。

### CI 中的额外呈现

`GITHUB_ACTIONS=true` 时自动启用，本地不输出：

| 命令                         | 作用                                        |
| ---------------------------- | ------------------------------------------- |
| `::group::` / `::endgroup::` | 把未匹配清单折叠起来，日志默认只占一行      |
| `::notice::`                 | 未匹配条数汇总到运行页顶部的 Annotations 区 |
| `::warning::`                | 有链路失败时同样上报到 Annotations          |

### CI 中的作业摘要

由 `src/sync-report.ts` 先写进 `SYNC_SUMMARY_FILE`（默认 `.cache/sync-summary.md`），再由 `sync.yml` 里一个 `if: always()` 的步骤贴到 `$GITHUB_STEP_SUMMARY`。运行页顶部会出现一块 **Markdown 面板**，顺序固定为：

1. 一行极简的六字段中文说明（含义）；
2. 一段计数关系说明（谁是谁的划分、哪个链路例外）；
3. 汇总表（`Path / Scanned / Written / Unchanged / Skipped / Unresolved / Failed / State`）；
4. 每条链路的明细块：先一个 `### 来源 → 目标`（H3，**只有该链路三档里至少一档非零才出现**），其下按档位分 `#### unresolved（N）` / `#### failed（N）` / `#### skipped（N）`（H4）。档位顺序固定为 `unresolved` → `failed` → `skipped`，空档位不产生标题；
5. `unresolved` 逐条列出，用 Markdown 有序列表（`1.`、`2.`、`3.`……，**每条链路各自从 1 起**），编号即「该链路全部 N 条里的第几条」；超过 200 条时末尾补一行不编号的 `… and N more`；
6. `failed` / `skipped` 按原因分组（超过 20 条的原因折叠成一行），**同样用有序列表、每节从 1 起**；但编号数的是**渲染出来的行**而非条目 —— 折叠行一次代表多条，每节最多渲染 60 行，所以「第 7 行」不等于「第 7 条」，条目数以小节标题里的计数为准；末尾的 `… and N more` 与第 5 条一样不编号；
7. 以上是 `sync.yml` 自己写的那份摘要。`review-queue.yml` 另写一份「待核对名单」，也按「链路 → 档位」两级分组（只是层级整体上移一级：H1 总数、H2 链路、H3 档位），见 `docs/review-queue.md` 的「名单结构」一节。

> 两份摘要的链路名逐字相同（都取自 `src/paths/*.ts` 的 `LABEL`），所以同一个词在控制台日志、作业摘要、待核对名单里能直接 grep 对齐。

| Path            | Scanned | Written | Unchanged | Skipped | Unresolved | Failed | State                |
| --------------- | ------: | ------: | --------: | ------: | ---------: | -----: | -------------------- |
| Bangumi → NeoDB |      50 |      38 |         6 |       0 |          6 |      0 | ok, 6 unresolved     |
| NeoDB → TMDB    |     200 |       1 |       193 |       0 |          6 |      0 | capped, 6 unresolved |

> **为什么先落文件、再由独立步骤发布**：`$GITHUB_STEP_SUMMARY` 是 **per-step** 的文件，随所属步骤结束才提交。把摘要写在「可能以非零码退出」的那个步骤里，等于让报表的可见性取决于同步是否成功 —— 而失败的那一轮恰恰最需要它（真实案例：一次 `NeoDB → TMDB` 失败的运行，Annotations 里四条注解齐全，摘要面板却是空的）。现在进程只负责把 Markdown 写到 `.cache/sync-summary.md`（覆盖写、一轮一份，写失败用 `warn` 明说而不是藏在 `consola.debug` 里），发布交给 `if: always()` 的步骤：同步决定退出码，发布步骤决定有没有人读得到原因。文件不存在时那个步骤只写一行提示，不会让作业变成另一种红。
>
> **为什么用作业摘要而不是 `actions/upload-artifact`**：GitHub 计费文档明确**日志与作业摘要不计入存储配额**（而 GitHub Free 的工件存储仅 500 MB，且与 GitHub Packages 共享同一配额池）；面板无需下载即可阅读。唯一代价是不可下载、不可脚本消费；将来真需要脚本消费再补 artifact。

### 留档文件：路径、写入方与格式

**路径**：`SYNC_UNMATCHED_LOG`，默认 `.cache/unmatched.json`。这是**相对路径**，按**进程的工作目录**解析 —— `npm run sync` 的工作目录是仓库根，所以本地默认落在 `<仓库>/.cache/unmatched.json`；用 `npm --prefix`、IDE 任务、或从别的目录直接调 `tsx src/index.ts` 时，它落在**那个目录**下的 `.cache/`。

**四条链路会写它**：② Douban → NeoDB（`no-neodb-match`）、③ Douban → Bangumi（`no-bangumi-match`）、④ Bangumi → NeoDB（`neodb-unresolved`）、⑤ NeoDB → TMDB（`no-tmdb-match`）。① 不写（它的未配置分类与写入失败走 Notion 侧的明细与 `skipped`），因此「汇总里没有 `Full entries` 那一行」不代表出错。

**日志里现在打印的是解析后的绝对路径**，形如：

```
[warn] 6 unmatched item(s) written to D://项目路径//.cache//unmatched.json.
```

作业摘要里的对应行还会带上真实条目数与体积，但**绝对路径只在本地给出**：

```text
# 本地：路径可点开
Full entries: `D:\项目路径\.cache\unmatched.json` (6 entries, 3.4 KiB)

# CI：路径指向一台作业结束即销毁的 runner，所以不给绝对路径
Full entries: 6 entries, 3.4 KiB recorded at `.cache/unmatched.json` on the runner — its disk is
discarded with the VM, so this is not downloadable. The list that survives is the 待核对名单
artifact (`docs/review-queue.md`).
```

文件不在时两种环境都明写 `**not present**`（本地额外补一句「本应在此」的绝对路径），而不是照样指向一个不存在的路径。

**在 CI 里它必然"找不到"**：路径相对 `$GITHUB_WORKSPACE` 解析，即 runner 上的 `/home/runner/work/<repo>/<repo>/.cache/unmatched.json`。runner 是一次性虚拟机，作业结束即销毁，`sync.yml` 也没有上传它。所以看到 Actions 日志里的这个路径后到本机磁盘上找，是找不到的 —— 这是设计行为，不是文件的 bug。正因如此，作业摘要现在**在 CI 里不打印绝对路径**（只给条目数、体积与相对位置），本地才打印。需要跨轮留存时走 `docs/review-queue.md` 里的 artifact 方案。

**确认实际位置的办法**（都在**运行同一个目录**下执行）：

```bash
# 1) 先看进程会把相对路径解析成什么
node -e "console.log(process.cwd(), require('path').resolve('.cache/unmatched.json'))"

# 2) 跑完之后直接看
ls -la .cache/ && node -e "console.log(require('./.cache/unmatched.json').length, 'entries')"

# 3) 不确定落在哪个目录时，按名字搜
find /d -maxdepth 8 -name 'unmatched.json' 2>/dev/null
```

注意 `.gitignore` 里有 `.cache`，所以它**不会**出现在 `git status`、GitHub Desktop 的改动列表或 GitHub 网页上 —— 这是它「明明写了却看不见」的另一个常见原因。

各链路写入**同一个文件**，用 `source` 区分来源：

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
  },
  {
    "source": "douban→bangumi",
    "reason": "no-bangumi-match",
    "title": "江南",
    "externalId": "https://music.douban.com/subject/1406731/",
    "externalUrl": "https://music.douban.com/subject/1406731/",
    "firstSeenAt": "2026-10-15T00:00:00.000Z",
    "lastSeenAt": "2026-10-15T00:00:00.000Z"
  }
]
```

> **写入是 upsert，不是盲目追加**。键为 `source::(externalId ?? uuid)`：同一部作品反复失败只保留**一条**记录，刷新 `lastSeenAt`、保留 `firstSeenAt`。这样既能一眼看出「这是新问题（两个时间相同）还是长期存在（`firstSeenAt` 很早）」，文件大小也稳定在**唯一未解析集合**的规模而不会无限增长。
>
> 之所以不是纯追加：同几条冷门条目每轮都会失败，追加只会让文件变大而不增加信息；而且早先的条目**完全没有时间戳**，两条一模一样的记录无法判断哪条更新——那种「历史」是不可用的。
>
> 该文件在 CI 中每轮都是全新的（runner 临时），所以去重只对**本地连续运行**有意义。`.cache` 已被 `.gitignore` 排除，**不会**进仓库。

### failed / skipped 明细的 reason 取值

控制台与作业摘要里每条明细都带一个 `reason` slug；同一 slug 在留档日志里也是同一个词，可以用一次 grep 对齐。带 `:` 的 slug 会把具体值接在后面（例如 `no-tmdb-category: game`），**分组按完整取值**，因此 `game` 与 `music` 会各占一组。

| 链路               | 档位    | reason                           | 含义                                                                                                     |
| ------------------ | ------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ① Douban → Notion  | skipped | `category-not-allowed`           | 分类不在 `DOUBAN_NOTION_CATEGORIES` 里（白名单模式）                                                     |
|                    | skipped | `no-notion-database: <分类>`     | 该分类没配 data source id，整类条目都不会写（要补的是**一行配置**）                                      |
|                    | failed  | `notion-insert-failed`           | Notion 收到请求但没建页（列不匹配 / 令牌权限）                                                           |
|                    | failed  | `douban-scrape-failed`           | 豆瓣条目页抓取或 PoW 求解失败，请求没发出过                                                              |
|                    | failed  | `notion-category-failed: <错误>` | 该分类的去重查询或 schema 读取抛错，整类计入失败                                                         |
| ② Douban → NeoDB   | skipped | `category-not-allowed`           | 同上，白名单排除                                                                                         |
|                    | skipped | `guard-target-status`            | 目标端状态是豆瓣表达不了的（如 `dropped`），留着不动                                                     |
|                    | failed  | `neodb-mark-rejected`            | 标记写入（新建或更新）被拒                                                                               |
| ③ Douban → Bangumi | skipped | `category-not-allowed`           | 同上                                                                                                     |
|                    | skipped | `guard-bangumi-status`           | Bangumi 上是搁置/抛弃，覆盖会毁掉源端没有的事实                                                          |
|                    | failed  | `bangumi-write-rejected`         | `upsertBangumiCollection` 返回失败                                                                       |
| ④ Bangumi → NeoDB  | skipped | `platform-mismatch`              | 漫画白名单下，该书的 Bangumi 平台不是「漫画」                                                            |
|                    | failed  | `item-threw: <错误>`             | 单条处理抛错（网络/解析），不影响其余条目                                                                |
| ⑤ NeoDB → TMDB     | skipped | `shelf-not-mapped`               | 该书架状态在 TMDB 没有对应（例如 `dropped`）                                                             |
|                    | skipped | `no-tmdb-category: <分类>`       | 分类 TMDB 装不了（游戏等），零请求                                                                       |
|                    | skipped | `unmapped-category: <分类>`      | 分类不在映射表里（新出现的分类）                                                                         |
|                    | skipped | `unchanged-since-last-run`       | 增量指纹命中；正常增量运行的主体，通常数百条                                                             |
|                    | skipped | `duplicate-in-run: <目标>`       | 同一 TMDB 条目本轮已被处理过（同一作品在两个书架）                                                       |
|                    | failed  | `no-catalog-item`                | 标记没有目录条目，连标题都没有                                                                           |
|                    | failed  | `tmdb-rating-write-failed`       | 评分写失败                                                                                               |
|                    | failed  | `tmdb-watchlist-write-failed`    | watchlist 写失败                                                                                         |
|                    | failed  | `tmdb-item-threw: <错误>`        | 单条处理抛错（刻意与 ④ 的 `item-threw` 分开：两条链路原先用同一个 slug，待核对名单只能记到其中一条名下） |

> **与计数的一一对应**：`failedItems.length` 必须等于 `failed`、`skippedItems.length` 必须等于 `skipped`。⑤ 是唯一「一个条目贡献两条明细」的地方 —— 评分与 watchlist 各失败一次就是 2 条明细、2 个 `failed`，与它按字段计数的口径一致。
>
> `unresolved` 不在这张表里：它没有单独的明细数组，标题直接进 `unresolvedTitles`，同时由 ②③④⑤ 写进上面那个 JSON 留档。它的 reason 只出现在日志行与待核对名单里：`no-neodb-match`（②）、`no-bangumi-match`（③）、`neodb-unresolved`（④）、`no-tmdb-match`（⑤）。

---

## 5. 节流与写入前比对

### 请求节流

| 链路              | 节流方式                                           | 默认值  |
| ----------------- | -------------------------------------------------- | ------- |
| ① 豆瓣 → Notion   | 每条之间固定等待                                   | 1000 ms |
| ② 豆瓣 → NeoDB    | `NEODB_REQUEST_DELAY_MS`                           | 300 ms  |
| ③ 豆瓣 → Bangumi  | 固定等待                                           | 400 ms  |
| ④ Bangumi → NeoDB | 固定等待                                           | 400 ms  |
| ⑤ NeoDB → TMDB    | `NEODB_REQUEST_DELAY_MS` + `TMDB_REQUEST_DELAY_MS` | 300 ms  |

> 链路①③④ 的等待是代码里的**固定值**（无旋钮）；链路②⑤ 走环境变量。

### 幂等：结构并不相同

「三层节流」只完整适用于 NeoDB → TMDB。两者的写入前比对机制完全不同：

| 节流层             | NeoDB → TMDB                                                  | Bangumi → NeoDB                   |
| ------------------ | ------------------------------------------------------------- | --------------------------------- |
| ① 内容指纹跳过     | ✅ `SYNC_INCREMENTAL`，未变化条目**在匹配前**就 return        | ❌ 无（每轮都重新解析并比对）     |
| ② 写入前字段级比对 | ✅ 先读 `account_states`，逐字段 diff                         | ⚠️ **有比对，但机制不同**（见下） |
| ③ 熔断上限         | ✅ `SYNC_MAX_ITEMS`（跨书架跨类别总计，按进入 TMDB 的条数计） | ❌ 无（由「只取第一页」天然限流） |

**为什么 Bangumi → NeoDB 不需要 `account_states`**：TMDB 的 `account_states` 是**独立的第三方接口**，读它才能知道目标端现状。而 NeoDB 侧读取标记用的是同一个客户端的 `getNeodbMark(uuid)`，返回结构与写入体同源，可直接做字段级比对——**不需要为「读现状」额外设计一套枚举接口**。两者目的相同（避免无差异写入），手段因目标平台的 API 形态而异。

### NeoDB → TMDB：读 `account_states` 逐字段比对

写入前先调 `GET /3/{type}/{id}/account_states`，然后 `planTmdbWrites()` 对两个字段分别判断：

| 字段          | 比对依据                                           | 判定规则                         |
| ------------- | -------------------------------------------------- | -------------------------------- |
| **watchlist** | `account_states.watchlist`（布尔）                 | 与计划目标相等 → 不写；不等 → 写 |
| **rating**    | `account_states.rated`（`{value}` **或 `false`**） | 与计划目标相等 → 不写；不等 → 写 |

两个关键细节：

1. **`rated` 是联合类型**——可能是 `{ value: 8 }`，也可能是 `false`（未评分）。`extractTmdbRating()` 统一归一：非对象或非数字一律返回 `null`。
2. **`tmdb_prefer` 下会「锁定」已有评分**——若 TMDB 已有评分且 profile 为 `tmdb_prefer`，则把 TMDB 的现有值当作目标值，与现状自然相等 → **恒不写入**。这就是日志里反复出现 `NeoDB prefer: keeping existing rating` 的成因。

比对结果汇总为 `shouldWrite`：**`false` 时调用方不得发出任何写入请求**（`planTmdbWrites` 的契约注释明确写了这一点）。写入时**按字段分别发请求**——`setRating` 与 `setWatchlist` 各自独立判断，**不存在的字段根本不会出现在 payload 里**，所以不存在「全量覆盖」。

> `plan === null` 的字段（如日志中的 `rating untouched`）表示**映射上就不该动这个字段**，此时既不 POST 也不 DELETE——**绝不删除**用户手动在 TMDB 设的评分。这是刻意的保护。

### Bangumi → NeoDB 与豆瓣 → NeoDB：读 `getNeodbMark` 逐字段比对

两者共用 `mergeNeodbMark()` 比对**四个字段**：

| 字段             | 比对依据                             | 判定规则                                     |
| ---------------- | ------------------------------------ | -------------------------------------------- |
| **shelf_type**   | 现有 `shelf_type`                    | 与来源不等 → 写（**状态永远以来源为准**）    |
| **rating_grade** | 现有 `rating_grade`（`0` = 未评分）  | `neodb_prefer` 下现有非 0 则保留；否则用来源 |
| **comment_text** | 现有 `comment_text`（空串 = 无短评） | `neodb_prefer` 下现有非空则保留；否则用来源  |
| **visibility**   | 现有 `visibility`                    | 与配置的 `NEODB_VISIBILITY` 不等 → 写        |

四个字段**全部相等时 `shouldWrite = false`**，日志打印 `NeoDB mark unchanged, skip`——这正是全量日志中该行批量出现的原因。

**与 TMDB 侧的两个差异**：

1. **没有「独立读现状接口」这一步**——`getNeodbMark` 与写入体同源，省去了一次专门的探测调用。
2. **`neodb_prefer` 是「填空」而非「锁定」**——TMDB 侧是「已有值就整体保留」；NeoDB 侧是「已有非空值才保留」，来源值仍可能填补空缺字段。

### 标记时间的不对称

- **链路②**：新建与更新**都**带 `created_time`（取 RSS 条目时间）。
- **链路④**：新建带 `created_time`（取 `collection.updated_at`），**更新时故意不传**——Bangumi 的 `updated_at` 不足以可信到可以覆盖 NeoDB 已有的标记日期。
- **链路③**：写不进去。Bangumi 的 payload 只有 `type` / `rate` / `comment` / `private` 四个字段。

### 豆瓣 → Bangumi：三字段比对 + 评分保留

`resolveBangumiCollectionWrite()` 先决定「要发什么」，再决定「是否需要发」：

1. `existing.type` 属于「搁置 / 抛弃」→ 整条跳过（守卫，在调用本函数之前判断）；
2. `existing.rate > 0` → 沿用该评分，豆瓣星级只填空分；
3. `type`、**最终生效的 `rate`**、`comment` 三者全等 → `unchanged`，不发请求；
4. 否则整条 upsert，载荷带 `private`。

> 第 3 步必须用「保留后的 rate」比对。若用传入的豆瓣评分，`Bangumi 8 分 / 豆瓣 6 分` 的条目会每轮都判为有差异、每轮重写，`unchanged` 永远不增长。
