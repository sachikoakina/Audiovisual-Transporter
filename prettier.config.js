/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 88,
  // Line endings belong to git, not to the formatter: `.gitattributes` stores LF, but a Windows
  // checkout with `core.autocrlf=true` hands every file CRLF. Prettier's default (`lf`) then reports
  // the whole repository, which hides real formatting problems behind 60 line-ending warnings.
  // `auto` keeps whatever the file already uses, so the check fails only on formatting; git still
  // normalises on commit.
  // 换行符归 git 管，不归格式化工具：`.gitattributes` 按 LF 存储，但 Windows 上开了
  // `core.autocrlf=true` 的检出会把每个文件变成 CRLF。Prettier 的默认值（`lf`）于是把整个仓库
  // 都报成问题，真正的格式错误反而被几十条换行警告埋掉。`auto` 沿用文件现有的换行符，检查因此
  // 只为格式失败；提交时仍由 git 归一化。
  endOfLine: 'auto',
};
