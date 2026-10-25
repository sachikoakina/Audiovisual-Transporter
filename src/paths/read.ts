/**
 * Turning a `ReadResult` into a value or an exception — the one place that decides what a failed
 * read means for the path that issued it.
 * 把 `ReadResult` 翻成「值或异常」—— 这里是唯一决定「一次读取失败对该链路意味着什么」的地方。
 *
 * Why an exception rather than another return value: the bug this replaces was a *returned* flag
 * that a caller forgot to check (`markNeodbItem` in ④, fixed in `611f3f3`). A throw cannot be
 * ignored — an uncaught one takes the process down loudly, which is the right failure mode for
 * "the destination would not tell me its current state".
 * 为什么用异常而不是又一个返回值：它取代的那个 bug 正是一个**被忘记检查的返回值**
 * （④ 的 `markNeodbItem`，已在 `611f3f3` 修掉）。抛错无法被忽略 —— 没人接就当场崩掉，
 * 而对「目标端不肯告诉我现状」来说，这正是正确的失败形态。
 */
import type { ReadResult, ReadScope } from '../types';

/** The whole path cannot continue: the credentials are dead, not the item. / 整条链路走不下去：坏的是凭据，不是条目。 */
export class PathAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAbortedError';
  }
}

/** This one item could not be read. Write nothing here, continue with the next. / 这一条读不到。这里不写任何东西，继续下一条。 */
export class ItemReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemReadError';
  }
}

/** `auth` aborts the path; everything else is one item's problem. / `auth` 让链路停下，其余只是单条的问题。 */
function throwReadError(
  error: { scope: ReadScope; message: string },
  what: string,
): never {
  if (error.scope === 'auth') {
    throw new PathAbortedError(`${what}: ${error.message}`);
  }
  throw new ItemReadError(`${what}: ${error.message}`);
}

/**
 * `found` → the value; `absent` → `null` (the caller's "nothing there yet" branch); error → throw.
 * `found` → 值；`absent` → `null`（调用方的「那里还什么都没有」分支）；error → 抛。
 *
 * @param what Short noun for the record, used in the exception message. Not the item label —
 *   the detail line already carries that, and repeating it here would say it twice.
 * @param what 记录的短名词，进异常信息用。不要传条目标签 —— 明细行已经带了，这里再写一遍就是说两遍。
 */
export function readOptionalOrThrow<T>(read: ReadResult<T>, what: string): T | null {
  switch (read.status) {
    case 'found':
      return read.value;
    case 'absent':
      return null;
    case 'error':
      throwReadError(read, what);
  }
}

/**
 * Same, but `absent` is an error too — for endpoints that cannot answer "nothing there".
 * 同上，但 `absent` 也算错误 —— 给那些根本无法回答「那里什么都没有」的端点用。
 */
export function readValueOrThrow<T>(read: ReadResult<T>, what: string): T {
  switch (read.status) {
    case 'found':
      return read.value;
    case 'absent':
      throw new ItemReadError(`${what}: absent`);
    case 'error':
      throwReadError(read, what);
  }
}

/**
 * The review-list reason for one thrown item.
 *
 * A failed read and an unexpected bug are separate rows on purpose: the first is answered by
 * re-running, the second by fixing code, and a single slug would make the list say "something
 * went wrong" to both.
 * 抛出条目在名单里的 reason。读取失败与预料之外的异常刻意分成两行：前者靠重跑回答，后者靠改代码，
 * 合成一个 slug 只会对两者都说「出了点问题」。
 */
export function failureReason(
  error: unknown,
  readSlug: string,
  threwSlug: string,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const slug = error instanceof ItemReadError ? readSlug : threwSlug;
  return `${slug}: ${detail}`;
}
