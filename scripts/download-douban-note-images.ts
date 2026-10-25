/*
 * Download the images referenced by exported 豆瓣日记 Markdown files, and rewrite the links to
 * the local `assets/images/<note>/` paths a blog expects.
 * 下载导出的豆瓣日记 Markdown 里引用的图片，并把链接改写为博客所需的本地
 * `assets/images/<note>/` 路径。
 *
 * NOT WIRED UP — this script cannot run as-is, for one remaining reason:
 *   `image-downloader` (imported below) is not declared in `package.json`. Types for it live in
 *   `scripts/image-downloader.d.ts`, so `tsc` can check this file, but the module still has to be
 *   installed before the script will execute: `npm install --save-dev image-downloader`.
 *
 * 尚未接通 —— 本脚本按原样无法运行，还剩一个原因：
 *   下面导入的 `image-downloader` 未在 `package.json` 中声明。它的类型放在
 *   `scripts/image-downloader.d.ts`，因此 `tsc` 能检查本文件，但在脚本能执行之前仍需先安装该
 *   模块：`npm install --save-dev image-downloader`。
 *
 * Usage (after the install above) / 用法（需先完成上述安装）:
 *   1. Export your Douban notes to `./douban-notes-20210716/`（把豆瓣日记导出到该目录）
 *   2. `npx tsx scripts/download-douban-note-images.ts`
 */

import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import download from 'image-downloader';
import { sleep } from '../src/utils';
// const pinyin = require("pinyin"); // no need to convert Chinese titles now

/**
 * `__dirname` does not exist in this ESM package (`"type": "module"`), so it is derived from
 * `import.meta.url`. `import.meta.dirname` would be shorter but needs Node ≥20.11, while
 * `package.json` only requires `>=20`.
 *
 * 本包是 ESM（`"type": "module"`），没有 `__dirname`，因此从 `import.meta.url` 推导。
 * `import.meta.dirname` 更短，但需要 Node ≥20.11，而 `package.json` 只要求 `>=20`。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const readDir = promisify(fs.readdir);
const mkDir = promisify(fs.mkdir);

const DIR = './douban-notes-20210716';
// const DIR = './douban-notes-test'; // for test
const IMG_DIR = './assets/images';
const IMG_PREFIX = '/assets/images/'; // for my blog setting

(async () => {
  const notesFiles = await readDir(DIR);
  let COUNT = 0;
  const FAILED_URLS: string[] = [];
  for (const notesFile of notesFiles) {
    // Narrowed instead of asserted: a file that does not match the date prefix used to make
    // `basename` the string "undefined" (`?.[1].replace(...)` short-circuits, then `!` lies).
    // 这里改为窄化而不是断言：不匹配日期前缀的文件过去会让 `basename` 变成字符串 "undefined"
    // （`?.[1].replace(...)` 短路，然后 `!` 说谎）。
    const parsedBasename = path
      .basename(notesFile)
      .match(/^\d{4}-\d{2}-\d{2}-(.+)\.md$/)?.[1];
    if (!parsedBasename) {
      console.warn(`Skipping ${notesFile}: no yyyy-mm-dd- prefix.`);
      continue;
    }
    const basename = parsedBasename.replace(/\s/g, '-');

    let file = await readFile(path.resolve(HERE, `${DIR}/${notesFile}`), 'utf8');
    const imgs: string[] = [];
    file = file.replace(/!\[(.*?)\]\((.+?)\)/g, function (whole, desc, url) {
      imgs.push(url);
      const name = url.match(/\/([^/]*\.(?:jpg|webp))$/); // last p12344.jpg
      return `![${desc}](${IMG_PREFIX}${basename}/${name[1]})`; // last is pic name
    });
    if (imgs.length > 0) {
      console.log(basename, ' has ', imgs.length, ' images.');
      const imgDir = path.resolve(HERE, path.join(IMG_DIR, basename));
      await mkDir(imgDir, { recursive: true }); // mkdir for images

      for (const url of imgs) {
        await download
          .image({
            url,
            dest: imgDir,
          })
          .then(({ filename }) => {
            console.log('Saved to', filename);
            COUNT++;
          })
          .catch(() => {
            const msg = 'Failed to download ' + url + ' which belongs to ' + basename;
            FAILED_URLS.push(msg);
          });

        if (COUNT % 100 === 0) {
          console.log(`Already ${COUNT} images, wait for 3 seconds...`);
          await sleep(3000);
        }
      }
      await writeFile(path.resolve(HERE, `${DIR}/${notesFile}`), file, 'utf8'); // write to the file
    }
  }
  console.log(FAILED_URLS);
})();
