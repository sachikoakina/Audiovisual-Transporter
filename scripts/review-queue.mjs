#!/usr/bin/env node
/**
 * Turn one `sync` run's console log into a de-duplicated, incrementally maintained
 * review list, carried across runs by a 90-day Actions artifact.
 * 把一轮 `sync` 的控制台日志变成一份去重、增量维护的待核对名单，用 90 天的 Actions
 * artifact 跨轮携带。
 *
 * Design constraints (see docs/review-queue.md for the rationale):
 * 设计约束（理由见 docs/review-queue.md）：
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

/** Removal needs two consecutive absences, so one flaky run cannot delete anything. / 移除需要连续两轮缺席，避免一次抖动就删掉条目。 */
const MISSES_BEFORE_REMOVAL = 2;

const KIND_ORDER = ['unresolved', 'failed', 'skipped'];

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

const SOURCE_ORDER = [...SOURCE_LABELS.keys()];

/**
 * GFM task marker. Rendered as a checkbox by GitHub even inside an ordered list, which is
 * what lets an entry carry both "which one is this" (the number) and "have I dealt with it"
 * (the box). If some renderer disagrees, setting this to `''` degrades to a plain numbered
 * list — the numbering and the two-level structure stay intact.
 *
 * GFM 任务标记。GitHub 即使把它放在有序列表里也会渲染成勾选框，条目因此同时带「这是哪一条」
 * （编号）与「我处理了没」（方框）。若某个渲染器不认，把它改成 `''` 就退化成纯编号列表 ——
 * 编号与两级结构都不受影响。
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
 * Parse every log file under `logsDir`.
 * 解析 `logsDir` 下的每个日志文件。
 *
 * @returns {{ items: Array, unattributable: number, sawPathSummary: boolean }}
 *   `unattributable` counts lines that prove something was skipped but name nothing
 *   (path ⑤'s "Mark without a catalog item"), so the summary can say how much of the
 *   truth it is missing instead of silently dropping it.
 *   `unattributable` 统计「确实跳过了但没点名」的行（⑤ 的 "Mark without a catalog item"），
 *   让摘要能说明自己少看到了多少，而不是悄悄丢掉。
 */
export function parseLogs(logsDir) {
  /** @type {Map<string, any>} */
  const items = new Map();
  let unattributable = 0;
  let sawPathSummary = false;

  const add = (kind, source, reason, { url, id, title }) => {
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
        const title = line
          .slice(noMatch + 'No TMDB match; skip '.length)
          .replace(/\.$/, '');
        add('unresolved', 'neodb→tmdb', 'no-tmdb-match', { title });
        continue;
      }
      if (line.includes('Mark without a catalog item')) {
        unattributable += 1; // No title in the message. / 这行没有标题。
        continue;
      }

      // ── ③ Douban → Bangumi ────────────────────────────────────────────
      const noBangumi = line.indexOf('No Bangumi match, skip: ');
      if (noBangumi >= 0) {
        const label = splitLabel(
          line.slice(noBangumi + 'No Bangumi match, skip: '.length),
        );
        add('unresolved', 'douban→bangumi', 'no-bangumi-match', label || { title: '' });
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
      const noNeodb = line.indexOf('NeoDB could not resolve Bangumi URL, skip: ');
      if (noNeodb >= 0) {
        const url = line
          .slice(noNeodb + 'NeoDB could not resolve Bangumi URL, skip: '.length)
          .trim();
        add('unresolved', 'bangumi→neodb', 'neodb-unresolved', {
          url,
          id: bangumiSubjectId(url),
          title: url,
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
      // ①'s failures arrive through the shared detail section:
      //   · 标题[https://…] — notion-insert-failed
      // The reason suffix is kept in the key's reason so the causes stay distinguishable.
      // Not anchored at `^`: consola prefixes every line with a level badge of its own choosing
      // (`[warn]` in Actions, a padded `WARN` on a TTY), so the bullet never sits at column 0.
      // ① 的失败走共用的明细小节；原因后缀原样保留，不同成因因此仍可区分。
      // 刻意不锚定 `^`：consola 会给每行加上自己决定的级别标记（Actions 里是 `[warn]`，终端里
      // 是补白后的 `WARN`），项目符号永远不在第 0 列。
      const detailLine =
        /·\s*(.+?)\s+—\s+(notion-insert-failed|douban-scrape-failed|notion-category-failed)(?::.*)?$/.exec(
          line,
        );
      if (detailLine) {
        const label = detailLine[1].trim();
        add(
          'failed',
          'douban→notion',
          detailLine[2],
          splitLabel(label) || { title: label },
        );
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
 * Merge this run's observations into the carried-over list.
 * 把本轮的观测合并进沿用的名单。
 *
 * @returns {{ items: Array, added: Array, removed: Array, degraded: string }}
 */
export function merge(previous, observed, runStartedAt) {
  const observedByKey = new Map(observed.map((item) => [item.key, item]));
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  const added = [];
  const removed = [];
  const items = [];

  // A run that parsed nothing while the last snapshot had entries is far more likely
  // to be a parser break than a sudden fix of everything. Keep the list, say so.
  // 上一份快照有条目而本轮一条都没解析到，更可能是解析器坏了而不是问题全修好了。保留名单，
  // 并明确说出来。
  const degraded =
    observed.length === 0 && previous.length > 0
      ? 'parsed nothing this run while the previous snapshot is non-empty — sweep skipped'
      : '';

  for (const entry of previous) {
    const seen = observedByKey.get(entry.key);
    if (seen) {
      items.push({
        ...entry,
        ...seen,
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

  return { items, added, removed, degraded };
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

/** Position in the ①→⑤ order. Unknown slugs rank after every known one. / ①→⑤ 的位次；未知 slug 排在最后。 */
function sourceRank(source) {
  const rank = SOURCE_ORDER.indexOf(source);
  return rank === -1 ? SOURCE_ORDER.length : rank;
}

/** Deterministic tie-break: never `localeCompare`, whose order depends on the runner's ICU. / 确定性兜底比较，不用受 ICU 影响的 `localeCompare`。 */
function byText(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

const compareSource = (a, b) =>
  sourceRank(a) - sourceRank(b) || byText(String(a), String(b));

const compareKind = (a, b) => {
  const rank = (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return rank(a) - rank(b) || byText(String(a), String(b));
};

export function render({
  items,
  added,
  removed,
  degraded,
  runStartedAt,
  runUrl,
  unattributable,
}) {
  const now = runStartedAt;
  const live = listed(items);
  const observing = items.filter(
    (item) => (item.seenCount || 1) < (MIN_ROUNDS[item.kind] ?? 1),
  );

  const out = [];
  out.push(`# 待核对名单（${live.length} 条）`);
  out.push('');
  out.push(`本轮运行：${runUrl ? `[${runStartedAt}](${runUrl})` : runStartedAt}`);
  out.push('');
  out.push(
    `新增 **${added.filter((item) => listed([item]).length > 0).length}** · ` +
      `移除 **${removed.length}** · 观察中 **${observing.length}** · 名单合计 **${live.length}**`,
  );
  out.push('');

  if (degraded) {
    out.push(
      '> ⚠️ **本轮未采信**：' + degraded + '。名单保持不变，请检查日志格式是否变了。',
    );
    out.push('');
  }
  if (unattributable > 0) {
    out.push(
      `> 另有 **${unattributable}** 处日志证明有条目被跳过但没有点名（如 ` +
        '`Mark without a catalog item`），无法归属到具体条目。',
    );
    out.push('');
  }

  if (added.length) {
    out.push('## 本轮新增');
    out.push('');
    for (const item of added) {
      out.push(
        `- \`${item.kind}\` ${item.title} — ${item.reason}（${sourceLabel(item.source)}）`,
      );
    }
    out.push('');
  }
  if (removed.length) {
    out.push('## 本轮移除（已连续两轮未出现）');
    out.push('');
    for (const item of removed) {
      out.push(`- ~~${item.title}~~ — ${item.reason}（${sourceLabel(item.source)}）`);
    }
    out.push('');
  }

  // Two passes: bucket by path first (buckets keep `live`'s order, i.e. `state.json`'s
  // order, so entries never jump between runs), then walk the paths in ①→⑤ order.
  // 两趟：先按链路分桶（桶内保持 `live` 的顺序，也就是 `state.json` 的顺序，条目因此不会在
  // 两轮之间跳位），再按 ①→⑤ 的顺序输出。
  const bySource = new Map();
  for (const item of live) {
    const bucket = bySource.get(item.source);
    if (bucket) {
      bucket.push(item);
    } else {
      bySource.set(item.source, [item]);
    }
  }

  for (const source of [...bySource.keys()].sort(compareSource)) {
    const group = bySource.get(source);
    out.push(`## ${sourceLabel(source)}`);
    out.push('');

    // Kinds are derived from the group rather than taken from `KIND_ORDER`: a kind that is
    // not in that list would otherwise be dropped silently, and `# 待核对名单（N 条）`
    // would stop matching the sum of the subsections.
    // 档位从分组里派生，而不是遍历 `KIND_ORDER`：否则不在列表里的档位会被静默丢掉，
    // 「# 待核对名单（N 条）」就不再等于各小节之和。
    const kinds = [...new Set(group.map((item) => item.kind))].sort(compareKind);
    for (const kind of kinds) {
      const bucket = group.filter((item) => item.kind === kind);
      if (!bucket.length) {
        continue;
      }
      out.push(`### ${kind}（${bucket.length}）`);
      out.push('');
      bucket.forEach((item, index) => {
        const age = daysSince(item.firstSeenAt, now);
        // Path ④ has no title in its log line, so `add()` falls back to the URL as the title;
        // printing it twice (`https://… — https://…`) would only add noise.
        // ④ 的日志行里没有标题，`add()` 会退化成用 URL 当标题；再拼一次链接只多出噪声。
        const link = item.url && item.url !== item.title ? ` — ${item.url}` : '';
        out.push(
          `${index + 1}. ${TASK_BOX}${item.title}${link} · ${item.reason} · 已存在 ${age} 天 · 见过 ${item.seenCount} 次`,
        );
      });
      out.push('');
    }
  }

  if (observing.length) {
    out.push(`## 观察中（${observing.length}，下一轮仍出现才入名单）`);
    out.push('');
    for (const item of observing) {
      // The path is spelled out here too: without it the reader cannot tell which H2 this
      // entry will land under once it clears its observation window.
      // 这里也标注链路：否则读者无法判断它在过了观察期后会落到哪个 H2 下。
      out.push(
        `- \`${item.kind}\` ${item.title} — ${item.reason}（${sourceLabel(item.source)}）`,
      );
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    '采集自本轮 `sync` 的控制台日志，**只包含同步过程打印过的条目**。' +
      '② Douban → NeoDB 的未匹配条目当前只记数量、不打印标题，因此不会出现在这里；' +
      '白名单过滤、增量命中、重复跳过属于设计行为，也不采集。',
  );

  return out.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
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

  if (!logsDir || !fs.existsSync(logsDir)) {
    // Nothing to read is not a crash: report it and leave the old snapshot alone.
    // 没东西可读不该算崩溃：报告出来并保留旧快照。
    console.error(`No logs directory at ${logsDir || '(unset)'}; nothing collected.`);
    process.exitCode = 0;
    return;
  }

  const { items: observed, unattributable } = parseLogs(logsDir);
  const previous = loadState(stateFile);
  const { items, added, removed, degraded } = merge(previous, observed, runStartedAt);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'state.json'),
    `${JSON.stringify({ version: 1, runStartedAt, items }, null, 2)}\n`,
    'utf8',
  );

  const summary = render({
    items,
    added,
    removed,
    degraded,
    runStartedAt,
    runUrl,
    unattributable,
  });
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
        unattributable,
        degraded,
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
