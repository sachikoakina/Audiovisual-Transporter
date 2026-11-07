# 接口、错误与运行数据参考

本文补充 [架构](architecture.md)、[链路说明](sync-paths.md) 和 [Actions 操作](github-actions.md) 中不便展开的接口边界、错误语义与本地状态文件。下表以当前 `src/clients/` 的请求代码为准。

## 接口读写边界

| 平台    | 主要读取                                                             | 写入                       |
| ------- | -------------------------------------------------------------------- | -------------------------- |
| 豆瓣    | 个人 interests RSS、条目 HTML 页面                                   | 无                         |
| Notion  | 按 `ITEM_LINK` 查询页面、读取 data source 属性结构                   | 创建页面；不更新或删除页面 |
| Bangumi | `/v0/me`、用户收藏列表、单条收藏和 subject、subject 搜索             | 创建或更新用户收藏         |
| NeoDB   | catalog fetch/search、当前用户、token 校验、书架分页、标记和进度读取 | 创建或更新书架标记、进度   |
| TMDB    | account、account states、IMDb 查找、电影/剧集搜索和详情              | 用户评分、watchlist 增删   |

Notion 写入只保留目标 data source 已存在的属性。NeoDB 标记请求将 `post_to_fediverse` 固定为 `false`。TMDB 路径只请求 movie 与 tv，不操作 TMDB favorite 或自建列表。

## 读取失败与写入保护

需要区分“记录不存在”和“读取失败”的 API 使用 `ReadResult<T>`：

| 状态     | 含义                                             | 写入处理                       |
| -------- | ------------------------------------------------ | ------------------------------ |
| `found`  | 读取到目标端记录                                 | 与来源和配置比较后决定是否写   |
| `absent` | 端点明确表示目标端记录不存在                     | 允许按路径规则创建             |
| `error`  | 认证失败、网络失败、服务端异常或单条记录读取失败 | 不把它当作空记录，不覆盖目标端 |

404 的含义取决于端点：例如读取收藏时可表示“尚未收藏”；读取 Bangumi subject 时表示主体不存在。401/403 分类为认证问题；认证失效会中止依赖该凭据的路径，避免对每个条目重复报告相同故障。NeoDB→TMDB 在写评分或 watchlist 前读取 account states；未读到现状就不生成写入计划。

单条失败通常记录后继续处理后续条目；整条路径无法运行时标为 `aborted`。目标端没有匹配项记为 `unresolved`，这是数据缺口，不单独导致非零退出码。`failed` 或 `aborted` 会导致失败，除非报告被 `SYNC_DOUBAN_REQUIRED=0` 标成 tolerated。

## 报告字段与日志契约

五条路径返回统一的 `PathReport`。六类计数分别是：

| 字段         | 含义                                           |
| ------------ | ---------------------------------------------- |
| `scanned`    | 进入该路径处理范围的条目                       |
| `written`    | 目标端发生写入的条目数；dry-run 中表示预计写入 |
| `unchanged`  | 比较后已与目标一致，无需写入                   |
| `skipped`    | 按分类、状态或安全规则刻意不写                 |
| `unresolved` | 目标目录中没有确认匹配项                       |
| `failed`     | 单条处理失败或目标端拒绝写入                   |

各路径用以下等式自检，TMDB 的字段级写入数单独输出，不参与条目数对账：

```text
scanned = written + unchanged + skipped + unresolved + failed
```

`review-queue.mjs` 会解析各链路的日志格式并结合 JSON 报告补全条目分类、状态和扫描覆盖范围。日志文案、`{category|shelf}` 后缀和报告身份字段属于跨脚本契约；调整时需同时核对 `scripts/review-queue.mjs`、`src/sync-report.ts` 与 `src/types.ts`。

## 状态文件与留档

| 配置项                          | 默认路径                              | 用途                                          |
| ------------------------------- | ------------------------------------- | --------------------------------------------- |
| `SYNC_STATE_FILE`               | `.cache/sync-state.json`              | NeoDB→TMDB 增量指纹，跳过来源标记未变化的条目 |
| `NEODB_ITEM_YEAR_CACHE`         | `.cache/neodb-item-years.json`        | 缓存 NeoDB uuid 对应的发行年份                |
| `BANGUMI_NEODB_FULL_SYNC_STATE` | `.cache/bangumi-neodb-full-sync.json` | Bangumi 全量同步的分页游标                    |
| `SYNC_UNMATCHED_LOG`            | `.cache/unmatched.json`               | 本地记录无法匹配的条目；空值关闭              |
| `SYNC_SUMMARY_FILE`             | `.cache/sync-summary.md`              | 本轮 Markdown 汇总                            |
| `SYNC_REPORT_FILE`              | `.cache/sync-report.json`             | 机器可读运行报告                              |

这些路径相对于进程工作目录。状态与留档写入采用同目录临时文件再改名，避免进程中断留下半份 JSON。TMDB 状态只在同步写入成功后更新；年份缓存只保存只读目录信息；Bangumi 游标只影响全量分页从哪里继续，不决定是否覆盖目标条目。

review-queue 工作流另用 Actions artifact 携带待核对名单状态；它与上述 `.cache` 同步状态不是同一文件或同一用途。细节见 [Actions 操作](github-actions.md)。

## 豆瓣 → Bangumi 进度

`SYNC_DOUBAN_BANGUMI_EPISODES=1` 时，③ 只对豆瓣 `complete` 条目补进度。电影标记第一个正片；TV/动画/真人只补 `type!=2` 的正片分集，已有集不写；SP 默认关闭，`SYNC_DOUBAN_BANGUMI_INCLUDE_SP=1` 才纳入。书籍按 `ep_status`/`vol_status` 是否大于 0 判断未知，只拉满已知维度，总量缺失则跳过。分集 `updated_at` 是 Unix 秒，已有集通过不写入保留，新增集使用服务端时间。

## 请求节流

NeoDB、Bangumi、TMDB 的请求间隔由对应客户端实现，部分间隔可通过 `.env.example` 中的配置调整。NeoDB 书架读取另有 GET 重试策略；其他目录读取失败不会一概转成“无匹配”。修改节流或重试时应保留“空结果”“未找到”和“请求失败”的区别。

## NeoDB → TMDB 未匹配原因

代码会区分以下情况，避免将目录缺项和读取故障混为一类：

| 原因                         | 含义                                       |
| ---------------------------- | ------------------------------------------ |
| `no-tmdb-match`              | 可用的匹配方式均未找到目标                 |
| `no-neodb-year`              | NeoDB 条目没有可用于标题匹配的年份         |
| `no-neodb-year-fetch-failed` | 读取 NeoDB 条目年份失败                    |
| `tmdb-link-type-mismatch`    | NeoDB 的 TMDB 外链媒体类型与条目分类不一致 |
| `tmdb-link-fetch-failed`     | 外链指向的 TMDB 条目无法读取               |
| `imdb-no-match`              | IMDb 查找没有得到相同媒体类型的结果        |
| `tmdb-search-empty`          | 标题搜索没有返回候选                       |
| `tmdb-ambiguous`             | 有候选，但没有通过精确标题与年份条件的结果 |
| `tmdb-season-parent-missing` | 季条目无法提取父剧标题用于回退搜索         |

按具体路径和错误位置，失败明细还会包含 `tmdb-item-threw`、`tmdb-write-failed` 等条目级原因。代码中的 reason slug 与日志解析契约需保持一致。

`data/tmdb-known-absent.json` 用于记录人工确认 TMDB 没有的条目。

**代码实际读取的只有两个字段**：

| 字段        | 必填 | 作用            |
| ----------- | :--: | --------------- |
| `neodbUuid` |  是  | NeoDB 条目 uuid |
| `mediaType` |  是  | `movie` / `tv`  |

身份键由这两个字段拼成 `${mediaType}:${uuid}`（纯函数 `matchKnownAbsentKey`，位于 `rules/tmdb-mapping.ts`；读文件的部分 `readKnownAbsentList` 在 `utils.ts`）。缺任一字段的行被静默跳过。`reason` / `checkedAt` / `note` 这类人类备注**会被容忍但从不读取** —— 它们存在是为了让编辑文件的人写下理由，不参与匹配。

命中后该条目转为 `tmdb-known-absent` skipped，跳过全部匹配级别。文件缺失、为空或不是合法 JSON 时一律按空集处理：这份名单是优化，不是真源。

## Bangumi → NeoDB 未匹配原因

| 原因                   | 含义                                       |
| ---------------------- | ------------------------------------------ |
| `neodb-unresolved-404` | NeoDB 目录返回 404，条目确实不存在         |
| `neodb-unresolved`     | 202 重试耗尽、429、5xx、超时或其他临时失败 |

两者日志都使用 `NeoDB could not resolve Bangumi URL, skip:`；区别只写入 `sync-report`，由 review-queue 从 report 覆盖显示。

## reason 总表（slug × 链路 × 档位 × 日志形态）

这是全仓 reason 的**唯一出处**。`.` 后面的「落点」一列说明它是进入待核对名单、还是只出现在报表/控制台：

- **路由**：`scripts/review-queue.mjs` 的 `DETAIL_REASONS` 表认识它，名单可归属；
- **哨兵**：没有明细行，slug 由某个日志哨兵隐含，名单自行推导；
- **不路由**：进入 `ReviewDetail` 且会被渲染，但设计上不归属（多为多链路共用或设计内跳过），名单计入「无法归属」计数；
- **仅报表**：只出现在 `sync-report.json` 的 `*Items` 里，不产生独立的日志行。

| slug                         | 链路 |    档位    | 落点                           |
| ---------------------------- | ---- | :--------: | ------------------------------ |
| `notion-insert-failed`       | ①    |   failed   | 路由                           |
| `douban-scrape-failed`       | ①    |   failed   | 路由                           |
| `notion-category-failed`     | ①    |   failed   | 路由                           |
| `no-notion-database`         | ①    |  skipped   | 路由                           |
| `neodb-mark-rejected`        | ②    |   failed   | 路由                           |
| `neodb-item-threw`           | ②    |   failed   | 路由                           |
| `neodb-read-failed`          | ②    |   failed   | 路由                           |
| `no-neodb-match`             | ②    | unresolved | 哨兵                           |
| `guard-target-status`        | ②    |  skipped   | 哨兵 / 不路由                  |
| `category-not-allowed`       | ①②③  |  skipped   | 不路由（三链路共用）           |
| `bangumi-write-rejected`     | ③    |   failed   | 路由                           |
| `bangumi-item-threw`         | ③    |   failed   | 路由                           |
| `bangumi-read-failed`        | ③    |   failed   | 路由                           |
| `no-bangumi-match`           | ③    | unresolved | 哨兵                           |
| `guard-bangumi-status`       | ③    |  skipped   | 哨兵                           |
| `item-threw`                 | ④    |   failed   | 路由                           |
| `duplicate-target`           | ④    |  skipped   | 路由                           |
| `platform-mismatch`          | ④    |  skipped   | 不路由（漫画闸门的设计内跳过） |
| `neodb-unresolved`           | ④    | unresolved | 哨兵（临时失败）               |
| `neodb-unresolved-404`       | ④    | unresolved | 仅报表（日志行与上者相同）     |
| `no-tmdb-match`              | ⑤    | unresolved | 哨兵                           |
| `no-neodb-year`              | ⑤    | unresolved | 哨兵                           |
| `no-neodb-year-fetch-failed` | ⑤    |   failed   | 路由                           |
| `tmdb-link-type-mismatch`    | ⑤    | unresolved | 仅报表                         |
| `tmdb-link-fetch-failed`     | ⑤    | unresolved | 仅报表                         |
| `imdb-no-match`              | ⑤    | unresolved | 仅报表                         |
| `tmdb-search-empty`          | ⑤    | unresolved | 仅报表                         |
| `tmdb-ambiguous`             | ⑤    | unresolved | 仅报表                         |
| `tmdb-season-parent-missing` | ⑤    | unresolved | 仅报表                         |
| `tmdb-item-threw`            | ⑤    |   failed   | 路由                           |
| `tmdb-write-failed`          | ⑤    |   failed   | 路由                           |
| `no-catalog-item`            | ⑤    |   failed   | 路由                           |
| `tmdb-known-absent`          | ⑤    |  skipped   | 路由                           |
| `shelf-not-mapped`           | ⑤    |  skipped   | 不路由（防御性兜底）           |
| `no-tmdb-category`           | ⑤    |  skipped   | 不路由                         |
| `unmapped-category`          | ⑤    |  skipped   | 不路由                         |
| `unchanged-since-last-run`   | ⑤    |  skipped   | 不路由（增量命中）             |
| `duplicate-in-run`           | ⑤    |  skipped   | 不路由（同轮重复）             |

`scripts/verify-log-contract.ts` 对这张表做双向校验：`src/` 里出现在三类 `push` 位点上的 reason 必须落进「路由 / 哨兵 / 不路由」之一，且每个桶里不得有过期条目。
