/**
 * Minimal ambient types for `image-downloader`, which is NOT in `package.json`.
 * `image-downloader` 的最小环境类型声明 —— 它并不在 `package.json` 里。
 *
 * `scripts/download-douban-note-images.ts` imports this package but never declared it, so `tsc`
 * could not check that file at all. A hand-written declaration lets the script be type-checked
 * today without silently adding a runtime dependency that nobody approved.
 *
 * `scripts/download-douban-note-images.ts` 导入了这个包却从未声明依赖，导致 `tsc` 完全无法检查
 * 该文件。手写一份声明可以让脚本今天就能通过类型检查，同时又不会**静默**加入一个没人批准过的
 * 运行时依赖。
 *
 * IMPORTANT — this makes the script TYPE-CHECK, not RUN. To actually execute it you still need:
 *   npm install --save-dev image-downloader
 *
 * 重要 —— 这只能让脚本通过**类型检查**，不等于能**运行**。要真正执行它还需要：
 *   npm install --save-dev image-downloader
 *
 * Only the surface the script uses is declared (`download.image({ url, dest })`).
 * 只声明脚本实际用到的接口（`download.image({ url, dest })`）。
 */
declare module 'image-downloader' {
  export interface DownloadOptions {
    /** Image URL to fetch. / 要抓取的图片 URL。 */
    url: string;
    /** Target directory. / 目标目录。 */
    dest: string;
    /** Optional filename override; defaults to the name in the URL. / 可选的文件名覆盖；默认取 URL 中的文件名。 */
    filename?: string;
  }

  export interface DownloadResult {
    /** Absolute path of the saved file. / 保存后的文件绝对路径。 */
    filename: string;
  }

  export function image(options: DownloadOptions): Promise<DownloadResult>;

  const download: {
    image: typeof image;
  };

  export default download;
}
