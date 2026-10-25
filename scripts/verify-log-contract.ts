/*
 * Verify the log contract between `src/` and `scripts/review-queue.mjs`.
 * 校验 `src/` 与 `scripts/review-queue.mjs` 之间的日志契约。
 *
 * The review list is parsed out of console logs, so three things are load-bearing and none of
 * them is checked by the type system:
 *   1. every reason slug in `DETAIL_REASONS` is still emitted by the path it claims;
 *   2. no slug is emitted by two different paths (a shared slug cannot be routed, and the table
 *      is only allowed to hold slugs with exactly one owner);
 *   3. the eight `indexOf` sentinels the parser relies on still appear in the source that prints
 *      them.
 *
 * 名单是从控制台日志里解析出来的，因此有三样东西是承重的，而它们都不受类型系统保护：
 *   1. `DETAIL_REASONS` 里的每个 reason slug 仍由它声称的那条链路产出；
 *   2. 没有哪个 slug 被两条链路同时产出（共用 slug 无法路由，表里只允许唯一归属的 slug）；
 *   3. 解析器依赖的八个 `indexOf` 哨兵仍出现在打印它们的源码里。
 *
 * This does not replace reading the log; it stops a rename from silently emptying the list.
 * 它不替代读日志；它只是让一次重命名无法悄悄把名单清空。
 *
 * USAGE: npm run verify:log-contract   (or `npm run verify:all`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecker } from './verify-lib';

/** Path display name → the file that prints its detail lines. / 链路显示名 → 打印其明细行的文件。 */
const PATH_FILES: Record<string, string> = {
  'douban→notion': 'src/paths/douban-to-notion.ts',
  'douban→neodb': 'src/paths/douban-to-neodb.ts',
  'douban→bangumi': 'src/paths/douban-to-bangumi.ts',
  'bangumi→neodb': 'src/paths/bangumi-to-neodb.ts',
  'neodb→tmdb': 'src/paths/neodb-to-tmdb.ts',
};

/**
 * The sentinels `parseLogs` matches on. Each one is a sentence, and a sentence is only a contract
 * while both sides agree on it — that is exactly what this list exists to notice breaking.
 * `parseLogs` 逐行匹配的哨兵。每一个都是一句话，而一句话只有在两侧都认它时才是契约 ——
 * 这份清单存在的意义就是发现它被破坏。
 */
const SENTINELS = [
  'No notion data source id for ',
  'No NeoDB match, skip: ',
  'No Bangumi match, skip: ',
  'NeoDB could not resolve Bangumi URL, skip: ',
  'NeoDB has Douban-absent status, skip overwrite: ',
  'No TMDB match; skip ',
  'Item failed, continuing: ',
  'TMDB write threw, continuing: ',
];

const { check, section, summary } = createChecker();

const root = process.cwd();
const queuePath = path.join(root, 'scripts/review-queue.mjs');
const queueSource = fs.readFileSync(queuePath, 'utf8');

// ───────────────────────────────────────────────────────────────────────────
section('DETAIL_REASONS / 路由表');

const mapBlock =
  queueSource.match(/const DETAIL_REASONS = new Map\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
const entries = [
  ...mapBlock.matchAll(/\['([a-z-]+)',\s*\['(failed|skipped)',\s*'([^']+)'\]\]/g),
].map((match) => ({ slug: match[1], kind: match[2], target: match[3] }));

check('the routing table parses', entries.length > 0, `${entries.length} entries`);
check(
  'every entry names a path this script knows',
  entries.every((entry) => entry.target in PATH_FILES),
  entries
    .filter((entry) => !(entry.target in PATH_FILES))
    .map((entry) => entry.target)
    .join(', '),
);

/**
 * Full-line comments dropped. A slug is emitted by a string literal on a code line; the only
 * other place it appears is a comment explaining it (`neodb-to-tmdb.ts` spells out ④'s
 * `item-threw` while explaining why it does not reuse it), and that must not count as an owner.
 * 丢掉整行注释。slug 出现在代码行的字符串字面量里；它唯一还会出现的地方是解释它的注释
 * （`neodb-to-tmdb.ts` 在解释为何不复用时写出了 ④ 的 `item-threw`），那不能被算作归属。
 */
function withoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const sources = new Map<string, string>(
  Object.values(PATH_FILES).map((file) => [
    file,
    withoutCommentLines(fs.readFileSync(path.join(root, file), 'utf8')),
  ]),
);

for (const entry of entries) {
  const owner = PATH_FILES[entry.target];
  const ownerSource = sources.get(owner) ?? '';
  check(
    `${entry.slug} is still emitted by ${entry.target}`,
    new RegExp(`(?<![\\w-])${entry.slug}(?![\\w-])`).test(ownerSource),
    `${owner} does not contain the slug`,
  );

  // A slug printed by two paths cannot be routed — the table is deliberately limited to slugs
  // with exactly one owner, so this is the check that keeps the table honest as `src/` moves.
  // 被两条链路同时打印的 slug 无法路由 —— 表刻意只收唯一归属的 slug，因此这条正是让表在
  // `src/` 变动时保持诚实的检查。
  // Whole-slug match, not `includes`: `item-threw` is a substring of `neodb-item-threw`, so a
  // plain containment test would report three phantom owners for the one slug that has none.
  // 按完整 slug 匹配而不是 `includes`：`item-threw` 是 `neodb-item-threw` 的子串，用包含判断会
  // 给那个确实没有第二归属的 slug 报出三个假归属。
  const slugPattern = new RegExp(`(?<![\\w-])${entry.slug}(?![\\w-])`);
  const otherOwners = [...sources.entries()]
    .filter(([file]) => file !== owner)
    .filter(([, source]) => slugPattern.test(source))
    .map(([file]) => file);
  check(
    `${entry.slug} has exactly one owner`,
    otherOwners.length === 0,
    `also printed by ${otherOwners.join(', ')}`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
section('Log sentinels / 日志哨兵');

for (const sentinel of SENTINELS) {
  const inParser = queueSource.includes(sentinel);
  const inSrc = [...sources.values()].some((source) => source.includes(sentinel));
  check(`the parser still matches "${sentinel.trim()}"`, inParser);
  check(`something in src/ still prints "${sentinel.trim()}"`, inSrc);
}

summary();
