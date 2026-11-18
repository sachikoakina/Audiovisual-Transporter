/*
 * Verify the documentation contract: README and `.env.example` must not drift from the code.
 *
 * The failure this guards against is quiet, not loud: a new `process.env` read lands in `src/`,
 * the run works, and the variable is simply missing from the template — so the next person
 * configures the project from `.env.example` and gets a path that never turns on. The same goes
 * for a renamed file: the README keeps pointing at a path that no longer exists, and nothing
 * fails until someone clicks it.
 *
 * USAGE: npm run verify:docs   (or `npm run verify:all` for every verify script)
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 验证文档契约：README 与 `.env.example` 不得与代码漂移。
 *
 * 它防的失败是安静的、不是响亮的：`src/` 里新增一个 `process.env` 读取，运行一切正常，
 * 而模板里根本没有这个变量 —— 下一个人照着 `.env.example` 配置，得到一条永远打不开的链路。
 * 文件改名同理：README 还指向不存在的路径，直到有人去点它才会发现。
 *
 * 用法：npm run verify:docs（或 `npm run verify:all` 跑全部验证脚本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecker } from './verify-lib';

const ROOT = path.resolve(import.meta.dirname, '..');
const README = path.join(ROOT, 'README.md');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const SRC = path.join(ROOT, 'src');

/**
 * Variables the runtime supplies, not the user. `.env.example` would be lying if it listed them
 * as something to fill in.
 *
 * 由运行时提供、不需要用户填写的变量。把它们列进 `.env.example` 反而是在骗人。
 */
const RUNTIME_PROVIDED = new Set(['GITHUB_ACTIONS']);

/** Every TypeScript file under `src/`, read once. / 一次性读取 `src/` 下的全部 TypeScript 文件。 */
function readSources(): Map<string, string> {
  const files = fs
    .readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts'));
  return new Map(
    files.map((name) => {
      const absolute = path.join(SRC, name);
      return [
        path.relative(ROOT, absolute).split(path.sep).join('/'),
        fs.readFileSync(absolute, 'utf8'),
      ];
    }),
  );
}

/**
 * Environment names the code reads.
 *
 * Four shapes because that is how the code reads them: `process.env.X` directly, `envEnabled` /
 * `envInt` for switches and integers, and `parseMergeProfile` / `parseCategoryAllowlist`, which
 * take the variable *name* as an argument. Missing one shape would make the check pass while the
 * variable is undocumented — the exact failure this file exists to prevent.
 *
 * 代码读取的环境变量名。四种形态对应代码实际读取它们的四种方式；漏掉任何一种，检查都会在
 * 变量未文档化时通过 —— 而那正是本文件要防的失败。
 */
function readEnvNames(sources: Map<string, string>): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /envEnabled\('([A-Z][A-Z0-9_]+)'/g,
    /envInt\('([A-Z][A-Z0-9_]+)'/g,
    /(?:parseMergeProfile|parseBangumiMergeProfile|parseMarkTimePolicy|parseNeodbVisibilityMode|parseNeodbVisibility|parseCategoryAllowlist|strictTrue|parseStatusGuard)\(\s*'([A-Z][A-Z0-9_]+)'/g,
  ];
  for (const text of sources.values()) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        names.add(match[1]);
      }
    }
  }
  return names;
}

/**
 * Names declared in `.env.example`, including commented-out ones — the template documents optional
 * knobs by comment, so ignoring those would report every optional variable as missing.
 *
 * `.env.example` 里声明的名字，包含被注释掉的那些 —— 模板正是用注释记录可选开关，忽略它们会把
 * 每个可选变量都报成缺失。
 */
function declaredEnvNames(): Set<string> {
  const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** Strip a `:123` line suffix and reject globs / runtime artifacts. / 去掉 `:123` 行号后缀，排除通配与运行时产物。 */
function repoPath(token: string): string | null {
  const clean = token.replace(/:\d+$/, '');
  if (clean.includes('*')) {
    return null;
  }
  if (clean === '.env.example') {
    return clean;
  }
  return /^(?:src|scripts|docs|tests)\//.test(clean) ? clean : null;
}

/** Paths the README offers the reader — backticked and linked. / README 提供给读者的路径（反引号与链接）。 */
function readmePaths(readme: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of readme.matchAll(/`([^`\n]+)`/g)) {
    tokens.add(match[1]);
  }
  for (const match of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    tokens.add(match[1]);
  }
  const paths = new Set<string>();
  for (const token of tokens) {
    const resolved = repoPath(token.trim());
    if (resolved) {
      paths.add(resolved);
    }
  }
  return paths;
}

/** `npm run <script>` names the README tells the reader to run. / README 让读者执行的 npm script。 */
function readmeScripts(readme: string): Set<string> {
  return new Set([...readme.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]));
}

function main(): void {
  const checker = createChecker();
  const readme = fs.readFileSync(README, 'utf8');
  const sources = readSources();
  const readNames = readEnvNames(sources);
  const declared = declaredEnvNames();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  checker.section('环境变量：代码 → .env.example');
  const undocumented = [...readNames]
    .filter((name) => !RUNTIME_PROVIDED.has(name) && !declared.has(name))
    .sort();
  checker.check(
    'every env var read in src/ is documented in .env.example',
    undocumented.length === 0,
    undocumented.join(', '),
  );

  checker.section('环境变量：.env.example → 代码');
  const stale = [...declared]
    .filter((name) => !RUNTIME_PROVIDED.has(name) && !readNames.has(name))
    .sort();
  checker.check(
    '.env.example documents no variable that src/ never reads',
    stale.length === 0,
    stale.join(', '),
  );

  checker.section('README：路径引用');
  const missingPaths = [...readmePaths(readme)]
    .filter((token) => !fs.existsSync(path.join(ROOT, token)))
    .sort();
  checker.check(
    'every src/scripts/docs/tests path the README names exists',
    missingPaths.length === 0,
    missingPaths.join(', '),
  );

  checker.section('README：命令');
  const unknownScripts = [...readmeScripts(readme)]
    .filter((name) => !(name in pkg.scripts))
    .sort();
  checker.check(
    'every `npm run` the README names exists in package.json',
    unknownScripts.length === 0,
    unknownScripts.join(', '),
  );

  // A verify script that points at a missing file is a CI step that fails for the wrong reason.
  // 指向不存在文件的 verify 脚本，会让 CI 因为错误的理由失败。
  const brokenVerify = Object.entries(pkg.scripts)
    .filter(([name]) => name.startsWith('verify:'))
    .flatMap(([name, command]) => {
      const target = /tsx\s+(\S+\.ts)/.exec(command)?.[1];
      return target && !fs.existsSync(path.join(ROOT, target))
        ? [`${name} → ${target}`]
        : [];
    });
  checker.check(
    'every verify:* script points at an existing file',
    brokenVerify.length === 0,
    brokenVerify.join(', '),
  );

  checker.section('README：结构');
  const requiredSections = [
    '在 GitHub Actions 中运行',
    '五条链路',
    '关键规则',
    '运行结果与退出码',
    '配置',
    '本地运行',
    '开发校验',
    '文档',
    'License',
  ];
  const missingSections = requiredSections.filter(
    (title) => !readme.includes(`## ${title}`),
  );
  checker.check(
    'README keeps its nine top-level sections',
    missingSections.length === 0,
    missingSections.join(', '),
  );

  const switches = [
    'SYNC_DOUBAN_NOTION',
    'SYNC_DOUBAN_NEODB',
    'SYNC_DOUBAN_BANGUMI',
    'SYNC_BANGUMI_NEODB',
    'SYNC_NEODB_TMDB',
  ];
  const missingSwitches = switches.filter((name) => !readme.includes(name));
  checker.check(
    'README names all five path switches',
    missingSwitches.length === 0,
    missingSwitches.join(', '),
  );

  checker.section('README：默认书架');
  // The table and the template must agree, or the reader copies one and gets the other.
  // 表格与模板必须一致，否则读者抄到的是其中一份。
  const shelfDefault = 'wishlist,progress,complete,dropped';
  checker.check(
    `README states the default shelf list (${shelfDefault})`,
    readme.includes(shelfDefault),
  );
  checker.check(
    '.env.example states the same default shelf list',
    fs.readFileSync(ENV_EXAMPLE, 'utf8').includes(shelfDefault),
  );

  checker.section('⑤ 未匹配原因');
  const reasons = ['no-tmdb-match', 'no-neodb-year', 'no-neodb-year-fetch-failed'];
  const pathSource = fs.readFileSync(
    path.join(ROOT, 'src/paths/neodb-to-tmdb.ts'),
    'utf8',
  );
  const envText = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const missingReasons = reasons.filter(
    (reason) => !pathSource.includes(reason) || !envText.includes(reason),
  );
  checker.check(
    'the three ⑤ reason slugs appear in both the path and .env.example',
    missingReasons.length === 0,
    missingReasons.join(', '),
  );

  checker.section('已删除资产的残留引用');
  const deleted = ['archive/', 'userscript/', 'fast-csv'];
  const currentDocs = [
    ['README.md', readme],
    [
      'docs/reference.md',
      fs.readFileSync(path.join(ROOT, 'docs/reference.md'), 'utf8'),
    ],
    ['.env.example', envText],
  ] as const;
  const leftovers = currentDocs.flatMap(([name, text]) =>
    deleted.filter((token) => text.includes(token)).map((token) => `${name}: ${token}`),
  );
  checker.check(
    'README / reference / .env.example do not cite deleted assets',
    leftovers.length === 0,
    leftovers.join(', '),
  );

  checker.section('Markdown 锚点：引用 → 目标标题');
  // Cross-file anchors are the one link kind nothing else checks. `repoPath` above validates the
  // *file* half of `[text](reference.md#anchor)` and silently ignores everything after the `#`,
  // so a heading rename leaves a link that looks fine in review and goes nowhere when clicked.
  // That is not hypothetical: `configuration.md` pointed at
  // `sync-paths.md#neodb-标记时间策略24` — the heading never contained "24" — and nothing noticed.
  //
  // 跨文件锚点是唯一没有别的东西检查的链接种类。上面的 `repoPath` 只校验
  // `[text](reference.md#anchor)` 的**文件**那一半，`#` 之后的一切都被静默忽略，因此一次标题改名
  // 会留下一个在评审时看着没问题、点下去却哪也不去的链接。这不是假设：`configuration.md` 曾指向
  // `sync-paths.md#neodb-标记时间策略24`，而那个标题里从来没有 "24"，却没有任何检查发现它。
  //
  // Loose on purpose. Reproducing GitHub's slugger exactly means reimplementing its CJK and
  // punctuation rules — and getting one wrong turns a working link into a red build. The failure
  // this guards against is "the heading was renamed or deleted", and a containment test catches
  // that without ever guessing at a slug. The trade-off is that a wrong-but-plausible slug
  // (`...策略24` vs `...策略`) would still pass; see the note on `anchorLooksPresent` below.
  //
  // 刻意宽松。精确复现 GitHub 的 slugger 意味着重写它的 CJK 与标点规则，而只要错一条，就会把一个
  // 本来能用的链接变成红色构建。这里要防的失败是「标题被改名或删除」，包含性判断能抓住它，且永远
  // 不需要去猜 slug。代价是「错得挺像」的 slug（`...策略24` 与 `...策略`）仍会通过；见下面
  // `anchorLooksPresent` 的说明。
  const DOC_FILES = fs
    .readdirSync(path.join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);

  /**
   * Does the target file plausibly carry this anchor?
   *
   * Two acceptance paths, both cheap and both immune to slug-rule drift:
   *   1. some heading, once its `#` markers and whitespace are dropped, contains the anchor text;
   *   2. the anchor is the slug of a heading once punctuation is stripped — which is what makes
   *      `#neodb-标记时间策略` match `## NeoDB 标记时间策略（②④）`.
   *
   * Path 2 is the reason a containment test is enough in practice: it normalises away exactly the
   * characters GitHub drops (brackets, circled digits) without needing to know that GitHub drops
   * them.
   *
   * 目标文件是否「看起来」带这个锚点？
   *
   * 两条接受路径，都很便宜，也都不受 slug 规则漂移影响：
   *   1. 某个标题去掉 `#` 与空白后，包含锚点文本；
   *   2. 某个标题去掉标点后，其 slug 与锚点相等 —— 这正是
   *      `#neodb-标记时间策略` 能匹配 `## NeoDB 标记时间策略（②④）` 的原因。
   *
   * 路径 2 正是包含性判断在实践中够用的理由：它恰好把 GitHub 会丢弃的那些字符（括号、带圈数字）
   * 归一化掉，而不需要知道 GitHub 会丢弃它们。
   */
  function anchorLooksPresent(markdown: string, anchor: string): boolean {
    const wanted = anchor.trim().toLowerCase();
    if (!wanted) {
      return true;
    }
    for (const line of markdown.split('\n')) {
      // `[^\r\n]*` rather than `(.*)$`: these files are checked out with CRLF on Windows, and
      // `$` does not match before a trailing `\r` in a non-multiline regex — so `(.*)$` silently
      // matches nothing at all, and every anchor would be reported broken. Stripping the line
      // ending is the one thing this scan has to get right before any slug logic can matter.
      // 用 `[^\r\n]*` 而不是 `(.*)$`：这些文件在 Windows 上以 CRLF 检出，而在非多行正则里 `$`
      // 并不匹配尾随 `\r` 之前的位置 —— 于是 `(.*)$` 静默地什么都匹配不到，每个锚点都会被报成断链。
      // 去掉行尾是这次扫描在任何 slug 逻辑生效之前必须先做对的一件事。
      const heading = /^#{1,6}\s+([^\r\n]*)/.exec(line)?.[1];
      if (!heading) {
        continue;
      }
      const text = heading.trim().toLowerCase();
      // Path 1 — the anchor is literally part of the heading.
      // 路径 1 —— 锚点字面上就是标题的一部分。
      if (text.replace(/\s+/g, '').includes(wanted.replace(/-/g, ''))) {
        return true;
      }
      // Path 2 — the heading slugifies to the anchor once punctuation is dropped.
      // 路径 2 —— 标题去掉标点后的 slug 与锚点相等。
      //
      // The order matters and is not obvious: punctuation is stripped *before* whitespace becomes
      // dashes, and **each single space becomes one dash** — no `+` quantifier, no collapsing.
      // `reason 总表（slug × 链路…）` has one space on each side of `×`; dropping the `×` leaves two
      // adjacent spaces, which must produce the `--` the anchor really contains. `[\s]+` would
      // merge them into one `-` and never match.
      // 顺序很重要且不显然：**先**去掉标点，**再**把空白变成连字符，且**每个空格各变一个连字符**
      // —— 不加 `+`、不做折叠。`reason 总表（slug × 链路…）` 里 `×` 两侧各有一个空格；删掉 `×`
      // 后剩下两个相邻空格，必须产出锚点里真实存在的 `--`。用 `[\s]+` 会把它们并成一个 `-`，
      // 永远匹配不上。
      const slug = text
        .replace(
          /[（）()【】\u005B\u005D「」《》〈〉·、，,。.：:；;！!？?"'“”‘’×→←—–]/g,
          '',
        )
        .replace(/[\u2460-\u24FF]/g, '')
        .replace(/[\s\u3000]/g, '-')
        .replace(/^-|-$/g, '');
      if (slug === wanted) {
        return true;
      }
    }
    return false;
  }

  /** `[text](file.md#anchor)` in one file → the anchors it points at, with their target files. */
  function crossFileAnchors(markdown: string): { target: string; anchor: string }[] {
    const found: { target: string; anchor: string }[] = [];
    for (const match of markdown.matchAll(/\]\(([\w.-]+\.md)#([^)\s]+)\)/g)) {
      found.push({ target: match[1]!, anchor: match[2]! });
    }
    return found;
  }

  const docsToScan: [string, string][] = [['README.md', readme]];
  for (const file of DOC_FILES) {
    docsToScan.push([file, fs.readFileSync(path.join(ROOT, file), 'utf8')]);
  }

  const brokenAnchors: string[] = [];
  let anchorCount = 0;
  for (const [name, text] of docsToScan) {
    for (const { target, anchor } of crossFileAnchors(text)) {
      anchorCount += 1;
      // Only same-directory links are checked: `docs/*.md` refers to its siblings by bare name,
      // and resolving `../README.md` anchors would drag in the root file's own heading contract.
      // 只检查同目录链接：`docs/*.md` 用裸文件名引用兄弟文件，而解析 `../README.md` 的锚点会把
      // 根文件自己的标题契约也拖进来。
      const baseDir = path.dirname(path.join(ROOT, name));
      const targetPath = path.join(baseDir, target);
      if (!fs.existsSync(targetPath)) {
        // The file half is already covered by the README path check above; reporting it here too
        // would make one defect fail two assertions and blur which one is authoritative.
        // 文件那一半已由上面的 README 路径检查覆盖；在这里重复报告会让一个缺陷触发两条断言，
        // 冲淡「哪条是权威」。
        continue;
      }
      const targetText = fs.readFileSync(targetPath, 'utf8');
      if (!anchorLooksPresent(targetText, decodeURIComponent(anchor))) {
        brokenAnchors.push(`${name} → ${target}#${anchor}`);
      }
    }
  }

  checker.check(
    'the anchor scan finds the cross-file links it is supposed to find',
    // A silent zero would make the assertion below pass for the wrong reason — the same trap the
    // log-contract scan guards against.
    // 静默的零会让下面那条断言以错误的理由通过 —— 与日志契约扫描所防的陷阱相同。
    anchorCount > 0,
    `${anchorCount} cross-file anchor(s)`,
  );
  checker.check(
    'every cross-file Markdown anchor resolves to a heading in its target',
    brokenAnchors.length === 0,
    brokenAnchors.join(', '),
  );

  checker.summary();
}

main();
