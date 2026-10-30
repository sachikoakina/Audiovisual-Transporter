# Audiovisual-Transporter

把豆瓣与 Bangumi 的书影音标记单向同步到 Notion、NeoDB、Bangumi 与 TMDB。
每条链路先读目标端现状，再逐字段比对，只写差异，因此重复运行不会产生重复数据。

## 快速开始

要求 Node.js 20 或以上。

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

状态映射：

| 豆瓣 | NeoDB                         | Bangumi | TMDB                                     |
| ---- | ----------------------------- | ------- | ---------------------------------------- |
| 想看 | `wishlist`                    | 1 想看  | 加入 watchlist                           |
| 在看 | `progress`                    | 3 在看  | 加入 watchlist                           |
| 看过 | `complete`                    | 2 看过  | 有评分则写评分并移出 watchlist，否则加入 |
| —    | `dropped`（仅 ④ 产生）        | 5 抛弃  | 加入 watchlist                           |
| —    | `progress`（④ 把 4 搁置归入） | 4 搁置  | 加入 watchlist                           |

豆瓣没有「搁置」与「弃看」，`dropped` 只能来自 ④；TMDB 没有「弃看」状态，⑤ 将它按「还想看」处理。

## 配置

完整变量与默认值见 [`.env.example`](.env.example)。常用项：

| 变量                   | 默认                                 | 说明                                              |
| ---------------------- | ------------------------------------ | ------------------------------------------------- |
| `SYNC_DRY_RUN`         | `0`                                  | `1` 时只打印计划，不写目标端                      |
| `SYNC_SHELF_TYPES`     | `wishlist,progress,complete,dropped` | ⑤ 处理的书架                                      |
| `SYNC_CATEGORIES`      | `movie,tv`                           | ⑤ 处理的分类                                      |
| `SYNC_MAX_ITEMS`       | `200`                                | ⑤ 单轮上限                                        |
| `SYNC_RATING_PROFILE`  | `tmdb_prefer`                        | 评分冲突时保留 TMDB；`neodb_prefer` 用 NeoDB 覆盖 |
| `SYNC_INCREMENTAL`     | `1`                                  | ⑤ 跳过内容未变的条目                              |
| `SYNC_DOUBAN_REQUIRED` | `1`                                  | `0` 时豆瓣失败不参与退出码                        |

注意 `neodb_prefer` 在两处的含义不同：⑤ 的 `SYNC_RATING_PROFILE` 表示用 NeoDB 覆盖 TMDB；②④ 的 `SYNC_*_NEODB_MERGE` 表示保留 NeoDB 已有的非空值。

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

## 同步规则

三条规则适用于所有链路。

1. **先读后写**。目标端读取分 `found`、`absent`、`error` 三态；`error` 时一律不写，遇到 401/403 中止该链路。
2. **只写差异**。字段逐个比较，相同就跳过；`unchanged` 计数不代表出错。
3. **失败记录在报告里**。单条失败不影响同链路的其他条目；凭据失效等常见故障会被折成 `aborted`，其余链路继续。

## 结果与退出码

每轮结束后每条链路输出六个计数：

| 计数         | 含义           |
| ------------ | -------------- |
| `scanned`    | 检查过的条目   |
| `written`    | 实际写出       |
| `unchanged`  | 读完无差异     |
| `skipped`    | 规则内跳过     |
| `failed`     | 读取或写入出错 |
| `unresolved` | 找不到目标条目 |

满足 `written + unchanged + skipped + unresolved + failed = scanned`。

任一条路 `aborted` 或 `failed > 0` 时退出码为 1；`SYNC_DOUBAN_REQUIRED=0` 时豆瓣侧的失败标记为 `TOLERATED`，只展示、不参与退出码。

未匹配条目会写入待核对名单（`review-state` artifact，保留 90 天），按 `结果 → 类型 → 状态` 分组；本地同时记录到 `.cache/unmatched.json`。

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
- `scripts/verify-*.ts` 是无框架断言，覆盖映射、解析器、日志与文档契约。
- 新增链路：在 `src/paths/` 新建文件 → `src/index.ts` 调度 → `types.ts` 计数 → 对应测试与断言。

## 文档

- [`docs/reference.md`](docs/reference.md)：平台边界、接口依据、数据格式、运行输出与留档契约。

## License

MIT
