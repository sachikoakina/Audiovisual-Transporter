/**
 * The shape of the review list itself — how `本轮新增`, `本轮移除` and `观察中` are laid out.
 * 待核对名单自身的形状 —— 「本轮新增」「本轮移除」「观察中」怎么排。
 *
 * Three claims are pinned here, because each of them was wrong or unverifiable before:
 * 这里钉住三件事，因为此前它们要么是错的，要么无从验证：
 *
 *   1. `本轮新增` and `本轮移除` are the *same* structure: a path heading per group, in ①→⑤ order.
 *      They used to be flat lists that only mentioned the path in a trailing bracket, so a long
 *      run read as one undifferentiated pile and the two sections described themselves differently.
 *      「本轮新增」与「本轮移除」是**同一个**结构：每组一个链路标题，按 ①→⑤ 排列。它们原先是不
 *      分组的平铺列表，链路只塞在行尾括号里 —— 一轮跑下来就是一堆分不清的条目，而且两节各自描述
 *      自己的方式还不一样。
 *   2. Every entry names its item before it prints the link. ④ printed only a `bgm.tv` URL, so its
 *      entries reached the list as an address nobody could recognise; the log line now carries
 *      `标题[链接]` and the parser still accepts the older bare-URL form.
 *      每个条目都先说名字、再说链接。④ 原先只打一个 `bgm.tv` 地址，于是它的条目进名单时是个谁也
 *      认不出的链接；现在日志行带 `标题[链接]`，而解析器仍接受更早的裸 URL 形态。
 *   3. An entry waiting out its observation window shows up once, under `观察中` — not also under
 *      `本轮新增`. 还在观察期里的条目只出现一次，在「观察中」下 —— 不再同时出现在「本轮新增」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLogs, render, type ReviewItem } from '../../scripts/review-queue.mjs';

const RUN_AT = '2026-10-26T08:00:00.000Z';

/** One entry as `state.json` would carry it: listed already, unless overridden. / 一条按 `state.json` 形状的条目。 */
function item(over: Partial<ReviewItem>): ReviewItem {
  return {
    key: 'key',
    kind: 'unresolved',
    source: 'neodb→tmdb',
    reason: 'no-tmdb-match',
    title: '无题',
    url: '',
    id: '',
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
  degraded = '',
}: {
  items: ReviewItem[];
  added?: ReviewItem[];
  removed?: ReviewItem[];
  degraded?: string;
}): string {
  return render({ items, added, removed, degraded, runStartedAt: RUN_AT, runUrl: '' });
}

/** The body of one `## heading`, up to the next H2. / 取某个 H2 的正文，到下一个 H2 为止。 */
function bodyOf(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) {
    return '';
  }
  const rest = text.slice(start + heading.length + 3);
  const next = rest.indexOf('\n## ');
  return next < 0 ? rest : rest.slice(0, next);
}

/** Path headings in the order they appear, count suffix stripped. / 按出现顺序取链路标题，去掉计数。 */
function pathHeadings(body: string): string[] {
  return [...body.matchAll(/^### (.+?)（\d+）$/gm)].map((match) => match[1]);
}

const bangumiUnresolved = item({
  key: 'bangumi→neodb::https://bgm.tv/subject/391457',
  source: 'bangumi→neodb',
  reason: 'neodb-unresolved',
  title: '狐妖小红娘13 黄风岭篇',
  url: 'https://bgm.tv/subject/391457',
  id: 'bangumi:391457',
});

const bangumiMatch = item({
  key: 'douban→bangumi::https://movie.douban.com/subject/1/',
  source: 'douban→bangumi',
  reason: 'no-bangumi-match',
  title: '四郎探母',
  url: 'https://movie.douban.com/subject/1/',
});

const tmdbMatch = item({
  key: 'neodb→tmdb::title:Medalist',
  title: 'Medalist (金牌得主 第二季)',
});

describe('render — 本轮新增', () => {
  it('groups by path in ①→⑤ order, whatever order the entries arrived in', () => {
    const added = [tmdbMatch, bangumiMatch, bangumiUnresolved];
    const text = renderText({ items: added, added });

    expect(pathHeadings(bodyOf(text, '本轮新增'))).toEqual([
      'Douban → Bangumi',
      'Bangumi → NeoDB',
      'NeoDB → TMDB',
    ]);
  });

  it('prints the item name before the link, the way a reader can scan it', () => {
    const text = renderText({ items: [bangumiUnresolved], added: [bangumiUnresolved] });

    expect(text).toContain(
      '- `unresolved` 狐妖小红娘13 黄风岭篇 — https://bgm.tv/subject/391457 · neodb-unresolved',
    );
  });

  it('counts the entries it actually printed', () => {
    const text = renderText({
      items: [bangumiMatch, tmdbMatch],
      added: [bangumiMatch, tmdbMatch],
    });

    expect(text).toContain('新增 **2**');
    expect(bodyOf(text, '本轮新增')).toContain('### Douban → Bangumi（1）');
  });
});

describe('render — 本轮移除', () => {
  it('mirrors 本轮新增 exactly: same headings, same order, same line shape', () => {
    const added = [tmdbMatch, bangumiMatch, bangumiUnresolved];
    const removed = [bangumiUnresolved, tmdbMatch, bangumiMatch];
    const text = renderText({ items: [], added, removed });

    expect(pathHeadings(bodyOf(text, '本轮移除'))).toEqual(
      pathHeadings(bodyOf(text, '本轮新增')),
    );
  });

  it('strikes the name but leaves the link clickable — a removal is a question, not a verdict', () => {
    const text = renderText({ items: [], removed: [bangumiMatch] });

    expect(text).toContain(
      '- `unresolved` ~~四郎探母~~ — https://movie.douban.com/subject/1/ · no-bangumi-match',
    );
  });
});

describe('render — 观察中', () => {
  it('keeps an entry that is still inside its observation window out of 本轮新增', () => {
    const observing = item({ kind: 'failed', reason: 'tmdb-item-threw', seenCount: 1 });
    const text = renderText({ items: [observing], added: [observing] });

    expect(text).toContain('新增 **0**');
    expect(text).not.toContain('## 本轮新增');
    expect(text).toContain('## 观察中（1，下一轮仍出现才入名单）');
    expect(text).toContain('- `failed` 无题 · tmdb-item-threw（NeoDB → TMDB）');
  });
});

describe('parseLogs — ④ names its items', () => {
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

  it('reads `标题[链接]`, so the entry arrives with a name and an id', () => {
    const [entry] = parse(
      '[warn] NeoDB could not resolve Bangumi URL, skip: 狐妖小红娘13 黄风岭篇[https://bgm.tv/subject/391457]\n',
    );

    expect(entry).toMatchObject({
      source: 'bangumi→neodb',
      reason: 'neodb-unresolved',
      title: '狐妖小红娘13 黄风岭篇',
      url: 'https://bgm.tv/subject/391457',
      id: 'bangumi:391457',
    });
  });

  it('still accepts an older log that printed the bare URL', () => {
    const [entry] = parse(
      '[warn] NeoDB could not resolve Bangumi URL, skip: https://bgm.tv/subject/999\n',
    );

    expect(entry).toMatchObject({
      url: 'https://bgm.tv/subject/999',
      id: 'bangumi:999',
      // Degraded rather than dropped: the entry is still worth showing, it just needs a look.
      // 退化而不是丢弃：条目仍值得列出，只是需要点开看。
      title: 'https://bgm.tv/subject/999',
    });
  });
});
