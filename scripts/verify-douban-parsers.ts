/*
 * Verify the Douban parsers offline, against saved HTML.
 * No network, no framework — run with the tsx already in devDependencies.
 *
 * SCOPE AND HONESTY ABOUT THE FIXTURES
 * `tests/fixtures/*.html` are SYNTHETIC: their markup was reconstructed from the selectors the
 * parsers use, not captured from Douban. That makes them good at two things and bad at one:
 *
 *   + Every branch of every parser has a case, so a future edit that changes parsing fails here.
 *   + The expected values are pinned exactly, including the quirks (see the test names).
 *   − They CANNOT prove the selectors still match the live site. Replacing these files with real
 *     captured HTML is the one upgrade that would add that.
 *
 * USAGE: npm run verify:parsers   (or `npm run verify:all` for every verify script)
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 离线验证豆瓣解析器（对着保存的 HTML 跑）。
 * 不需要网络、不引入测试框架 —— 直接用 devDependencies 里已有的 tsx 运行。
 *
 * 关于 fixture 的范围与诚实交代
 * `tests/fixtures/*.html` 是**手工构造**的：标记结构由解析器所用的选择器反推而来，并非从豆瓣
 * 抓取。这让它们擅长两件事、不擅长一件：
 *
 *   + 每个解析器的每个分支都有用例，因此未来任何改动解析行为的编辑都会在这里失败。
 *   + 期望值被精确定住，包括那些「怪癖」（见用例名）。
 *   − 它们**无法**证明选择器今天仍与线上一致。把这里的文件换成真实抓取的 HTML，是唯一能补上
 *     这一点的升级。
 *
 * 用法：npm run verify:parsers（或 `npm run verify:all` 跑全部验证脚本）
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  buildBookItem,
  buildDramaItem,
  buildGameItem,
  buildMovieItem,
  buildMusicItem,
} from '../src/clients/douban-subject-parsers';
import { extractItemInfo } from '../src/clients/douban-rss';
import { DB_PROPERTIES, ItemCategory, ItemStatus } from '../src/types';
import { createChecker } from './verify-lib';

const { check, section, summary } = createChecker();

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Load a saved fixture as a DOM Document. / 把保存的 fixture 载入为 DOM Document。 */
function fixture(name: string): Document {
  const file = path.resolve(HERE, '..', 'tests', 'fixtures', name);
  return new JSDOM(readFileSync(file, 'utf8')).window.document;
}

/** Build a Document from an inline snippet, for one-off edge cases. / 由内联片段构造 Document，用于一次性边界用例。 */
function html(markup: string): Document {
  return new JSDOM(markup).window.document;
}

// ───────────────────────────────────────────────────────────────────────────
// extractItemInfo — title + link → category / id / status
// extractItemInfo —— 标题 + 链接 → 分类 / 条目 id / 状态
// ───────────────────────────────────────────────────────────────────────────

section('extractItemInfo / 从标题与链接解出分类、id、状态');

{
  const movie = extractItemInfo(
    '看过 肖申克的救赎',
    'https://movie.douban.com/subject/1292052/',
  );
  check('看过 + movie.douban.com → Movie', movie?.category === ItemCategory.Movie);
  check('movie subject id is captured', movie?.id === '1292052');
  check('看过 → Complete', movie?.status === ItemStatus.Complete);
}

{
  const http = extractItemInfo('在看 某剧', 'http://movie.douban.com/subject/1/');
  check(
    'http:// movie links count as movies too',
    http?.category === ItemCategory.Movie,
  );
  check('在看 → Progress', http?.status === ItemStatus.Progress);
}

{
  const recent = extractItemInfo(
    '最近想看 某片',
    'https://movie.douban.com/subject/2/',
  );
  check('the optional 最近 prefix is accepted', recent?.status === ItemStatus.Wishlist);
}

{
  const drama = extractItemInfo(
    '想看 茶馆',
    'https://www.douban.com/location/drama/12345/',
  );
  check(
    'a 看* status on a non-movie link → Drama',
    drama?.category === ItemCategory.Drama,
  );
  check('drama id is captured from the location URL', drama?.id === '12345');
}

{
  const stray = extractItemInfo('看过 某个东西', 'https://example.com/whatever');
  check(
    'a 看* status with an unrecognized link → Drama with an empty id',
    stray?.category === ItemCategory.Drama && stray?.id === '',
  );
}

{
  const read = extractItemInfo(
    '读过 百年孤独',
    'https://book.douban.com/subject/1001/',
  );
  check(
    '读过 → Book / Complete',
    read?.category === ItemCategory.Book && read?.status === ItemStatus.Complete,
  );
  check('book id is captured', read?.id === '1001');
}

{
  const wantRead = extractItemInfo('想读 某书', 'https://book.douban.com/subject/1002');
  check(
    'a book link without a trailing slash still yields the id',
    wantRead?.id === '1002',
  );
  check('想读 → Wishlist', wantRead?.status === ItemStatus.Wishlist);
}

{
  const listened = extractItemInfo(
    '听过 范特西',
    'https://music.douban.com/subject/1003/',
  );
  check(
    '听过 → Music / Complete',
    listened?.category === ItemCategory.Music &&
      listened?.status === ItemStatus.Complete,
  );
}

{
  const wantListen = extractItemInfo(
    '想听 某专辑',
    'https://music.douban.com/subject/1004/',
  );
  check('想听 → Music / Wishlist', wantListen?.status === ItemStatus.Wishlist);
}

{
  const played = extractItemInfo('玩过 塞尔达', 'https://www.douban.com/game/1005/');
  check(
    '玩过 → Game / Complete',
    played?.category === ItemCategory.Game && played?.status === ItemStatus.Complete,
  );
  check('game id is captured', played?.id === '1005');
}

{
  const wantPlay = extractItemInfo('想玩 某游戏', 'https://www.douban.com/game/1006/');
  check('想玩 → Game / Wishlist', wantPlay?.status === ItemStatus.Wishlist);
}

check(
  'a title with no status word is rejected',
  extractItemInfo('肖申克的救赎', 'https://movie.douban.com/subject/1292052/') ===
    undefined,
);
check(
  'an empty title is rejected',
  extractItemInfo('', 'https://movie.douban.com/') === undefined,
);

// ───────────────────────────────────────────────────────────────────────────
// buildMovieItem
// ───────────────────────────────────────────────────────────────────────────

section('buildMovieItem / 电影条目页');

{
  const item = buildMovieItem(fixture('movie.html'));
  check(
    'title comes from [property="v:itemreviewed"]',
    item[DB_PROPERTIES.NAME] === '肖申克的救赎 The Shawshank Redemption',
  );
  check(
    'MOVIE_TITLE mirrors NAME',
    item[DB_PROPERTIES.MOVIE_TITLE] === item[DB_PROPERTIES.NAME],
  );
  check('year drops the parentheses around it', item[DB_PROPERTIES.YEAR] === '1994');
  check(
    'poster is taken when the image carries the real-poster marker, and .webp → .jpg',
    item[DB_PROPERTIES.POSTER] ===
      'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p480747492.jpg',
  );
  check(
    'directors come from the 导演 row',
    item[DB_PROPERTIES.DIRECTORS] === '弗兰克·德拉邦特',
  );
  check(
    'writers are joined with " / "',
    item[DB_PROPERTIES.SCREENWRITERS] === '弗兰克·德拉邦特 / 斯蒂芬·金',
  );
  check(
    'actors are capped at five',
    item[DB_PROPERTIES.ACTORS] ===
      '蒂姆·罗宾斯 / 摩根·弗里曼 / 鲍勃·冈顿 / 威廉姆·赛德勒 / 克兰西·布朗',
  );
  check(
    'genre collects every v:genre element',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '["剧情","犯罪"]',
  );
  check(
    'IMDb link is built from the id in the following text node',
    item[DB_PROPERTIES.IMDB_LINK] === 'https://www.imdb.com/title/tt0111161',
  );
}

{
  const item = buildMovieItem(
    html(`<div id="content"><h1><span property="v:itemreviewed">无海报</span></h1>
      <div id="mainpic"><img src="https://img1.doubanio.com/x.webp" title="点击上传封面图片"></div>
      <div id="info"></div></div>`),
  );
  check(
    'an image carrying the placeholder marker is NOT used as the poster (opposite predicate to the cover branches)',
    item[DB_PROPERTIES.POSTER] === '',
  );
}

{
  const item = buildMovieItem(
    html('<div id="content"><h1></h1><div id="info"></div></div>'),
  );
  check(
    'a page with no title element yields empty strings, not undefined',
    item[DB_PROPERTIES.NAME] === '',
  );
  check(
    'a page with no #mainpic yields an empty poster',
    item[DB_PROPERTIES.POSTER] === '',
  );
  check(
    'a page with NO #info rows does not throw (regression guard: the director fallback used to dereference undefined)',
    item[DB_PROPERTIES.DIRECTORS] === '' &&
      item[DB_PROPERTIES.ACTORS] === '' &&
      item[DB_PROPERTIES.SCREENWRITERS] === '' &&
      JSON.stringify(item[DB_PROPERTIES.GENRE]) === '[]',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// buildMusicItem
// ───────────────────────────────────────────────────────────────────────────

section('buildMusicItem / 音乐条目页');

{
  const item = buildMusicItem(fixture('music.html'));
  check(
    'title comes from #wrapper h1 span',
    item[DB_PROPERTIES.NAME] === '范特西 Fantasy',
  );
  check(
    'MUSIC_TITLE mirrors NAME',
    item[DB_PROPERTIES.MUSIC_TITLE] === item[DB_PROPERTIES.NAME],
  );
  check(
    'cover is used when the image is not the placeholder and the src is short',
    item[DB_PROPERTIES.COVER] ===
      'https://img1.doubanio.com/view/subject/l/public/s1234567.jpg',
  );
  check(
    'an ISO release date is kept as-is',
    item[DB_PROPERTIES.RELEASE_DATE] === '2001-09-14',
  );
  check('musician strips the 表演者 label', item[DB_PROPERTIES.MUSICIAN] === '周杰伦');
}

{
  const item = buildMusicItem(
    html(`<div id="wrapper"><h1><span>中文日期专辑</span></h1>
      <div id="mainpic"><img src="https://img1.doubanio.com/view/subject/l/public/s1.jpg" title="中文日期专辑"></div>
      <div id="info"><span class="pl">发行时间:</span> 2006年1月01日</div></div>`),
  );
  check(
    'a Chinese-form release date is parsed through the 年月日 branch',
    item[DB_PROPERTIES.RELEASE_DATE] === '2006-01-01',
  );
}

{
  const item = buildMusicItem(
    html(`<div id="wrapper"><h1><span>中文日期单数字日</span></h1>
      <div id="mainpic"><img src="https://img1.doubanio.com/view/subject/l/view/s1.jpg" title="中文日期单数字日"></div>
      <div id="info"><span class="pl">发行时间:</span> 2006年1月1日</div></div>`),
  );
  check(
    'KNOWN LIMIT: a Chinese date whose day is NOT zero-padded does not match, so the release date is dropped silently',
    item[DB_PROPERTIES.RELEASE_DATE] === '',
  );
}

{
  const long = `https://img1.doubanio.com/${'a'.repeat(120)}.jpg`;
  const item = buildMusicItem(
    html(`<div id="wrapper"><h1><span>长链接专辑</span></h1>
      <div id="mainpic"><img src="${long}" title="长链接专辑"></div><div id="info"></div></div>`),
  );
  check(
    'an over-long image src is rejected as a placeholder, not used as the cover',
    item[DB_PROPERTIES.COVER] === '',
  );
}

{
  const item = buildMusicItem(
    html(`<div id="wrapper"><h1><span>占位专辑</span></h1>
      <div id="mainpic"><img src="https://img1.doubanio.com/s.jpg" title="点击上传封面图片"></div>
      <div id="info"></div></div>`),
  );
  check(
    'an image carrying the placeholder marker is rejected as the cover',
    item[DB_PROPERTIES.COVER] === '',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// buildBookItem
// ───────────────────────────────────────────────────────────────────────────

section('buildBookItem / 图书条目页');

{
  const item = buildBookItem(fixture('book.html'));
  check(
    'title comes from #wrapper h1 [property="v:itemreviewed"]',
    item[DB_PROPERTIES.NAME] === '百年孤独',
  );
  check(
    'cover is used for a normal image',
    item[DB_PROPERTIES.COVER] ===
      'https://img1.doubanio.com/view/subject/l/public/s27237842.jpg',
  );
  check(
    'the writer row drops the 作者 label',
    item[DB_PROPERTIES.WRITER] === '加西亚·马尔克斯',
  );
  check('ISBN becomes a number', item[DB_PROPERTIES.ISBN] === 9787544253994);
  check(
    'a short numeric publish date is normalised to YYYY-MM-DD',
    item[DB_PROPERTIES.PUBLICATION_DATE] === '2011-06-01',
  );
  check(
    'QUIRK: the publisher value keeps its 出版社 label, because that branch takes the whole row text',
    item[DB_PROPERTIES.PUBLISHING_HOUSE] === '出版社: 南海出版公司',
  );
  check(
    'QUIRK: 原作名 is appended to the title with no separator',
    item[DB_PROPERTIES.BOOK_TITLE] === '百年孤独Cien años de soledad',
  );
}

{
  const item = buildBookItem(
    html(`<div id="wrapper"><h1><span property="v:itemreviewed">单作者书</span></h1>
      <div id="mainpic"><img src="https://img1.doubanio.com/view/subject/l/public/s2.jpg" title="单作者书"></div>
      <div id="info"><span class="pl">作者</span><span class="attrs"><a href="/a/1/">某作者</a></span></div></div>`),
  );
  check(
    'the single-author branch reads the sibling span (parentElement IS #info)',
    item[DB_PROPERTIES.WRITER] === '某作者',
  );
}

{
  const item = buildBookItem(
    html(`<div id="wrapper"><h1><span property="v:itemreviewed">中文出版年</span></h1>
      <div id="info"><span><span class="pl">出版年:</span> 2000年5月</span></div></div>`),
  );
  check(
    '2000年5月 is converted through the separator special case',
    item[DB_PROPERTIES.PUBLICATION_DATE] === '2000-05-01',
  );
}

{
  const item = buildBookItem(
    html(`<div id="wrapper"><h1><span property="v:itemreviewed">无出版年</span></h1>
      <div id="info"><span><span class="pl">出版年:</span></span></div></div>`),
  );
  check(
    'an EMPTY 出版年 yields "" — regression guard: `dayjs("")` formats to the literal "Invalid Date"',
    item[DB_PROPERTIES.PUBLICATION_DATE] === '',
  );
}

{
  const item = buildBookItem(
    html(`<div id="wrapper"><h1><span property="v:itemreviewed">不可解析出版年</span></h1>
      <div id="info"><span><span class="pl">出版年:</span> 不明</span></div></div>`),
  );
  check(
    'an UNPARSEABLE 出版年 yields "" rather than the literal "Invalid Date"',
    item[DB_PROPERTIES.PUBLICATION_DATE] === '',
  );
}

{
  const item = buildBookItem(
    html(
      `<div id="wrapper"><h1><span property="v:itemreviewed">无出版年行</span></h1><div id="info"></div></div>`,
    ),
  );
  check(
    'a book page with no 出版年 row at all yields ""',
    item[DB_PROPERTIES.PUBLICATION_DATE] === '',
  );
  check('…and an ISBN of 0 (never NaN)', item[DB_PROPERTIES.ISBN] === 0);
}

// ───────────────────────────────────────────────────────────────────────────
// buildGameItem
// ───────────────────────────────────────────────────────────────────────────

section('buildGameItem / 游戏条目页');

{
  const item = buildGameItem(fixture('game.html'));
  check(
    'title comes from #wrapper #content h1',
    item[DB_PROPERTIES.NAME] === '塞尔达传说 旷野之息',
  );
  check(
    'GAME_TITLE mirrors NAME',
    item[DB_PROPERTIES.GAME_TITLE] === item[DB_PROPERTIES.NAME],
  );
  check(
    'genre collects the links in the 类型 row',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '["动作","冒险"]',
  );
  check(
    'release date is normalised',
    item[DB_PROPERTIES.RELEASE_DATE] === '2017-03-03',
  );
  check(
    'cover is used for a normal image',
    item[DB_PROPERTIES.COVER] ===
      'https://img1.doubanio.com/view/subject/l/public/s1111111.jpg',
  );
}

{
  const item = buildGameItem(
    html(`<div id="wrapper"><div id="content"><h1>老版游戏页</h1>
      <div class="item-subject-info"><div class="pic"><img src="https://img1.doubanio.com/x.jpg" title="老版游戏页"></div></div>
      <div class="game-attr"><dl><dt>类型</dt><dd><a>RPG</a></dd></dl></div></div></div>`),
  );
  check(
    'the older `.game-attr` container is still supported',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '["RPG"]',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// buildDramaItem
// ───────────────────────────────────────────────────────────────────────────

section('buildDramaItem / 舞台剧条目页');

{
  const item = buildDramaItem(fixture('drama.html'));
  check('title comes from .drama-info .meta h1', item[DB_PROPERTIES.NAME] === '茶馆');
  check(
    'DRAMA_TITLE mirrors NAME',
    item[DB_PROPERTIES.DRAMA_TITLE] === item[DB_PROPERTIES.NAME],
  );
  check(
    'a single genre is wrapped in an array',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '["话剧"]',
  );
  check(
    'poster is taken from .drama-info .pic img',
    item[DB_PROPERTIES.POSTER] ===
      'https://img1.doubanio.com/view/locpic/l/public/p2222222.jpg',
  );
}

{
  const item = buildDramaItem(
    html(
      `<div id="content"><div class="drama-info"><div class="meta"><h1>无类型舞台剧</h1></div></div></div>`,
    ),
  );
  check(
    'no genre yields an empty array in the GENRE column',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '[]',
  );
  check('…and an empty poster, not undefined', item[DB_PROPERTIES.POSTER] === '');
}

{
  const item = buildGameItem(
    html('<div id="wrapper"><div id="content"><h1>无属性容器</h1></div></div>'),
  );
  check(
    'a game page with NEITHER `.game-attr` nor `.thing-attr` does not throw (regression guard)',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '[]' &&
      item[DB_PROPERTIES.RELEASE_DATE] === '',
  );
  check(
    '…and still reports the title it did find',
    item[DB_PROPERTIES.NAME] === '无属性容器',
  );
}

{
  const item = buildGameItem(
    html(`<div id="wrapper"><div id="content"><h1>孤立 dt</h1>
      <div class="thing-attr"><dl><dt>类型</dt></dl></div></div></div>`),
  );
  check(
    'a `dt` with no following `dd` does not throw (regression guard)',
    JSON.stringify(item[DB_PROPERTIES.GENRE]) === '[]',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-parser invariant
// ───────────────────────────────────────────────────────────────────────────

section('Cross-parser invariant / 跨解析器不变量');

{
  const movie = buildMovieItem(fixture('movie.html'));
  const music = buildMusicItem(fixture('music.html'));
  const book = buildBookItem(fixture('book.html'));
  const game = buildGameItem(fixture('game.html'));
  const drama = buildDramaItem(fixture('drama.html'));

  check(
    'every parser sets NAME to a non-empty string',
    [movie, music, book, game, drama].every(
      (item) =>
        typeof item[DB_PROPERTIES.NAME] === 'string' && item[DB_PROPERTIES.NAME] !== '',
    ),
  );
  check(
    'every parser emits at least one non-empty TITLE column (addItemToNotion skips falsy columns)',
    [movie, music, book, game, drama].every((item) => {
      const titleColumns = [
        DB_PROPERTIES.MOVIE_TITLE,
        DB_PROPERTIES.MUSIC_TITLE,
        DB_PROPERTIES.BOOK_TITLE,
        DB_PROPERTIES.GAME_TITLE,
        DB_PROPERTIES.DRAMA_TITLE,
      ];
      return titleColumns.some(
        (col) => typeof item[col] === 'string' && item[col] !== '',
      );
    }),
  );
  check(
    'movie / music / game / drama set their TITLE column to exactly NAME',
    [movie, music, game, drama].every(
      (item) =>
        item[DB_PROPERTIES.MOVIE_TITLE] === item[DB_PROPERTIES.NAME] ||
        item[DB_PROPERTIES.MUSIC_TITLE] === item[DB_PROPERTIES.NAME] ||
        item[DB_PROPERTIES.GAME_TITLE] === item[DB_PROPERTIES.NAME] ||
        item[DB_PROPERTIES.DRAMA_TITLE] === item[DB_PROPERTIES.NAME],
    ),
  );
  check(
    'book is the exception: 原作名 is appended, so BOOK_TITLE starts with NAME',
    String(book[DB_PROPERTIES.BOOK_TITLE]).startsWith(String(book[DB_PROPERTIES.NAME])),
  );
  check(
    'no parser emits a literal "Invalid Date" anywhere (regression guard for the whole family)',
    [movie, music, book, game, drama].every((item) =>
      Object.values(item).every((v) => v !== 'Invalid Date'),
    ),
  );
}

// ───────────────────────────────────────────────────────────────────────────

summary();
