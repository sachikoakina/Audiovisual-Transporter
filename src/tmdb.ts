import got, { HTTPError } from 'got';
import { consola } from 'consola';
import { neodbTmdbConfig } from './sync-config';
import { sleep } from './utils';
import type {
  TmdbAccountStates,
  TmdbMediaType,
  TmdbSearchResult,
  TmdbTarget,
} from './types';

/**
 * TMDB API client.
 *
 * Verified capability boundary (see README for sources):
 *   - only movie / tv exist (no book / music / game)
 *   - the only writable per-item states are watchlist, favorite and rating
 *   - there is NO "watched" or "in progress" state → carried by user lists
 *   - add-rating implicitly drops the item from the watchlist (undocumented)
 *   - `account_states.rated` is `{ value }` or `false`, never a boolean
 *   - writes require a v3 session_id; favorite/watchlist also need account_id
 */

const tmdb = got.extend({
  prefixUrl: neodbTmdbConfig.tmdb.baseUrl,
  headers: { accept: 'application/json' },
  timeout: { request: 30000 },
  retry: {
    limit: 3,
    // GET only: replaying a write after a timeout could silently change a
    // rating the user set by hand. Failures are left to the next run instead.
    methods: ['GET'],
    statusCodes: [408, 429, 500, 502, 503, 504],
    errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'],
    calculateDelay: ({ attemptCount, error, computedValue }) => {
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return retryAfter * 1000;
      }
      return Math.min(2 ** attemptCount * 500, 8000) || computedValue;
    },
  },
});

function failureCode(error: unknown): string {
  if (error instanceof HTTPError) {
    return `${error.response.statusCode} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof HTTPError && error.response.statusCode === 401;
}

function logUnauthorized(): void {
  consola.error(
    'TMDB 返回 401：session 无效或已过期。请重新生成 TMDB_SESSION_ID / TMDB_ACCESS_TOKEN。',
  );
}

function readParams(): Record<string, string> {
  return { api_key: neodbTmdbConfig.tmdb.apiKey ?? '' };
}

/**
 * How a request proves *which user* it is acting for.
 *
 * - `session` — the documented v3 way: `?api_key=&session_id=`
 * - `bearer`  — a user-scoped v4 token used directly as the Bearer credential.
 *               Verified against the live API to work for reads *and* writes on
 *               v3 endpoints, including GET /3/account, so no session id is
 *               needed when the token is user-scoped.
 */
export type TmdbAuth =
  { kind: 'session'; sessionId: string } | { kind: 'bearer'; accessToken: string };

/** Query params carrying the credential. Empty in bearer mode. */
function authParams(auth: TmdbAuth): Record<string, string> {
  if (auth.kind === 'session') {
    return {
      api_key: neodbTmdbConfig.tmdb.apiKey ?? '',
      session_id: auth.sessionId,
    };
  }
  // The Bearer token already encodes the API key in its `aud` claim; sending
  // api_key alongside it is rejected by some endpoints.
  return {};
}

/** Headers carrying the credential. Empty in session mode. */
function authHeaders(auth: TmdbAuth): Record<string, string> {
  return auth.kind === 'bearer' ? { Authorization: `Bearer ${auth.accessToken}` } : {};
}

export async function tmdbThrottle(): Promise<void> {
  await sleep(neodbTmdbConfig.tmdb.requestDelayMs);
}

// ───────────────────────────────────────────────────────────────────────────
// auth
// ───────────────────────────────────────────────────────────────────────────

let cachedAuth: TmdbAuth | null | undefined;

/**
 * Resolve how user-level requests authenticate, once per run.
 *
 * Order of preference:
 *   1. an explicit TMDB_SESSION_ID
 *   2. a v4 token exchanged for a session id (the documented path)
 *   3. the same v4 token used directly as a Bearer credential
 *
 * Step 3 is not redundant. Step 2 is not universally available: some
 * user-scoped tokens make /authentication/session/convert/4 answer
 * 400 Invalid parameters. Those tokens still authenticate reads *and* writes
 * as a Bearer, so falling back keeps the write path working instead of
 * disabling it outright.
 *
 * Returns null when nothing works — callers must stop rather than write.
 */
export async function resolveTmdbAuth(): Promise<TmdbAuth | null> {
  if (cachedAuth !== undefined) {
    return cachedAuth;
  }

  if (neodbTmdbConfig.tmdb.sessionId) {
    cachedAuth = { kind: 'session', sessionId: neodbTmdbConfig.tmdb.sessionId };
    return cachedAuth;
  }

  const accessToken = neodbTmdbConfig.tmdb.accessToken;
  if (!accessToken) {
    cachedAuth = null;
    return null;
  }

  const converted = await convertTokenToSession(accessToken);
  if (converted) {
    consola.info('TMDB: using a session id converted from the v4 token.');
    cachedAuth = { kind: 'session', sessionId: converted };
    return cachedAuth;
  }

  if (await probeBearerToken(accessToken)) {
    consola.info(
      'TMDB: session conversion unavailable — using the token directly as a Bearer credential.',
    );
    cachedAuth = { kind: 'bearer', accessToken };
    return cachedAuth;
  }

  cachedAuth = null;
  return null;
}

/** POST /3/authentication/session/convert/4 — null when not applicable. */
async function convertTokenToSession(accessToken: string): Promise<string | null> {
  try {
    const result = (await got
      .post(`${neodbTmdbConfig.tmdb.baseUrl}/authentication/session/convert/4`, {
        headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      })
      .json()) as { session_id?: string };

    if (!result.session_id) {
      consola.debug(
        'TMDB token→session conversion returned no session_id; trying Bearer.',
      );
      return null;
    }
    return result.session_id;
  } catch (error) {
    // Not fatal — the Bearer fallback may still authenticate. Logged at debug
    // level so a perfectly working run does not look broken.
    consola.debug('TMDB token→session conversion failed: ', failureCode(error));
    return null;
  }
}

/**
 * Does this token authenticate *user-level* requests?
 * Probes GET /3/account, which only returns account data for a user credential.
 */
async function probeBearerToken(accessToken: string): Promise<boolean> {
  try {
    const account = (await got(`${neodbTmdbConfig.tmdb.baseUrl}/account`, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }).json()) as { id?: number };
    return typeof account?.id === 'number';
  } catch (error) {
    if (isUnauthorized(error)) {
      consola.error(
        'TMDB rejected the access token as a user credential. Writes need a ' +
          'user-scoped v4 token, or TMDB_SESSION_ID.',
      );
    } else {
      consola.error('Failed to probe the TMDB access token: ', failureCode(error));
    }
    return false;
  }
}

/** GET /3/account — resolves the account id for the authenticated user. */
export async function getTmdbAccount(auth: TmdbAuth): Promise<{ id: number } | null> {
  if (neodbTmdbConfig.tmdb.accountId) {
    return { id: Number(neodbTmdbConfig.tmdb.accountId) };
  }
  try {
    return (await tmdb('account', {
      searchParams: authParams(auth),
      headers: authHeaders(auth),
    }).json()) as { id: number };
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error('Failed to fetch TMDB account: ', failureCode(error));
    }
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// read
// ───────────────────────────────────────────────────────────────────────────

/** Stable identity of an item inside a list. */
export function memberKey(target: { mediaType: string; id: number }): string {
  return `${target.mediaType}:${target.id}`;
}

/** Read current account state. This GET is what makes every write idempotent. */
export async function getTmdbAccountStates(
  target: TmdbTarget,
  auth: TmdbAuth,
): Promise<TmdbAccountStates | null> {
  try {
    return (await tmdb(`${target.mediaType}/${target.id}/account_states`, {
      searchParams: authParams(auth),
      headers: authHeaders(auth),
    }).json()) as TmdbAccountStates;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(
        `Failed to read account states for ${memberKey(target)}: `,
        failureCode(error),
      );
    }
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// resolve
// ───────────────────────────────────────────────────────────────────────────

/** Exact lookup by IMDb id — zero false positives. */
export async function findTmdbByImdbId(imdbId: string): Promise<TmdbTarget[]> {
  try {
    const data = (await tmdb(`find/${imdbId}`, {
      searchParams: { ...readParams(), external_source: 'imdb_id', language: 'en-US' },
    }).json()) as Record<string, TmdbSearchResult[] | undefined>;

    const targets: TmdbTarget[] = [];
    for (const movie of data?.movie_results ?? []) {
      targets.push({
        mediaType: 'movie',
        id: movie.id,
        title: movie.title ?? movie.original_title,
      });
    }
    for (const tv of data?.tv_results ?? []) {
      targets.push({ mediaType: 'tv', id: tv.id, title: tv.name ?? tv.original_name });
    }
    return targets;
  } catch (error) {
    consola.error(`TMDB find failed for ${imdbId}: `, failureCode(error));
    return [];
  }
}

/** Look up a TMDB item by its own id — used when NeoDB already links to TMDB. */
export async function getTmdbById(
  mediaType: TmdbMediaType,
  id: number,
): Promise<TmdbTarget | null> {
  try {
    const data = (await tmdb(`${mediaType}/${id}`, {
      searchParams: { ...readParams(), language: neodbTmdbConfig.tmdb.language },
    }).json()) as TmdbSearchResult;
    if (!data?.id) {
      return null;
    }
    return { mediaType, id: data.id, title: data.title ?? data.name };
  } catch (error) {
    consola.error(`TMDB lookup failed for ${mediaType}:${id}: `, failureCode(error));
    return null;
  }
}

export async function searchTmdb(
  mediaType: TmdbMediaType,
  query: string,
  year?: number,
): Promise<TmdbSearchResult[]> {
  try {
    const searchParams: Record<string, string | number | boolean> = {
      ...readParams(),
      query,
      language: neodbTmdbConfig.tmdb.language,
      include_adult: neodbTmdbConfig.tmdb.includeAdult,
      page: 1,
    };
    if (year != null) {
      searchParams[mediaType === 'tv' ? 'first_air_date_year' : 'year'] = year;
    }
    const data = (await tmdb(mediaType === 'tv' ? 'search/tv' : 'search/movie', {
      searchParams,
    }).json()) as { results?: TmdbSearchResult[] };
    return data?.results ?? [];
  } catch (error) {
    consola.error(`TMDB search failed for "${query}": `, failureCode(error));
    return [];
  }
}

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '');
}

function titleCandidates(result: TmdbSearchResult): string[] {
  return [
    result.title,
    result.original_title,
    result.name,
    result.original_name,
  ].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

function resultYear(result: TmdbSearchResult): number | undefined {
  const raw = result.release_date || result.first_air_date;
  const match = raw?.match(/^(\d{4})/);
  return match ? Number(match[1]) : undefined;
}

/** Exact normalized title match only — never settle for the closest hit. */
export function pickExactTmdbMatch(
  results: TmdbSearchResult[],
  title: string,
  expectedYear?: number,
  tolerance = 1,
): TmdbSearchResult | null {
  const wanted = normalizeTitleKey(title);
  if (!wanted) {
    return null;
  }

  return (
    results.find((result) => {
      const titles = titleCandidates(result).map(normalizeTitleKey);
      if (!titles.includes(wanted)) {
        return false;
      }
      if (expectedYear == null) {
        return true;
      }
      const year = resultYear(result);
      return year != null && Math.abs(year - expectedYear) <= tolerance;
    }) ?? null
  );
}

// ───────────────────────────────────────────────────────────────────────────
// write
// ───────────────────────────────────────────────────────────────────────────

export async function setTmdbWatchlist(
  target: TmdbTarget,
  on: boolean,
  auth: TmdbAuth,
  accountId: number,
): Promise<boolean> {
  try {
    await tmdb.post(`account/${accountId}/watchlist`, {
      searchParams: authParams(auth),
      headers: authHeaders(auth),
      json: { media_type: target.mediaType, media_id: target.id, watchlist: on },
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(
        `Failed to set watchlist for ${memberKey(target)}: `,
        failureCode(error),
      );
    }
    return false;
  }
}

export async function setTmdbRating(
  target: TmdbTarget,
  value: number,
  auth: TmdbAuth,
): Promise<boolean> {
  try {
    await tmdb.post(`${target.mediaType}/${target.id}/rating`, {
      searchParams: authParams(auth),
      headers: authHeaders(auth),
      json: { value },
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(
        `Failed to set rating for ${memberKey(target)}: `,
        failureCode(error),
      );
    }
    return false;
  }
}
