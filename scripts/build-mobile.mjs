// 產生手機版（Android／iPhone）與線上版共用的網頁：mobile/www
// 和桌面版同一份畫面程式；另外放進 SRT、檔名兩個共用模組（桌面版由主程式 require）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'mobile', 'www');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// 不用 fs.cpSync：Node 22 在 Windows 的中文路徑會直接崩潰（0xC0000005）
(function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    if (f.isDirectory()) copy(path.join(from, f.name), path.join(to, f.name));
    else fs.copyFileSync(path.join(from, f.name), path.join(to, f.name));
  }
})(path.join(ROOT, 'src/app'), OUT);
fs.mkdirSync(path.join(OUT, 'js/shared'), { recursive: true });
for (const f of ['srt.js', 'naming.js']) fs.copyFileSync(path.join(ROOT, 'src/main', f), path.join(OUT, 'js/shared', f));
fs.writeFileSync(path.join(OUT, 'js/version.js'), `window.XK_VERSION = ${JSON.stringify(pkg.version)};\n`);
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version: pkg.version }) + '\n');

const file = path.join(OUT, 'index.html');
let html = fs.readFileSync(file, 'utf8')
  .replace('<html lang="zh-Hant" data-theme="dark">', '<html lang="zh-Hant" data-theme="dark" class="mobile">')
  .replace('<script type="module" src="js/app.js"></script>', '<script src="js/version.js"></script>\n  <script src="js/shared/srt.js"></script>\n  <script src="js/shared/naming.js"></script>\n  <script type="module" src="js/app.js"></script>')
  // 手機版的網頁直接連雲端（Apps Script）與 GitHub
  .replace("connect-src 'self' https://api.openai.com https://api.github.com", "connect-src 'self' https://api.openai.com https://api.github.com https://script.google.com https://script.googleusercontent.com");
fs.writeFileSync(file, html);

let n = 0, bytes = 0;
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; } } })(OUT);
console.log(`手機版網頁 v${pkg.version}：${n} 個檔案、${(bytes / 1048576).toFixed(1)} MB → ${OUT}`);
