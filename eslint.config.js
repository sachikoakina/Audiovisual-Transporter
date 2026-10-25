import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['node_modules/', 'archive/', 'userscript/', 'scripts/'],
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
);
