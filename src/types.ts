/**
 * Shared vocabulary — every type and enum the rest of the codebase agrees on.
 * 共享词汇表 —— 其余代码共同约定的全部类型与枚举。
 *
 * Also the single gateway to `cols.json`: re-exporting `DB_PROPERTIES` here means no module
 * nested in a subdirectory needs a `../../` import, and there is exactly one place that knows
 * where the Notion column definitions live.
 * 同时也是 `cols.json` 的唯一入口：在这里再导出 `DB_PROPERTIES`，使任何处于子目录的模块都不必
 * 写 `../../` 形式的导入，并且「Notion 列定义放在哪里」只有一处知道。
 */
import Parser from 'rss-parser';
import DB_PROPERTIES from '../cols.json';

export { DB_PROPERTIES };

export type DB_PROPERTIES_KEYS = Exclude<keyof typeof DB_PROPERTIES, 'NAME'>;

export enum ItemCategory {
  Movie = 'movie',
  Music = 'music',
  Book = 'book',
  Game = 'game',
  Drama = 'drama',
}

// Follow the schema value of NeoDB. A const object, not an enum: the same four values also back
// `SHELF_TYPES`, and an enum would be a second declaration of the same vocabulary.
// 跟随 NeoDB 的 schema 值。用 const 对象而不是 enum：同样四个值还要支撑 `SHELF_TYPES`，
// enum 会让同一套词汇出现第二份声明。
export const ItemStatus = {
  Wishlist: 'wishlist',
  Progress: 'progress',
  Complete: 'complete',
  Dropped: 'dropped',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/**
 * A raw `rss-parser` entry. The index signature is `unknown`, not `any`: everything this repo
 * reads off it (`title` / `link` / `content` / `isoDate`) is declared by `Parser.Item`, so nothing
 * needs the escape hatch — and `unknown` makes an undeclared field a compile error instead of a
 * silent `undefined` that a later `!` hides.
 * 原始的 `rss-parser` 条目。索引签名是 `unknown` 而不是 `any`：本仓库从它上面读的字段
 * （`title` / `link` / `content` / `isoDate`）都由 `Parser.Item` 声明，没有哪个字段需要这个
 * 逃生口 —— 而 `unknown` 会让未声明的字段变成编译错误，而不是一个被后面的 `!` 遮住的 `undefined`。
 */
export type RSSFeedItem = {
  [key: string]: unknown;
} & Parser.Item;

export type FeedItem = {
  id: string;
  link: string;
  title: string;
  rating: number | null;
  comment: string | null;
  time: string;
  status: ItemStatus;
  category: ItemCategory;
};

/** Bangumi SubjectType: 1 book, 2 anime, 3 music, 4 game, 6 real */
export type BangumiSubjectType = 1 | 2 | 3 | 4 | 6;

/** Bangumi CollectionType: 1 wish, 2 done, 3 doing, 4 on-hold, 5 dropped */
export type BangumiCollectionType = 1 | 2 | 3 | 4 | 5;

/** NeoDB shelf progress type */
export type NeodbProgressType =
  | 'page'
  | 'chapter'
  | 'part'
  | 'episode'
  | 'track'
  | 'cycle'
  | 'timestamp'
  | 'percentage';

export enum NotionPropTypesEnum {
  TITLE = 'title',
  RICH_TEXT = 'rich_text',
  FILES = 'files',
  DATE = 'date',
  MULTI_SELECT = 'multi_select',
  NUMBER = 'number',
  URL = 'url',
}

export type NotionRichTextPropType = {
  id?: string;
  type: NotionPropTypesEnum.RICH_TEXT;
  rich_text: {
    type: 'text';
    text: {
      content: string;
    };
  }[];
};

export type NotionTitlePropType = {
  // Notion returns a real (random) property id here — it is not the literal `'title'`.
  // Notion 在这里返回的是真实的（随机）属性 id，并不是字面量 `'title'`。
  id?: string;
  type: NotionPropTypesEnum.TITLE;
  title: {
    text: {
      content: string;
    };
  }[];
};

export type NotionFilesPropType = {
  id?: string;
  type: NotionPropTypesEnum.FILES;
  files: {
    name: string;
    type: 'external';
    external: {
      url: string;
    };
  }[];
};

export type NotionDatePropType = {
  id?: string;
  type: NotionPropTypesEnum.DATE;
  /**
   * Only `start` is ever sent; Notion fills the rest of the range in itself, so `end` and
   * `time_zone` are optional rather than required.
   * 实际只会发送 `start`，其余区间信息由 Notion 自行补全，因此 `end` 与 `time_zone` 是可选
   * 而不是必填。
   */
  date: {
    start: string;
    end?: string | null;
    time_zone?: string | null;
  };
};

export type NotionMultiSelectPropType = {
  id?: string;
  type: NotionPropTypesEnum.MULTI_SELECT;
  multi_select: {
    name: string;
  }[];
};

export type NotionNumberPropType = {
  id?: string;
  type: NotionPropTypesEnum.NUMBER;
  number: number | null;
};

export type NotionUrlPropType = {
  id?: string;
  type: NotionPropTypesEnum.URL;
  url: string;
};

export type NotionColPropTypes =
  | NotionRichTextPropType
  | NotionTitlePropType
  | NotionFilesPropType
  | NotionDatePropType
  | NotionMultiSelectPropType
  | NotionNumberPropType
  | NotionUrlPropType;

export type FailedItem = {
  link: string;
  title: string;
  /**
   * Why it failed, as a slug. Optional so an existing caller that has nothing to add does not
   * have to invent one — the listing then prints the bare title.
   * 失败原因的 slug。可选：没有额外信息的调用方不必硬编一个，清单就只打印标题。
   */
  reason?: string;
};

// ───────────────────────────────────────────────────────────────────────────
// NeoDB → TMDB path
//
// Shapes below are copied from the verified NeoDB API reference, not guessed.
// See README "接口依据" for sources.
// ───────────────────────────────────────────────────────────────────────────

/** `{type}` path variable of GET /api/me/shelf/{type}. Verified: all four exist. */
export const SHELF_TYPES = [
  ItemStatus.Wishlist,
  ItemStatus.Progress,
  ItemStatus.Complete,
  ItemStatus.Dropped,
] as const;

export type ShelfType = (typeof SHELF_TYPES)[number];

/** `category` query parameter of GET /api/me/shelf/{type}. */
export type NeodbCategory =
  'book' | 'movie' | 'tv' | 'music' | 'game' | 'podcast' | 'performance';

/**
 * ItemSchema — the catalog object, inlined as `mark.item` on the shelf API.
 *
 * This is the union of what the two sync paths need: the legacy Douban/Notion
 * fields (`id`, `brief`) and the shelf fields (`year`, `pub_year`,
 * `description`). Kept in `types.ts` — the shared vocabulary module — so that no
 * client has to import a type out of another client.
 *
 * 这是两条同步链路所需字段的并集：旧有豆瓣/Notion 字段（`id`、`brief`）与书架字段
 * （`year`、`pub_year`、`description`）。保留在 `types.ts`（共享词汇表）里，使任何客户端都不必
 * 从另一个客户端导入类型。
 */
export type NeodbItem = {
  /** Legacy field required by the existing mark logic. */
  id: string;
  type: string;
  uuid: string;
  url: string;
  api_url: string;
  category: NeodbCategory | string;
  parent_uuid: string | null;
  display_title: string;
  title: string;
  /** Short summary (legacy field name). */
  brief: string;
  description: string;
  cover_image_url: string;
  rating: number;
  rating_count: number;
  localized_title?: { lang?: string; text?: string }[];
  localized_description?: { lang?: string; text?: string }[];
  /** Platform URLs; verified platforms include douban, imdb and tmdb. */
  external_resources: { url: string }[];
  /** MovieSchema / TVSchema only. */
  year?: number;
  /** EditionSchema (books) only. */
  pub_year?: number;
};

/**
 * MarkSchema — one element of `data[]` in PagedMarkSchema.
 *
 * Named `NeodbShelfMark` to distinguish it from `NeodbMark` in
 * `clients/neodb-shelf.ts`, which is a different (item-less) shape used by the
 * mark read/write calls. The two are easy to confuse and are not interchangeable.
 *
 * 命名为 `NeodbShelfMark` 是为了与 `clients/neodb-shelf.ts` 里的 `NeodbMark` 区分开：后者是
 * 标记读写调用使用的另一种（不含条目内容的）结构。两者很容易混淆，且不可互换。
 */
export type NeodbShelfMark = {
  shelf_type: ShelfType | string;
  /** 0 = public, 1 = followers, 2 = private. Not mapped to TMDB (no equivalent). */
  visibility?: number;
  post_id?: number;
  /** Catalog item, inlined — no second request needed. */
  item: NeodbItem;
  created_time?: string;
  /** Free-text short comment. TMDB has no write endpoint for it. */
  comment_text?: string;
  /** 0 = unrated, 2 = 1 star … 10 = 5 stars. */
  rating_grade?: number;
  tags?: string[];
};

/** PagedMarkSchema — response of GET /api/me/shelf/{type}. */
export type NeodbPagedMark = {
  data: NeodbShelfMark[];
  pages: number;
  count: number;
};

/** GET /api/me */
export type NeodbMe = {
  username?: string;
  display_name?: string;
  url?: string;
};

/** How Douban/Bangumi marks merge into an existing NeoDB mark. / 豆瓣/Bangumi 的标记如何合并进 NeoDB 已有标记。 */
export type NeodbMergeProfile = 'overwrite' | 'neodb_prefer';

/** Only movie and tv can carry a TMDB user mark. */
export type TmdbMediaType = 'movie' | 'tv';

/** A resolved TMDB target — enough to address every write endpoint. */
export type TmdbTarget = {
  mediaType: TmdbMediaType;
  id: number;
  title?: string;
  /**
   * Release (or first-air) year, when the response carried a date.
   *
   * Only filled by the by-id lookups. It exists so the TMDB-link level can say "this link points at
   * an entity from a different decade" — the one check that level can still make, since a link is a
   * choice the user made and must not be overruled silently.
   *
   * 发行（或首播）年份，响应带日期时才有值。
   *
   * 只有按 id 查询的调用会填它。它的存在是为了让 TMDB 外链那一级能说出「这个外链指向的是另一个
   * 年代的实体」—— 那一级唯一还能做的检查，因为外链是用户自己的选择，不该被程序静默推翻。
   */
  year?: number;
};

/**
 * GET /3/{movie|tv}/{id}/account_states.
 * `rated` is `{ value }` when rated and `false` when not — never a boolean.
 */
export type TmdbAccountStates = {
  id: number;
  favorite: boolean;
  rated: { value: number } | false;
  watchlist: boolean;
};

export type TmdbSearchResult = {
  id: number;
  media_type?: string;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
};

/** How a NeoDB↔TMDB rating conflict resolves. */
export type RatingProfile = 'tmdb_prefer' | 'overwrite';

export type SyncCounters = {
  scanned: number;
  /**
   * Marks that actually reached TMDB: past the shelf/category gates **and** past the incremental
   * skip. `SYNC_MAX_ITEMS` is compared against this counter, not against `scanned`.
   *
   * Why it cannot be `scanned`:
   *   1. `scanned` is the left-hand side of the per-path self-check
   *      (`scanned = written + unchanged + skipped + unresolved + failed`), so it has to count
   *      every mark that entered the loop — including the ones a gate skipped.
   *   2. `scanned` grows at the top of `syncMark`, i.e. *before* the incremental skip. Counting
   *      the quota there lets N unchanged marks at the head of a shelf fill it up without any of
   *      them being processed, so the run can never reach the items behind them.
   *
   * Internal only — deliberately absent from `PathReport`.
   *
   * 真正进入 TMDB 的标记数：已通过书架/分类闸门，**且**已通过增量跳过。`SYNC_MAX_ITEMS` 比较的
   * 是它，而不是 `scanned`。
   *
   * 不能用 `scanned` 的原因：
   *   1. `scanned` 是每条链路自检等式的左边
   *      （`scanned = written + unchanged + skipped + unresolved + failed`），必须计入进入循环的
   *      每一条标记 —— 包括被闸门跳过的那些。
   *   2. `scanned` 在 `syncMark` 开头就自增，即**早于**增量跳过。在那里计配额会让书架头部的 N
   *      条「未变化」标记在一条都没被处理的情况下吃满配额，后面的条目永远轮不到。
   *
   * 仅内部使用 —— 刻意不进入 `PathReport`。
   */
  processed: number;
  skippedCategory: number;
  skippedShelf: number;
  skippedCached: number;
  /**
   * Same TMDB item reached again in one run (an item can sit on several
   * shelves). Counted so that the per-path self-check still adds up: without
   * it, a duplicate would bump `scanned` and nothing else.
   */
  skippedDuplicate: number;
  matchedTmdbLink: number;
  matchedImdb: number;
  matchedSearch: number;
  unmatched: number;
  /**
   * Field-level counters: one item can write both fields, so these sum to more than `written`.
   * Printed in the breakdown, never used for the self-check equation.
   * 字段级计数：一个条目可能两个字段都写，因此它们的和大于 `written`。只在分项明细里打印，
   * 不参与自检等式。
   */
  writtenWatchlist: number;
  writtenRating: number;
  /**
   * Items whose write landed — one per item, not one per field. This is what `report.written`
   * carries, so the self-check (`scanned = written + unchanged + skipped + unresolved + failed`)
   * holds for this path exactly as it does for the other four.
   * 写入真正落地的**条目**数（按条目计，不按字段）。`report.written` 用的是它，自检等式
   * （`scanned = written + unchanged + skipped + unresolved + failed`）因此对本链路与另外四条一样成立。
   */
  written: number;
  unchanged: number;
  failed: number;
};

export function newSyncCounters(): SyncCounters {
  return {
    scanned: 0,
    processed: 0,
    skippedCategory: 0,
    skippedShelf: 0,
    skippedCached: 0,
    skippedDuplicate: 0,
    matchedTmdbLink: 0,
    matchedImdb: 0,
    matchedSearch: 0,
    unmatched: 0,
    writtenWatchlist: 0,
    writtenRating: 0,
    written: 0,
    unchanged: 0,
    failed: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-path result reporting
// ───────────────────────────────────────────────────────────────────────────

/**
 * One entry that a counter counts, kept so the closing listing can name it.
 *
 * Exists because `skipped` and `failed` used to be bare numbers: the summary could say "12
 * skipped" and nothing else, which leaves the reader with no way to tell a designed-in skip
 * (`unchanged since last run`) from one worth fixing (`no Notion data source configured`).
 * The counts are the truth; these lists only explain them, and every list must stay the same
 * length as its count — `printPathSummary` says so out loud when it is not.
 *
 * 被某个计数器计入、同时被记下来以便收尾时点名的一条记录。
 *
 * 之所以需要它：`skipped` 与 `failed` 过去只有数字，汇总只能说「跳过了 12 条」而别无下文，
 * 读者无法区分「设计内的跳过」（自上次运行后无变化）与「值得修的那种」（某个分类没配 Notion
 * 数据源）。**计数才是事实**，这些清单只负责解释；每份清单都必须与其计数等长 ——
 * 不等长时 `printPathSummary` 会明说。
 */
export type ReviewDetail = {
  /**
   * The title as the source named it, e.g. `沙丘 2`. Stored as data, not as a display string:
   * it used to be `label: '某书[https://…]'`, i.e. a URL glued into a title, which is impossible
   * to turn back into a link without parsing the thing you just built.
   * 源端给出的标题。存成数据而不是展示串：过去是 `label: '某书[https://…]'`，把链接粘进标题，
   * 想要回一个可点的链接就得解析自己刚拼出来的字符串。
   */
  title: string;
  /**
   * Where to look, when the source provided one; empty string when it did not.
   * Kept apart from `title` because a title gets edited — that is exactly what the reader goes to
   * fix — so the link is the only stable handle between runs.
   * 能点开的地址；源端没给时为空串。与 `title` 分开，因为标题会被改（而这正是读者要去改的东西），
   * 只有链接是跨轮稳定的句柄。
   */
  url: string;
  /**
   * Why it was counted, using the same slugs as the on-disk review log so a log line and a
   * JSON record can be matched with one grep.
   * 为什么被计入，用与磁盘留档日志同一套 slug，使日志行与 JSON 记录可以用同一次 grep 对上。
   */
  reason: string;
  /**
   * Item type, normalised to the review vocabulary (`movie` / `tv` / `book` …). Optional because
   * an entry can be created without one — a summary-level failure, or an older report. The queue
   * folds a missing value into `other` rather than dropping the entry.
   * 条目类型，已收敛到名单词汇。可缺省：汇总级失败或旧报表本来就没有类型；名单会把它归入
   * `other`，而不是丢掉条目。
   */
  category?: string;
  /**
   * The user's state on the source, normalised to `wishlist` / `progress` / `complete` /
   * `on_hold` / `dropped`. Optional for the same reason as `category`; missing becomes `unknown`.
   * 源端的用户状态，已收敛到固定词汇。与 `category` 同理可缺省；缺失时归入 `unknown`。
   */
  shelf?: string;
};

/**
 * Outcome of one sync path, consumed by the closing summary.
 *
 * Two counts are deliberately treated differently by the exit code:
 *
 *   `unresolved` — the destination simply has no counterpart for this entry
 *                  (an obscure OVA, a book NeoDB never catalogued). That is a
 *                  data gap, not a defect: record it and warn, but never fail
 *                  the run, or CI would go red on every pass.
 *   `failed`     — something threw. A real error: fail the run.
 */
export type PathReport = {
  /** Shown in the summary, e.g. `Bangumi → NeoDB`. */
  label: string;
  scanned: number;
  /**
   * Identities of the items this run actually examined — the same strings the review list uses
   * as the identity part of an entry's key: the Douban link for ①②③, the Bangumi subject URL
   * (plus the display title, for the title-keyed failure lines) for ④, and the display title for
   * ⑤. Empty when the path stopped before examining anything.
   *
   * This is what separates "fixed" from "never looked at". A capped, paginated or aborted run
   * simply contains fewer identities, so the review list can freeze the entries it never reached
   * instead of deleting them. Without it, an incremental run that only walks the first 200 items
   * looks exactly like a run in which every reachable item was repaired.
   *
   * 本轮真正检查过的条目身份 —— 与待核对名单 key 的身份段同形：①②③ 用豆瓣链接，④ 用
   * Bangumi 条目 URL（另加标题，供按标题建 key 的失败行），⑤ 用展示标题。未检查任何条目时为空。
   *
   * 它正是「修好了」与「根本没看」的分界。被配额截断、分页上限或凭据中止的一轮，集合里自然
   * 少一些身份，名单因此可以冻结没走到的条目，而不是把它们删掉。没有它时，一轮只走前 200 条
   * 的增量运行，和一轮「所有能到的条目都已修好」的运行在日志上完全一样。
   */
  scannedIds: string[];
  written: number;
  unchanged: number;
  skipped: number;
  unresolved: number;
  failed: number;
  /** A configured cap stopped the run before everything was walked. */
  capped: boolean;
  /** The path could not run at all (missing credentials, network failure). */
  aborted: boolean;
  /**
   * Nothing was sent: the counters describe what *would* have been written. The summary says so
   * in the row label, because "written 12" without that word is a lie a dry run tells very well.
   * 什么都没发出去：计数描述的是「本来会写什么」。汇总在行标签里说明这一点 —— 少了这句话，
   * 「written 12」是 dry-run 说得最像的一句谎。
   */
  dryRun: boolean;
  /**
   * Report the failure but do not fail the run.
   *
   * Used by the Douban RSS feed when `SYNC_DOUBAN_REQUIRED=0`: the failure stays visible (it is
   * printed, and the summary marks the row `TOLERATED`), but it must not decide the exit code —
   * otherwise the summary would have to claim "none failed" while the process exits 1.
   *
   * 报告失败，但不让整轮失败。
   *
   * 仅在 `SYNC_DOUBAN_REQUIRED=0` 时用于豆瓣 RSS：失败仍然可见（会打印，汇总里该行标为
   * `TOLERATED`），但不参与退出码 —— 否则就会出现「汇总说全部成功、退出码却是 1」。
   */
  tolerated: boolean;
  /** Titles needing a human look, in encounter order. */
  unresolvedTitles: string[];
  /**
   * The same unresolved entries as data, with link, reason, type and state. `unresolvedTitles`
   * stays for the console listing; this is what the review queue groups by. A path that can only
   * name a title leaves the other fields empty rather than inventing them.
   * 与 `unresolvedTitles` 同一批条目，但带链接、reason、类型与状态。`unresolvedTitles` 保留给
   * 控制台清单；这里才是名单分组用的数据。只能点名的链路会让其余字段留空，而不是编造。
   */
  unresolvedItems: ReviewDetail[];
  /**
   * One entry per `failed`, in encounter order. Same length as `failed` — if a path cannot name
   * what it counted, it must not invent a name, and the listing will report the shortfall.
   * 与 `failed` 一一对应、按出现顺序排列。长度等于 `failed`；若某条链路无法点名，就不许编造
   * 名字，由清单如实报出缺口。
   */
  failedItems: ReviewDetail[];
  /**
   * One entry per `skipped`, in encounter order. Same length as `skipped`.
   * 与 `skipped` 一一对应、按出现顺序排列，长度等于 `skipped`。
   */
  skippedItems: ReviewDetail[];
  /** Set only when entries were actually appended to it. */
  reviewLog: string;
};

export function newPathReport(label: string): PathReport {
  return {
    label,
    scanned: 0,
    scannedIds: [],
    written: 0,
    unchanged: 0,
    skipped: 0,
    unresolved: 0,
    failed: 0,
    capped: false,
    aborted: false,
    dryRun: false,
    tolerated: false,
    unresolvedTitles: [],
    unresolvedItems: [],
    failedItems: [],
    skippedItems: [],
    reviewLog: '',
  };
}

/**
 * Whether this report should make the run exit non-zero.
 * A `tolerated` report is excluded on purpose — see the field's own note.
 *
 * 这份报告是否应让整轮以非零码退出。`tolerated` 的报告被刻意排除，原因见字段自身的说明。
 */
export function pathHasFailed(report: PathReport): boolean {
  if (report.tolerated) {
    return false;
  }
  return report.aborted || report.failed > 0;
}

/**
 * Outcome of syncing ONE source item to one destination.
 * 把**单条**源条目同步到一个目标端的结果。
 *
 * The five names are deliberately identical to the `PathReport` counter fields, so a per-path loop
 * can aggregate with `report[outcome] += 1` — and the summary's self-check
 * (`written + unchanged + skipped + unresolved + failed = scanned`) then holds by construction
 * rather than by careful bookkeeping.
 * 这五个名字刻意与 `PathReport` 的计数字段完全一致，使每条链路的循环可以直接写
 * `report[outcome] += 1` —— 于是汇总的自检等式
 * （`written + unchanged + skipped + unresolved + failed = scanned`）**由构造保证**，而不是靠
 * 小心翼翼地记账。
 *
 *  - `written`    — the destination was changed. / 目标端被改动。
 *  - `unchanged`  — compared and already correct; no write issued. / 比较后已正确，未发起写入。
 *  - `skipped`    — deliberately not written (category allowlist, or a status the source cannot
 *                   express and must therefore not overwrite). / 刻意不写（分类白名单，或源端无法
 *                   表达、因此不得覆盖的状态）。
 *  - `unresolved` — the destination has no counterpart for this item. A data gap, not an error.
 *                   目标端没有对应条目。这是数据缺口，不是错误。
 *  - `failed`     — something threw or the destination rejected the write. / 抛错或目标端拒绝了写入。
 */
export type ItemSyncOutcome =
  'written' | 'unchanged' | 'skipped' | 'unresolved' | 'failed';

/**
 * What came back from reading one target-side record.
 * 读一条目标端记录得到的东西。
 *
 * Three cases, because "absent" and "could not read" are different facts and only the first one
 * may be written over. Collapsing both into `null` is exactly what let a 500 pass for "no rating
 * yet" — and then for "so let me write the source's rating over whatever was there".
 * 三种情况 —— 「不存在」与「读不到」是两件不同的事实，只有前者可以被覆盖。把两者压成 `null`
 * 正是「500 被当成『还没有评分』、进而『那就把源端评分写上去』」的成因。
 *
 * `scope` says who failed: `item` is one bad record (skip it, keep going), `auth` means the
 * credentials are dead and every remaining item would fail the same way.
 * `scope` 说明是谁失败：`item` 是单条记录的问题（跳过它继续），`auth` 表示凭据已失效，
 * 剩下每一条都会同样失败。
 */
export type ReadScope = 'item' | 'auth';

export type ReadResult<T> =
  | { status: 'found'; value: T }
  | { status: 'absent' }
  | { status: 'error'; scope: ReadScope; message: string };
