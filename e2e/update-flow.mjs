// 實測程式內更新：用已安裝的舊版查 GitHub 最新版 → 下載 → 靜默安裝 → 自動重開新版
// 用法：node e2e/update-flow.mjs（會更新 %LOCALAPPDATA%\Programs\XiaokeSuno 裡的安裝版）
import { _electron as electron } from 'playwright-core';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'XiaokeSuno', 'XiaokeSuno.exe');
const ver = () => execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const before = ver();
console.log('安裝版目前：', before);
const app = await electron.launch({ executablePath: exe, args: ['--profile=updtest', '--hidden'] });
let win = null;
for (let i = 0; i < 200 && !win; i++) { win = app.windows().find((w) => w.url().startsWith('app://')); if (!win) await sleep(100); }
const r = await win.evaluate(() => window.xk.update.check());
console.log('檢查更新：', JSON.stringify({ current: r.current, latest: r.latest, newer: r.newer, asset: r.asset && r.asset.name, canInstall: r.canInstall }));
if (!r.newer || !r.canInstall) { await app.close(); process.exit(1); }
const file = await win.evaluate(() => window.xk.update.download());
console.log('下載完成：', file, Math.round(fs.statSync(file).size / 1048576), 'MB');
await win.evaluate((f) => window.xk.update.install(f), file).catch(() => {});
// 安裝程式靜默安裝後會自動開新版（--force-run）；等版本號變了
let after = before;
for (let i = 0; i < 90 && after === before; i++) { await sleep(2000); try { after = ver(); } catch {} }
console.log('安裝後：', after);
// 新版會自動打開（使用者平常的那份設定），這就是正常的更新流程，不去關它
console.log(after.startsWith(r.latest) ? `✔ 程式內更新 ${before} → ${after}` : '✘ 版本沒有變');
process.exit(after.startsWith(r.latest) ? 0 : 1);
