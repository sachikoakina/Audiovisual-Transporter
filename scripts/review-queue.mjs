#!/usr/bin/env node
/**
 * Turn one `sync` run's console log into a de-duplicated, incrementally maintained
 * review list, carried across runs by a 90-day Actions artifact.
 * 把一轮 `sync` 的控制台日志变成一份去重、增量维护的待核对名单，用 90 天的 Actions
 * artifact 跨轮携带。
 *
 * Design constraints (see the review queue section of docs/reference.md):
 * 设计约束（理由见 docs/reference.md 的「待核对名单」）：
 *
 *   1. It reads logs only. `src/` is untouched, so it cannot invent facts that the
 *      sync did not already print.
 *      只读日志。`src/` 未被改动，因此它无法编造同步过程没有打印过的事实。
 *   2. A parse failure must never wipe the list. If this run yields zero items while
 *      the previous snapshot is non-empty, the sweep is skipped and the summary says
 *      so — "empty list" and "nothing worth reviewing" are different claims.
 *      解析失败绝不能清空名单。若本轮一条都没解析到而上一份快照非空，则跳过淘汰并在
 *      摘要里说明 —— 「名单为空」与「没有需要核对的东西」是两回事。
 *   3. Artifacts are immutable and can only be written whole, so "incremental" here
 *      means the list's semantics (keep `firstSeenAt`, delete only on disappearance),
 *      not that the file is patched in place.
 *      artifact 不可变、只能整份写入，因此这里的「增量」指名单语义（保留 `firstSeenAt`、
 *      仅在条目消失时删除），而不是对文件做原地补丁。
 */

import fs from 'node:fs';
import path from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// What each kind needs before it earns a place in the list
// 每档进入名单前需要满足的条件
// ───────────────────────────────────────────────────────────────────────────

/**
 * Failed items wait a round: most `failed` lines are network blips, and a list that
 * gains an entry every time a request times out is a list nobody reads.
 * `failed` 要等一轮：多数 `failed` 是网络抖动，一个「每次超时都多一条」的名单没人会看。
 */
const MIN_ROUNDS = { unresolved: 1, skipped: 1, failed: 2 };

/** Removal needs two consecutive absences the run could actually observe, so one flaky run cannot delete anything. / 移除需要连续两轮「本轮确实看过」的缺席，避免一次抖动就删掉条目。 */
const MISSES_BEFORE_REMOVAL = 2;

const KIND_ORDER = ['unresolved', 'failed', 'skipped'];

/** Item-type order and display names. Mirrors `src/rules/review-vocab.ts`. / 类型顺序与显示名，与词汇模块一致。 */
const CATEGORY_ORDER = [
  'movie',
  'tv',
  'anime',
  'book',
  'music',
  'game',
  'podcast',
  'performance',
  'other',
];
const CATEGORY_LABELS = new Map([
  ['movie', '电影'],
  ['tv', '电视剧'],
  ['anime', '动画'],
  ['book', '书籍'],
  ['music', '音乐'],
  ['game', '游戏'],
  ['podcast', '播客'],
  ['performance', '演出'],
  ['other', '其他'],
]);

/** User-state order and display names; `unknown` is the fallback group. / 用户状态顺序与显示名；`unknown` 是兜底分组。 */
const SHELF_ORDER = [
  'wishlist',
  'progress',
  'complete',
  'on_hold',
  'dropped',
  'unknown',
];
const SHELF_LABELS = new Map([
  ['wishlist', '想看'],
  ['progress', '在看'],
  ['complete', '看过'],
  ['on_hold', '搁置'],
  ['dropped', '抛弃'],
  ['unknown', '未知'],
]);

/**
 * Trailing `{category|shelf}` on a per-item log line. Curly braces keep it apart from the
 * `标题[链接]` shape; a line from an older run has none and falls back to `other` / `unknown`.
 * 逐条日志行末尾的 `{category|shelf}`。花括号使它不与 `标题[链接]` 混淆；旧日志没有它，回落到
 * `other` / `unknown`。
 */
const META_PATTERN = /\s*\{([a-z]+)\|([a-z_]+)\}\s*\.?$/;

function splitMeta(text) {
  const match = META_PATTERN.exec(text);
  if (!match) {
    return { text: text.trim(), category: '', shelf: '' };
  }
  return {
    text: text.slice(0, match.index).trim(),
    category: match[1],
    shelf: match[2],
  };
}

function normalizeCategory(value) {
  const key = String(value || '').toLowerCase();
  return CATEGORY_ORDER.includes(key) ? key : 'other';
}

function normalizeShelf(value) {
  const key = String(value || '').toLowerCase();
  return SHELF_ORDER.includes(key) ? key : 'unknown';
}

const compareCategory = (a, b) =>
  CATEGORY_ORDER.indexOf(normalizeCategory(a)) -
    CATEGORY_ORDER.indexOf(normalizeCategory(b)) || byText(a, b);

const compareShelf = (a, b) =>
  SHELF_ORDER.indexOf(normalizeShelf(a)) - SHELF_ORDER.indexOf(normalizeShelf(b)) ||
  byText(a, b);

/**
 * Path slug → display name. The keys are exactly the five literals passed to `add()`
 * (arrow U+2192, no spaces); the values are byte-identical to the `LABEL` constants in
 * `src/paths/*.ts`. That matters: one path is then spelled the same way in the console
 * log, in sync's own job summary and in this list, so a single grep lines them up.
 *
 * Insertion order is ①→⑤, which is also the render order — not alphabetical, not by
 * count. `Map` rather than an object literal: `state.json` is hand-editable and an object
 * lookup on `constructor` / `toString` would return a prototype function.
 *
 * 链路 slug → 显示名。key 恰是 `add()` 收到的五个字面量（箭头 U+2192，无空格），value 与
 * `src/paths/*.ts` 的 `LABEL` 逐字相同。这一点很重要：同一条链路在控制台日志、sync 自己的
 * 作业摘要、这份名单里写法一致，一次 grep 就能对齐。
 *
 * 插入顺序 = ①→⑤，也就是渲染顺序 —— 不按字母、不按条数。用 `Map` 而不是对象字面量：
 * `state.json` 可手工编辑，而对象字面量在 `constructor` / `toString` 这类键上会取到原型链函数。
 */
const SOURCE_LABELS = new Map([
  ['douban→notion', 'Douban → Notion'],
  ['douban→neodb', 'Douban → NeoDB'],
  ['douban→bangumi', 'Douban → Bangumi'],
  ['bangumi→neodb', 'Bangumi → NeoDB'],
  ['neodb→tmdb', 'NeoDB → TMDB'],
]);

/**
 * Display label → path slug. `PathReport.label` and `SOURCE_LABELS` carry byte-identical strings
 * (that is what makes one grep line up the console log, the job summary and this list), so the
 * run report can be joined to the list without a second mapping table.
 * 显示名 → 链路 slug。`PathReport.label` 与 `SOURCE_LABELS` 逐字相同（这正是「一次 grep 就能把
 * 控制台日志、作业摘要与这份名单对齐」的依据），因此运行报表不需要第二张映射表就能接到名单上。
 */
const SOURCE_BY_LABEL = new Map(
  [...SOURCE_LABELS.entries()].map(([source, label]) => [label, source]),
);

/**
 * GFM task marker — the "have I dealt with it" box.
 *
 * The number is deliberately *not* the list marker. GitHub sets `list-style-type: none` on
 * task-list items so the checkbox can occupy the marker slot, which silently eats an
 * `1. [ ] title` list marker: the rendered panel then shows boxes with no visible numbering at
 * all. The ordinal therefore goes into the item text (`**3.**`), where no stylesheet can take it
 * away. Setting this constant to `''` drops the checkbox and leaves the numbering untouched.
 *
 * GFM 任务标记 —— 「我处理了没」那个方框。
 *
 * 编号**刻意不放在列表标记里**。GitHub 给任务列表项设了 `list-style-type: none`，好让复选框
 * 占住标记位，于是 `1. [ ] 标题` 的列表标记会被悄悄吃掉：渲染出来的面板只有一排方框，看不到
 * 任何编号。因此序号写进条目正文（`**3.**`），任何样式表都拿不走它。把这个常量改成 `''`
 * 只会去掉方框，编号不受影响。
 */
const TASK_BOX = '[ ] ';

// ───────────────────────────────────────────────────────────────────────────
// Log parsing
// 日志解析
//
// Deliberately substring-based rather than anchored at line start: consola prefixes
// every line with a level badge and may add ANSI colour, so anchoring would break on
// a logging-library upgrade instead of on a message change.
// 刻意按子串匹配而不是锚定行首：consola 会给每行加级别标记、可能带 ANSI 颜色，锚定行首会
// 因为日志库升级而失效，而不是因为文案变化。
// ───────────────────────────────────────────────────────────────────────────

// Matching a control character is the whole job here: consola colourises every line in a TTY,
// and an unstripped escape sequence breaks the title/reason split.
// 这里匹配控制字符正是目的本身：consola 在 TTY 里给每行上色，没剥掉的转义序列会破坏
// 标题 / reason 的切分。
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `title[url]` → `{ title, url }`, else `null`. Used by path ② and ③ labels. / 解析 `标题[链接]` 形式。 */
function splitLabel(label) {
  const trimmed = label.trim();
  const open = trimmed.lastIndexOf('[');
  if (open <= 0 || !trimmed.endsWith(']')) {
    return null;
  }
  const url = trimmed.slice(open + 1, -1).trim();
  if (!/^https?:\/\//.test(url)) {
    return null;
  }
  return { title: trimmed.slice(0, open).trim(), url };
}

/** Bangumi subject id out of `https://bgm.tv/subject/123` or `subject/123`. / 从链接里取 Bangumi 条目 id。 */
function bangumiSubjectId(text) {
  const match = /subject\/(\d+)/.exec(text);
  return match ? `bangumi:${match[1]}` : '';
}

/**
 * Identity of one item. Stable across rounds, which is the whole point: the same
 * obscure title must map to the same key on every run.
 * 一条条目的身份。跨轮稳定才是重点：同一个冷门标题每轮都必须映射到同一个 key。
 *
 * URLs win over titles because titles get re-edited on Douban (the very thing the
 * reader is here to fix), and an id that changes when you fix the title would
 * re-create the entry you just fixed.
 * URL 优先于标题，因为豆瓣标题会被改（而改标题正是读者要做的事），一个「改了标题就变」的
 * id 会把你刚修好的条目重新创建出来。
 */
function makeKey(source, { url, id, title }) {
  return `${source}::${url || id || `title:${title}`}`;
}

/**
 * `· 标签 — reason` lines from a detail section, and the path that printed them.
 *
 * The reason slug is the router. Every `failedItems` / `skippedItems` entry carries one, and
 * `src/` spells it the same way in the console detail section as in the job summary, so the slug
 * is the only thing a log reader needs. Before this table the rule knew three slugs, all belonging
 * to ① — a `failed` from ③ printed `· 标题[链接] — bangumi-write-rejected`, matched nothing, and
 * vanished from the list without a trace.
 *
 * A slug earns a place here only if exactly one path emits it. `category-not-allowed` (①②③) and
 * `guard-target-status` (②…④) are shared, so they stay out: guessing a source would be worse than
 * saying "could not attribute", which the summary already does in words.
 *
 * `· 标签 — reason` 明细行 → 打印它的链路。
 *
 * 靠 reason slug 路由。每个 `failedItems` / `skippedItems` 条目都带一个，`src/` 在控制台明细
 * 与控制台摘要里写法一致，因此日志读者只需要认 slug。这张表出现之前规则只认三个 slug、全属 ①
 * —— ③ 的 `failed` 打的是 `· 标题[链接] — bangumi-write-rejected`，一条规则都不匹配，于是
 * 无声无息地从名单里消失。
 *
 * 只有唯一链路使用的 slug 才能进表。`category-not-allowed`（①②③）与 `guard-target-status`
 * （②…④）是多条链路共用的，留在表外：猜一个来源比「无法归属」更坏，而后者摘要里已经用文字说了。
 */
const DETAIL_REASONS = new Map([
  ['notion-insert-failed', ['failed', 'douban→notion']],
  ['douban-scrape-failed', ['failed', 'douban→notion']],
  ['notion-category-failed', ['failed', 'douban→notion']],
  ['neodb-mark-rejected', ['failed', 'douban→neodb']],
  ['neodb-item-threw', ['failed', 'douban→neodb']],
  ['neodb-read-failed', ['failed', 'douban→neodb']],
  ['bangumi-write-rejected', ['failed', 'douban→bangumi']],
  ['bangumi-item-threw', ['failed', 'douban→bangumi']],
  ['bangumi-read-failed', ['failed', 'douban→bangumi']],
  ['item-threw', ['failed', 'bangumi→neodb']],
  ['tmdb-item-threw', ['failed', 'neodb→tmdb']],
  ['no-catalog-item', ['failed', 'neodb→tmdb']],
  ['tmdb-write-failed', ['failed', 'neodb→tmdb']],
]);

/**
 * Anchored on a known slug rather than on a loose ` — `: a title may contain a dash, and a reason
 * may carry `: <error message>` after it. Not anchored at `^` because consola prefixes every line
 * with a level badge of its own choosing (`[warn]` in Actions, a padded `WARN` on a TTY).
 * 以「已知 slug」为准，而不是松散的 ` — `：标题里可能带破折号，reason 后面还可能跟着
 * `: <错误信息>`。刻意不锚定 `^`，因为 consola 会给每行加级别标记（Actions 里是 `[warn]`，
 * 终端里是补白后的 `WARN`）。
 */
const DETAIL_PATTERN = new RegExp(
  `·\\s*(.+?)\\s+—\\s+(${[...DETAIL_REASONS.keys()].join('|')})(?::.*)?$`,
);

/**
 * Parse every log file under `logsDir`.
 * 解析 `logsDir` 下的每个日志文件。
 *
 * @returns {{ items: Array, unattributable: number, sawPathSummary: boolean }}
 *   `unattributable` counts lines that prove something was skipped or failed but cannot be
 *   pinned to an item or a path (⑤'s "Mark without a catalog item", a detail line whose reason
 *   slug is shared or unregistered), so the summary can say how much of the truth it is missing
 *   instead of silently dropping it.
 *   `unattributable` 统计「确实跳过或失败了、却既点不了名也归不了属」的行（⑤ 的
 *   "Mark without a catalog item"、reason slug 共用或未登记的明细行），让摘要能说明自己少看到
 *   了多少，而不是悄悄丢掉。
 */
export function parseLogs(logsDir) {
  /** @type {Map<string, any>} */
  const items = new Map();
  let unattributable = 0;
  let sawPathSummary = false;

  const add = (kind, source, reason, { url, id, title, category, shelf }) => {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle && !url && !id) {
      unattributable += 1;
      return;
    }
    const key = makeKey(source, { url, id, title: cleanTitle });
    const existing = items.get(key);
    if (existing) {
      // Same item reported twice (e.g. unresolved here, skipped there) — keep the
      // first kind, because that is the one that needs the human.
      // 同一条被报两次（例如既 unresolved 又 skipped）—— 保留先出现的档位，因为那才是需要
      // 人工介入的那个。
      return;
    }
    items.set(key, {
      key,
      kind,
      source,
      reason,
      title: cleanTitle || url || id,
      url: url || '',
      id: id || '',
      category: normalizeCategory(category),
      shelf: normalizeShelf(shelf),
    });
  };

  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  if (fs.existsSync(logsDir)) {
    walk(logsDir);
  }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // Unreadable log file: the rest still count. / 读不了就跳过，其他文件仍有效。
    }
    const lines = text.replace(ANSI, '').split(/\r?\n/);

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        continue;
      }

      // ── ⑤ NeoDB → TMDB ────────────────────────────────────────────────
      const noMatch = line.indexOf('No TMDB match; skip ');
      if (noMatch >= 0) {
        const raw = line.slice(noMatch + 'No TMDB match; skip '.length);
        const { text, category, shelf } = splitMeta(raw);
        const label = splitLabel(text);
        add('unresolved', 'neodb→tmdb', 'no-tmdb-match', {
          url: label ? label.url : '',
          title: label ? label.title : text.replace(/\.$/, '').trim(),
          category,
          shelf,
        });
        continue;
      }
      if (line.includes('Mark without a catalog item')) {
        unattributable += 1; // No title in the message. / 这行没有标题。
        continue;
      }
      // ⑤'s per-item failure. Its wording is deliberately not ④'s `Item failed, continuing:`:
      // both paths used that string, so every failure here was filed under Bangumi → NeoDB.
      // ⑤ 的条目级失败。措辞刻意不用 ④ 的 `Item failed, continuing:`：两条链路原先用同一句，
      // 于是这里的每条失败都被记到 Bangumi → NeoDB 名下。
      const tmdbFailed = line.indexOf('TMDB write threw, continuing: ');
      if (tmdbFailed >= 0) {
        const title = line
          .slice(tmdbFailed + 'TMDB write threw, continuing: '.length)
          .replace(/\s+—.*$/, '');
        add('failed', 'neodb→tmdb', 'tmdb-item-threw', { title });
        continue;
      }

      // ── ③ Douban → Bangumi ────────────────────────────────────────────
      const noBangumi = line.indexOf('No Bangumi match, skip: ');
      if (noBangumi >= 0) {
        const { text, category, shelf } = splitMeta(
          line.slice(noBangumi + 'No Bangumi match, skip: '.length),
        );
        const label = splitLabel(text);
        add('unresolved', 'douban→bangumi', 'no-bangumi-match', {
          ...(label || { title: text.trim() }),
          category,
          shelf,
        });
        continue;
      }
      if (line.includes('Bangumi has Douban-absent status')) {
        const match = /skip overwrite:\s*subject\/(\d+)\s+type=(\S+)/.exec(line);
        add('skipped', 'douban→bangumi', 'guard-bangumi-status', {
          id: match ? `bangumi:${match[1]}` : '',
          title: match ? `bangumi subject ${match[1]} (${match[2]})` : '',
        });
        continue;
      }

      // ── ④ Bangumi → NeoDB ─────────────────────────────────────────────
      // `标题[链接]` since 2026-10-26; before that this path printed the URL alone, which is why
      // its entries used to reach the list as an address with no name. A bare URL is still
      // accepted (an older run's log, or a replayed artifact) and falls back to using the URL as
      // the name — the entry is still worth showing, it just cannot be recognised at a glance.
      // 2026-10-26 起是 `标题[链接]`；在此之前这条链路只打链接，所以它的条目一直是以「有地址、
      // 没名字」的样子进名单的。光秃秃的 URL 仍被接受（旧一轮的日志、重放的 artifact），退化
      // 成用 URL 当名字 —— 条目仍值得列出，只是没法一眼认出来。
      const noNeodb = line.indexOf('NeoDB could not resolve Bangumi URL, skip: ');
      if (noNeodb >= 0) {
        const { text, category, shelf } = splitMeta(
          line.slice(noNeodb + 'NeoDB could not resolve Bangumi URL, skip: '.length),
        );
        const label = splitLabel(text);
        add('unresolved', 'bangumi→neodb', 'neodb-unresolved', {
          url: label ? label.url : text,
          id: bangumiSubjectId(label ? label.url : text),
          title: label ? label.title : '',
          category,
          shelf,
        });
        continue;
      }
      const itemFailed = line.indexOf('Item failed, continuing: ');
      if (itemFailed >= 0) {
        const title = line
          .slice(itemFailed + 'Item failed, continuing: '.length)
          .replace(/\s+—.*$/, '');
        add('failed', 'bangumi→neodb', 'item-threw', { title });
        continue;
      }

      // ── ② Douban → NeoDB ──────────────────────────────────────────────
      // `No NeoDB match, skip: 标题[链接]` — one line per item, same shape as ③'s. This path used
      // to count an unresolved item and print nothing, which is why its data gaps never reached
      // the list even after the summary started naming them.
      // `No NeoDB match, skip: 标题[链接]` —— 每条一行，形状与 ③ 相同。这条链路原先只计数、
      // 什么都不打，因此即使摘要已经开始点名，它的数据缺口也从未进过名单。
      const noNeodbMatch = line.indexOf('No NeoDB match, skip: ');
      if (noNeodbMatch >= 0) {
        const { text, category, shelf } = splitMeta(
          line.slice(noNeodbMatch + 'No NeoDB match, skip: '.length),
        );
        const label = splitLabel(text);
        add('unresolved', 'douban→neodb', 'no-neodb-match', {
          ...(label || { title: text.trim() }),
          category,
          shelf,
        });
        continue;
      }
      const absentStatus = line.indexOf(
        'NeoDB has Douban-absent status, skip overwrite: ',
      );
      if (absentStatus >= 0) {
        const rest = line
          .slice(
            absentStatus + 'NeoDB has Douban-absent status, skip overwrite: '.length,
          )
          .replace(/\s+shelf_type=\S+$/, '');
        const label = splitLabel(rest);
        add(
          'skipped',
          'douban→neodb',
          'guard-target-status',
          label || { title: rest.trim() },
        );
        continue;
      }

      // ── ① Douban → Notion ─────────────────────────────────────────────
      const noSource = line.indexOf('No notion data source id for ');
      if (noSource >= 0) {
        // One entry per category, not per item: the thing to fix is one config line.
        // 按分类记一条而不是按条目：要修的只是一行配置。
        const category = line
          .slice(noSource + 'No notion data source id for '.length)
          .trim();
        add('skipped', 'douban→notion', 'no-notion-database', {
          id: `config:${category}`,
          title: `未配置 ${category} 的 Notion 数据源`,
        });
        continue;
      }
      // ── Detail sections, all five paths ───────────────────────────────
      //   · 标题[https://…] — notion-insert-failed
      // Routed by the reason slug, see `DETAIL_REASONS`. The slug is kept as the entry's reason so
      // the causes stay distinguishable.
      // 五条链路的明细小节都走这里，按 reason slug 路由（见 `DETAIL_REASONS`）。slug 原样作为
      // 条目的 reason，不同成因因此仍可区分。
      const detailLine = DETAIL_PATTERN.exec(line);
      if (detailLine) {
        const label = detailLine[1].trim();
        const [kind, source] = DETAIL_REASONS.get(detailLine[2]);
        // `(unknown)` is `src/` saying "there was nothing to name this with" (`labelOf`'s
        // fallback). Ingesting it would add one entry called "(unknown)" that stands for every
        // unnamed failure at once and can never be ticked off.
        // `(unknown)` 是 `src/` 在说「没有东西可用来命名它」（`labelOf` 的兜底）。收下它会得到
        // 一条叫 "(unknown)" 的条目，同时代表所有无名失败，而且永远勾不掉。
        if (label === '(unknown)') {
          unattributable += 1;
          continue;
        }
        add(kind, source, detailLine[2], splitLabel(label) || { title: label });
        continue;
      }
      // A `· … — slug` line whose slug is shared between paths or not registered yet. Counted,
      // never dropped: silently losing these is exactly how ③'s `failed` stayed invisible.
      // 项目符号行，但 slug 被多条链路共用、或新增后还没登记。计数，绝不丢弃 —— 上一轮 ③ 的
      // `failed` 一直看不见，正是因为这种行被静默丢掉。
      if (/·\s+.+\s+—\s+[a-z][a-z-]*[a-z](?::.*)?$/.test(line)) {
        unattributable += 1;
        continue;
      }

      // ── Cross-path summary lines ──────────────────────────────────────
      if (line.includes('unresolved item(s) — no counterpart at the destination')) {
        sawPathSummary = true;
      }
    }
  }

  return { items: [...items.values()], unattributable, sawPathSummary };
}

// ───────────────────────────────────────────────────────────────────────────
// State machine
// 状态机
// ───────────────────────────────────────────────────────────────────────────

function loadState(file) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return []; // Corrupt snapshot: start over rather than crash. / 快照损坏则从零开始。
  }
}

/**
 * The identity part of an entry's key — the same string `scannedIds` records for that item.
 *
 * `makeKey` builds `${source}::${url || id || 'title:' + title}`, and ⑤ is the one path whose
 * identity is a bare title, so the `title:` marker has to come off before comparing against the
 * run report (which stores the title, not this list's key syntax).
 * 条目 key 的身份段 —— 与 `scannedIds` 为同一条目记录的字符串相同。
 *
 * `makeKey` 拼的是 `${source}::${url || id || 'title:' + title}`，而 ⑤ 是唯一以纯标题为身份的
 * 链路，因此与运行报表比较前要去掉 `title:` 标记（报表存的是标题，不是本名单的 key 语法）。
 */
function scannedIdOf(entry) {
  const key = String(entry.key ?? '');
  const prefix = `${entry.source}::`;
  if (!key.startsWith(prefix)) {
    return '';
  }
  const rest = key.slice(prefix.length);
  return rest.startsWith('title:') ? rest.slice('title:'.length) : rest;
}

/**
 * Turn one run report into per-source coverage: which identities the run actually examined.
 *
 * A source with no entry in the report (the path is disabled, or the report is missing) yields
 * no coverage at all, and `merge` then freezes its entries instead of sweeping them. That is the
 * safe direction: "I did not look" must never be recorded as "it is gone".
 * 把一份运行报表折算成按链路划分的覆盖集合：本轮真正检查过哪些身份。
 *
 * 报表里没有某条链路（链路未启用，或报表缺失）时，该链路没有覆盖信息，`merge` 会冻结它的条目
 * 而不是淘汰它们。方向必须是安全的：「我没看」绝不能被记成「它没了」。
 */
export function coverageFromReport(report) {
  const coverage = new Map();
  for (const path of report?.paths ?? []) {
    const source = SOURCE_BY_LABEL.get(path.label);
    if (!source) {
      continue; // Aggregate reports (e.g. `Douban RSS`) are not review-list sources. / 汇总报表不是名单来源。
    }
    coverage.set(source, {
      ids: new Set(
        (Array.isArray(path.scannedIds) ? path.scannedIds : []).map((id) => String(id)),
      ),
      complete: !path.capped && !path.aborted,
      // Used only to tell a genuine "everything is fixed" round (report says 0 unresolved) from
      // a parser break (report counted some, the log yielded none).
      // 只用来区分真正的「全部修好」（报表计 0 条未匹配）与解析器失效（报表计了，日志却没解析到）。
      unresolved: Number(path.unresolved) || 0,
    });
  }
  return coverage;
}

/**
 * Merge this run's observations into the carried-over list.
 * 把本轮的观测合并进沿用的名单。
 *
 * Removal now has two conditions, not one: the entry must have been **examined** this run (its
 * identity is in the path's `scannedIds`) and must not have been reported again. A run that was
 * capped, paginated short or aborted simply examined fewer items, so the entries it never reached
 * are frozen rather than deleted. Without `coverage` (no run report) nothing is swept at all.
 * 淘汰现在有两个条件，而不是一个：条目本轮**被检查过**（身份在该链路的 `scannedIds` 里），且没有
 * 被再次报告。被配额截断、分页不足或中途中止的一轮，只是检查得少一些，没走到的条目因此被冻结
 * 而不是删除。没有 `coverage`（没有运行报表）时，一条都不淘汰。
 *
 * `missedRuns` keeps its old meaning — two consecutive misses — but an uncovered round resets it,
 * because the streak is only meaningful while every round in it actually looked at the item.
 * `missedRuns` 的「连续两轮」语义不变，但未覆盖的一轮会把它清零：只有这一串轮次真的都看过该条目，
 * 「连续」才有意义。
 *
 * @param {Map<string, {ids: Set<string>, complete: boolean, unresolved: number}> | null} coverage
 * @returns {{ items: Array, added: Array, removed: Array, degraded: string, uncovered: Array }}
 */
export function merge(previous, observed, runStartedAt, coverage = null) {
  const observedByKey = new Map(observed.map((item) => [item.key, item]));
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  const added = [];
  const removed = [];
  const uncovered = [];
  const items = [];

  // A run that parsed nothing while the last snapshot had entries is usually a parser break.
  // With a run report we can tell the two cases apart: if the report counted unresolved items,
  // the log should have carried them, so freeze; if it counted none, the silence is genuine and
  // the covered entries are allowed to age out. Without a report, coverage is empty anyway and
  // every absence is frozen — no need to guess.
  // 上一份快照有条目而本轮一条都没解析到，通常是解析器失效。有运行报表时两者可以区分：报表计了
  // 未匹配条目，日志就该有它们，冻结；报表计 0 条，沉默是真的，被覆盖的条目可以正常老化。没有
  // 报表时覆盖集合本来就是空的、所有缺席都会被冻结 —— 不必猜。
  const reportedUnresolved = coverage
    ? [...coverage.values()].reduce((sum, item) => sum + (item.unresolved || 0), 0)
    : 0;
  const degraded =
    observed.length === 0 && previous.length > 0 && reportedUnresolved > 0
      ? 'parsed nothing this run while the previous snapshot is non-empty — sweep skipped'
      : '';

  for (const entry of previous) {
    const seen = observedByKey.get(entry.key);
    if (seen) {
      items.push({
        ...entry,
        ...seen,
        // A log line without the `{category|shelf}` suffix must not erase what an earlier run
        // recorded; only a real value overwrites.
        // 没有 `{category|shelf}` 后缀的日志行不得抹掉上一轮记下的值；只有真实值才覆盖。
        category: seen.category || entry.category,
        shelf: seen.shelf || entry.shelf,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: runStartedAt,
        missedRuns: 0,
        seenCount: (entry.seenCount || 1) + 1,
      });
      continue;
    }
    if (degraded) {
      items.push(entry); // Freeze: no miss is counted. / 冻结：不计缺席。
      continue;
    }

    // The entry is absent from this run's log. That only means "fixed" if the run actually
    // examined the item; otherwise the run simply never got to it (cap, pagination, abort).
    // 条目没出现在本轮日志里。只有本轮真的检查过它，这才能读成「修好了」；否则只是没走到
    // （配额、分页、中止）。
    const sourceCoverage = coverage?.get(entry.source);
    if (!sourceCoverage || !sourceCoverage.ids.has(scannedIdOf(entry))) {
      uncovered.push(entry);
      items.push({ ...entry, missedRuns: 0 });
      continue;
    }

    const missedRuns = (entry.missedRuns || 0) + 1;
    if (missedRuns >= MISSES_BEFORE_REMOVAL) {
      removed.push(entry);
      continue;
    }
    items.push({ ...entry, missedRuns });
  }

  for (const entry of observed) {
    if (previousByKey.has(entry.key)) {
      continue;
    }
    const fresh = {
      ...entry,
      firstSeenAt: runStartedAt,
      lastSeenAt: runStartedAt,
      missedRuns: 0,
      seenCount: 1,
    };
    added.push(fresh);
    items.push(fresh);
  }

  return { items, added, removed, degraded, uncovered };
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// 渲染
// ───────────────────────────────────────────────────────────────────────────

/** Items that are in the list yet, i.e. past their observation window. / 仍在名单里的条目，即已过观察期。 */
function listed(items) {
  return items.filter((item) => (item.seenCount || 1) >= (MIN_ROUNDS[item.kind] ?? 1));
}

function daysSince(iso, now) {
  const diff = Date.parse(now) - Date.parse(iso);
  return Number.isFinite(diff) ? Math.max(0, Math.floor(diff / 86_400_000)) : 0;
}

/**
 * Display name for one path slug.
 *
 * An unknown slug is printed verbatim rather than mapped to something plausible: a missing
 * entry in `SOURCE_LABELS` has to be visible at a glance, not disguised as a normal heading.
 *
 * 链路 slug 的显示名。未知 slug **原样输出**，而不是套一个「看起来合理」的名字：映射表漏了
 * 一项，必须在第一眼就暴露，不能伪装成一个正常标题。
 */
function sourceLabel(source) {
  if (!source) {
    return '（未标注来源）';
  }
  return SOURCE_LABELS.get(source) ?? source;
}

/** Deterministic tie-break: never `localeCompare`, whose order depends on the runner's ICU. / 确定性兜底比较，不用受 ICU 影响的 `localeCompare`。 */
function byText(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

const compareKind = (a, b) => {
  const rank = (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return rank(a) - rank(b) || byText(String(a), String(b));
};

/**
 * One bullet for an entry that is a diff notice rather than a task: no checkbox, no ordinal. It is
 * not something to work through — it is what changed since the last round. The path used to trail
 * the line as `（链路）`; it is now the heading above it, so the line does not repeat it.
 * 「本轮新增 / 本轮移除 / 观察中」这种差量提示的条目行：没有复选框也没有序号，因为它不是待办清单，
 * 而是「上一轮之后变了什么」。链路原先跟在行尾当 `（链路）`，现在是它上面的标题，行内不再重复。
 *
 * Name first, link second — `名称 — 链接 · reason`. A bare address tells the reader nothing about
 * which entry needs a look, and ④'s lines used to carry nothing else.
 * 名称在前、链接在后 —— `名称 — 链接 · reason`。光一个地址说明不了是哪一条要核对，而 ④ 的行
 * 原先只有地址。
 *
 * `strike` marks a removed entry, and only the name is struck: the link stays clickable, because
 * "did it really get matched?" is exactly the question a removal raises.
 * `strike` 标记已移除的条目，且只有名字加删除线：链接保持可点 —— 「它真的匹配上了吗」正是移除会
 * 引出的那个问题。
 */
function diffLine(item, { strike = false } = {}) {
  const name = strike ? `~~${item.title}~~` : item.title;
  // The name falls back to the URL when the log had nothing better to name it with (④ before
  // 2026-10-26). Printing the address twice would only add noise.
  // 日志里没有更好的名字时名字会退化成 URL（2026-10-26 之前的 ④）。把地址打印两遍只会多出噪声。
  const link = item.url && item.url !== item.title ? ` — ${item.url}` : '';
  return `- \`${item.kind}\` ${name}${link} · ${item.reason}`;
}

export function render({
  items,
  added,
  removed,
  degraded,
  runStartedAt,
  runUrl,
  unattributable,
  uncovered = 0,
  coverageAvailable = true,
}) {
  const now = runStartedAt;
  const live = listed(items);
  const observing = items.filter(
    (item) => (item.seenCount || 1) < (MIN_ROUNDS[item.kind] ?? 1),
  );
  // What actually entered the list this round. `added` also holds entries still inside their
  // observation window; those are 观察中's business alone. Counting them here (as the old summary
  // line did, via `added.filter(listed)`) meant the number described something other than the body.
  // 本轮真正进入名单的条目。`added` 里还包含仍在观察期内的条目，那些只归「观察中」管。把它们
  // 也计进这里（旧计数行就是这么做的，用 `added.filter(listed)`）会让数字描述的并不是正文。
  const fresh = listed(added);

  const out = [];
  // The list title stays bold text, not an H1: the results (`unresolved` / `failed` / `skipped`)
  // are the H1s below, which is the structure this list is read in. Two H1 levels would make the
  // document outline say two different things about the same level.
  // 标题用加粗行而不是 H1：下面的结果（`unresolved` / `failed` / `skipped`）才是一级标题，
  // 两级 H1 会让文档大纲对同一层级给出两种说法。
  out.push(`**待核对名单（${live.length} 条）**`);
  out.push('');
  out.push(`本轮运行：${runUrl ? `[${runStartedAt}](${runUrl})` : runStartedAt}`);
  out.push('');
  out.push(
    `新增 **${fresh.length}** · ` +
      `移除 **${removed.length}** · 观察中 **${observing.length}** · 名单合计 **${live.length}**`,
  );
  out.push('');

  if (degraded) {
    out.push(
      '> ⚠️ **本轮未采信**：' + degraded + '。名单保持不变，请检查日志格式是否变了。',
    );
    out.push('');
  }
  // Coverage is the second half of the same promise: a capped/paginated run must not look like a
  // run that fixed everything. The notice is deliberately placed next to `degraded` — both say
  // "this round could not see everything", and a reader should meet them together.
  // 覆盖范围是同一个承诺的另一半：被截断的一轮不能看起来像「全都修好了」。这条提示刻意放在
  // `degraded` 旁边 —— 两者都在说「本轮没看全」，读者应该在同一处遇到它们。
  if (!coverageAvailable) {
    out.push(
      '> 本轮没有运行报表（`sync-report.json`），无法确认哪些条目被扫描到；名单只更新、不移除。',
    );
    out.push('');
  } else if (uncovered > 0) {
    out.push(
      `> 本轮有 **${uncovered}** 条不在扫描集合里（配额截断、分页上限或链路未运行），` +
        '已保留、不计缺席。',
    );
    out.push('');
  }
  if (unattributable > 0) {
    out.push(
      `> 另有 **${unattributable}** 处日志证明有条目被跳过或失败，但无法归属到具体条目或链路（如 ` +
        '`Mark without a catalog item`，或 reason 被多条链路共用、尚未登记的明细行）。',
    );
    out.push('');
  }

  // Change notices are a summary block, not sections: they describe what changed since the last
  // round, not the work waiting now. Giving them heading levels would compete with the
  // result→type→state outline and make it ambiguous which heading means what.
  // 变化提示是摘要块而不是小节：它说的是「上一轮之后变了什么」，不是现在要做的活。让它占用标题
  // 层级会与 结果→类型→状态 的大纲争夺含义。
  if (fresh.length) {
    out.push(`**本轮新增（${fresh.length}）**`);
    out.push('');
    for (const item of fresh) {
      out.push(`${diffLine(item)}（${sourceLabel(item.source)}）`);
    }
    out.push('');
  }
  if (removed.length) {
    out.push(`**本轮移除（${removed.length}，连续两轮被扫描到且未再出现）**`);
    out.push('');
    for (const item of removed) {
      out.push(`${diffLine(item, { strike: true })}（${sourceLabel(item.source)}）`);
    }
    out.push('');
  }
  if (observing.length) {
    out.push(`**观察中（${observing.length}，下一轮仍出现才入名单）**`);
    out.push('');
    for (const item of observing) {
      out.push(`${diffLine(item)}（${sourceLabel(item.source)}）`);
    }
    out.push('');
  }

  // Three levels, in the order a reader triages: result → item type → user state. The path stays
  // at the end of the line because it is per-entry information, not something to browse by.
  // 三层，按读者分诊的顺序：结果 → 类型 → 用户状态。链路留在行尾，因为它是逐条信息，不是用来
  // 浏览的分组。
  const kinds = [...new Set(live.map((item) => item.kind))].sort(compareKind);
  for (const kind of kinds) {
    const kindItems = live.filter((item) => item.kind === kind);
    out.push(`# ${kind}（${kindItems.length}）`);
    out.push('');

    const categories = [
      ...new Set(kindItems.map((item) => normalizeCategory(item.category))),
    ].sort(compareCategory);
    for (const category of categories) {
      const categoryItems = kindItems.filter(
        (item) => normalizeCategory(item.category) === category,
      );
      out.push(
        `## ${CATEGORY_LABELS.get(category) ?? category}（${categoryItems.length}）`,
      );
      out.push('');

      const shelves = [
        ...new Set(categoryItems.map((item) => normalizeShelf(item.shelf))),
      ].sort(compareShelf);
      for (const shelf of shelves) {
        const bucket = categoryItems.filter(
          (item) => normalizeShelf(item.shelf) === shelf,
        );
        out.push(`### ${SHELF_LABELS.get(shelf) ?? shelf}（${bucket.length}）`);
        out.push('');
        bucket.forEach((item, index) => {
          const age = daysSince(item.firstSeenAt, now);
          // Name, then link. `add()` falls back to the URL as the name when the log carried
          // nothing better, and printing the address twice would only add noise.
          // 名称在前、链接在后。日志里没有更好的名字时 `add()` 会退化成用 URL 当名称；再拼一次
          // 链接只多出噪声。
          const link = item.url && item.url !== item.title ? ` — ${item.url}` : '';
          // Bullet + checkbox + the ordinal in the text; see `TASK_BOX` for why the number cannot
          // be the list marker.
          // 项目符号 + 复选框 + 写在正文里的序号；编号为何不能当列表标记，见 `TASK_BOX`。
          out.push(
            `- ${TASK_BOX}**${index + 1}.** ${item.title}${link} · ${item.reason} · 已存在 ${age} 天（${sourceLabel(item.source)}）`,
          );
        });
        out.push('');
      }
    }
  }

  out.push('---');
  out.push('');
  out.push(
    '条目来自本轮 `sync` 的控制台日志，**只包含同步过程打印过的条目**；是否移除由 ' +
      '`sync-report.json` 的**扫描集合**（`PathReport.scannedIds`）决定 —— 只有本轮确实检查过、' +
      '且日志里不再出现的条目才计入缺席。被 `SYNC_MAX_ITEMS` / `NEODB_MAX_PAGES` 截断、' +
      '或链路未运行的部分会冻结在原处。' +
      '类别白名单过滤、增量命中、重复跳过属于设计行为，不采集；' +
      'reason 被多条链路共用（如 `category-not-allowed`）时不做猜测，只计入上面的「无法归属」计数。',
  );

  return out.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// The run's own report — the coverage oracle, and a cross-check on the parser
// 本轮运行自己的报表 —— 覆盖范围的依据，同时给解析器对账
//
// The list is still built from logs: a log line is what a human can also read, and swapping the
// parser out in one step would change what the list contains without anyone being able to say
// which change caused it. What the JSON adds is the fact a log cannot carry — **which items were
// examined at all**. A missing log line is ambiguous; a `scannedIds` hit is not. If the run
// counted 3 `failed` and the parser only recognised 1, that difference is still printed.
// 名单仍然由日志构建：日志行也是人能读的东西，而一次性替掉解析器会让名单内容变化，却没人能
// 说清是哪处改动造成的。JSON 补上的正是日志承载不了的事实 —— **哪些条目真的被检查过**。
// 缺一行日志是有歧义的；`scannedIds` 命中则没有歧义。若本轮计了 3 条 `failed` 而解析器只认出
// 1 条，这个差值仍然会被打印。

/**
 * Find the run report under `dir`, wherever the artifact was unzipped.
 * @param {string} dir
 * @returns {{paths: Array<{label: string, failed: number, skipped: number, unresolved: number, scanned: number, scannedIds?: string[], capped?: boolean, aborted?: boolean}>} | null}
 * 在 `dir` 下找到运行报表，不管 artifact 被解压到哪一层。
 */
export function readRunReport(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return null;
  }
  /** @type {string[]} */
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
  };
  walk(dir);

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // `version` + `paths` is the shape `publishRunReport` writes; anything else under the
      // artifact directory is not ours to read.
      // `version` + `paths` 就是 `publishRunReport` 写出的形状；artifact 目录下别的 JSON 不归我们读。
      if (parsed && parsed.version === 1 && Array.isArray(parsed.paths)) {
        return parsed;
      }
    } catch {
      // Not the report, or truncated. Try the next file; absence is handled by the caller.
      // 不是报表，或者被截断。试下一个；缺失由调用方处理。
    }
  }
  return null;
}

/**
 * Lines appended to the summary when a run report was available.
 * @param {{paths: Array<{label: string, failed: number, skipped: number, unresolved: number}>} | null} report
 * @param {Array<{kind: string}>} observed
 * @returns {string[]}
 */
export function runReportLines(report, observed) {
  if (!report) {
    return [];
  }
  const total = report.paths.reduce(
    (acc, item) => ({
      failed: acc.failed + (item.failed || 0),
      skipped: acc.skipped + (item.skipped || 0),
      unresolved: acc.unresolved + (item.unresolved || 0),
    }),
    { failed: 0, skipped: 0, unresolved: 0 },
  );
  const parsedFailed = observed.filter((item) => item.kind === 'failed').length;

  const lines = ['', '### 运行报表（JSON）', ''];
  lines.push(
    `报表合计：failed ${total.failed} · skipped ${total.skipped} · unresolved ${total.unresolved}。` +
      `本次从日志解析出 ${observed.length} 条（其中 failed ${parsedFailed} 条）。`,
  );

  const failedPaths = report.paths
    .filter((item) => (item.failed || 0) > 0)
    .map((item) => `\`${item.label}\` ${item.failed}`);
  if (failedPaths.length) {
    lines.push(`有 failed 的链路：${failedPaths.join(' · ')}。`);
  }

  if (total.failed > parsedFailed) {
    lines.push(
      `> ⚠️ 报表记了 ${total.failed} 条 failed，日志只解析出 ${parsedFailed} 条 —— ` +
        '差值意味着有失败行没有被任何规则认领（多半是 slug 未登记，或措辞改了而哨兵没跟上）。' +
        '这一节只做提示，不改变上面的名单。',
    );
  }
  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * Fill type and state from the run report when a log line did not carry them.
 *
 * The log suffix is the primary source; the report is the redundancy the user asked for. A line
 * from an older run has neither, and stays `other` / `unknown` rather than being dropped.
 * 日志后缀是主来源，报表是要求的冗余。旧一轮的日志两者都没有，保持 `other` / `unknown`，
 * 而不是被丢弃。
 */
export function attachReportMeta(items, report) {
  if (!report) {
    return items;
  }
  const index = new Map();
  for (const path of report.paths ?? []) {
    const source = SOURCE_BY_LABEL.get(path.label);
    if (!source) {
      continue;
    }
    const details = [
      ...(Array.isArray(path.unresolvedItems) ? path.unresolvedItems : []),
      ...(Array.isArray(path.failedItems) ? path.failedItems : []),
      ...(Array.isArray(path.skippedItems) ? path.skippedItems : []),
    ];
    for (const entry of details) {
      const meta = {
        category: normalizeCategory(entry.category),
        shelf: normalizeShelf(entry.shelf),
      };
      if (entry.url) {
        index.set(`${source}::${entry.url}`, meta);
      }
      if (entry.title) {
        index.set(`${source}::title:${entry.title}`, meta);
      }
    }
  }
  return items.map((item) => {
    const hit = index.get(item.key) || index.get(`${item.source}::title:${item.title}`);
    if (!hit) {
      return item;
    }
    return {
      ...item,
      category: item.category !== 'other' ? item.category : hit.category,
      shelf: item.shelf !== 'unknown' ? item.shelf : hit.shelf,
    };
  });
}

function main() {
  const logsDir = arg('logs', process.env.LOGS_DIR || '');
  const stateFile = arg('state', process.env.STATE_FILE || '');
  const outDir = arg('out', process.env.OUT_DIR || 'review-state');
  const runStartedAt = arg(
    'run-started-at',
    process.env.RUN_STARTED_AT || new Date().toISOString(),
  );
  const runUrl = arg('run-url', process.env.RUN_URL || '');
  const reportDir = arg('report', process.env.REPORT_DIR || '');

  if (!logsDir || !fs.existsSync(logsDir)) {
    // Nothing to read is not a crash: report it and leave the old snapshot alone.
    // 没东西可读不该算崩溃：报告出来并保留旧快照。
    console.error(`No logs directory at ${logsDir || '(unset)'}; nothing collected.`);
    process.exitCode = 0;
    return;
  }

  const parsed = parseLogs(logsDir);
  const previous = loadState(stateFile);
  // Read the report *before* the merge: it decides which absences may be counted, and it fills in
  // the type/state a log line may not have carried.
  // 在合并之前读报表：它决定哪些缺席可以计数，并补齐日志行可能没带的类型与状态。
  const report = readRunReport(reportDir);
  const observed = attachReportMeta(parsed.items, report);
  const unattributable = parsed.unattributable;
  const coverage = coverageFromReport(report);
  const { items, added, removed, degraded, uncovered } = merge(
    previous,
    observed,
    runStartedAt,
    coverage,
  );

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'state.json'),
    `${JSON.stringify({ version: 1, runStartedAt, items }, null, 2)}\n`,
    'utf8',
  );

  const summary = [
    render({
      items,
      added,
      removed,
      degraded,
      runStartedAt,
      runUrl,
      unattributable,
      uncovered: uncovered.length,
      coverageAvailable: report !== null,
    }),
    ...runReportLines(report, observed),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary}\n`, 'utf8');

  fs.writeFileSync(
    path.join(outDir, 'stats.json'),
    `${JSON.stringify(
      {
        runStartedAt,
        observed: observed.length,
        carried: previous.length,
        kept: items.length,
        added: added.length,
        removed: removed.length,
        uncovered: uncovered.length,
        unattributable,
        degraded,
        // Why the sweep did or did not happen, in one place. `complete: false` means at least one
        // path was capped or aborted, which is expected on a normal incremental run — the point
        // is that it is now recorded instead of being inferred from a shrinking list.
        // 淘汰为什么发生或没发生，集中在这里。`complete: false` 表示至少一条链路被截断或中止，
        // 这在正常增量运行里是常态 —— 重点是它现在被记录下来，而不是靠名单变短去反推。
        coverage: report
          ? {
              sources: coverage.size,
              complete: [...coverage.values()].every((item) => item.complete),
            }
          : null,
        runReport: report ? { paths: report.paths.length } : null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('review-queue.mjs')) {
  main();
}
