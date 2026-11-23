import { describe, expect, it } from 'vitest';
import { renderSummaryMarkdown } from '../../src/sync-summary-markdown';
import { newPathReport } from '../../src/types';

function reports() {
  return [
    newPathReport('豆瓣 → Notion'),
    newPathReport('豆瓣 → NeoDB'),
    newPathReport('豆瓣 → Bangumi'),
    newPathReport('Bangumi → NeoDB'),
  ];
}

describe('renderSummaryMarkdown — 写入条目', () => {
  it('在计数表下方按链路列出成功写入的源名和两个链接', () => {
    const rows = reports();
    rows[0]!.unresolved = 1;
    rows[0]!.unresolvedTitles.push('待核对条目');
    const target = rows[3]!;
    target.written = 1;
    target.writtenItems.push({
      title: '狐妖小红娘·王权篇',
      sourceUrl: 'https://bgm.tv/subject/281271',
      targetUrl: 'https://neodb.social/tv/season/0sMADT4DQansMdT6YkDPrG',
    });

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain('## 写入条目（1）');
    expect(markdown).toContain(
      '<summary><strong>Bangumi → NeoDB（1）</strong></summary>',
    );
    expect(markdown).not.toContain('<details open>');
    expect(markdown).toContain(
      '- 狐妖小红娘·王权篇 — https://bgm.tv/subject/281271 ' +
        '—— https://neodb.social/tv/season/0sMADT4DQansMdT6YkDPrG',
    );
    expect(markdown).toContain('</details>');
    expect(markdown.indexOf('## 写入条目')).toBeGreaterThan(
      markdown.indexOf('| Bangumi → NeoDB |'),
    );
    expect(markdown.indexOf('## 写入条目')).toBeLessThan(
      markdown.indexOf('## 链路明细'),
    );
    expect(markdown.indexOf('## 链路明细')).toBeLessThan(
      markdown.indexOf('### 豆瓣 → Notion'),
    );
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it('按实际写入链路动态生成写入条目子标题', () => {
    const rows = reports();
    rows[0]!.written = 1;
    rows[0]!.writtenItems.push({
      title: 'Notion 写入条目',
      sourceUrl: 'https://movie.douban.com/subject/0/',
      targetUrl: 'https://www.notion.so/page-0',
      category: 'movie',
    });
    rows[1]!.written = 1;
    rows[1]!.writtenItems.push({
      title: '豆瓣写入条目',
      sourceUrl: 'https://movie.douban.com/subject/1/',
      targetUrl: 'https://neodb.social/movie/douban',
      category: 'movie',
    });
    rows[2]!.written = 1;
    rows[2]!.writtenItems.push({
      title: 'Bangumi 写入条目',
      sourceUrl: 'https://movie.douban.com/subject/2/',
      targetUrl: 'https://bgm.tv/subject/2',
      category: 'book',
    });
    rows[3]!.written = 1;
    rows[3]!.writtenItems.push({
      title: 'Bangumi 写入条目',
      sourceUrl: 'https://bgm.tv/subject/2',
      targetUrl: 'https://neodb.social/movie/bangumi',
      category: 'tv',
    });

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain(
      '<summary><strong>豆瓣 → Notion（1）</strong></summary>',
    );
    expect(markdown).toContain('<summary><strong>豆瓣 → NeoDB（1）</strong></summary>');
    expect(markdown).toContain(
      '<summary><strong>豆瓣 → Bangumi（1）</strong></summary>',
    );
    expect(markdown).toContain(
      '<summary><strong>Bangumi → NeoDB（1）</strong></summary>',
    );
    expect(markdown).toContain('#### 电影（1）');
    expect(markdown).toContain('#### 书籍（1）');
    expect(markdown).toContain('#### 电视剧（1）');
  });

  it('按电影、电视剧、书籍分类展示豆瓣写入条目', () => {
    const rows = reports();
    const douban = rows[1]!;
    douban.written = 3;
    douban.writtenItems.push(
      {
        title: '电影条目',
        sourceUrl: 'https://movie.douban.com/subject/1/',
        targetUrl: 'https://neodb.social/movie/1',
        category: 'movie',
      },
      {
        title: '电视剧条目',
        sourceUrl: 'https://movie.douban.com/subject/2/',
        targetUrl: 'https://neodb.social/tv/2',
        category: 'tv',
      },
      {
        title: '书籍条目',
        sourceUrl: 'https://book.douban.com/subject/3/',
        targetUrl: 'https://neodb.social/book/3',
        category: 'book',
      },
    );

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain('<summary><strong>豆瓣 → NeoDB（3）</strong></summary>');
    expect(markdown).toContain('#### 电影（1）');
    expect(markdown).toContain('#### 电视剧（1）');
    expect(markdown).toContain('#### 书籍（1）');
    expect(markdown.indexOf('#### 电影')).toBeLessThan(markdown.indexOf('#### 电视剧'));
    expect(markdown.indexOf('#### 电视剧')).toBeLessThan(markdown.indexOf('#### 书籍'));
  });

  it('链路明细统一标注源平台与源条目链接', () => {
    const rows = reports();
    rows[0]!.unresolved = 1;
    rows[0]!.unresolvedItems.push({
      title: '待核对电影',
      url: 'https://movie.douban.com/subject/100/',
      reason: 'no-match',
    });
    rows[1]!.failed = 1;
    rows[1]!.failedItems.push({
      title: '写入失败条目',
      url: 'https://movie.douban.com/subject/101/',
      reason: 'neodb-write-failed',
    });
    rows[2]!.skipped = 1;
    rows[2]!.skippedItems.push({
      title: '跳过条目',
      url: 'https://movie.douban.com/subject/102/',
      reason: 'already-synced',
    });
    rows[3]!.unresolved = 1;
    rows[3]!.unresolvedItems.push({
      title: 'Bangumi 待核对',
      url: 'https://bgm.tv/subject/103',
      reason: 'no-neodb-match',
    });

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain(
      '豆瓣 · 待核对电影 — https://movie.douban.com/subject/100/',
    );
    expect(markdown).toContain(
      '豆瓣 · 写入失败条目 — https://movie.douban.com/subject/101/',
    );
    expect(markdown).toContain(
      '豆瓣 · 跳过条目 — https://movie.douban.com/subject/102/',
    );
    expect(markdown).toContain('Bangumi · Bangumi 待核对 — https://bgm.tv/subject/103');
  });

  it('链路明细的 unresolved / failed / skipped 默认折叠', () => {
    const rows = reports();
    const first = rows[0]!;
    first.unresolved = 1;
    first.unresolvedTitles.push('待核对条目');
    first.failed = 1;
    first.skipped = 1;

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, 1 FAILED');

    expect(markdown).toContain('<summary><strong>unresolved（1）</strong></summary>');
    expect(markdown).toContain('<summary><strong>failed（1）</strong></summary>');
    expect(markdown).toContain('<summary><strong>skipped（1）</strong></summary>');
    expect(markdown).not.toContain('<details open>');
  });

  it('没有成功写入时不生成空区块', () => {
    const markdown = renderSummaryMarkdown(reports(), '4 path(s) ran, none failed');
    expect(markdown).not.toContain('## 写入条目');
  });

  it('目标条目带豆瓣外链时，聚合提示与逐条标记同时出现', () => {
    // The aggregate answers "did this happen this round"; the per-item marker answers "which
    // one". Both are needed once a few hundred writes are in the same list.
    // 聚合回答「本轮发生了吗」，逐条标记回答「是哪一条」。几百条写入同列时两者都需要。
    const rows = reports();
    const target = rows[3]!;
    target.written = 2;
    target.writtenItems.push(
      {
        title: '带豆瓣外链的条目',
        sourceUrl: 'https://bgm.tv/subject/1',
        targetUrl: 'https://neodb.social/movie/aaa',
        doubanLinkPresent: true,
      },
      {
        title: '普通条目',
        sourceUrl: 'https://bgm.tv/subject/2',
        targetUrl: 'https://neodb.social/movie/bbb',
        doubanLinkPresent: false,
      },
    );

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain('**1** 条的目标条目已带豆瓣外链');
    expect(markdown).toContain('本项目刻意不自动合并');
    expect(markdown).toContain('带豆瓣外链的条目 — https://bgm.tv/subject/1');
    expect(markdown).toContain('⚠ 目标条目已带豆瓣外链');
    // The clean item must not carry the marker.
    // 干净条目不得带这个标记。
    const plainLine = markdown.split('\n').find((line) => line.includes('普通条目'));
    expect(plainLine).toBeDefined();
    expect(plainLine).not.toContain('⚠');
  });

  it('没有条目带豆瓣外链时不产生聚合提示', () => {
    const rows = reports();
    const target = rows[3]!;
    target.written = 1;
    target.writtenItems.push({
      title: '普通条目',
      sourceUrl: 'https://bgm.tv/subject/2',
      targetUrl: 'https://neodb.social/movie/bbb',
      doubanLinkPresent: false,
    });

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).not.toContain('已带豆瓣外链');
    expect(markdown).not.toContain('⚠');
  });
});
