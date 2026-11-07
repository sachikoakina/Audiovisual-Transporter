# 配置说明

本文按“总开关 → 共享豆瓣 → 五条链路 → 输出与待核对”组织。所有变量都可通过 `.env`、进程环境或 GitHub Actions Variables/Secrets 传入；代码默认值以 `src/sync-config.ts` 为准。

开关类变量接受 `1/true/on/yes` 为开启，`0/false/off/no` 为关闭（大小写不敏感）。未设置时使用下表的默认值。

---

## 一、总开关

| 变量                      | 默认 | 作用                                                              |
| ------------------------- | ---- | ----------------------------------------------------------------- |
| `SYNC_DOUBAN_NOTION`      | `0`  | 豆瓣 RSS → Notion；默认关闭                                       |
| `SYNC_DOUBAN_NEODB`       | `1`  | 豆瓣 RSS → NeoDB；默认开启                                        |
| `SYNC_DOUBAN_BANGUMI`     | `1`  | 豆瓣 RSS → Bangumi；默认开启                                      |
| `SYNC_BANGUMI_NEODB`      | `1`  | Bangumi → NeoDB；默认开启                                         |
| `SYNC_NEODB_TMDB`         | `0`  | NeoDB → TMDB；默认关闭                                            |
| `SYNC_DOUBAN_REQUIRED`    | `1`  | 豆瓣 RSS 失败是否让整轮失败；`0` 只标记 `TOLERATED`，不影响退出码 |
| `SYNC_DRY_RUN`            | `0`  | 仅 ⑤：只计算并打印计划，不写 TMDB                                 |
| `BANGUMI_NEODB_FULL_SYNC` | `0`  | 仅 ④：遍历 Bangumi 全部收藏页                                     |
| `NEODB_TMDB_FULL_SYNC`    | `0`  | 仅 ⑤：取消条数/页数上限，并关闭本次增量跳过                       |

说明：

- 总开关关闭时，对应链路完全不执行；
- `SYNC_DRY_RUN` 不作用于 ①②③④；
- 两个 full 开关是“本次运行”语义，不应长期写入 `.env`；
- `SYNC_MAX_ITEMS=0`、`NEODB_MAX_PAGES=0` 不是“无限”，低于最小值会回落到默认值。

---

## 二、共享豆瓣配置

①②③都需要。

| 变量                    | 默认      | 说明                                        |
| ----------------------- | --------- | ------------------------------------------- |
| `DOUBAN_USER_ID`        | 空        | 豆瓣数字用户 id；未设置时豆瓣 RSS 无法抓取  |
| `DOUBAN_RSS_USER_AGENT` | 浏览器 UA | RSS 与豆瓣条目页共用；豆瓣 WAF 变化时可覆盖 |
| `SYNC_DOUBAN_REQUIRED`  | `1`       | 见总开关；`0` 仅容忍豆瓣 RSS 失败           |

---

## 三、① 豆瓣 RSS → Notion

### 3.1 专属开关

| 变量                            | 默认       | 说明                                    |
| ------------------------------- | ---------- | --------------------------------------- |
| `SYNC_DOUBAN_NOTION`            | `0`        | 总开关                                  |
| `SYNC_DOUBAN_NOTION_CATEGORIES` | 空（全部） | 逗号分隔；`movie,music,book,game,drama` |

### 3.2 凭据

| 变量                       | 必填       | 说明                                               |
| -------------------------- | ---------- | -------------------------------------------------- |
| `NOTION_TOKEN`             | 是         | Notion Integration Token；缺失时整条路径 `aborted` |
| `NOTION_MOVIE_DATABASE_ID` | 分类启用时 | 电影目标 data source                               |
| `NOTION_MUSIC_DATABASE_ID` | 分类启用时 | 音乐目标 data source                               |
| `NOTION_BOOK_DATABASE_ID`  | 分类启用时 | 书籍目标 data source                               |
| `NOTION_GAME_DATABASE_ID`  | 分类启用时 | 游戏目标 data source                               |
| `NOTION_DRAMA_DATABASE_ID` | 分类启用时 | 话剧目标 data source                               |

### 3.3 行为

- 只处理豆瓣 `complete`；
- 按豆瓣链接查重，已存在页面不更新；
- 只创建新页面，不删除、不更新；
- 只写入目标 data source 实际存在的列；
- 缺失对应分类 DB ID 时，该分类无法创建页面。

---

## 四、② 豆瓣 RSS → NeoDB

### 4.1 专属开关

| 变量                           | 默认           | 说明                                       |
| ------------------------------ | -------------- | ------------------------------------------ |
| `SYNC_DOUBAN_NEODB`            | `1`            | 总开关                                     |
| `SYNC_DOUBAN_NEODB_CATEGORIES` | 空（全部）     | `movie,music,book,game,drama`              |
| `SYNC_DOUBAN_NEODB_RATING`     | `neodb_prefer` | 评分策略：目标非 0 分优先，或 `overwrite`  |
| `SYNC_DOUBAN_NEODB_COMMENT`    | `neodb_prefer` | 短评策略：目标非空短评优先，或 `overwrite` |

`neodb_prefer`：保留目标非 0 分/非空短评，源值只填空；`overwrite`：对应字段由源覆盖。评分和短评开关彼此独立。

### 4.2 共享 NeoDB 凭据与网络

| 变量                     | 默认                   | 说明                                                           |
| ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `NEODB_API_TOKEN`        | 空                     | 读写 NeoDB 必需                                                |
| `NEODB_VISIBILITY`       | `2`                    | 写入可见性：`0` 公开、`1` 仅关注者、`2` 私密；非法值回落到 `2` |
| `NEODB_BASE_URL`         | `https://neodb.social` | 自建实例地址                                                   |
| `NEODB_REQUEST_DELAY_MS` | `300`                  | 书架请求间隔（毫秒）                                           |

### 4.3 行为

- 用豆瓣条目 URL 解析 NeoDB 目录；
- 目录不存在 → `unresolved`，不创建目录；
- 现有 NeoDB `dropped` 不被豆瓣覆盖；
- 更新时 `created_time` 仍传豆瓣 RSS `time`，可能改变标记日期；
- 不写进度。

---

## 五、③ 豆瓣 RSS → Bangumi

### 5.1 专属开关

| 变量                             | 默认             | 说明                                                 |
| -------------------------------- | ---------------- | ---------------------------------------------------- |
| `SYNC_DOUBAN_BANGUMI`            | `1`              | 总开关                                               |
| `SYNC_DOUBAN_BANGUMI_CATEGORIES` | 空（全部）       | `movie,music,book,game,drama`                        |
| `SYNC_DOUBAN_BANGUMI_EPISODES`   | `0`              | 仅 complete 条目：补 Bangumi 分集/书籍进度           |
| `SYNC_DOUBAN_BANGUMI_INCLUDE_SP` | `0`              | 是否把 TV/动画/真人的 SP 也纳入补点；电影永不处理 SP |
| `SYNC_DOUBAN_BANGUMI_RATING`     | `bangumi_prefer` | 评分策略：目标非 0 分优先，或 `overwrite`            |
| `SYNC_DOUBAN_BANGUMI_COMMENT`    | `bangumi_prefer` | 短评策略：目标非空短评优先，或 `overwrite`           |

### 5.2 凭据与 Bangumi 公共项

| 变量                       | 默认        | 说明                                        |
| -------------------------- | ----------- | ------------------------------------------- |
| `BANGUMI_ACCESS_TOKEN`     | 空          | 读写 Bangumi 必需                           |
| `BANGUMI_PRIVATE`          | `false`     | 仅字面值 `true` 开启；写入收藏的私密标记    |
| `BANGUMI_USER_AGENT`       | 项目默认 UA | Bangumi 要求可识别 UA                       |
| `BANGUMI_COLLECTION_LIMIT` | `50`        | 收藏分页大小，范围 1–50；非数字/空值回落 50 |

### 5.3 行为

- 优先经 NeoDB 外链匹配；否则按分类精确标题 + 年份搜索；
- 评分默认 `bangumi_prefer`：Bangumi 已有非 0 分保留，豆瓣分只填空；`SYNC_DOUBAN_BANGUMI_RATING=overwrite` 才覆盖；
- 短评默认 `bangumi_prefer`：Bangumi 已有非空短评保留，只填空；`SYNC_DOUBAN_BANGUMI_COMMENT=overwrite` 才覆盖（含空值）；
- Bangumi 已有 4/5 状态保留，不被豆瓣覆盖；
- 进度默认关闭；开启后：
  - 电影补第一个正片；
  - TV/动画/真人补缺失正片；
  - 书籍只拉满已知的 Chap./Vol. 维度；
  - 已有分集不发送请求，保留原有时间。

---

## 六、④ Bangumi → NeoDB

### 6.1 专属开关

| 变量                              | 默认           | 说明                                                                    |
| --------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `SYNC_BANGUMI_NEODB`              | `1`            | 总开关                                                                  |
| `SYNC_BANGUMI_NEODB_CATEGORIES`   | 空（全部）     | `anime,manga,book,music,game,real`；`manga` 仅漫画平台，`book` 全部书籍 |
| `SYNC_BANGUMI_NEODB_PROGRESS`     | `0`            | 是否写 NeoDB 进度                                                       |
| `SYNC_BANGUMI_NEODB_RATING`       | `neodb_prefer` | 评分策略：目标非 0 分优先，或 `overwrite`                               |
| `SYNC_BANGUMI_NEODB_COMMENT`      | `neodb_prefer` | 短评策略：目标非空短评优先，或 `overwrite`                              |
| `SYNC_BANGUMI_NEODB_STATUS_GUARD` | `off`          | `no-downgrade` 时目标 complete 不被 progress/wishlist 覆盖              |
| `SYNC_BANGUMI_NEODB_CREATED_TIME` | `target`       | NeoDB 标记日期策略                                                      |

`SYNC_BANGUMI_NEODB_CREATED_TIME`：

- `target`：更新时不传，保留 NeoDB 原日期；新建用 Bangumi 时间；
- `source`：更新时也用 Bangumi 时间，允许倒退；
- `source-newer`：仅当 Bangumi 时间更晚才覆盖。

### 6.2 全量分页

| 变量                            | 默认                                  | 说明                             |
| ------------------------------- | ------------------------------------- | -------------------------------- |
| `BANGUMI_NEODB_FULL_SYNC`       | `0`                                   | 遍历全部收藏页；只对本次运行生效 |
| `BANGUMI_NEODB_FULL_SYNC_STATE` | `.cache/bangumi-neodb-full-sync.json` | 全量 offset 游标文件             |
| `BANGUMI_COLLECTION_LIMIT`      | `50`                                  | 每页收藏数，范围 1–50            |

游标只在全量运行读取；常规运行每次从 offset 0 开始。删除游标文件等于下次全量从头走。

### 6.3 凭据与共享网络

Bangumi 侧：

- `BANGUMI_ACCESS_TOKEN`
- `BANGUMI_USER_AGENT`
- `BANGUMI_COLLECTION_LIMIT`

NeoDB 侧（同 ②）：

- `NEODB_API_TOKEN`
- `NEODB_VISIBILITY`
- `NEODB_BASE_URL`
- `NEODB_REQUEST_DELAY_MS`

### 6.4 行为

- 同分类精确标题 + 年份；禁止跨分类；
- 同轮同 uuid 冲突按 `direct > douban-twin > title-twin`、`complete > progress/wishlist > dropped` 裁决；
- 评分/短评默认目标优先；
- 进度只在类型兼容时写；
- `created_time` 不是“状态更新时间”，缺省保留目标创建日期。

---

## 七、⑤ NeoDB → TMDB

### 7.1 专属开关

| 变量                    | 默认                           | 说明                                                       |
| ----------------------- | ------------------------------ | ---------------------------------------------------------- |
| `SYNC_NEODB_TMDB`       | `0`                            | 总开关；关闭时完整入口会报错退出                           |
| `SYNC_SHELF_TYPES`      | 全部                           | 逗号分隔：`wishlist,progress,complete,dropped`             |
| `SYNC_CATEGORIES`       | `movie,tv`                     | 只允许 movie/tv                                            |
| `SYNC_DRY_RUN`          | `0`                            | 只打印计划，不写 TMDB                                      |
| `SYNC_MAX_ITEMS`        | `50`                           | 每个书架×分类最多处理条数；`0` 会回落 50                   |
| `SYNC_RATING_PROFILE`   | `tmdb_prefer`                  | `tmdb_prefer` 保留 TMDB 非 0 评分；`overwrite` 用 NeoDB 分 |
| `SYNC_YEAR_TOLERANCE`   | `1`                            | 标题搜索允许的年份差                                       |
| `NEODB_TMDB_FULL_SYNC`  | `0`                            | 取消 `SYNC_MAX_ITEMS`/`NEODB_MAX_PAGES`，关闭增量          |
| `SYNC_INCREMENTAL`      | `1`                            | 跳过已同步指纹                                             |
| `SYNC_STATE_FILE`       | `.cache/sync-state.json`       | ⑤ 增量状态                                                 |
| `NEODB_ITEM_YEAR_CACHE` | `.cache/neodb-item-years.json` | NeoDB 年份缓存                                             |
| `NEODB_MAX_PAGES`       | `10`                           | 每个书架×分类最多翻页数；`0` 会回落 10                     |

### 7.2 TMDB 凭据与网络

| 变量                    | 默认                           | 说明                                  |
| ----------------------- | ------------------------------ | ------------------------------------- |
| `TMDB_API_KEY`          | 空                             | v3 API key，必需                      |
| `TMDB_SESSION_ID`       | 空                             | v3 session id；与 access token 二选一 |
| `TMDB_ACCESS_TOKEN`     | 空                             | 用户级 v4 token；与 session 二选一    |
| `TMDB_ACCOUNT_ID`       | 空                             | 省略时从 `/3/account` 获取            |
| `TMDB_LANGUAGE`         | `zh-CN`                        | TMDB 搜索/响应语言                    |
| `TMDB_REQUEST_DELAY_MS` | `300`                          | 请求间隔（毫秒）                      |
| `TMDB_INCLUDE_ADULT`    | `false`                        | 搜索是否包含成人结果                  |
| `TMDB_BASE_URL`         | `https://api.themoviedb.org/3` | 代理/镜像地址                         |

### 7.3 行为

- 只处理 movie/tv；
- 匹配：TMDB 外链 → IMDb → 精确标题+年份 → 季父剧；
- 写前读取 account states，读失败不写；
- 评分默认保留 TMDB 非 0 值；目标无评分时才填入；
- 不写短评、不写时间；
- 未匹配按 `no-tmdb-match`、`no-neodb-year`、`tmdb-ambiguous`、`tmdb-season-parent-missing` 等分类记录。

---

## 八、输出、日志与待核对

| 变量                 | 默认                      | 说明                                         |
| -------------------- | ------------------------- | -------------------------------------------- |
| `SYNC_UNMATCHED_LOG` | `.cache/unmatched.json`   | 未匹配留档路径；空字符串关闭留档，计数仍打印 |
| `SYNC_SUMMARY_FILE`  | `.cache/sync-summary.md`  | 每轮覆盖写 Markdown 摘要                     |
| `SYNC_REPORT_FILE`   | `.cache/sync-report.json` | 每轮覆盖写机器可读报告                       |

说明：

- `SYNC_UNMATCHED_LOG` 为相对路径时按当前工作目录解析；
- 空值 `SYNC_UNMATCHED_LOG=` 关闭文件，不关闭控制台统计；
- 摘要/报告文件始终覆盖写，不追加；
- GitHub Actions 的 `review-state` 由 `scripts/review-queue.mjs` 生成，不使用上述三个路径。

---

## 九、待核对候选的定向复核

仅由 `review-queue` 使用，不在 sync 作业中执行。

> **这五个变量不由 `src/` 读取，也不由 `npm run sync` 读取。** 唯一消费者是 `scripts/review-queue.mjs`，由 `.github/workflows/review-queue.yml` 直接传入 `process.env`。因此它们**不出现在 `.env.example`**（那个文件记录的是同步进程能读到什么），本地跑 `npm run sync` 时设置它们没有任何效果。

| 变量                       | 默认     | 说明                                                         |
| -------------------------- | -------- | ------------------------------------------------------------ |
| `REVIEW_VERIFY_MODE`       | `off`    | `off` 关闭；`shadow` 只查询并记录；`enforce` 按结果移出/保留 |
| `REVIEW_VERIFY_SOURCES`    | 四条链路 | `douban-neodb,douban-bangumi,bangumi-neodb,neodb-tmdb`       |
| `REVIEW_VERIFY_LIMIT`      | `100`    | 每轮最多复核条数                                             |
| `REVIEW_VERIFY_RETRY_DAYS` | `7`      | “仍未解决”条目的复核间隔                                     |

行为：

- 只复核 `unresolved`；
- `resolved` 移出；
- `still-unresolved` 重置 `missedRuns=0`，不会因日志缺席被老化删除；
- `ambiguous` / `error` 保留；
- 需要 review-queue 具备 NeoDB/Bangumi/TMDB 只读凭据；
- `off` 时完全走现有两轮规则。

> **复核是串行的**：`scripts/review-verify.ts` 逐条 `await`，上限 `REVIEW_VERIFY_LIMIT` 条。按当前 10 分钟作业超时与单条 1–3 次请求的规模，这不构成瓶颈；也**没有**并发数开关 —— 曾有 `REVIEW_VERIFY_CONCURRENCY`，但从未有任何代码读取它，已删除，不要重新引入一个没有消费者的旋钮。

---

## 十、推荐最小配置

### 本地只跑 ②③

```bash
DOUBAN_USER_ID=...
NEODB_API_TOKEN=...
BANGUMI_ACCESS_TOKEN=...
SYNC_DOUBAN_NEODB=1
SYNC_DOUBAN_BANGUMI=1
SYNC_BANGUMI_NEODB=0
SYNC_NEODB_TMDB=0
```

### 只跑 ④

```bash
BANGUMI_ACCESS_TOKEN=...
NEODB_API_TOKEN=...
SYNC_DOUBAN_NEODB=0
SYNC_DOUBAN_BANGUMI=0
SYNC_BANGUMI_NEODB=1
SYNC_NEODB_TMDB=0
```

### 首次 ⑤ 导入

```bash
SYNC_NEODB_TMDB=1
TMDB_API_KEY=...
TMDB_SESSION_ID=...        # 或 TMDB_ACCESS_TOKEN
SYNC_DRY_RUN=1             # 先看计划
# 确认后改 SYNC_DRY_RUN=0，配合 NEODB_TMDB_FULL_SYNC=1
```
