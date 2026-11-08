# 五条同步链路

入口顺序固定为 ① → ② → ③ → ④ → ⑤。豆瓣 RSS 只抓取一次，①②③复用同一份归一化结果；①失败会跳过②③，④⑤独立执行。本文逐链路说明匹配、状态映射、写入字段与幂等规则。

| #   | 链路               | 触发范围                | 写入目标               |
| --- | ------------------ | ----------------------- | ---------------------- |
| ①   | 豆瓣 RSS → Notion  | 豆瓣 complete           | 新建 Notion 页面       |
| ②   | 豆瓣 RSS → NeoDB   | 豆瓣全部状态            | NeoDB 标记             |
| ③   | 豆瓣 RSS → Bangumi | 豆瓣全部状态            | Bangumi 收藏；可选进度 |
| ④   | Bangumi → NeoDB    | 配置允许的 Bangumi 分类 | NeoDB 标记；可选进度   |
| ⑤   | NeoDB → TMDB       | NeoDB movie/tv          | TMDB watchlist/评分    |

---

## NeoDB 标记时间策略（②④）

NeoDB 的请求字段仍叫 `created_time`，同步侧把这次写入的时间称为“标记时间”。② 与 ④ 各自使用：

```bash
SYNC_DOUBAN_NEODB_MARK_TIME_POLICY=status
SYNC_BANGUMI_NEODB_MARK_TIME_POLICY=status
```

可选值：

```text
status
initial-source
always-source
```

| 策略             | 新建标记 | 已有标记，状态相同 | 已有标记，状态变化 |
| ---------------- | -------- | ------------------ | ------------------ |
| `status`（默认） | 来源时间 | 目标时间           | 来源时间           |
| `initial-source` | 来源时间 | 目标时间           | 目标时间           |
| `always-source`  | 来源时间 | 来源时间           | 来源时间           |

来源时间：

- ② 豆瓣 RSS：`item.time`；
- ④ Bangumi：`collection.updated_at`。

“状态变化”以最终实际写入状态为准；④ 经过 `no-downgrade` 后如果仍保持 complete，就属于状态未变，保留目标时间。

### 适用场景

| 策略             | 适用场景                                                |
| ---------------- | ------------------------------------------------------- |
| `status`         | 默认；标记时间跟随收藏状态变化，评分/短评更新不重置时间 |
| `initial-source` | 已有标记时间不可变，只给新标记播种来源时间              |
| `always-source`  | 每次写入都对齐来源时间，适合重建或强制同步              |

### 边界

- 只改评分、只改短评、短评有↔无都不是状态变化；`status` / `initial-source` 下保留目标时间。
- 状态相同且目标时间缺失 → 不写、不回填。
- 来源时间缺失/非法 → 省略，不使用 `now()`。
- 发生写请求可能新增 NeoDB 历史更新记录，但 `created_time` 不一定变化。
- ②④ 同时写同一 NeoDB uuid 时，② 先执行、④ 后执行；最终时间由 ④ 的策略决定。

---

# ① 豆瓣 RSS → Notion

## 作用

把豆瓣 RSS 中**已看完**的条目登记到 Notion。只创建新页面，不更新已有页面。

## 流程

```text
读取归一化 RSS
  → 只保留 complete
  → 分类白名单过滤
  → 按豆瓣链接查重
  → 不存在：抓取豆瓣条目页 → 创建 Notion 页面
  → 已存在：跳过
```

## 匹配

- 不按标题匹配；
- 用 Notion `ITEM_LINK` 中的豆瓣条目 id 查重；
- 已存在页面不更新，避免覆盖用户在 Notion 的编辑。

## 字段

新页面写入：

- 标题；
- 豆瓣链接；
- 豆瓣 RSS 评分；
- 评分日期（RSS `time`，仅真实值才写）；
- 豆瓣短评；
- 条目页抓取的元数据、海报、封面等；
- 只提交目标 data source 实际存在的列。

状态只用于“只取 complete”的入口过滤，不写入 Notion 状态列；不写更新时间。

## 幂等与失败

- 以豆瓣链接是否存在判断，已存在即 `unchanged`；
- 没有 Notion token → 整条路径 `aborted`；
- 不删除、不更新 Notion 页面。

---

# ② 豆瓣 RSS → NeoDB

## 作用

把豆瓣 RSS 的书架状态、评分和短评同步到 NeoDB 已有目录条目。

## 流程

```text
分类白名单过滤
  → 豆瓣条目 URL 解析 NeoDB 目录
  → 读取当前用户标记
  → 不存在：创建标记
  → 存在：按 merge profile 合并
  → 有变化才写
```

## 匹配

```text
item.link（豆瓣 URL）
  → NeoDB /api/catalog/fetch
  → uuid
```

- 目录没有条目 → `unresolved`，不创建目录；
- 标记读取失败 → `failed`，不当作“未标记”覆盖。

## 状态映射

| 豆瓣状态 | NeoDB `shelf_type` |
| -------- | ------------------ |
| wishlist | `wishlist`         |
| progress | `progress`         |
| complete | `complete`         |

豆瓣 RSS 不表达 `dropped`。若 NeoDB 现有标记是 `dropped`，本链路跳过，不覆盖。

## 写入字段

| 字段           | 规则                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `shelf_type`   | 跟随豆瓣源状态；现有 `dropped` 除外                                                       |
| `rating_grade` | `SYNC_DOUBAN_NEODB_RATING`：默认 `neodb_prefer` 保留目标非 0 分；`overwrite` 才由源覆盖   |
| `comment_text` | `SYNC_DOUBAN_NEODB_COMMENT`：默认 `neodb_prefer` 保留目标非空短评；`overwrite` 才由源覆盖 |
| `visibility`   | 与配置的目标可见性比较，不一致才写                                                        |
| `created_time` | 按 `SYNC_DOUBAN_NEODB_MARK_TIME_POLICY`；见《NeoDB 标记时间策略》                         |

## 是否写入

先算“最终要写入的值”，评分和短评各看自己的开关：

```text
SYNC_DOUBAN_NEODB_RATING=neodb_prefer（默认）:
  目标已有非 0 分 → 保留目标分；否则用源评分
SYNC_DOUBAN_NEODB_RATING=overwrite:
  始终用源评分

SYNC_DOUBAN_NEODB_COMMENT=neodb_prefer（默认）:
  目标已有非空短评 → 保留；否则用源短评
SYNC_DOUBAN_NEODB_COMMENT=overwrite:
  始终用源短评
```

以下全部成立才 `unchanged`：

- `shelf_type` 相同；
- `writeRating` 与现有 `rating_grade` 相同；
- `writeComment` 与现有 `comment_text` 相同；
- 现有 `visibility` 与目标可见性相同。

`writeRating` / `writeComment` 是合并后的最终值，不是豆瓣原始值；目标已有非 0 分/非空短评时，源值不会触发写入。

## 不写入

- 不写进度；
- 不删除标记；
- 不创建 NeoDB 目录条目。

---

# ③ 豆瓣 RSS → Bangumi

## 作用

把豆瓣 RSS 的状态、评分、短评同步到 Bangumi；可选对 complete 条目补书籍/分集进度。

## 流程

```text
分类白名单过滤
  → 优先读 NeoDB 的 Bangumi 外链
  → 否则按分类搜索 Bangumi
  → 精确标题 + 年份匹配
  → 读取现有收藏
  → 合并状态/评分/短评
  → 可选：补 complete 进度
  → 有变化才写
```

## 匹配

按以下顺序执行，任一步命中即停止：

1. **用豆瓣链接查 NeoDB**
   - 以 `item.link` 调用 NeoDB catalog fetch；
   - 找到条目时读取其外部链接；
   - NeoDB 没有对应目录条目时，不创建目录，但仍继续标题搜索。

2. **NeoDB 的 Bangumi 外链优先**
   - NeoDB 条目带 Bangumi 外链时，直接采用该 subject id；
   - 不再进行标题搜索。

3. **没有 Bangumi 外链时，按标题搜索**
   - 第一轮关键词依次取：
     1. NeoDB `display_title`
     2. NeoDB `title`
     3. 豆瓣标题
   - 使用第一个非空值；
   - 按豆瓣分类限定 Bangumi `subject_type`：

   | 豆瓣分类 | Bangumi `subject_type` |
   | -------- | ---------------------- |
   | 电影     | `2` 动画 + `6` 真人    |
   | 书籍     | `1`                    |
   | 音乐     | `3`                    |
   | 游戏     | `4`                    |
   | 话剧     | 无对应类型，仅外链     |

4. **精确标题比较**
   - 候选的 `name` / `name_cn` 经 `trim().toLowerCase()` 后，必须与搜索标题完全相等；
   - 不做模糊匹配或包含匹配。

5. **动画/真人年份过滤**
   - 只对 `subject_type` 2/6 生效；
   - 双方年份可用且相差超过 1 年才拒绝；
   - 任一方缺年份时，不因年份拒绝。

6. **豆瓣标题回退**
   - 第一轮关键词来自 NeoDB，且与豆瓣标题不同：
     1. 先在已有搜索结果中，用豆瓣标题再做一次精确比较；
     2. 仍无结果，才用豆瓣标题发起第二次搜索；
     3. 对第二次结果再次做精确标题 + 年份筛选。

7. **全部失败**
   - `unresolved`，不猜、不跨类型、不按相似度写入。

## 状态映射

| 豆瓣状态 | Bangumi 收藏类型           |
| -------- | -------------------------- |
| wishlist | `1` 想看                   |
| complete | `2` 看过                   |
| progress | `3` 在看                   |
| dropped  | `5` 抛弃（RSS 通常不产生） |

Bangumi 已有 `4`（搁置）或 `5`（抛弃）时，豆瓣无法表达，保留且跳过覆盖。

## 写入字段

| 字段      | 规则                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `type`    | 跟随豆瓣映射；现有 4/5 保留                                                                               |
| `rate`    | `SYNC_DOUBAN_BANGUMI_RATING`：默认 `bangumi_prefer` 保留目标非 0 分；`overwrite` 才由豆瓣覆盖             |
| `comment` | `SYNC_DOUBAN_BANGUMI_COMMENT`：默认 `bangumi_prefer` 保留目标非空短评；`overwrite` 才由豆瓣覆盖（含空值） |
| `private` | 写入配置的 `BANGUMI_PRIVATE`                                                                              |
| 更新时间  | 不传时间字段；仅在实际写请求时由 Bangumi 服务端设置                                                       |

### rate 示例

豆瓣星级先按 `stars * 2` 换算成 0–10 分，再与 Bangumi 现有 `rate` 比较：

| Bangumi 现有 | 豆瓣评分 | 实际写入 | 说明                       |
| -----------: | -------: | -------: | -------------------------- |
|            8 |        6 |        8 | 目标非零分优先，豆瓣不覆盖 |
|            8 |  无（0） |        8 | 豆瓣无分不清空目标         |
|            0 |        6 |        6 | 目标为空，豆瓣填入         |
|            0 |  无（0） |        0 | 两边都没有有效评分         |
|            3 |        6 |        3 | 目标已有非零分，保留 3     |

`unchanged` 比较的是最终写入评分，不是豆瓣原始评分。默认 `bangumi_prefer` 下，Bangumi 已有非 0 分时最终写入评分就是该现有分；切到 `overwrite` 后才按豆瓣分覆盖。

### 是否写入

评分和短评各自先算“最终要写入的值”，再与现有值比较。

最终评分：

- `SYNC_DOUBAN_BANGUMI_RATING=bangumi_prefer`（默认）：
  - Bangumi 已有非 0 分 → 保留现有分；
  - Bangumi 为 0 分 → 用豆瓣换算分；
  - 豆瓣无分不会清空已有分。
- `SYNC_DOUBAN_BANGUMI_RATING=overwrite`：
  - 始终用豆瓣换算分，包括把目标改成 0。

最终短评：

- `SYNC_DOUBAN_BANGUMI_COMMENT=bangumi_prefer`（默认）：目标非空短评保留，只填空；
- `SYNC_DOUBAN_BANGUMI_COMMENT=overwrite`：始终用豆瓣短评，空值也会清空。

写入条件：

```text
状态不同
或 最终评分与现有评分不同
或 最终短评与现有短评不同
→ 写入

三者都相同 → unchanged
```

因此评分和短评互不影响开关：可以只覆盖评分、保留短评，也可以只覆盖短评、保留评分。

### 更新时间

③ 的写请求只发送 `type`、`rate`、`comment`、`private`，不发送时间字段：

- 本轮实际发出写请求时，Bangumi 服务端把 `updated_at` 设为该次请求的处理时间；
- 本轮 `unchanged`、不发请求时，`updated_at` 不变；
- 只改评分/短评也会更新服务端时间，不是只有状态变化才更新；
- 无法用豆瓣 RSS 时间指定、回填或比较 Bangumi 时间。

## 仅 complete 条目的进度同步（可选，默认关闭）

`SYNC_DOUBAN_BANGUMI_EPISODES=1` 时：

- **电影**：补第一个正片集；没有正片只写“看过”；
- **TV/动画/真人**：只补分集收藏中 `type != 2` 的正片；
- 对每个缺失集发送一次 HTTP PUT：
  `PUT /v0/users/-/collections/-/episodes/{episodeId}`，body `{ "type": 2 }`，表示标记为看过；
- 已经是 `type=2` 的集不发送请求，原有 `updated_at` 不变；
- 新增集由 Bangumi 服务端写入当前时间，客户端不能指定时间；
- SP 默认不处理；`SYNC_DOUBAN_BANGUMI_INCLUDE_SP=1` 才纳入 TV/动画/真人的 SP；电影永不自动处理 SP；
- **书籍**：`ep_status`/`vol_status` 都为 0 视为未知；只拉满已知维度到 `subject.eps`/`volumes`，另一维度不发送；总量缺失则跳过该维度；
- 条目“看过”不等于分集已打勾，始终以分集 `type=2` 判断。

### 判定口径

- `type=2` 指用户分集收藏状态为“看过”，不是 `episode.type=2`（OP）；
- 正片指 `episode.type=0`；电影只取第一个正片；SP 仅在 `SYNC_DOUBAN_BANGUMI_INCLUDE_SP=1` 时纳入 TV/动画/真人；OP/ED 永不纳入；
- 缺失按 `目标分集集合 - 已看集合` 计算，已看集合为用户分集收藏中 `type=2` 的 episode id；
- 不使用 `ep_status`、条目“看过”状态或总集数推断缺失；
- 因此已有 `type=2` 的分集不写，只对仍然缺失的目标分集发送 PUT。

示例：26 集正片，已看 1–14 集 → 目标 1–26，已看 1–14，待补 15–26。

## 不写入

- 不向 Bangumi 发送时间字段；
  - 实际发生写请求时，服务端会把该收藏的 `updated_at` 设为本次请求时间；
  - 本轮 `unchanged`、不发请求时，`updated_at` 不变；
- 书籍的进度通过在 `ep_status` / `vol_status` 写入；
- 电影和 TV 的进度在 `SYNC_DOUBAN_BANGUMI_EPISODES=1` 时通过分集收藏接口写入；
- 不处理 OP/ED；
- 不删除收藏。

---

# ④ Bangumi → NeoDB

## 作用

把 Bangumi 收藏的状态、评分、短评同步到 NeoDB；可选写进度。全量模式支持分页续跑。

## 流程

```text
读取 Bangumi 收藏
  → 分类白名单/平台闸门过滤
  → Bangumi URL 解析 NeoDB 条目
  → 同轮 uuid 冲突裁决
  → 读取 NeoDB 标记
  → 合并状态/评分/短评
  → 可选写进度
  → 有变化才写
```

## 分页游标（仅全量）

游标不是数据库游标，而是**全量分页的 offset 续跑位置**：

- 默认文件 `.cache/bangumi-neodb-full-sync.json`，可用 `BANGUMI_NEODB_FULL_SYNC_STATE` 覆盖；
- 结构：
  ```json
  {
    "version": 1,
    "updatedAt": "...",
    "offsets": { "mixed": 200, "2": 400 }
  }
  ```
- 键是“趟”：`mixed`，或按 `subject_type` 的 `1`/`2`/`4`/`6`；
- 值是下一页 `offset`；每页处理后写一次；一趟完成或空页时删除该键；
- 只有全量运行读取；常规运行每次从 0 开始；
- 中断后下一次全量从上次 offset 继续，最多重走一页；
- 游标不决定是否写入；写入仍逐条由 `mergeNeodbMark` 比较；
- 分页大小由 `BANGUMI_COLLECTION_LIMIT` 控制，默认 50，最大 50。

## 匹配

```text
Bangumi subject URL
  → NeoDB catalog fetch（直链 A）
  → 找带豆瓣外链的同名候选 B
  → 标题 + 年份筛选
  → NeoDB 媒体形态软裁决
  → 唯一候选才写
```

- 分类由 Bangumi `subject_type` 决定：
  - 1 书籍 → `book`
  - 2 动画 → `movie,tv`
  - 3 音乐 → `music`
  - 4 游戏 → `game`
  - 6 真人 → `movie,tv`
- **只允许 movie/tv 内部互搜；book/music/game 各自封闭，禁止跨大类**；
- 年份双方可用且相差超过 1 年 → 拒绝；任一侧缺失 → 不立即判断；
- 同名多候选先收集，不允许 first-hit；
- 最终用直链 A 的 NeoDB `category` / URL 判断媒体形态：
  - A 类型未知 → B 唯一即选 B；
  - A 与 B 同类型 → B 唯一即选 B；
  - A 与 B 不同类型 → 选 A；
  - B 有多个且无法唯一确定 → 记录 `ambiguous`，不使用 B，回退直链 A；
- 直链 A 由 Bangumi URL 解析，始终是可用目标；只有 A 本身无法解析时才记 `unresolved`；
- `ambiguous` 是诊断状态，不等于“整条不写”；
- Bangumi `subject_type` 只用于搜索分类，不能用来直接判断电影/TV；
- 直链 A 没有可用豆瓣孪生时，仍使用 A。

## 状态映射

| Bangumi | NeoDB `shelf_type` |
| ------- | ------------------ |
| 1 想看  | `wishlist`         |
| 2 看过  | `complete`         |
| 3 在看  | `progress`         |
| 4 搁置  | `progress`         |
| 5 抛弃  | `dropped`          |

## 写入字段

| 字段           | 规则                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| `shelf_type`   | 跟随 Bangumi；`no-downgrade` 时目标 complete 保持 complete                                 |
| `rating_grade` | `SYNC_BANGUMI_NEODB_RATING`：默认 `neodb_prefer` 保留目标非 0 分；`overwrite` 才用源分     |
| `comment_text` | `SYNC_BANGUMI_NEODB_COMMENT`：默认 `neodb_prefer` 保留目标非空短评；`overwrite` 才用源短评 |
| `visibility`   | 与 `NEODB_VISIBILITY` 比较，不一致才写                                                     |
| `created_time` | 按 `SYNC_BANGUMI_NEODB_MARK_TIME_POLICY`；见《NeoDB 标记时间策略》                         |
| 进度           | `SYNC_BANGUMI_NEODB_PROGRESS=1` 时写；0 不清空                                             |

### created_time

按 `SYNC_BANGUMI_NEODB_MARK_TIME_POLICY` 处理，具体规则见《NeoDB 标记时间策略》。

### 进度

| Bangumi 类型  | 来源                     | NeoDB 进度 | 约束           |
| ------------- | ------------------------ | ---------- | -------------- |
| 动画/真人 2/6 | `ep_status`              | `episode`  | 目标须为 tv    |
| 书籍 1        | `vol_status`/`ep_status` | `chapter`  | 目标须为 book  |
| 音乐 3        | `ep_status`              | `track`    | 目标须为 music |
| 游戏 4        | —                        | 不写       | —              |

0 值跳过，不清空已有进度；进度类型与目录不兼容时跳过。

## 同一 uuid 的冲突

本轮 ④ 内维护 `targetClaims`：

1. 同一 `subject_id` 再次出现 → 允许修正；
2. 不同 subject 命中同一 uuid：
   - 身份置信度：`direct > douban-twin > title-twin`；
   - 同置信度看状态：`complete > progress/wishlist > dropped`；
   - 仍相同则较小 `subject_id` 胜出；
3. 落败者记 `skipped-duplicate`，不写。

## 与 ② 同时写 NeoDB

② 先执行，④ 后执行；④ 的 `targetClaims` 不包含 ②。

| 字段         | ② 豆瓣                                  | ④ Bangumi                                | 最终结果                           |
| ------------ | --------------------------------------- | ---------------------------------------- | ---------------------------------- |
| 状态         | 豆瓣状态                                | Bangumi 状态 + 可选 guard                | ④ 后写；guard 可阻止 complete 降级 |
| 评分         | 按 `SYNC_DOUBAN_NEODB_RATING`           | 按 `SYNC_BANGUMI_NEODB_RATING`           | ④ 读取 ② 的结果后再合并            |
| 短评         | 同上                                    | 同上                                     | 同上                               |
| 可见性       | `NEODB_VISIBILITY`                      | 同                                       | 最后一次写按配置                   |
| created_time | 按 `SYNC_DOUBAN_NEODB_MARK_TIME_POLICY` | 按 `SYNC_BANGUMI_NEODB_MARK_TIME_POLICY` | ④ 后写，最终时间由 ④ 的策略决定    |

因此，②/④ 都启用时，最终状态通常由 ④ 决定；若只想让 Bangumi 作最终状态源，应关闭 ② 或接受 ④ 后写。

---

# ⑤ NeoDB → TMDB

## 作用

把 NeoDB 的 movie/tv 标记映射为 TMDB watchlist/评分。不写短评和时间。

## 流程

```text
遍历 NeoDB 书架/分类
  → 只保留 movie/tv
  → TMDB 外链 → IMDb → 精确标题+年份 → 季父剧
  → 读取 TMDB account states
  → 按字段 diff 写 watchlist/评分
```

## 匹配

```text
NeoDB TMDB 外链（类型必须一致）
  → IMDb（只接受同 movie/tv）
  → 精确标题 + 必需年份（默认 ±1 年）
  → TV 季：去季号父剧标题 + 年份
```

- 不按相似标题猜测；
- 标题必须精确一致；
- 缺年份 → 停止标题搜索，记 `no-neodb-year`；
- 年份读取失败 → `failed`；
- 外链年份漂移只告警；外链类型不一致拒绝。

## 状态映射

| NeoDB           | TMDB 操作                         |
| --------------- | --------------------------------- |
| wishlist        | 加入 watchlist                    |
| progress        | 加入 watchlist（TMDB 无在看）     |
| dropped         | 加入 watchlist（TMDB 无弃看）     |
| complete 有评分 | 写评分并移出 watchlist            |
| complete 无评分 | 加入 watchlist（TMDB 无已看标记） |

## 写入字段

| 字段        | 规则                                                              |
| ----------- | ----------------------------------------------------------------- |
| `watchlist` | 与当前状态比较；相同不写                                          |
| `rating`    | 默认 `tmdb_prefer` 保留 TMDB 非 0 评分；`overwrite` 才用 NeoDB 分 |
| 短评        | 不写；TMDB 无对应字段                                             |
| 时间        | 不写                                                              |

- 写前必须读到 account states；读取失败不写；
- 无评分时既不 POST 也不 DELETE，避免清掉手动评分；
- dry-run 只输出计划。

## 未匹配原因

⑤ 区分九种未匹配原因（`no-tmdb-match`、`no-neodb-year`、`no-neodb-year-fetch-failed`、`tmdb-link-type-mismatch`、`tmdb-link-fetch-failed`、`imdb-no-match`、`tmdb-search-empty`、`tmdb-ambiguous`、`tmdb-season-parent-missing`），**逐条含义与档位见 [`reference.md` 的 reason 总表](reference.md#reason-总表slug--链路--档位--日志形态)** —— 那里是全仓 reason 的唯一出处。

只有一条需要在这里强调：`no-neodb-year-fetch-failed` 计入 **`failed`** 而不是 `unresolved`，因为 TMDB 根本没被问到，重跑就能回答；把它记成「没有对应条目」会让报表说谎。

确认 TMDB 缺失的条目可进 `data/tmdb-known-absent.json`，命中后转 `tmdb-known-absent` skipped（文件格式见 [`reference.md`](reference.md)）。
