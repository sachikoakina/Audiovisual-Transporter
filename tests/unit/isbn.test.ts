import { describe, expect, it } from 'vitest';
import { extractIsbns, normalizeIsbn } from '../../src/rules/isbn';
import type { BangumiSubject } from '../../src/clients/bangumi';

function subject(over: Partial<BangumiSubject>): BangumiSubject {
  return {
    id: 1,
    type: 1,
    name: 'test',
    name_cn: '',
    ...over,
  };
}

describe('ISBN normalization', () => {
  it('keeps valid ISBN-13 and removes separators', () => {
    expect(normalizeIsbn('9784047376465')).toBe('9784047376465');
    expect(normalizeIsbn('978-4-04-737646-5')).toBe('9784047376465');
    expect(normalizeIsbn(' 978 4047 376465 ')).toBe('9784047376465');
  });

  it('converts ISBN-10 to ISBN-13', () => {
    expect(normalizeIsbn('4047376469')).toBe('9784047376465');
    expect(normalizeIsbn('4-04-737646-9')).toBe('9784047376465');
  });

  it('rejects invalid checksums and unusable values', () => {
    expect(normalizeIsbn('9784047376466')).toBeNull();
    expect(normalizeIsbn('4047376468')).toBeNull();
    expect(normalizeIsbn('123')).toBeNull();
    expect(normalizeIsbn('')).toBeNull();
    expect(normalizeIsbn(null)).toBeNull();
    expect(normalizeIsbn(undefined)).toBeNull();
  });
});

describe('Bangumi candidate ISBN extraction', () => {
  it('extracts main and edition ISBNs', () => {
    expect(
      extractIsbns(
        subject({
          infobox: [
            { key: 'ISBN', value: '978-4-04-737646-5' },
            {
              key: '版本:天角版',
              value: [{ k: 'ISBN', v: '9787513356756' }],
            },
          ],
        }),
      ),
    ).toEqual(['9784047376465', '9787513356756']);
  });

  it('skips invalid and duplicate ISBNs', () => {
    expect(
      extractIsbns(
        subject({
          infobox: [
            { key: 'ISBN', value: '9784047376465' },
            { key: '版本:duplicate', value: [{ k: 'ISBN', v: '9784047376465' }] },
            { key: '版本:bad', value: [{ k: 'ISBN', v: '123' }] },
          ],
        }),
      ),
    ).toEqual(['9784047376465']);
  });

  it('returns an empty list without infobox', () => {
    expect(extractIsbns(subject({}))).toEqual([]);
  });
});
