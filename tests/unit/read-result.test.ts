/**
 * The read tri-state, at the seam where it becomes control flow.
 * 读取三态 —— 在它变成控制流的那条缝上。
 *
 * These are the two functions every path now goes through, and neither is covered by
 * `verify-*`: those scripts assert pure rules, while this is the decision that a failed read
 * means "skip one item" or "stop the path". A regression here is silent by construction — the
 * wrong branch still writes something plausible.
 * 这是每条链路现在都要经过的两个函数，而 `verify-*` 都没覆盖：那些脚本断言的是纯规则，而这里
 * 决定的是「一次读取失败意味着跳过一条，还是让整条链路停下」。这里一旦回归，失败是无声的 ——
 * 走错分支之后写下去的东西看上去依然合理。
 */
import { describe, expect, it } from 'vitest';
import { classifyReadFailure } from '../../src/rules/read-result';
import {
  ItemReadError,
  PathAbortedError,
  readOptionalOrThrow,
  readValueOrThrow,
} from '../../src/paths/read';

describe('classifyReadFailure', () => {
  it('treats 404 as "nothing there" by default, the only answer a create may rest on', () => {
    expect(classifyReadFailure(404)).toBe('absent');
  });

  it('treats 404 as an item failure when the endpoint has no "nothing there" answer', () => {
    expect(classifyReadFailure(404, 'item')).toBe('item');
  });

  it('treats 401 and 403 as the credentials, not the item', () => {
    expect(classifyReadFailure(401)).toBe('auth');
    expect(classifyReadFailure(403)).toBe('auth');
  });

  it('treats a 500 and a missing response as item failures', () => {
    expect(classifyReadFailure(500)).toBe('item');
    expect(classifyReadFailure(null)).toBe('item');
  });
});

describe('readOptionalOrThrow', () => {
  it('hands the value back when the read found something', () => {
    expect(readOptionalOrThrow({ status: 'found', value: 7 }, 'x')).toBe(7);
  });

  it('maps absent to null, which is the caller’s "create it" branch', () => {
    expect(readOptionalOrThrow({ status: 'absent' }, 'x')).toBeNull();
  });

  it('raises PathAbortedError for an auth failure, so the loop stops', () => {
    expect(() =>
      readOptionalOrThrow({ status: 'error', scope: 'auth', message: '401' }, 'x'),
    ).toThrow(PathAbortedError);
  });

  it('raises ItemReadError for an item failure, so only that item is counted', () => {
    expect(() =>
      readOptionalOrThrow({ status: 'error', scope: 'item', message: '500' }, 'x'),
    ).toThrow(ItemReadError);
  });

  it('carries the noun it was given into the message, so the detail names the thing', () => {
    expect(() =>
      readOptionalOrThrow(
        { status: 'error', scope: 'item', message: '500' },
        'NeoDB mark',
      ),
    ).toThrow('NeoDB mark: 500');
  });
});

describe('readValueOrThrow', () => {
  it('treats absent as an error too, for endpoints that cannot answer "nothing there"', () => {
    expect(() => readValueOrThrow({ status: 'absent' }, 'x')).toThrow(ItemReadError);
  });

  it('still separates auth from item failures', () => {
    expect(() =>
      readValueOrThrow({ status: 'error', scope: 'auth', message: '401' }, 'x'),
    ).toThrow(PathAbortedError);
  });
});
