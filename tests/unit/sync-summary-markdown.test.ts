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
    expect(markdown).toContain('### Bangumi → NeoDB（1）');
    expect(markdown).toContain('<summary>展开条目</summary>');
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
    rows[1]!.written = 1;
    rows[1]!.writtenItems.push({
      title: '豆瓣写入条目',
      sourceUrl: 'https://movie.douban.com/subject/1/',
      targetUrl: 'https://neodb.social/movie/douban',
    });
    rows[3]!.written = 1;
    rows[3]!.writtenItems.push({
      title: 'Bangumi 写入条目',
      sourceUrl: 'https://bgm.tv/subject/2',
      targetUrl: 'https://neodb.social/movie/bangumi',
    });

    const markdown = renderSummaryMarkdown(rows, '4 path(s) ran, none failed');

    expect(markdown).toContain('### 豆瓣 → NeoDB（1）');
    expect(markdown).toContain('### Bangumi → NeoDB（1）');
    expect(markdown).not.toContain('### 豆瓣 → Notion（1）');
    expect(markdown).not.toContain('### 豆瓣 → Bangumi（1）');
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
