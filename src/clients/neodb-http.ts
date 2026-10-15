/**
 * NeoDB transport primitives — credentials, request headers, error helpers, pacing.
 * NeoDB 传输层基础件 —— 凭据、请求头、错误助手、节流。
 *
 * The single place that knows the NeoDB base URL. `NEODB_BASE_URL` is read once (in
 * `sync-config.ts`) and applied to EVERY NeoDB request, so a self-hosted instance works for
 * reads and writes alike.
 *
 * There are two clients here, differing only in retry/timeout policy — not in base URL:
 *
 *   - `neodbClient` — per-item endpoints (`/api/catalog/*`, `/api/me/shelf/item/*`). Keeps got's
 *     stock retry policy, which never replays a POST, so a mark is never sent twice.
 *   - `neodbShelfClient` (defined in `neodb-shelf.ts`) — the shelf listing endpoint
 *     (`/api/me/shelf/{type}`), with an explicit timeout and GET-only retry.
 *
 * 本文件是唯一了解 NeoDB base URL 的地方。`NEODB_BASE_URL` 只解析一次（在 `sync-config.ts`），
 * 并作用于**每一个** NeoDB 请求，因此自建实例的读取与写入都正常。
 *
 * 这里有两个客户端，差异只在重试/超时策略，**不在 base URL**：
 *
 *   - `neodbClient` —— 条目级端点（`/api/catalog/*`、`/api/me/shelf/item/*`）。沿用 got 的默认
 *     重试策略，它从不重放 POST，因此标记不会被重复提交。
 *   - `neodbShelfClient`（定义在 `neodb-shelf.ts`）—— 书架列表端点（`/api/me/shelf/{type}`），
 *     带显式超时与仅 GET 的重试。
 */
import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import { sleep } from '../utils';
import { neodbTmdbConfig } from '../sync-config';

dotenv.config();

/** NeoDB API token. `undefined` disables every authenticated call. / NeoDB API 令牌；为 `undefined` 时所有需鉴权的调用都会被跳过。 */
export const neodbToken = process.env.NEODB_API_TOKEN;

/** Default mark visibility: 0 = public, 1 = followers, 2 = private. / 标记的默认可见性：0 = 公开，1 = 仅关注者，2 = 私密。 */
export const neodbVisibility = Number(process.env.NEODB_VISIBILITY ?? 2);

/**
 * Client for the per-item NeoDB endpoints, on the configured base URL.
 * 条目级 NeoDB 端点的客户端，使用已配置的 base URL。
 *
 * Pass a path relative to the base (`'api/catalog/fetch'`). An absolute URL bypasses `prefixUrl`,
 * which is what the redirect-retry in `neodb-shelf.ts` relies on.
 * 传入相对于 base 的路径（如 `'api/catalog/fetch'`）。绝对 URL 会绕过 `prefixUrl`，
 * `neodb-shelf.ts` 的重定向重试正是依赖这一点。
 */
export const neodbClient = got.extend({
  prefixUrl: neodbTmdbConfig.neodb.baseUrl,
});

/** Auth + accept headers for an authenticated NeoDB call. / 需鉴权的 NeoDB 调用所用的请求头。 */
export function neodbAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${neodbToken}`,
    accept: 'application/json',
  };
}

/** Wait one configured NeoDB request interval. / 等待一个已配置的 NeoDB 请求间隔。 */
export async function neodbThrottle(): Promise<void> {
  await sleep(neodbTmdbConfig.neodb.requestDelayMs);
}

/** Compact `${status} ${message}` for logs; plain text for non-HTTP errors. / 用于日志的 `${status} ${message}` 紧凑形式；非 HTTP 错误则取纯文本。 */
export function neodbFailureCode(error: unknown): string {
  if (error instanceof HTTPError) {
    return `${error.response.statusCode} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Explain a 401 in the user's own language, with the exact fix. / 用用户的语言解释 401，并给出确切的修复步骤。 */
export function logNeodbUnauthorized(): void {
  consola.error(
    'NeoDB 返回 401：token 无效或已过期。请到你的实例 /developer/ 页面重新授权并更新 NEODB_API_TOKEN。',
  );
}

/**
 * Absolutise a NeoDB-relative path against the CONFIGURED base URL (self-hosted instances
 * included), so a redirect target reported by the server is retried on the same instance.
 * 把 NeoDB 的相对路径按**已配置的** base URL 补成绝对 URL（自建实例同样适用），使服务器返回的
 * 重定向目标仍在同一实例上重试。
 */
export function absoluteNeodbUrl(url: string): string {
  if (url.startsWith('http')) {
    return url;
  }
  return new URL(url, `${neodbTmdbConfig.neodb.baseUrl}/`).toString();
}

/**
 * Pull the "retry here" URL out of a redirect-shaped error response.
 * 从「重定向形态」的错误响应里取出「改到这里重试」的 URL。
 */
export function redirectUrlFromError(error: HTTPError): string | null {
  const location = error.response.headers.location;
  if (typeof location === 'string' && location) {
    return absoluteNeodbUrl(location);
  }
  let body: unknown = error.response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (
    body &&
    typeof body === 'object' &&
    'url' in body &&
    typeof body.url === 'string'
  ) {
    return absoluteNeodbUrl(body.url);
  }
  return null;
}
