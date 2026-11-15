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
      markdown.indexOf('### 豆瓣 → Notion'),
    );
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it('没有成功写入时不生成空区块', () => {
    const markdown = renderSummaryMarkdown(reports(), '4 path(s) ran, none failed');
    expect(markdown).not.toContain('## 写入条目');
  });
});
