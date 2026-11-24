/* ── 源码保护：src/（明文）→ terser 混淆 → web/ 与 dist/ ──
 * 单向流程：以后改前端代码只改 src/，再跑本脚本重新生成发布文件；
 * 不要手改 web/app.js（它会被下次构建覆盖）。
 * 服务端 engine/ 是 Node 也在 import 的明文，绝不覆盖；网页版 /engine/*.js
 * 仍由 engine/ 提供，热更包内的 engine/*.js 用 dist/engine/ 的混淆副本。
 * 用法：node tools/obfuscate.mjs                  （ROOT = /opt/dingerhuang）
 *       DH_ROOT=/tmp/obf63 node tools/obfuscate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.DH_ROOT || '/opt/dingerhuang';
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TERSER = path.join(ROOT, 'node_modules/.bin/terser');

const MOD = ['--module', '--compress', '--mangle', '--comments', 'false'];
const SCRIPT = ['--compress', '--mangle', '--comments', 'false'];
const ENGINE_FILES = ['game.js', 'cards.js', 'evaluator.js', 'ai.js', 'split.js'];

const jobs = [
  { src: 'app.js',    outs: ['web/app.js', 'dist/web/app.js'],       opts: MOD },
  { src: 'update.js', outs: ['web/update.js', 'dist/web/update.js'], opts: SCRIPT },
  ...ENGINE_FILES.map((f) => ({
    src: `engine/${f}`, outs: [`dist/engine/${f}`], opts: MOD,
  })),
];

if (!fs.existsSync(TERSER)) throw new Error(`terser 缺失: ${TERSER}`);
for (const d of [path.join(DIST, 'web'), path.join(DIST, 'engine')]) {
  fs.mkdirSync(d, { recursive: true });
}

for (const j of jobs) {
  const input = path.join(SRC, j.src);
  if (!fs.existsSync(input)) throw new Error(`明文源码缺失: ${input}`);
  for (const out of j.outs) {
    const target = path.join(ROOT, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(TERSER, [input, '-o', target, ...j.opts], { stdio: 'inherit' });
  }
  const a = fs.statSync(input).size;
  const b = fs.statSync(path.join(ROOT, j.outs[0])).size;
  console.log(`混淆 ${j.src.padEnd(20)} ${String(a).padStart(7)} -> ${String(b).padStart(7)}  => ${j.outs.join(', ')}`);
}
console.log('产物就绪:', DIST);
