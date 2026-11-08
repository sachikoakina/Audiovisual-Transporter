/*
 * Verify the log contract between `src/` and `scripts/review-queue.mjs`.
 * 校验 `src/` 与 `scripts/review-queue.mjs` 之间的日志契约。
 *
 * The review list is parsed out of console logs, so three things are load-bearing and none of
 * them is checked by the type system:
 *   1. every reason slug in `DETAIL_REASONS` is still emitted by the path it claims;
 *   2. no slug is emitted by two different paths (a shared slug cannot be routed, and the table
 *      is only allowed to hold slugs with exactly one owner);
 *   3. the nine `indexOf` sentinels the parser relies on still appear in the source that prints
 *      them.
 *
 * 名单是从控制台日志里解析出来的，因此有三样东西是承重的，而它们都不受类型系统保护：
 *   1. `DETAIL_REASONS` 里的每个 reason slug 仍由它声称的那条链路产出；
 *   2. 没有哪个 slug 被两条链路同时产出（共用 slug 无法路由，表里只允许唯一归属的 slug）；
 *   3. 解析器依赖的九个 `indexOf` 哨兵仍出现在打印它们的源码里。
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
  'NeoDB year fetch failed; counting as failed: ',
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

/**
 * Every literal the parser actually matches on, read out of its own source.
 *
 * The list above is a *transcription* of these, and a transcription only stays true if something
 * compares it back. Without this, adding a new `indexOf('…')` to the parser would be invisible
 * here: the checks below would happily pass for the old set while the new pattern decided real
 * behaviour.
 * 上面那份清单是对这些字面量的**抄录**，而抄录只有被反向比对才保持为真。缺了这一段，给解析器
 * 新增一个 `indexOf('…')` 在这里完全看不见：下面的检查会对旧集合一路放行，而真正的行为已经由
 * 那个新模式决定。
 */
const matchedLiterals = [...queueSource.matchAll(/indexOf\(\s*'([^']*)'/g)].map(
  (match) => match[1],
);
const matchedSet = new Set(matchedLiterals);
const declaredSet = new Set(SENTINELS);

check(
  'the parser source yields the sentinels it is expected to match',
  matchedSet.size > 0,
  `${matchedLiterals.length} literal(s)`,
);
check(
  'no literal in the parser is missing from the list above',
  [...matchedSet].every((literal) => declaredSet.has(literal)),
  [...matchedSet].filter((literal) => !declaredSet.has(literal)).join(' | '),
);
check(
  'no sentinel in the list is stale (absent from the parser source)',
  [...declaredSet].every((literal) => matchedSet.has(literal)),
  [...declaredSet].filter((literal) => !matchedSet.has(literal)).join(' | '),
);

for (const sentinel of SENTINELS) {
  const inParser = queueSource.includes(sentinel);
  const inSrc = [...sources.values()].some((source) => source.includes(sentinel));
  check(`the parser still matches "${sentinel.trim()}"`, inParser);
  check(`something in src/ still prints "${sentinel.trim()}"`, inSrc);
}

// ───────────────────────────────────────────────────────────────────────────
section('Metadata suffix / 元数据后缀');

// The queue reads `{category|shelf}` from the line; the five paths must print it. Without this,
// a renamed helper silently drops every entry back to `other` / `unknown`.
// 名单从行里读 `{category|shelf}`，五条链路必须打印它。缺了这条检查，一次改名就会让所有条目静默
// 退回 `other` / `unknown`。
// ① has no per-item unresolved line (its data gaps are configuration, not a missing catalogue
// entry), so it has no suffix to print. The other four do.
// ① 没有逐条未匹配行（它的缺口是配置，而不是目录里没有条目），因此没有后缀可打；其余四条有。
for (const [source, file] of Object.entries(PATH_FILES)) {
  if (source === 'douban→notion') {
    continue;
  }
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  check(
    `${source} prints the {category|shelf} suffix`,
    text.includes('reviewMetaSuffix'),
  );
}
check(
  'the queue parses the suffix before splitting the label',
  queueSource.includes('META_PATTERN') && queueSource.includes('splitMeta('),
);

// ───────────────────────────────────────────────────────────────────────────
section('Detail reasons / 明细 reason 的三个桶');

/**
 * Every reason a path can put on a `ReviewDetail`, extracted from the three `push` sites only.
 *
 * The scan is deliberately narrow. `src/rules/` also has a `reason` field on two unrelated types
 * (`BangumiOperationPlan.reason`, `TmdbOperationPlan.reason`) whose values are human-readable
 * Chinese explanations — e.g. `'想看 → 加入 watchlist'`. Scanning a whole file for `reason:` would
 * pull those in and then demand that phrases become review slugs. Only the three arrays that end up
 * in `PathReport` (`failedItems` / `skippedItems` / `unresolvedItems`) are review identities.
 *
 * 链路能放到 `ReviewDetail` 上的每一个 reason，只从三处 `push` 位点提取。
 *
 * 扫描范围刻意收窄。`src/rules/` 里另有两个无关类型带 `reason` 字段（`BangumiOperationPlan.reason`、
 * `TmdbOperationPlan.reason`），值是人类可读的中文解释，例如 `'想看 → 加入 watchlist'`。整文件扫
 * `reason:` 会把它们卷进来，然后要求这些句子变成名单 slug。只有真正进入 `PathReport` 的三个数组
 * （`failedItems` / `skippedItems` / `unresolvedItems`）才是名单身份。
 *
 * Five shapes appear at those sites and all of them must be understood:
 *   1. a plain literal          — `reason: 'no-neodb-match',`
 *   2. a template literal       — `` reason: `item-threw: ${detail}`, `` → the prefix before `${`
 *   3. a function call          — `reason: failureReason(err, 'a', 'b')` → every string argument
 *   4. a threaded fallback      — `reason: skipReason ?? 'guard-bangumi-status'` → the literal on
 *      the right of `??`; the threaded value itself is collected from its `skipReason: '…'`
 *      return site (the second scan below)
 *   5. a bare identifier        — `reason: resolution.reason` → cannot be resolved statically; the
 *      union `NoMatchReason` it comes from is listed by hand in `RESOLUTION_REASONS` below, and the
 *      assertion on that list is what keeps the hand-listing honest.
 *
 * 五种形态都必须认得：
 *   1. 普通字面量         — `reason: 'no-neodb-match',`
 *   2. 模板字面量         — `` reason: `item-threw: ${detail}`, `` → 取 `${` 之前的前缀
 *   3. 函数调用           — `reason: failureReason(err, 'a', 'b')` → 每个字符串实参
 *   4. 透传兜底           — `reason: skipReason ?? 'guard-bangumi-status'` → 收集 `??` 右侧的字面量；
 *      透传值本身由下方第二段扫描从 `skipReason: '…'` 返回点收集
 *   5. 裸标识符           — `reason: resolution.reason` → 无法静态求值；它来自联合类型
 *      `NoMatchReason`，由下面的 `RESOLUTION_REASONS` 手工列出，而这条断言正是让手工清单保持诚实的东西。
 */
function reviewDetailReasons(source: string): Set<string> {
  const found = new Set<string>();
  const withoutComments = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  // Walk to each `push(` on the three arrays, then read the object literal that follows.
  // 走到三个数组上的每个 `push(`，再读它后面那个对象字面量。
  //
  // `.push({` is the common shape, but `douban-to-notion.ts` builds one array with
  // `skippedItems: feeds.map((item) => ({ … }))` — a `map` right after the property name. Both are
  // review identities, so both are scanned; missing the `map` form is how `no-notion-database`
  // would look unrouted while being routed all along.
  // `.push({` 是常见形态，但 `douban-to-notion.ts` 用 `skippedItems: feeds.map((item) => ({ … }))`
  // 构造了一个数组 —— 属性名后面直接跟 `map`。两者都是名单身份，因此都要扫；漏掉 `map` 形态正是
  // `no-notion-database` 明明被路由、却被看成未路由的原因。
  const pushPattern =
    /(?:failedItems|skippedItems|unresolvedItems)(?:\.push\(|:\s*[\w.]+\.map\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\()\{/g;
  for (const match of withoutComments.matchAll(pushPattern)) {
    const index = match.index + match[0].length;
    // Stop at the end of this object literal: reasons live before the first closing `});`.
    // 停在这个对象字面量的末尾：reason 都出现在第一个 `});` 之前。
    const end = withoutComments.indexOf('});', index);
    if (end < 0) {
      continue;
    }
    const block = withoutComments.slice(index, end);

    for (const literal of block.matchAll(/\breason:\s*'([^']+)'/g)) {
      found.add(literal[1]);
    }
    for (const template of block.matchAll(/\breason:\s*`([^`$]*)\$\{/g)) {
      const prefix = template[1].replace(/:\s*$/, '').trim();
      if (prefix) {
        found.add(prefix);
      }
    }
    // `reason: failureReason(error, 'a', 'b')` → both string arguments.
    // `reason: failureReason(error, 'a', 'b')` → 两个字符串实参都算。
    for (const call of block.matchAll(/\breason:\s*failureReason\([^)]*?\)/g)) {
      for (const arg of call[0].matchAll(/'([a-z][a-z0-9-]*)'/g)) {
        found.add(arg[1]);
      }
    }
    // `reason: skipReason ?? 'guard-bangumi-status'` → the fallback literal. The threaded value
    // comes back through `skipReason: '…'` and is collected by the return-site scan below.
    // `reason: skipReason ?? 'guard-bangumi-status'` → 收集兜底字面量；透传值经 `skipReason: '…'`
    // 返回，由下面的返回点扫描收集。
    for (const fallback of block.matchAll(/\breason:\s*[\w$.]+\s*\?\?\s*'([^']+)'/g)) {
      found.add(fallback[1]);
    }
    // `reason,` — a bare identifier passed through (④'s recordUnresolved). Its callers supply the
    // slug, so it is checked where the callers are, not here.
    // `reason,` —— 直接透传的裸标识符（④ 的 recordUnresolved）。slug 由调用方给出，因此在调用方
    // 检查，不在这里。
  }

  // Threaded skip reasons: ③'s item function returns `skipReason: '<slug>'` and the caller pushes
  // `reason: skipReason ?? '<fallback>'`. The fallback is collected at the push site above; the
  // threaded slug is collected here from the return sites, so both sides of the `??` are accounted
  // for in the buckets.
  // 透传的跳过原因：③ 的条目函数返回 `skipReason: '<slug>'`，调用方 push
  // `reason: skipReason ?? '<fallback>'`。兜底值在上面的 push 位点收集；透传 slug 在这里从返回点
  // 收集 —— `??` 的两侧由此都进入桶里。
  for (const returned of withoutComments.matchAll(
    /\bskipReason:\s*'([a-z][a-z0-9-]+)'/g,
  )) {
    found.add(returned[1]);
  }

  return found;
}

/**
 * Reasons assigned through a variable instead of a literal, resolved by hand with the union they
 * come from named. `neodb-to-tmdb.ts` writes `reason: resolution.reason`, and `resolution` is a
 * `TmdbResolution` whose miss branch carries a `NoMatchReason`. Those nine values are the ones
 * below; `verify-tmdb-mapping.ts` and `verify-rules.ts` already pin the union's membership, so a
 * new member shows up there first and this list is what forces it to be accounted for here too.
 * 通过变量而非字面量赋值的 reason，手工列出并注名其来源联合类型。`neodb-to-tmdb.ts` 写的是
 * `reason: resolution.reason`，而 `resolution` 是 `TmdbResolution`，其落空分支携带 `NoMatchReason`。
 * 下面就是那九个值；`verify-tmdb-mapping.ts` 与 `verify-rules.ts` 已钉住该联合的成员，因此新增成员
 * 会先在那边暴露，而这份清单会强制它在这里也被交代。
 */
const RESOLUTION_REASONS = [
  'no-tmdb-match',
  'no-neodb-year',
  'no-neodb-year-fetch-failed',
  'tmdb-link-type-mismatch',
  'tmdb-link-fetch-failed',
  'imdb-no-match',
  'tmdb-search-empty',
  'tmdb-ambiguous',
  'tmdb-season-parent-missing',
];

/**
 * Bucket ① — routed by `DETAIL_REASONS`. Read out of the queue's own table, so the two sides can
 * never disagree about membership.
 * 桶① —— 由 `DETAIL_REASONS` 路由。从名单自己的表里读出，两侧因此不可能对成员资格有分歧。
 */
const ROUTED_REASONS = new Set(entries.map((entry) => entry.slug));

/**
 * Bucket ② — no detail line at all; the slug is implied by a log sentinel and the queue derives it.
 * 桶② —— 根本没有明细行；slug 由日志哨兵隐含，由名单推导出来。
 */
const SENTINEL_IMPLIED_REASONS = new Set([
  'no-neodb-match',
  'no-bangumi-match',
  'guard-bangumi-status',
  'guard-target-status',
  'neodb-unresolved',
  'guard-bangumi-status',
]);

/**
 * Bucket ③ — deliberately NOT routed. These reach `ReviewDetail` and are rendered, but they are
 * shared between paths or are designed-in skips, so guessing an owner would be worse than saying
 * "could not attribute" — which is exactly what the queue does with them, and what its summary
 * reports as a count.
 * 桶③ —— 刻意不做路由。它们进入 `ReviewDetail` 且会被渲染，但被多条链路共用、或属于设计内跳过，
 * 因此猜一个归属比「无法归属」更坏 —— 而这正是名单对它们的处理，也是摘要里以计数报出来的那部分。
 */
const INTENTIONALLY_UNROUTED_REASONS = new Set([
  // Shared by ①②③ — see the note above `DETAIL_REASONS` in the queue.
  // ①②③ 共用 —— 见名单里 `DETAIL_REASONS` 上方的说明。
  'category-not-allowed',
  // ④'s manga platform gate and ⑤'s four designed-in skips. All four reach `skippedItems`, and all
  // four are the intended outcome of a configuration, not a defect.
  // ④ 的漫画平台闸门与 ⑤ 的四种设计内跳过。四种都会进入 `skippedItems`，且都是配置的预期结果，
  // 不是缺陷。
  'platform-mismatch',
  'unchanged-since-last-run',
  'duplicate-in-run',
  'shelf-not-mapped',
  'no-tmdb-category',
  'unmapped-category',
  // ③'s book-progress skip: the pair of records cannot produce a progress plan, so the item is
  // left untouched. Threaded out of `syncFeedItemToBangumi` as `skipReason` (see the `??` shape
  // above); the real cause is already on the console via the `Bangumi book progress skipped:` line.
  // ③ 的书籍进度跳过：这对记录规划不出进度方案，条目原样保留。经 `syncFeedItemToBangumi` 的
  // `skipReason` 透传（见上方的 `??` 形态）；真实原因已通过 `Bangumi book progress skipped:` 行
  // 打在控制台上。
  'progress-unplannable',
]);

const allowedReasons = new Set([
  ...ROUTED_REASONS,
  ...SENTINEL_IMPLIED_REASONS,
  ...INTENTIONALLY_UNROUTED_REASONS,
  ...RESOLUTION_REASONS,
]);

const emitted = new Map<string, string[]>();
for (const [source, file] of Object.entries(PATH_FILES)) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const reason of reviewDetailReasons(text)) {
    const owners = emitted.get(reason) ?? [];
    owners.push(source);
    emitted.set(reason, owners);
  }
}

check(
  'the reason scan finds the literals it is supposed to find',
  // A silent empty scan would make every assertion below pass for the wrong reason.
  // 一次静默的空扫描会让下面每条断言都以错误的理由通过。
  [...emitted.keys()].length >= 20,
  `${emitted.size} reason(s): ${[...emitted.keys()].sort().join(', ')}`,
);

const unaccounted = [...emitted.keys()].filter((reason) => !allowedReasons.has(reason));
check(
  'every ReviewDetail reason is routed, sentinel-implied, or explicitly unrouted',
  unaccounted.length === 0,
  `not in any bucket: ${unaccounted.sort().join(', ')}`,
);

// The reverse direction: a bucket entry that nothing emits any more is dead weight, and dead
// weight is how a bucket silently grows into "everything is allowed".
// 反方向：某个桶里再没有任何链路产出的条目就是死重，而死重正是桶悄悄退化成「什么都放行」的方式。
const routedButSilent = [...ROUTED_REASONS].filter(
  (reason) => !emitted.has(reason) && !RESOLUTION_REASONS.includes(reason),
);
check(
  'every routed reason is still emitted by some path',
  routedButSilent.length === 0,
  `routed but never emitted: ${routedButSilent.sort().join(', ')}`,
);

const unroutedButUnused = [...INTENTIONALLY_UNROUTED_REASONS].filter(
  (reason) => !emitted.has(reason),
);
check(
  'every intentionally-unrouted reason is still emitted (no stale allowlist entries)',
  unroutedButUnused.length === 0,
  `allowlisted but never emitted: ${unroutedButUnused.sort().join(', ')}`,
);

// ───────────────────────────────────────────────────────────────────────────
section('Workflow env coverage / 工作流的环境变量覆盖');

/**
 * The sync workflow must forward every variable `src/` reads, with a documented set of exceptions.
 *
 * This check exists because `verify-docs` cannot see it: that script only reads `src/` and
 * `.env.example`, so a variable the code reads but `sync.yml` never forwards passes every existing
 * assertion while being impossible to set in Actions. That is not hypothetical — ten rating,
 * comment, progress and guard switches were in exactly that state.
 *
 * 同步工作流必须转发 `src/` 读取的每一个变量，例外需有据可查。
 *
 * 这条检查存在的原因是 `verify-docs` 看不到它：那个脚本只读 `src/` 与 `.env.example`，因此
 * 「代码读、但 `sync.yml` 从不转发」的变量能通过所有既有断言，同时在 Actions 里根本无法设置。
 * 这不是假设 —— 曾有十个评分、短评、进度与守卫开关正处于这个状态。
 */
const SYNC_YML = fs.readFileSync(path.join(root, '.github/workflows/sync.yml'), 'utf8');
const syncYmlKeys = new Set(
  [...SYNC_YML.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
);

/** Provided by the runtime, not the workflow. / 由运行时提供，不由工作流提供。 */
const RUNTIME_PROVIDED = new Set(['GITHUB_ACTIONS']);

/**
 * Read by `scripts/review-queue.mjs` and forwarded by `review-queue.yml` instead.
 *
 * Every member here must be read by the queue script; the last assertion in this section enforces
 * that in both directions, so a name that stops being read cannot linger as a silent exemption.
 * There is deliberately no `REVIEW_VERIFY_CONCURRENCY`: it was forwarded and never consumed, and
 * an exemption for a knob nobody turns is the same illusion the exemption list exists to prevent.
 *
 * 由 `review-queue` 读取，并由 `review-queue.yml` 转发。
 *
 * 这里每个成员都必须真被名单脚本读取；本节最后一条断言双向强制这一点，因此不再被读的名字无法
 * 作为静默豁免留在这里。刻意没有 `REVIEW_VERIFY_CONCURRENCY`：它曾被转发但从未被消费，为一个
 * 没人拧的旋钮保留豁免，正是这份豁免清单本身要防范的那种假象。
 */
const REVIEW_QUEUE_ONLY = new Set([
  'REVIEW_VERIFY_MODE',
  'REVIEW_VERIFY_SOURCES',
  'REVIEW_VERIFY_LIMIT',
  'REVIEW_VERIFY_RETRY_DAYS',
]);

/**
 * `REVIEW_VERIFY_*` is a special case among the exemptions: `src/` no longer reads it *at all*,
 * because the dead `neodbTmdbConfig.reviewVerify` object that used to parse it was deleted. It
 * stays in `REVIEW_QUEUE_ONLY` as documentation of where those variables actually live, and the
 * "no stale exemption" check below is therefore scoped to `PINNED_BY_WORKFLOW` only. Keeping the
 * two lists separate is what makes both statements true at once.
 * `REVIEW_VERIFY_*` 在豁免清单里是个特例：`src/` 现在**完全不读**它 —— 因为曾经解析它的那个死对象
 * `neodbTmdbConfig.reviewVerify` 已删除。它留在 `REVIEW_QUEUE_ONLY` 里是作为「这些变量实际住在哪」
 * 的说明，因此下面那条「无过期豁免」检查的作用域只覆盖 `PINNED_BY_WORKFLOW`。两张表分开，才让两句话
 * 同时为真。
 */

/**
 * Pinned to a literal path by the workflow's own steps. Forwarding these would let a repository
 * setting move the file away from the path `actions/upload-artifact` and `actions/cache` hardcode,
 * so the upload would ship an empty directory while the run still looked green.
 * 由工作流自己的步骤钉死为字面路径。透传它们会让仓库设置把文件挪离
 * `actions/upload-artifact` 与 `actions/cache` 写死的路径，于是上传打包空目录而运行看起来仍正常。
 */
const PINNED_BY_WORKFLOW = new Set([
  'BANGUMI_NEODB_FULL_SYNC_STATE', // actions/cache path: .cache/bangumi-neodb-full-sync.json
  'SYNC_SUMMARY_FILE', // the summary step cats .cache/sync-summary.md
  'SYNC_REPORT_FILE', // the artifact step uploads .cache/sync-report.json
  'NEODB_ITEM_YEAR_CACHE', // throwaway per-run cache; the code default is the right place
]);

const srcSources = fs
  .readdirSync(path.join(root, 'src'), { recursive: true })
  .map(String)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => fs.readFileSync(path.join(root, 'src', name), 'utf8'))
  .join('\n');

const srcEnvNames = new Set(
  [
    ...srcSources.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
    ...srcSources.matchAll(/envEnabled\('([A-Z][A-Z0-9_]+)'/g),
    ...srcSources.matchAll(/envInt\('([A-Z][A-Z0-9_]+)'/g),
    ...srcSources.matchAll(
      /(?:parseMergeProfile|parseBangumiMergeProfile|parseCategoryAllowlist)\(\s*'([A-Z][A-Z0-9_]+)'/g,
    ),
  ].map((match) => match[1]),
);

const mustBeForwarded = [...srcEnvNames].filter(
  (name) =>
    !RUNTIME_PROVIDED.has(name) &&
    !REVIEW_QUEUE_ONLY.has(name) &&
    !PINNED_BY_WORKFLOW.has(name),
);
const notForwarded = mustBeForwarded.filter((name) => !syncYmlKeys.has(name)).sort();
check(
  'sync.yml forwards every env var src/ reads (minus the documented exceptions)',
  notForwarded.length === 0,
  `read by src/ but never set in sync.yml: ${notForwarded.join(', ')}`,
);

// The exceptions must actually be exceptions: a name on the pinned list that `src/` no longer reads
// is a stale exemption, and stale exemptions are how the next real gap slips through unnoticed.
// `REVIEW_QUEUE_ONLY` is deliberately excluded from this sweep — those variables are read by a
// different process, so "src/ does not read it" is the normal case, not a staleness signal.
// 例外必须真的是例外：钉死清单上 `src/` 已经不读的名字是过期豁免，而过期豁免正是下一个真实缺口悄悄
// 溜过去的方式。`REVIEW_QUEUE_ONLY` 刻意不在本次扫描范围内 —— 那些变量由另一个进程读取，因此
// 「src/ 不读它」是常态，不是过期信号。
const staleExemptions = [...PINNED_BY_WORKFLOW].filter(
  (name) => !srcEnvNames.has(name),
);
check(
  'no stale exemption in the pinned-by-workflow list',
  staleExemptions.length === 0,
  `pinned but no longer read by src/: ${staleExemptions.sort().join(', ')}`,
);

check(
  'the review-queue-only exemptions are genuinely absent from src/',
  // The opposite direction, and the assertion that would have caught the dead `reviewVerify`
  // object: if `src/` starts reading one of these again, the exemption is a lie and the variable
  // must be re-examined.
  // 反方向，也正是那条能抓住死对象 `reviewVerify` 的断言：如果 `src/` 又开始读其中之一，这条豁免就是
  // 假的，该变量必须重新审视。
  [...REVIEW_QUEUE_ONLY].every((name) => !srcEnvNames.has(name)),
  `read by src/ but exempted as review-queue-only: ${[...REVIEW_QUEUE_ONLY]
    .filter((name) => srcEnvNames.has(name))
    .join(', ')}`,
);

check(
  'sync.yml no longer forwards the retired *_MERGE variables',
  // Rating and comment were split into two switches each; the old combined name has no reader.
  // 评分与短评已各自拆成两个开关；旧的合并名不再有任何读取方。
  !syncYmlKeys.has('SYNC_DOUBAN_NEODB_MERGE') &&
    !syncYmlKeys.has('SYNC_BANGUMI_NEODB_MERGE'),
  'SYNC_DOUBAN_NEODB_MERGE / SYNC_BANGUMI_NEODB_MERGE are still present',
);

summary();
