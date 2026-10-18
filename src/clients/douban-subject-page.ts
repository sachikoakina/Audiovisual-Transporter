/**
 * Douban subject-page client — fetch a subject page and hand its DOM to the parsers.
 * 豆瓣条目页客户端 —— 抓取条目页，并把 DOM 交给解析器。
 *
 * Owns the anti-scraping transport only (module-level cookie jar, PoW self-solve, retry);
 * all `Document -> fields` decoding lives in `douban-subject-parsers.ts`.
 * 本文件只负责反爬传输（模块级 cookie jar、PoW 自解、重试）；全部 `Document -> 字段` 的
 * 解码逻辑都在 `douban-subject-parsers.ts` 里。
 */
import got from 'got';
import crypto from 'crypto';
import { CookieJar } from 'tough-cookie';
import { JSDOM } from 'jsdom';
import { consola } from 'consola';
import { ItemCategory } from '../types';
import { sleep } from '../utils';
import {
  buildMovieItem,
  buildMusicItem,
  buildBookItem,
  buildGameItem,
  buildDramaItem,
} from './douban-subject-parsers';

/**
 * Persistent cookie jar, shared by every request in this process.
 * 持久化 cookie jar，进程内所有请求共用同一个实例。
 */
const cookieJar = new CookieJar();

/**
 * Hard cap on PoW brute-force iterations.
 *
 * At `difficulty = 4` roughly one nonce in 65536 satisfies the target, so this bound is several
 * hundred times the expected work — only a changed challenge scheme can reach it. That is exactly
 * when a loud failure beats an unbounded loop: spinning forever looks like a hung CI job, with no
 * hint that Douban changed the algorithm.
 *
 * PoW 暴力枚举的硬上限。
 *
 * 在 `difficulty = 4` 下，大约每 65536 个 nonce 才有一个满足目标，因此这个上限是期望工作量的
 * 数百倍 —— 只有挑战方案变更才可能撞到它。而这正是「明确报错」优于「无界循环」的时刻：
 * 无限空转看起来就像 CI 卡死，且完全不会提示「豆瓣改了算法」。
 */
const MAX_POW_ITERATIONS = 20_000_000;

/**
 * Solve Douban's proof-of-work challenge page.
 * 解开豆瓣的 PoW 挑战页。
 *
 * The page ships three hidden inputs (`#tok` / `#cha` / `#red`); we brute-force a nonce whose
 * sha512 of `cha + nonce` starts with `difficulty` zeroes, then post `{tok, cha, sol, red}`.
 * 挑战页带三个隐藏输入（`#tok` / `#cha` / `#red`）；暴力枚举 nonce，使 `cha + nonce` 的
 * sha512 以 `difficulty` 个 0 开头，再回传 `{tok, cha, sol, red}`。
 *
 * Returns `null` when the page is not actually a challenge page (no `#tok`/`#cha`).
 * 当页面并非挑战页（没有 `#tok`/`#cha`）时返回 `null`。
 *
 * @throws When the cap is reached without a solution — see `MAX_POW_ITERATIONS`.
 *   达到上限仍未解出时抛出 —— 见 `MAX_POW_ITERATIONS`。
 */
async function solveDoubanPoW(html: string) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const tok = (doc.querySelector('#tok') as HTMLInputElement)?.value;
  const cha = (doc.querySelector('#cha') as HTMLInputElement)?.value;
  const red = (doc.querySelector('#red') as HTMLInputElement)?.value;

  if (!tok || !cha) return null;

  let nonce = 0;
  const difficulty = 4;
  const target = '0'.repeat(difficulty);
  let solved = false;

  while (nonce < MAX_POW_ITERATIONS) {
    nonce += 1;
    const hash = crypto
      .createHash('sha512')
      .update(cha + nonce)
      .digest('hex');
    if (hash.startsWith(target)) {
      solved = true;
      break;
    }
  }

  if (!solved) {
    throw new Error(
      `Douban PoW not solved after ${MAX_POW_ITERATIONS} iterations; ` +
        'the challenge scheme may have changed.',
    );
  }

  return { tok, cha, sol: nonce, red };
}

/**
 * Scrape one Douban subject page and return its column values.
 * 抓取一个豆瓣条目页并返回其列值。
 *
 * Flow / 流程: build a got client with a browser UA → request → if the response is a PoW
 * challenge, solve it, submit, wait 600–1200 ms, re-request → parse → dispatch by category.
 * 用浏览器 UA 构造 got 客户端 → 请求 → 若响应是 PoW 挑战页则解出、提交、随机等待
 * 600–1200 ms 后重试 → 解析 → 按分类分派。
 */
export default async function scrapeDoubanSubjectPage(
  link: string,
  category: ItemCategory,
): Promise<{
  [key: string]: string | string[] | number | null | undefined;
}> {
  consola.start(`Scraping ${category} item with link: ${link}`);

  const client = got.extend({
    cookieJar,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: link,
    },
    followRedirect: true,
  });

  let response = await client(link);

  if (response.body.includes('id="sec"') && response.body.includes('sha512')) {
    consola.info('Detected Douban PoW challenge, solving...');
    const payload = await solveDoubanPoW(response.body);

    if (payload) {
      // A random 600–1200 ms pause makes the submission look less mechanical.
      // 随机停顿 600–1200 ms，让提交行为看起来不那么机械。
      const delay = Math.floor(Math.random() * 600) + 600;
      await sleep(delay);
      await client.post('https://sec.douban.com/c', {
        form: payload,
      });
      consola.success('PoW solved and submitted. Retrying original request...');

      // Cookies from the verification round-trip ride along automatically.
      // 验证往返带回的 Cookie 会自动带上。
      response = await client(link);
    }
  }

  const dom = new JSDOM(response.body);
  const doc = dom.window.document;

  // Still on the challenge page → the bypass failed (bad IP, or the PoW form changed).
  // 仍停留在验证页 → 绕过失败（IP 被封，或 PoW 表单已变更）。
  if (doc.querySelector('#sec')) {
    throw new Error(
      'Failed to bypass Douban security page. Might need a proxy or manual login.',
    );
  }

  switch (category) {
    case ItemCategory.Movie:
      return buildMovieItem(doc);
    case ItemCategory.Music:
      return buildMusicItem(doc);
    case ItemCategory.Book:
      return buildBookItem(doc);
    case ItemCategory.Game:
      return buildGameItem(doc);
    case ItemCategory.Drama:
      return buildDramaItem(doc);
    default:
      return {};
  }
}
