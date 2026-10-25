/**
 * Turning a failed read into a classification. Pure — the caller supplies the status code.
 * 把一次失败的读取归类。纯函数 —— 状态码由调用方提供。
 *
 * The three outcomes exist because the alternative (one `null`) is what let "the server said 500"
 * and "the user has no mark here" become the same value, and the write plan for both is
 * opposite: the first must not write, the second must.
 * 之所以要分三种，是因为另一种做法（只有一个 `null`）正是「服务器返回 500」与「用户在这里没有
 * 标记」变成同一个值的原因，而两者的写计划相反：前者绝不能写，后者必须写。
 */
import type { ReadScope } from '../types';

export type ReadFailureKind = 'absent' | ReadScope;

/**
 * @param status The HTTP status code, or `null` when there was no response at all (DNS, timeout).
 * @param notFound What a 404 means on this endpoint. Defaults to `absent` — "not marked", "not
 *   collected" — because that is the only reading under which a 404 may be written over. An
 *   endpoint whose 404 means "the record itself is gone" must pass `'item'`.
 *
 * @param status HTTP 状态码；完全没有响应（DNS、超时）时传 `null`。
 * @param notFound 该端点上 404 的含义。默认 `absent`（未标记、未收藏），因为只有在那个读法下
 *   404 才允许被覆盖。若 404 意味着「记录本身不存在」，必须传 `'item'`。
 */
export function classifyReadFailure(
  status: number | null,
  notFound: 'absent' | 'item' = 'absent',
): ReadFailureKind {
  if (status === 404) {
    return notFound;
  }
  // 401 and 403 are the same story for the caller: the token is wrong, not the item. Treating
  // them as per-item failures would produce one failure per item and hide the one real cause.
  // 401 与 403 对调用方是同一件事：错的是 token，不是条目。按条目级处理会产出一条一条的失败，
  // 把唯一真正的原因埋掉。
  if (status === 401 || status === 403) {
    return 'auth';
  }
  return 'item';
}
