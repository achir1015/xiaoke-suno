// 線上版（書籤小工具）測試：Edge 打開假的 Suno 網頁 → 模擬點書籤載入 online/panel.js → 讀歌、抓取這一頁、扣次數確認、批量下載
// 檢查瀏覽器真正下載到的檔名（同 Suno 歌名、同名加 (1)）與 SRT 內容
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeSuno } from './fake-suno.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('✔', name); } else { fail++; console.log('✘', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = 'e2e/out';
fs.mkdirSync(outDir, { recursive: true });

const suno = await fakeSuno();
// 線上版的檔案（和 GitHub Pages 上一樣的配置：panel.js＋srt.js＋naming.js＋icon.png）
const FILES = { '/panel.js': 'online/panel.js', '/srt.js': 'src/main/srt.js', '/naming.js': 'src/main/naming.js', '/icon.png': 'docs/ios/icon-180.png', '/index.html': 'online/index.html' };
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = FILES[p];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript; charset=utf-8' : p.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PAGES = `http://127.0.0.1:${srv.address().port}/`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 }, locale: 'zh-TW' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'xks-online-'));
const got = [];
page.on('download', async (d) => { const n = d.suggestedFilename(); await d.saveAs(path.join(DL, n)); got.push(n); });
// 書籤做的事：載入 panel.js（測試時告訴它假 Suno 的 API 位置）
const bookmark = (base) => page.evaluate(([src, b]) => { window.__xksTest = { site: b + '/a', api: b }; const s = document.createElement('script'); s.src = src; document.body.append(s); }, [PAGES + 'panel.js', base]);
const P = (fn, arg) => page.evaluate(([f, a]) => new Function('r', 'a', 'return (' + f + ')(r, a)')(document.querySelector('#xks-panel')?.shadowRoot, a), [fn.toString(), arg]);
const waitP = async (fn, arg, ms = 15000) => { const t = Date.now(); for (;;) { const v = await P(fn, arg).catch(() => false); if (v) return v; if (Date.now() - t > ms) throw new Error('等待逾時：' + fn); await sleep(100); } };

try {
  // 線上版說明頁：書籤程式碼
  await page.goto(PAGES + 'index.html');
  const code = await page.evaluate(() => document.getElementById('bm').href);
  check('說明頁產生書籤程式碼', code.startsWith('javascript:') && code.includes('panel.js'));

  // 登入假的 Suno（瀏覽器原本的登入）
  await page.goto(suno.base + '/login');
  await bookmark(suno.base);
  await waitP((r) => r && r.getElementById('who') && /已登入/.test(r.getElementById('who').textContent));
  check('點書籤後出現小柯面板，顯示已登入', true);
  await waitP((r) => /剩 20/.test(r.getElementById('quota').textContent));
  check('顯示 Suno 下載次數', true);
  await P((r) => r.getElementById('all').click());
  await waitP((r) => r.querySelectorAll('#list .s').length === 5);
  check('讀取全部歌曲 5 首', true);
  check('已解鎖的歌有 🔓', (await P((r) => r.querySelectorAll('#list .tag').length)) === 1);
  await page.screenshot({ path: path.join(outDir, 'o-01-panel.png') });

  // 同一個網頁再點一次書籤：不會開第二個面板
  await bookmark(suno.base);
  await sleep(500);
  check('再點一次書籤不重複開面板', (await page.evaluate(() => document.querySelectorAll('#xks-panel').length)) === 1);

  // 全選＋MP3、SRT：有 4 首沒解鎖 → 先問
  await P((r) => { const c = r.getElementById('selAll'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await P((r) => r.getElementById('go').click());
  await waitP((r) => r.querySelector('.dlg'));
  check('下載前問要不要用下載次數', /4<\/b> 首還沒在 Suno 解鎖/.test(await P((r) => r.querySelector('.dlg').innerHTML)));
  await page.screenshot({ path: path.join(outDir, 'o-02-ask.png') });
  await P((r) => r.getElementById('a2').click());
  await waitP((r) => /完成 5 首/.test(r.getElementById('log').textContent), null, 40000);
  await sleep(1500);
  got.sort();
  console.log('  瀏覽器下載的檔案：', got.join(' | '));
  check('檔名同 Suno 歌名，同名第二首加 (1)，MP3 與 SRT 同名', ['夏日微風.mp3', '夏日微風.srt', '夏日微風 (1).mp3', '夏日微風 (1).srt', '台北的雨.mp3', '愛_恨_ 交織_.mp3', '雨夜鋼琴.mp3'].every((n) => got.includes(n)), got.join(','));
  check('純音樂沒有 SRT', !got.includes('雨夜鋼琴.srt'));
  const srt = fs.readFileSync(path.join(DL, '夏日微風.srt'), 'utf8');
  check('SRT 有 BOM、提早 0.1 秒、去掉 [Verse]', srt.startsWith('﻿1\r\n00:00:0') && srt.includes('夏天的風吹過海邊') && !srt.includes('[Verse]'), JSON.stringify(srt.slice(0, 50)));
  check('MP3 內容完整', fs.statSync(path.join(DL, '台北的雨.mp3')).size === fs.statSync('e2e/fixtures/tone.mp3').size);
  check('扣了 4 次（已解鎖的不扣）', suno.state.used === 4, suno.state.used);
  await waitP((r) => /剩 16/.test(r.getElementById('quota').textContent));
  check('下載後剩餘次數更新', true);
  await page.screenshot({ path: path.join(outDir, 'o-03-done.png') });

  // 工作區頁：抓取這一頁
  await page.goto(suno.base + '/workspace');
  await page.waitForSelector('a[href*="/song/"]');
  await bookmark(suno.base);
  await waitP((r) => r && r.getElementById('scan'));
  await P((r) => r.getElementById('scan').click());
  await waitP((r) => /這一頁抓到 2 首/.test(r.getElementById('log').textContent), null, 30000);
  check('抓取工作區這一頁 2 首並勾選', (await P((r) => r.getElementById('go').textContent)).includes('2 首'));

  // 不扣次數：只下載已解鎖的
  got.length = 0;
  const before = suno.state.used;
  await P((r) => r.getElementById('go').click());
  await waitP((r) => r.querySelector('.dlg'));
  await P((r) => r.getElementById('a1').click());
  await waitP((r) => /完成 2 首/.test(r.getElementById('log').textContent), null, 30000);
  await sleep(1000);
  check('選「只下載已解鎖的」：沒解鎖的 MP3 不下載、不扣次數，SRT 照樣下載', suno.state.used === before && got.includes('工作區限定.srt') && !got.includes('工作區限定.mp3'), JSON.stringify([before, suno.state.used, got]));
  check('畫面沒有錯誤', errors.length === 0, errors.join('\n'));
} catch (e) {
  fail++;
  console.log('✘ 測試中斷：', e.message);
  console.log(errors.join('\n'));
  await page.screenshot({ path: path.join(outDir, 'o-99-error.png') }).catch(() => {});
}
await browser.close();
srv.close();
suno.close();
fs.rmSync(DL, { recursive: true, force: true });
console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
