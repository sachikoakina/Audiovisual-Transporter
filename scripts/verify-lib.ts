/*
 * The assertion harness the four `verify-*` scripts share.
 * 四个 `verify-*` 脚本共用的断言脚手架。
 *
 * It existed four times, once per script, and had already drifted: two of them printed failures to
 * stderr and two to stdout, one had a `detail` argument the others lacked. That drift is the
 * reason this file exists — not the line count.
 * 它原本有四份，每个脚本一份，而且已经开始漂移：两份把失败打到 stderr、两份打到 stdout，其中
 * 一份多一个 `detail` 参数。这份文件存在的理由正是这种漂移，而不是行数。
 *
 * No framework on purpose: `tsx` is already a devDependency, the assertions need no DOM/HTTP
 * doubles, and `process.exitCode` is the only integration CI needs.
 * 刻意不引入框架：`tsx` 已是 devDependency，这些断言不需要 DOM/HTTP 替身，而 CI 需要的唯一集成点
 * 就是 `process.exitCode`。
 */

export type Checker = {
  /** Record one assertion. `detail` is printed only when it fails. / 记一条断言；`detail` 仅在失败时打印。 */
  check: (name: string, ok: boolean, detail?: string) => void;
  /** Print a section heading. / 打印小节标题。 */
  section: (title: string) => void;
  /** Print the totals and make the process exit non-zero when anything failed. / 打印总计，失败时置非零退出码。 */
  summary: () => number;
};

export function createChecker(): Checker {
  let passed = 0;
  let failed = 0;

  return {
    check(name, ok, detail) {
      if (ok) {
        passed += 1;
        console.log(`  ok   ${name}`);
        return;
      }
      failed += 1;
      // stderr, because a failing assertion is what a `2>` redirect or a CI annotation should
      // catch — and because half of the original copies already did it this way.
      // 打到 stderr：失败的断言才该被 `2>` 重定向或 CI 注解捕获 —— 而且原来那四份里有一半就是
      // 这么做的。
      console.error(`FAIL   ${name}${detail ? ` — ${detail}` : ''}`);
    },
    section(title) {
      console.log(`\n${title}`);
    },
    summary() {
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failed > 0) {
        process.exitCode = 1;
      }
      return failed;
    },
  };
}
