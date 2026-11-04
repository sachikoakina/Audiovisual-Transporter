# 五条同步链路

本文按实际代码描述执行顺序、匹配方式、状态映射、写入字段与幂等规则；入口顺序以 `src/index.ts` 为准。

## 总览

| #   | 链路               | 读取                                 | 写入                             | 触发范围                |
| --- | ------------------ | ------------------------------------ | -------------------------------- | ----------------------- |
| ①   | 豆瓣 RSS → Notion  | 豆瓣 RSS（仅 complete）+ 条目页      | 新建 Notion 页面                 | 豆瓣 `complete`         |
| ②   | 豆瓣 RSS → NeoDB   | 豆瓣 RSS + NeoDB 目录/标记           | NeoDB 书架标记                   | 豆瓣全部状态            |
| ③   | 豆瓣 RSS → Bangumi | 豆瓣 RSS + NeoDB 外链 + Bangumi 搜索 | Bangumi 收藏/评分/短评；可选进度 | 豆瓣全部状态            |
| ④   | Bangumi → NeoDB    | Bangumi 收藏 + NeoDB 目录/标记       | NeoDB 标记/进度                  | 配置允许的 Bangumi 分类 |
| ⑤   | NeoDB → TMDB       | NeoDB 书架 + TMDB 搜索/状态          | TMDB watchlist/评分              | NeoDB movie/tv          |

执行顺序固定为 ① → ② → ③ → ④ → ⑤。豆瓣 RSS 只抓取一次，①②③复用；①失败会跳过②③，④⑤仍独立执行。

---

## ① 豆瓣 RSS → Notion

### 执行顺序

1. `src/index.ts` 从归一化 feed 中只取 `status=complete`；
2. 按分类白名单过滤；
3. 按分类读取 Notion data source 的列结构；
4. 按豆瓣链接批量查重；
5. 仅对不存在的页面抓取豆瓣条目页并创建。

### 匹配

- 不按标题匹配；
- 用 Notion `ITEM_LINK` 的 URL 包含豆瓣条目 id 查询；
- 已存在页面直接跳过，**不更新**；
- 没有 token 时整条路径 `aborted`。

### 状态与字段

- 状态只用于入口过滤（只处理 complete），不写入 Notion 状态列；
- 新页面写入：
  - 标题；
  - 豆瓣链接；
  - 豆瓣 RSS 评分；
  - 评分日期（来自 RSS `time`，仅真实值才写）；
  - 豆瓣短评；
  - 条目页抓取的元数据/海报/封面等；
  - 只提交目标 data source 实际存在的列；
- 不写入更新时间；Notion 页面创建时间由 Notion 维护。

### 幂等

- 以豆瓣链接是否存在判断；
- 已存在即 `unchanged`，不覆盖用户后续在 Notion 的编辑。

---

## ② 豆瓣 RSS → NeoDB

### 执行顺序

1. 按分类白名单过滤豆瓣 feed；
2. 用豆瓣条目 URL 调 NeoDB catalog resolve；
3. 读取当前用户在该 uuid 上的标记；
4. 不存在则创建；存在则按 merge profile 合并；
5. 只有字段真正变化才写。

### 匹配

```text
item.link（豆瓣条目 URL）
  → NeoDB /api/catalog/fetch
  → uuid
```

- 目录没有对应条目 → `unresolved`，不创建目录；
- 读取标记失败 → 条目 `failed`，不当作“未标记”覆盖。

### 状态映射

豆瓣 RSS 可表达：

| 豆瓣状态                        | NeoDB `shelf_type` |
| ------------------------------- | ------------------ |
| wishlist（想看/想读/想听/想玩） | `wishlist`         |
| progress（在看/在读/在听/在玩） | `progress`         |
| complete（看过/读过/听过/玩过） | `complete`         |

`dropped` 不是豆瓣 RSS 可表达状态。若 NeoDB 现有标记是 `dropped`，本链路跳过，不覆盖。

### 更新策略

| 字段           | 规则                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `shelf_type`   | 始终跟随豆瓣源状态（除现有 `dropped` 跳过）                                                                  |
| `rating_grade` | `SYNC_DOUBAN_NEODB_MERGE=neodb_prefer`（默认）：目标已有非 0 分则保留；否则填豆瓣分。`overwrite`：豆瓣分覆盖 |
| `comment_text` | 同上：默认保留目标非空短评；`overwrite` 用豆瓣短评                                                           |
| `visibility`   | 与配置的 `NEODB_VISIBILITY` 比较；不一致才写                                                                 |
| `created_time` | 新建和更新都传豆瓣 RSS `time`；这可能重置 NeoDB 标记日期                                                     |

### 是否写入

同时满足以下条件才 `unchanged`、不发请求：

- `shelf_type` 相同；
- 生效后的 `rating_grade` 相同；
- 生效后的 `comment_text` 相同；
- 现有 `visibility` 与目标可见性相同。

### 不写入

- 不写进度；
- 不删除标记；
- 不创建 NeoDB 目录条目。

---

## ③ 豆瓣 RSS → Bangumi

### 执行顺序

1. 按分类白名单过滤；
2. 优先从 NeoDB 条目的外链取 Bangumi subject id；
3. 没有外链时按分类搜索 Bangumi，精确标题匹配；
4. 读取现有 Bangumi 收藏；
5. 合并评分/短评/状态；
6. 可选：对 complete 条目补书籍/分集进度。

### 匹配

按以下顺序执行，任一步命中即停止：

1. **NeoDB 外链**
   - 如果 NeoDB 条目带 Bangumi 外链，直接使用该 subject id，不再搜索。

2. **确定第一轮搜索标题**
   - 依次取 NeoDB `display_title` → NeoDB `title` → 豆瓣标题；
   - 用第一个非空值作为关键词。

3. **按分类限定 Bangumi 类型**

   | 豆瓣分类 | 搜索的 Bangumi `subject_type` |
   | -------- | ----------------------------- |
   | 电影     | `2` 动画 + `6` 真人           |
   | 书籍     | `1`                           |
   | 音乐     | `3`                           |
   | 游戏     | `4`                           |
   | 话剧     | 无对应类型，只能靠 NeoDB 外链 |

4. **精确标题比较**
   - 候选的 `name` / `name_cn` 经 `trim().toLowerCase()` 后，必须与搜索标题完全相等；
   - 不做模糊、包含或相似度匹配。

5. **动画/真人年份过滤**
   - 只对 `subject_type` 2/6 生效；
   - 双方年份都可用且相差超过 1 年才拒绝；
   - 任一方缺年份 → 不因年份拒绝。

6. **豆瓣标题回退**
   - 如果第一轮关键词来自 NeoDB，且与豆瓣标题不同：
     1. 先在**同一批搜索结果**中按豆瓣标题再做一次精确比较；
     2. 仍没有，才用豆瓣标题发起第二次搜索，并再次精确比较。

7. 全部失败 → `unresolved`，不猜、不跨类型、不按相似度写入。

### 状态映射

| 豆瓣状态 | Bangumi 收藏类型           |
| -------- | -------------------------- |
| wishlist | `1` 想看                   |
| complete | `2` 看过                   |
| progress | `3` 在看                   |
| dropped  | `5` 抛弃（RSS 通常不产生） |

Bangumi 已有 `4`（搁置）或 `5`（抛弃）时，豆瓣无法表达，**保留并跳过覆盖**。

### 更新策略

| 字段      | 规则                                                          |
| --------- | ------------------------------------------------------------- |
| `type`    | 跟随豆瓣映射；现有 4/5 保留                                   |
| `rate`    | **Bangumi 已有非 0 分优先**；豆瓣分只填 0。不会把已有评分清零 |
| `comment` | 豆瓣短评覆盖现有短评；空短评也会写空                          |
| `private` | 写入配置的 `BANGUMI_PRIVATE`                                  |
| 更新时间  | 不传时间字段；仅在实际写请求时由 Bangumi 服务端设置           |

### rate 示例

豆瓣星级先按 `stars * 2` 换算成 0–10 分，再与 Bangumi 现有 `rate` 比较：

| Bangumi 现有 | 豆瓣评分 | 实际写入 | 说明                       |
| -----------: | -------: | -------: | -------------------------- |
|            8 |        6 |        8 | 目标非零分优先，豆瓣不覆盖 |
|            8 |  无（0） |        8 | 豆瓣无分不清空目标         |
|            0 |        6 |        6 | 目标为空，豆瓣填入         |
|            0 |  无（0） |        0 | 两边都没有有效评分         |
|            8 |        8 |        8 | 相同，评分维度 unchanged   |
|            3 |        6 |        3 | 目标已有非零分，保留 3     |

`unchanged` 用**合并后的有效 rate** 比较，不是豆瓣原始 rate；因此“Bangumi 8、豆瓣 6”不会每轮都触发写入。

### 是否写入

`type`、生效后的 `rate`、`comment` 全部相同 → `unchanged`，不发请求。

### 更新时间

③ 的写请求只发送 `type`、`rate`、`comment`、`private`，**不发送任何时间字段**。

- 本轮确实发出写请求时，Bangumi 服务端把该收藏的 `updated_at` 设为该次请求的处理时间；
- 本轮 `unchanged`、不发请求时，`updated_at` 不变；
- 因此“只改评分/短评”也会更新服务端时间，不是只有状态变化才更新；
- 无法用豆瓣 RSS 时间指定、回填或比较 Bangumi 时间；若想保留 Bangumi 原时间，只能避免写入。

### 仅 complete 条目的进度同步（可选，默认关闭）

`SYNC_DOUBAN_BANGUMI_EPISODES=1` 时，只对豆瓣 `complete` 条目补进度：

- 电影：补第一个正片集；没有正片只写“看过”；
- TV/动画/真人：只补分集收藏中 `type != 2` 的正片；
- 对每个缺失集发送一次 HTTP PUT：
  `PUT /v0/users/-/collections/-/episodes/{episodeId}`，body 为 `{ "type": 2 }`，表示标记该集为看过；
- 已经是 `type=2` 的集**不发送请求**，因此原有 `updated_at` 不变；
- 新增集由 Bangumi 服务端写入当前时间，客户端不能指定时间；
- SP 默认不处理；`SYNC_DOUBAN_BANGUMI_INCLUDE_SP=1` 才纳入 TV/动画/真人的 SP；电影永不自动处理 SP；
- 书籍：`ep_status`/`vol_status` 都为 0 视为未知；只拉满已知维度到 `subject.eps`/`volumes`，另一维度不发送；总量缺失则跳过该维度；
- 条目“看过”不等于分集已打勾，始终以分集 `type=2` 判断。

---

## ④ Bangumi → NeoDB

### 执行顺序

1. 读取 Bangumi 用户收藏（可全量分页/游标）；
2. 按分类白名单、漫画平台闸门过滤；
3. 解析 Bangumi URL → NeoDB 条目；
4. 同轮 uuid 认领冲突裁决；
5. 读取 NeoDB 标记；
6. 合并状态/评分/短评；
7. 可选写进度。

### 匹配

```text
Bangumi subject URL
  → NeoDB catalog fetch
  → 若条目带豆瓣外链，优先豆瓣孪生
  → 否则同分类精确标题 + 年份
```

- 分类由 Bangumi `subject_type` 决定：
  - 1 书籍 → `book`
  - 2 动画 → `anime`
  - 3 音乐 → `music`
  - 4 游戏 → `game`
  - 6 真人 → `movie,tv`
- **禁止跨分类回退**；书籍不再按同名命中电影/TV；
- 年份双方可用且相差超过 1 年 → 拒绝；
- 直链 > 豆瓣孪生 > 仅标题匹配。

### 状态映射

| Bangumi 类型 | NeoDB `shelf_type` |
| ------------ | ------------------ |
| 1 想看       | `wishlist`         |
| 2 看过       | `complete`         |
| 3 在看       | `progress`         |
| 4 搁置       | `progress`         |
| 5 抛弃       | `dropped`          |

### 更新策略

| 字段           | 规则                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `shelf_type`   | 跟随 Bangumi；`SYNC_BANGUMI_NEODB_STATUS_GUARD=no-downgrade` 时，目标已 complete 则保持 complete |
| `rating_grade` | 默认 `neodb_prefer`：目标已有非 0 分保留；`overwrite` 才用 Bangumi 评分                          |
| `comment_text` | 默认保留目标非空短评；`overwrite` 才用 Bangumi 短评                                              |
| `visibility`   | 与 `NEODB_VISIBILITY` 比较，不一致才写                                                           |
| `created_time` | 见下                                                                                             |
| 进度           | `SYNC_BANGUMI_NEODB_PROGRESS=1` 时写；0 不清空                                                   |

### created_time

`SYNC_BANGUMI_NEODB_CREATED_TIME`：

| 值               | 新建                              | 更新                              |
| ---------------- | --------------------------------- | --------------------------------- |
| `target`（默认） | 用 Bangumi `updated_at`（合法时） | 省略，保留 NeoDB 原日期           |
| `source`         | 用 Bangumi `updated_at`           | 用 Bangumi `updated_at`，允许倒退 |
| `source-newer`   | 用 Bangumi `updated_at`           | 仅当 Bangumi 时间更晚才覆盖       |

缺失/非法源时间 → 省略，不写 `now()`。

### 进度

| Bangumi 类型     | 来源                           | NeoDB 进度               |
| ---------------- | ------------------------------ | ------------------------ |
| 动画/真人（2/6） | `ep_status`                    | `episode`，目标须为 tv   |
| 书籍（1）        | `vol_status`，否则 `ep_status` | `chapter`，目标须为 book |
| 音乐（3）        | `ep_status`                    | `track`，目标须为 music  |
| 游戏（4）        | —                              | 不写                     |

- 0 值跳过，不清空已有进度；
- 进度类型与 NeoDB 目录 category 不兼容时跳过；
- 进度写入成功也算 `written`，即使标记本身 unchanged。

### 同一 uuid 的冲突

`targetClaims` 只在本轮 ④ 内生效：

1. 同一 `subject_id` 再次出现 → 允许修正；
2. 不同 subject 命中同一 uuid：
   - 身份置信度：`direct > douban-twin > title-twin`；
   - 同置信度看状态：`complete > progress/wishlist > dropped`；
   - 仍相同则较小 `subject_id` 胜出；
3. 落败者记 `skipped-duplicate`，不写。

---

## ② 与 ④ 同时写 NeoDB 的冲突

两条链路都会写同一个 NeoDB uuid，但**不是同一套冲突裁决**：

- ② 按豆瓣链接命中目录，逐条写；
- ④ 按 Bangumi 收藏解析，另有自己的单轮 `targetClaims`；
- 入口顺序是 ② → ④，所以同一条目若两边都启用，**④ 最后写**，最终状态通常由 ④ 决定（受 `no-downgrade` 影响）。

字段层面的结果：

| 字段     | ② 豆瓣                    | ④ Bangumi                  | 最终结果                                                   |
| -------- | ------------------------- | -------------------------- | ---------------------------------------------------------- |
| 状态     | 豆瓣状态                  | Bangumi 状态 + 可选 guard  | ④ 最后写；guard 开启时 complete 不被降级                   |
| 评分     | `SYNC_DOUBAN_NEODB_MERGE` | `SYNC_BANGUMI_NEODB_MERGE` | ④ 读取 ② 写后的值，再按自己的 profile 合并                 |
| 短评     | 同上                      | 同上                       | 同上                                                       |
| 可见性   | `NEODB_VISIBILITY`        | 同                         | 最后一次写按配置                                           |
| 创建时间 | 总是豆瓣 `time`           | `created_time` 模式        | 默认 ④ 不覆盖 ② 写入的时间；`source`/`source-newer` 可能改 |

注意：

- ④ 的 `targetClaims` **不包含 ②**；它只处理 ④ 内部多个 Bangumi subject 的冲突；
- ② 不参与“直链/孪生/标题”置信度比较；
- ② 遇到 NeoDB 现有 `dropped` 会跳过；④ 可以写入 `dropped`；
- ② 不写进度，④ 可选写进度；
- 若只想让 Bangumi 作为最终状态源，应关闭 ② 或接受 ④ 后写。

---

## ⑤ NeoDB → TMDB

### 执行顺序

1. 遍历配置的 NeoDB 书架/分类；
2. 只保留 movie/tv；其他分类在发请求前跳过；
3. 按 TMDB 外链 → IMDb → 精确标题+年份 → 季父剧匹配；
4. 读取 TMDB account states；
5. 按字段 diff 写 watchlist/评分。

### 匹配

```text
NeoDB TMDB 外链（媒体类型必须一致）
  ↓ 无
IMDb ID（只接受相同 movie/tv）
  ↓ 无
精确标题 + 必需年份（默认 ±1 年）
  ↓ TV 季未命中
去掉季号的父剧标题 + 年份
```

- 不按相似标题猜测；
- 标题必须规范化后完全一致；
- 缺年份 → 停止标题搜索，记 `no-neodb-year`；
- 年份读取失败 → `failed`，不是 `unresolved`；
- 外链年份漂移只告警，外链仍采信；类型不一致拒绝外链。

### 状态映射

| NeoDB           | TMDB 操作                               |
| --------------- | --------------------------------------- |
| wishlist        | 加入 watchlist                          |
| progress        | 加入 watchlist（TMDB 无在看）           |
| dropped         | 加入 watchlist（TMDB 无弃看；评分不动） |
| complete 有评分 | 写评分并移出 watchlist                  |
| complete 无评分 | 加入 watchlist（TMDB 无已看标记）       |

### 更新策略

| 字段          | 规则                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `watchlist`   | 与当前状态比较；相同不写                                                                 |
| `rating`      | `SYNC_RATING_PROFILE=tmdb_prefer`（默认）保留 TMDB 已有评分；`overwrite` 才用 NeoDB 评分 |
| 短评          | 不写；TMDB 没有对应字段                                                                  |
| 创建/更新时间 | 不写                                                                                     |

- 写前必须读到 account states；读取失败不写；
- 无评分时既不 POST 也不 DELETE，避免清掉手动评分；
- `shouldWrite=false` 时零请求；
- dry-run 只输出计划。

### 未匹配原因

| 原因                         | 含义                        |
| ---------------------------- | --------------------------- |
| `no-tmdb-match`              | 匹配执行过但未找到          |
| `no-neodb-year`              | 缺年份，标题搜索未执行      |
| `no-neodb-year-fetch-failed` | 年份读取失败，计 failed     |
| `tmdb-link-type-mismatch`    | 外链媒体类型不符            |
| `tmdb-link-fetch-failed`     | 外链取不到目标              |
| `imdb-no-match`              | IMDb 无同类型结果           |
| `tmdb-search-empty`          | 所有标题候选无结果          |
| `tmdb-ambiguous`             | 有候选但无精确标题/年份命中 |
| `tmdb-season-parent-missing` | 季条目无法得到父剧标题      |

确认 TMDB 缺失的条目可进 `data/tmdb-known-absent.json`，命中后转 `tmdb-known-absent` skipped。
