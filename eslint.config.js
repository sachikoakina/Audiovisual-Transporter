import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // `scripts/` is linted now, not excluded: the review list is parsed by one of those files, so
    // a typo in it is a data-loss bug, not a style issue. `archive/` and `userscript/` stay out —
    // both are documented as out of service (see `archive/README.md` and README's tree).
    // `scripts/` 现在纳入 lint 而不是排除：待核对名单由其中一个文件解析，因此那里的笔误是数据
    // 丢失级别的 bug，不是风格问题。`archive/` 与 `userscript/` 保持排除 —— 两者都在文档里声明
    // 了不再参与（见 `archive/README.md` 与 README 的目录树）。
    ignores: ['node_modules/', 'archive/', 'userscript/'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `catch (error: any)` is gone from `src/`; the single remaining `any`
      // (`buildPropertyValue`'s scraped value) carries a disable comment and a reason. Raising
      // this from `off` to `error` is what keeps it from growing back.
      // `src/` 里已无 `catch (error: any)`；仅剩的一处 `any`（`buildPropertyValue` 的抓取值）
      // 带着 disable 注释和理由。把它从 `off` 提升到 `error`，正是为了防止它长回来。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The `.mjs` helper has no bundler and no `@types/node` — these globals are the whole of its
    // runtime contract, so declaring them here is what `lint:fix` would otherwise be guessing at.
    // `.mjs` 助手既没有打包器也没有 `@types/node`，这几个全局就是它全部的运行时契约 ——
    // 在这里声明，才不会让 `lint:fix` 去猜。
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    // `verify-*.ts` reach into payloads to assert their shape (`(buildPropertyValue(...) as
    // any).date.start`). That is the one place a cast is cheaper than a type, and it stays
    // confined to assertions that fail loudly when the shape changes.
    // `verify-*.ts` 会伸手进载荷里断言形状（`(buildPropertyValue(...) as any).date.start`）。
    // 这是断言里唯一一处「断言比类型更便宜」的地方，而形状一变它就会响亮地失败。
    files: ['scripts/verify-*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
