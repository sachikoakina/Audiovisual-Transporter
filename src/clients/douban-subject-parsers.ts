/**
 * Douban subject-page parsers — decode a subject page's DOM into Notion column values.
 * 豆瓣条目页解析器 —— 把条目页 DOM 解码为 Notion 的列值。
 *
 * Pure by construction: no network, no `process.env`, no file system. Every `buildXxxItem`
 * is a `Document -> fields` transform, so its behaviour can be frozen with saved HTML
 * fixtures instead of being re-derived by reading the selectors. That is the whole point of
 * splitting this file out of `douban-subject-page.ts`.
 * 构造上即纯函数：无网络、无 `process.env`、无文件系统。每个 `buildXxxItem` 都是
 * `Document -> 字段` 变换，因此可以用保存的 HTML fixture 冻结行为，而不是靠读选择器
 * 反推语义。这正是把它从 `douban-subject-page.ts` 拆出来的全部理由。
 */
import dayjs from 'dayjs';
import { DB_PROPERTIES } from '../types';

/** Real poster image lives in `#mainpic img`. / 真实海报图所在的选择器。 */
const IMG_SELECTOR = '#mainpic img';
/** Info rows (`导演` / `主演` / `作者` …) live in `#info span.pl`. / 条目信息行的选择器。 */
const INFO_SELECTOR = '#info span.pl';

/**
 * The two "no real image here" markers Douban puts on the subject image element.
 *
 * They are *different kinds* of marker, which is why the two predicates below look
 * inverted but are not:
 *  - `REAL_POSTER` is a positive marker: the image is the real poster (movie page).
 *  - `PLACEHOLDER_COVER` is a negative marker: the image is a "click to upload" placeholder,
 *    so the real cover (if any) has to be taken from the `src` only when this marker is absent.
 *
 * 豆瓣在条目图元素上使用的两个「非真实图片」标记。两者是*不同性质*的标记，这也是下面两处
 * 判定式看起来极位相反但并不矛盾的原因：
 *  - `REAL_POSTER` 是正向标记：该图就是真实海报（电影页）。
 *  - `PLACEHOLDER_COVER` 是反向标记：该图是「点击上传封面图片」占位符，因此只有在它缺席
 *    时才把 `src` 当作真实封面。
 *
 * Neither predicate can be validated offline against the live site; both should stay frozen
 * by fixtures rather than "corrected" by guesswork.
 * 这两处判定都无法离线对着线上页面验证；应当用 fixture 冻结，而不是靠猜去「纠正」。
 */
export const DOUBAN_IMAGE_MARKERS = {
  REAL_POSTER: '点击看更多海报',
  PLACEHOLDER_COVER: '点击上传封面图片',
} as const;

/** Movie: `https://movie.douban.com/subject/*` / 电影条目页。 */
export function buildMovieItem(doc: Document) {
  const title =
    doc.querySelector('#content h1 [property="v:itemreviewed"]')?.textContent?.trim() ||
    '';
  const year = doc.querySelector('#content h1 .year')?.textContent?.slice(1, -1) || '';
  const img = doc.querySelector(IMG_SELECTOR) as HTMLImageElement;
  const poster =
    img?.title === DOUBAN_IMAGE_MARKERS.REAL_POSTER
      ? img?.src?.trim().replace(/\.webp$/, '.jpg')
      : '';

  const infoPl = [...doc.querySelectorAll(INFO_SELECTOR)];
  const directorPl = infoPl.filter((i) => i.textContent === '导演');
  // `?.` is required, not cosmetic: a page with no `#info span.pl` rows at all leaves both
  // `directorPl[0]` and `infoPl[0]` undefined, and the old unguarded `.nextElementSibling` threw
  // `TypeError` — one partial page could therefore abort the whole item.
  // `?.` 是必需的，不是修饰：页面完全没有 `#info span.pl` 行时，`directorPl[0]` 与 `infoPl[0]`
  // 都是 undefined，而原先未加保护的 `.nextElementSibling` 会抛 `TypeError` —— 一个不完整的
  // 页面就能让整个条目失败。
  const directors =
    (directorPl[0] ?? infoPl[0])?.nextElementSibling?.textContent?.trim() || '';
  const actorsPl = infoPl.filter((i) => i.textContent === '主演');
  const actorLinks = actorsPl[0]?.nextElementSibling?.querySelectorAll('span a');
  const actors = actorLinks
    ? [...actorLinks]
        .slice(0, 5)
        .map((i) => i.textContent)
        .join(' / ')
    : '';
  const screenwritersPl = infoPl.filter((i) => i.textContent === '编剧');
  const writerLinks = screenwritersPl[0]?.nextElementSibling?.querySelectorAll('span a');
  const screenwriters = writerLinks
    ? [...writerLinks]
        .slice(0, 5)
        .map((i) => i.textContent)
        .join(' / ')
    : '';

  const genre = [...doc.querySelectorAll('#info [property="v:genre"]')]
    .map((i) => i.textContent || '')
    .filter((v) => v);
  const imdbInfo = [...doc.querySelectorAll(INFO_SELECTOR)].filter((i) =>
    i.textContent?.startsWith('IMDb'),
  );
  const imdbLink = imdbInfo.length
    ? 'https://www.imdb.com/title/' + imdbInfo[0].nextSibling?.textContent?.trim()
    : '';

  return {
    [DB_PROPERTIES.NAME]: title,
    [DB_PROPERTIES.MOVIE_TITLE]: title,
    [DB_PROPERTIES.YEAR]: year,
    [DB_PROPERTIES.POSTER]: poster, // optional / 可选
    [DB_PROPERTIES.DIRECTORS]: directors,
    [DB_PROPERTIES.SCREENWRITERS]: screenwriters, // optional / 可选
    [DB_PROPERTIES.ACTORS]: actors,
    [DB_PROPERTIES.GENRE]: genre,
    [DB_PROPERTIES.IMDB_LINK]: imdbLink, // optional / 可选
  };
}

/** Music: `https://music.douban.com/subject/*` / 音乐条目页。 */
export function buildMusicItem(doc: Document) {
  const title = doc.querySelector('#wrapper h1 span')?.textContent?.trim() || '';
  const img = doc.querySelector(IMG_SELECTOR) as HTMLImageElement;
  const cover =
    img?.title !== DOUBAN_IMAGE_MARKERS.PLACEHOLDER_COVER && img?.src.length <= 100
      ? img?.src.replace(/\.webp$/, '.jpg')
      : '';
  const info = [...doc.querySelectorAll(INFO_SELECTOR)];
  const release = info.filter((i) => i.textContent?.trim().startsWith('发行时间'));
  let releaseDate = '';
  if (release.length) {
    const text = release[0].nextSibling?.textContent?.trim() || '';
    if (/\d{4}-\d/.test(text) && text) {
      releaseDate = dayjs(text).format('YYYY-MM-DD');
    } else if (/\d{4}年\d{1,2}月\d{2}日/.test(text)) {
      // Not a bug: some music pages publish the release date in Chinese form
      // (`2006年1月1日`), which `dayjs` cannot parse, hence the branch below.
      // Example: https://music.douban.com/subject/2375247/
      // 这不是缺陷：部分音乐条目的发行时间是中文格式（如「2006年1月1日」），`dayjs` 无法
      // 直接解析，因此需要下面这个分支单独处理。
      const match = text.match(/(\d{4})年(\d{1,2})月(\d{2})日/);
      releaseDate = dayjs(`${match![1]}-${match![2]}-${match![3]}`).format(
        'YYYY-MM-DD',
      );
    }
  }
  const musicianElems = info.filter((i) => i.textContent?.trim().startsWith('表演者'));
  // Split-and-trim removes the newlines Douban inserts; Notion rich_text is capped at
  // 2000 characters, so long values are truncated downstream by `buildPropertyValue`.
  // 拆分再 trim 以去掉豆瓣插入的换行；Notion rich_text 上限 2000 字符，超长值由下游的
  // `buildPropertyValue` 截断。
  const musician = musicianElems.length
    ? musicianElems[0].textContent
        ?.replace('表演者:', '')
        .trim()
        .split('\n')
        .map((v) => v.trim())
        .join('')
    : '';

  return {
    [DB_PROPERTIES.MUSIC_TITLE]: title,
    [DB_PROPERTIES.NAME]: title,
    [DB_PROPERTIES.COVER]: cover, // optional / 可选
    [DB_PROPERTIES.RELEASE_DATE]: releaseDate, // optional / 可选
    [DB_PROPERTIES.MUSICIAN]: musician, // optional / 可选
  };
}

/** Book: `https://book.douban.com/subject/*` / 图书条目页。 */
export function buildBookItem(doc: Document) {
  const title =
    doc.querySelector('#wrapper h1 [property="v:itemreviewed"]')?.textContent?.trim() ||
    '';
  const img = doc.querySelector(IMG_SELECTOR) as HTMLImageElement;
  const cover =
    img?.title !== DOUBAN_IMAGE_MARKERS.PLACEHOLDER_COVER && img?.src.length <= 100
      ? img?.src.replace(/\.webp$/, '.jpg')
      : '';
  const info = [...doc.querySelectorAll(INFO_SELECTOR)];

  let writer = '',
    publisher = '',
    bookTitle = title,
    publishDate = '',
    isbn = 0;
  info.forEach((i) => {
    const text = i.textContent?.trim() || '';
    // `nextSibling` may be an empty `#text` node, hence the `nextElementSibling` fallback.
    // `nextSibling` 可能是空的 `#text` 节点，故需回退到 `nextElementSibling`。
    let nextText =
      i.nextSibling?.textContent?.trim() ||
      i.nextElementSibling?.textContent?.trim() ||
      '';

    if (text.startsWith('作者')) {
      writer =
        i.parentElement?.id === 'info'
          ? // Single author: the parent element is the `#info` container itself.
            // 单一作者：父元素就是 `#info` 容器本身。
            i.nextElementSibling?.textContent?.replace(/\n/g, '').replace(/\s/g, '') ||
            ''
          : // Multiple authors: each one gets its own `<span>`.
            // 多个作者：每人一个独立的 `<span>`。
            i.parentElement?.textContent?.trim().replace('作者:', '').trim() || '';
    } else if (text.startsWith('出版社')) {
      // `nextSibling` may be an empty `#text` node, in which case it must be skipped.
      // `nextSibling` 可能是空的 `#text` 节点，此时需要跳过。
      publisher =
        i.nextElementSibling?.tagName === 'BR' || !i.nextSibling?.textContent?.trim()
          ? nextText
          : // The publisher may be wrapped in its own `<a>上海三联书店</a>`.
            // 出版社可能有独立的链接 `<a>上海三联书店</a>`。
            i.parentElement?.textContent?.trim() || '';
    } else if (text.startsWith('原作名')) {
      bookTitle = title + nextText;
    } else if (text.startsWith('出版年')) {
      if (/年|月|日/.test(nextText)) {
        // `2000年5月` special case: convert separators, then drop the trailing one.
        // 「2000年5月」这类特例：先替换分隔符，再去掉结尾多出来的那一个。
        nextText = nextText.replace(/年|月|日/g, '-').slice(0, -1);
      }
      // Guard required. `dayjs('')` is an Invalid Date, and `.format()` on it returns the literal
      // string `'Invalid Date'` — which would then be submitted as a perfectly valid DATE value.
      // The music and game branches already guard this; books were the one that did not.
      // 必须加守卫。`dayjs('')` 是 Invalid Date，对它 `.format()` 会返回**字面量**字符串
      // `'Invalid Date'`，然后会被当成完全合法的 DATE 值提交。音乐与游戏分支早已加了守卫，
      // 图书是唯一漏掉的那个。
      const parsed = nextText ? dayjs(nextText) : null;
      publishDate = parsed?.isValid() ? parsed.format('YYYY-MM-DD') : '';
    } else if (text.startsWith('ISBN')) {
      isbn = Number(nextText);
    }
  });

  return {
    [DB_PROPERTIES.NAME]: title,
    [DB_PROPERTIES.COVER]: cover, // optional / 可选
    [DB_PROPERTIES.WRITER]: writer, // optional / 可选
    [DB_PROPERTIES.PUBLISHING_HOUSE]: publisher, // optional / 可选
    [DB_PROPERTIES.BOOK_TITLE]: bookTitle, // optional / 可选
    [DB_PROPERTIES.PUBLICATION_DATE]: publishDate, // optional / 可选
    [DB_PROPERTIES.ISBN]: isbn, // optional / 可选
  };
}

/** Game: `https://www.douban.com/game/*` / 游戏条目页。 */
export function buildGameItem(doc: Document) {
  const title = doc.querySelector('#wrapper #content h1')?.textContent?.trim() || '';
  const img = doc.querySelector('.item-subject-info .pic img') as HTMLImageElement;
  const cover =
    img?.title !== DOUBAN_IMAGE_MARKERS.PLACEHOLDER_COVER && img?.src.length <= 100
      ? img?.src.replace(/\.webp$/, '.jpg')
      : '';
  // Douban renamed the container from `game-attr` to `thing-attr`; keep both selectors so
  // already-published pages keep parsing. Either may be absent on a partial page, hence the `?.`
  // guards on every use below.
  // 豆瓣把容器类名从 `game-attr` 改成了 `thing-attr`；两个选择器都保留，避免老页面解析失败。
  // 不完整的页面上两者都可能缺失，因此下面每一处使用都带 `?.` 保护。
  const gameInfo =
    doc.querySelector('#content .game-attr') ||
    doc.querySelector('#content .thing-attr');
  const dts = gameInfo ? [...gameInfo.querySelectorAll('dt')] : [];
  const genre: string[] = [];
  let releaseDate = '';
  dts.forEach((dt) => {
    if (dt.textContent?.startsWith('类型')) {
      const strs = [...(dt.nextElementSibling?.querySelectorAll('a') ?? [])]
        .map((a) => a.textContent?.trim() || '')
        .filter((v) => v);
      genre.push(...strs);
    } else if (dt.textContent?.startsWith('发行日期')) {
      const date = dt.nextElementSibling?.textContent?.trim() || '';
      releaseDate = date ? dayjs(date).format('YYYY-MM-DD') : '';
    }
  });

  return {
    [DB_PROPERTIES.GAME_TITLE]: title,
    [DB_PROPERTIES.NAME]: title,
    [DB_PROPERTIES.COVER]: cover, // optional / 可选
    [DB_PROPERTIES.GENRE]: genre, // optional string[] / 可选，字符串数组
    [DB_PROPERTIES.RELEASE_DATE]: releaseDate, // optional / 可选
  };
}

/** Stage drama: `https://www.douban.com/location/drama/*` / 舞台剧条目页。 */
export function buildDramaItem(doc: Document) {
  const title =
    doc.querySelector('#content .drama-info .meta h1')?.textContent?.trim() || '';
  const genre =
    doc
      .querySelector('#content .drama-info .meta [itemprop="genre"]')
      ?.textContent?.trim() || '';
  const img = doc.querySelector('.drama-info .pic img') as HTMLImageElement;
  const poster =
    img?.title !== DOUBAN_IMAGE_MARKERS.PLACEHOLDER_COVER && img?.src.length <= 100
      ? img?.src.replace(/\.webp$/, '.jpg')
      : '';
  return {
    [DB_PROPERTIES.DRAMA_TITLE]: title,
    [DB_PROPERTIES.NAME]: title,
    [DB_PROPERTIES.POSTER]: poster, // optional / 可选
    [DB_PROPERTIES.GENRE]: genre ? [genre] : [], // optional / 可选
  };
}
