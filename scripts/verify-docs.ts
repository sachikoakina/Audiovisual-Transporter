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
    /(?:parseMergeProfile|parseCategoryAllowlist)\(\s*'([A-Z][A-Z0-9_]+)'/g,
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
    '快速开始',
    '五条链路',
    '配置',
    '目录结构',
    '同步规则',
    '结果与退出码',
    '已知限制',
    '开发',
    '文档',
    'License',
  ];
  const missingSections = requiredSections.filter(
    (title) => !readme.includes(`## ${title}`),
  );
  checker.check(
    'README keeps its ten top-level sections',
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

  checker.summary();
}

main();
