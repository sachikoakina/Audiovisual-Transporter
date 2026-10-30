/**
 * The shape of the review list: sync path → result → item type → user state.
 * 待核对名单的形状：同步链路 → 结果 → 条目类型 → 用户状态。
 *
 * The claims pinned here are the ones a future refactor can silently break: the heading levels,
 * the group order, the fallback buckets, and the fact that an entry keeps its link, reason and
 * age no matter which group it lands in — while the path lives in the H1 above it, not in the
 * line.
 * 这里钉住的是将来重构容易悄悄弄坏的东西：标题层级、分组顺序、兜底分组，以及条目无论落到哪一组
 * 都保留链接、reason 与已存在天数 —— 而链路由它上方的 H1 承载，不再出现在条目行里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLogs, render, type ReviewItem } from '../../scripts/review-queue.mjs';

const RUN_AT = '2026-10-26T08:00:00.000Z';

function item(over: Partial<ReviewItem>): ReviewItem {
  return {
    key: 'key',
    kind: 'unresolved',
    source: 'neodb→tmdb',
    reason: 'no-tmdb-match',
    title: '无题',
    url: '',
    id: '',
    category: 'movie',
    shelf: 'wishlist',
    firstSeenAt: RUN_AT,
    lastSeenAt: RUN_AT,
    missedRuns: 0,
    seenCount: 2,
    ...over,
  };
}

function renderText({
  items,
  added = [],
  removed = [],
}: {
  items: ReviewItem[];
  added?: ReviewItem[];
  removed?: ReviewItem[];
}): string {
  return render({
    items,
    added,
    removed,
    degraded: '',
    runStartedAt: RUN_AT,
    runUrl: '',
  });
}

/** The body under one heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) {
    return '';
  }
  const level = (heading.match(/^#+/) ?? [''])[0].length;
  const rest = text.slice(start + heading.length + 1).replace(/^\n+/, '');
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const bangumiUnresolved = item({
  key: 'bangumi→neodb::https://bgm.tv/subject/391457',
  source: 'bangumi→neodb',
  reason: 'neodb-unresolved',
  title: '狐妖小红娘13 黄风岭篇',
  url: 'https://bgm.tv/subject/391457',
  category: 'anime',
  shelf: 'progress',
});

const doubanBook = item({
  key: 'douban→bangumi::https://book.douban.com/subject/2/',
  source: 'douban→bangumi',
  reason: 'no-bangumi-match',
  title: '天仙配',
  url: 'https://book.douban.com/subject/2/',
  category: 'book',
  shelf: 'wishlist',
});

const tmdbMovie = item({
  key: 'neodb→tmdb::https://neodb.social/movie/1',
  title: 'Medalist (金牌得主 第二季)',
  url: 'https://neodb.social/movie/1',
  category: 'movie',
  shelf: 'dropped',
});

describe('render — 链路作为一级标题', () => {
  it('emits one H1 per sync path, in ①→⑤ order, with counts', () => {
    const failed = item({
      kind: 'failed',
      reason: 'tmdb-item-threw',
      category: 'tv',
      shelf: 'complete',
    });
    const text = renderText({
      items: [tmdbMovie, failed, doubanBook, bangumiUnresolved],
    });

    expect(text).toContain('# Douban → Bangumi（1）');
    expect(text).toContain('# Bangumi → NeoDB（1）');
    expect(text).toContain('# NeoDB → TMDB（2）');
    expect(text.indexOf('# Douban → Bangumi')).toBeLessThan(
      text.indexOf('# Bangumi → NeoDB'),
    );
    expect(text.indexOf('# Bangumi → NeoDB')).toBeLessThan(
      text.indexOf('# NeoDB → TMDB'),
    );
  });

  it('does not use a heading for the list title, so H1 means a sync path', () => {
    const text = renderText({ items: [tmdbMovie] });

    expect(text).toContain('**待核对名单（1 条）**');
    expect(text).not.toContain('# 待核对名单');
  });
});

describe('render — 结果、类型与状态', () => {
  it('groups by result under each path (H2), in unresolved → failed → skipped order', () => {
    const skipped = item({ kind: 'skipped', reason: 'guard-target-status' });
    const text = renderText({ items: [tmdbMovie, skipped] });
    const body = section(text, '# NeoDB → TMDB（2）');

    expect(body).toContain('## unresolved（1）');
    expect(body).toContain('## skipped（1）');
    expect(body.indexOf('## unresolved')).toBeLessThan(body.indexOf('## skipped'));
  });

  it('groups by item type under each result (H3), in the fixed order', () => {
    const tv = item({ category: 'tv', shelf: 'complete' });
    const text = renderText({ items: [tmdbMovie, tv] });
    const body = section(text, '# NeoDB → TMDB（2）');

    expect(body).toContain('### 电影（1）');
    expect(body).toContain('### 电视剧（1）');
    expect(body.indexOf('### 电影')).toBeLessThan(body.indexOf('### 电视剧'));
  });

  it('groups by user state under each type (H4), in the fixed order', () => {
    const wishing = item({ shelf: 'wishlist' });
    const text = renderText({ items: [tmdbMovie, wishing] });
    const body = section(text, '# NeoDB → TMDB（2）');

    expect(body).toContain('#### 想看（1）');
    expect(body).toContain('#### 抛弃（1）');
    expect(body.indexOf('#### 想看')).toBeLessThan(body.indexOf('#### 抛弃'));
  });

  it('renders the entry line with checkbox, ordinal, link, reason and age under the H4', () => {
    const text = renderText({ items: [bangumiUnresolved] });
    const body = section(text, '# Bangumi → NeoDB（1）');

    expect(body).toContain('#### 在看（1）');
    expect(body).toContain(
      '- [ ] **1.** 狐妖小红娘13 黄风岭篇 — https://bgm.tv/subject/391457',
    );
  });

  it('keeps link, reason and age on the item line, and leaves the path to the H1', () => {
    const text = renderText({ items: [bangumiUnresolved] });

    expect(text).toContain('· neodb-unresolved · 已存在 0 天');
    expect(section(text, '# Bangumi → NeoDB（1）')).not.toContain(
      '（Bangumi → NeoDB）',
    );
  });
});

describe('render — 缺失类型与状态', () => {
  it('folds a missing type into 其他 (H3) and a missing state into 未知 (H4)', () => {
    const bare = item({ title: '无名', url: '', category: '', shelf: '' });
    const text = renderText({ items: [bare] });

    expect(text).toContain('### 其他（1）');
    expect(text).toContain('#### 未知（1）');
  });

  it('counts every entry exactly once at every level', () => {
    const text = renderText({ items: [tmdbMovie, doubanBook, bangumiUnresolved] });
    const h1 = [...text.matchAll(/^# .+（(\d+)）$/gm)].map((m) => Number(m[1]));
    const h4 = [...text.matchAll(/^#### .+（(\d+)）$/gm)].map((m) => Number(m[1]));

    expect(h1.reduce((a, b) => a + b, 0)).toBe(3);
    expect(h4.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('render — 变化摘要块', () => {
  it('uses a bold block, not headings, for 本轮新增', () => {
    const text = renderText({ items: [doubanBook], added: [doubanBook] });

    expect(text).toContain('**本轮新增（1）**');
    expect(text).not.toContain('## 本轮新增');
    expect(text).toContain(
      '- `unresolved` 天仙配 — https://book.douban.com/subject/2/',
    );
  });

  it('marks removals with a strikethrough and keeps the path', () => {
    const text = renderText({ items: [], removed: [doubanBook] });

    expect(text).toContain('**本轮移除（1，连续两轮被扫描到且未再出现）**');
    expect(text).toContain('~~天仙配~~');
    expect(text).toContain('（Douban → Bangumi）');
  });

  it('shows an entry still inside its observation window only under 观察中', () => {
    const observing = item({ kind: 'failed', reason: 'tmdb-item-threw', seenCount: 1 });
    const text = renderText({ items: [observing], added: [observing] });

    expect(text).toContain('新增 **0**');
    expect(text).toContain('**观察中（1，下一轮仍出现才入名单）**');
    expect(text).not.toContain('# NeoDB → TMDB');
    expect(text).toContain('- `failed` 无题 · tmdb-item-threw（NeoDB → TMDB）');
  });
});

describe('parseLogs — 类型与状态', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function parse(text: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-queue-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'sync.log'), text, 'utf8');
    return parseLogs(dir).items;
  }

  it('reads the {category|shelf} suffix from a ③ line', () => {
    const [entry] = parse(
      '[warn] No Bangumi match, skip: 天仙配[https://book.douban.com/subject/2/] {book|wishlist}\n',
    );

    expect(entry).toMatchObject({
      source: 'douban→bangumi',
      title: '天仙配',
      url: 'https://book.douban.com/subject/2/',
      category: 'book',
      shelf: 'wishlist',
    });
  });

  it('reads the ⑤ link and suffix', () => {
    const [entry] = parse(
      '[warn] No TMDB match; skip Medalist[https://neodb.social/movie/1] {movie|dropped}.\n',
    );

    expect(entry).toMatchObject({
      source: 'neodb→tmdb',
      title: 'Medalist',
      url: 'https://neodb.social/movie/1',
      category: 'movie',
      shelf: 'dropped',
    });
  });

  it('keeps an older ⑤ line with a relative NeoDB path as a title-only entry', () => {
    // Pre-absolutization log shape: the parser cannot accept a relative URL, so the bracket
    // stays inside the title. Production no longer prints this form; the fallback stays so an
    // old log degrades instead of losing the entry.
    // 绝对化之前的日志形态：解析器不收相对 URL，方括号因此留在标题里。生产端已不再打印这种
    // 形态；保留兜底是为了让旧日志降级而不是丢条目。
    const [entry] = parse(
      '[warn] No TMDB match; skip 流浪地球3(下)[/movie/1NYyQu0dXMM3PpvA5EoK5p] {movie|complete}.\n',
    );

    expect(entry).toMatchObject({
      source: 'neodb→tmdb',
      url: '',
      category: 'movie',
      shelf: 'complete',
    });
    expect(entry.title).toBe('流浪地球3(下)[/movie/1NYyQu0dXMM3PpvA5EoK5p]');
  });

  it('still accepts an older line with neither suffix nor link', () => {
    const [entry] = parse('[warn] No TMDB match; skip Medalist.\n');

    expect(entry).toMatchObject({
      title: 'Medalist',
      url: '',
      category: 'other',
      shelf: 'unknown',
    });
  });
});
