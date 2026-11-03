# 五条同步链路

本页描述 `src/paths/` 与 `src/rules/` 当前实现的链路顺序、匹配方式和状态映射。

## 链路总览

| 链路 | 来源与目标         | 条目匹配                                                  | 写入内容                                     |
| ---- | ------------------ | --------------------------------------------------------- | -------------------------------------------- |
| ①    | 豆瓣 RSS → Notion  | 以豆瓣条目链接查重；按分类读取一次数据源列                | 新建 Notion 页面                             |
| ②    | 豆瓣 RSS → NeoDB   | 使用豆瓣外链调用 NeoDB 目录解析                           | 书架状态、评分、短评、可见性和有效的来源时间 |
| ③    | 豆瓣 RSS → Bangumi | 优先使用 NeoDB 中的 Bangumi 外链；否则按分类精确标题搜索  | 收藏状态、评分、短评和隐私设置               |
| ④    | Bangumi → NeoDB    | 解析 Bangumi URL；必要时选择带豆瓣外链的 NeoDB 同作品条目 | 书架状态、评分、短评；可选进度               |
| ⑤    | NeoDB 书架 → TMDB  | TMDB 外链、IMDb ID、精确标题与年份依次匹配                | 评分和 watchlist                             |

## ① 豆瓣 RSS → Notion

RSS 标题中的状态前缀与条目链接共同确定分类和状态；RSS 正文解析评分、短评等字段。现有 Notion 页面按条目链接分批查重。每个分类只读取一次目标数据源结构，创建页面时只提交真实存在的列。

## ② 豆瓣 RSS → NeoDB

通过豆瓣条目链接调用 NeoDB 目录解析，再读取该条目当前书架标记。标记不存在时创建；存在时先按 `SYNC_DOUBAN_NEODB_MERGE` 合并评分和短评，默认 `neodb_prefer` 保留已有非空值。豆瓣 RSS 无法表达的 NeoDB 状态不会被覆盖。本链路不写进度。

## ③ 豆瓣 RSS → Bangumi

先从 NeoDB 条目的外链取 Bangumi subject ID。没有外链时，按豆瓣分类限定 Bangumi subject 类型，再对标题做精确比较；电影可能匹配动画或真人类型。只有动画/真人类型使用年份软过滤，双方年份都可用时容差为一年；年份缺失不会单独拒绝候选。话剧没有 Bangumi 分类，只能通过 NeoDB 上已有的 Bangumi 外链继续。

状态与评分处理：

| 豆瓣来源             | Bangumi 收藏类型 |
| -------------------- | ---------------- |
| 想看/想读等 wishlist | 1 wish           |
| 看过/读过等 complete | 2 done           |
| 在看/在读等 progress | 3 doing          |

豆瓣无法表达的 Bangumi `on-hold` 与 `dropped` 会保留。Bangumi 已有非零评分时，豆瓣评分不会覆盖它；无评分的豆瓣条目也不会清除现有分数。

## ④ Bangumi → NeoDB

先按 Bangumi subject URL 解析 NeoDB 条目。若该条目链接到另一个豆瓣条目，优先选取豆瓣侧的 NeoDB 孪生记录；否则使用 Bangumi 标题在 `subject_type` 对应的 NeoDB 分类中搜索精确标题，**禁止跨分类回退**。已知年份双方相差超过一年时拒绝该候选；年份缺失不作为拒绝依据。

多个 Bangumi subject 指向同一 NeoDB uuid 时，先比较身份来源置信度：直链高于豆瓣孪生，高于仅标题匹配；置信度相同时再按状态优先级和 subject ID 稳定裁决。低优先级冲突会被记录为跳过，不再覆盖高优先级结果。

Bangumi 收藏类型映射如下：

| Bangumi 类型 | NeoDB 状态                     |
| ------------ | ------------------------------ |
| 1 wish       | wishlist                       |
| 2 done       | complete                       |
| 3 doing      | progress                       |
| 4 on-hold    | progress（NeoDB 没有 on-hold） |
| 5 dropped    | dropped                        |

当 `SYNC_BANGUMI_NEODB_PROGRESS=1` 时，进度按 Bangumi subject 类型映射：

| Bangumi 类型     | 来源字段                       | NeoDB 进度 | 限制                     |
| ---------------- | ------------------------------ | ---------- | ------------------------ |
| 动画/真人（2/6） | `ep_status`                    | `episode`  | 目标 NeoDB 分类必须为 tv |
| 书籍（1）        | `vol_status`，否则 `ep_status` | `chapter`  | 目标分类必须为 book      |
| 音乐（3）        | `ep_status`                    | `track`    | 目标分类必须为 music     |
| 游戏（4）        | —                              | 不写       | 没有进度映射             |

零值不会清除 NeoDB 已有进度。日期默认保留 NeoDB 原日期；`target`、`source`、`source-newer` 三种模式由 `SYNC_BANGUMI_NEODB_CREATED_TIME` 控制。

## ⑤ NeoDB 书架 → TMDB

只映射 NeoDB 的 movie 和 tv；其他分类在发起 TMDB 请求前跳过。条目匹配按以下顺序进行：

```text
NeoDB TMDB 外链（媒体类型必须一致）
    ↓ 无有效目标
IMDb ID（仅接受相同 movie/tv 类型）
    ↓ 未命中
精确标题 + 必需的年份（默认容差 ±1 年）
    ↓ tv 条目像某一季且未命中
去掉季信息的父剧标题 + 年份
```

标题搜索要求候选具有日期且规范化标题完全一致。NeoDB 书架载荷没有年份时，代码会读取条目详情并缓存年份；读不到年份或读取失败时停止该级匹配，不退化为仅按标题写入。TMDB 外链若年份相差较大只告警；外链仍被采信，但媒体类型不一致时会被拒绝。

NeoDB 状态到 TMDB 操作：

| NeoDB 状态        | TMDB 操作                           |
| ----------------- | ----------------------------------- |
| wishlist          | 加入 watchlist                      |
| progress          | 加入 watchlist（TMDB 没有在看状态） |
| dropped           | 加入 watchlist（TMDB 没有弃看状态） |
| complete 且有评分 | 写入评分并移出 watchlist            |
| complete 且无评分 | 加入 watchlist（TMDB 没有已看标记） |

默认 `SYNC_RATING_PROFILE=tmdb_prefer` 保留 TMDB 已有评分；`overwrite` 才以 NeoDB 评分覆盖。写入前先读取 TMDB account states；读取失败不会被当作空状态，也不会继续写入。dry-run 只输出计划，不写 TMDB。

## 未匹配与错误分类

未匹配条目会带上原因写入报告或待核对名单。

④ 的 `neodb-unresolved-404` 表示 NeoDB 目录确实没有该条目；`neodb-unresolved` 表示 202 重试耗尽、429、5xx 或超时等临时失败。两者日志文案相同，区别通过 `sync-report` 传递。

⑤ 的原因：

| 原因                         | 含义                               |
| ---------------------------- | ---------------------------------- |
| `no-tmdb-match`              | 已执行匹配但仍未找到               |
| `no-neodb-year`              | NeoDB 条目没有可用于标题匹配的年份 |
| `no-neodb-year-fetch-failed` | 读取 NeoDB 条目年份失败            |
| `tmdb-link-type-mismatch`    | TMDB 外链媒体类型与条目分类不一致  |
| `tmdb-link-fetch-failed`     | 外链存在但取不到对应 TMDB 条目     |
| `imdb-no-match`              | IMDb ID 没有同 movie/tv 类型结果   |
| `tmdb-search-empty`          | 所有标题候选都没有搜索结果         |
| `tmdb-ambiguous`             | 有结果但没有精确标题/年份命中      |
| `tmdb-season-parent-missing` | TV 季标题去季号后仍无法匹配父剧    |

确认 TMDB 缺失的条目可加入 `data/tmdb-known-absent.json`；命中后记为 `tmdb-known-absent` 的 skipped，不再重复标题搜索，但外链/IMDb 仍优先尝试。读取故障不会伪装成“没有对应条目”。
