// 手機版網頁測試（不用手機）：Edge 模擬手機尺寸＋假的 Android 原生介面（window.XiaokeAndroid）＋假的 Suno
// 測 mobile/www（scripts/build-mobile.mjs 產生）＋ js/mobile/android.js 的流程：掃 QR 帶入登入、讀歌、扣次數確認、下載、字幕、邊聽邊看
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSuno } from './fake-suno.mjs';

const ROOT = path.resolve('.');
execFileSync(process.execPath, ['scripts/build-mobile.mjs'], { stdio: 'inherit' });
const WWW = path.join(ROOT, 'mobile', 'www');
const TONE = fs.readFileSync('e2e/fixtures/tone.mp3');
const outDir = 'e2e/out';
fs.mkdirSync(outDir, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('✔', name); } else { fail++; console.log('✘', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const suno = await fakeSuno();
// 同一個來源：手機版網頁＋/fake 轉給假 Suno＋/media 回傳音檔（CSP 只允許 'self'）
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/fake/')) {
    const body = await new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); });
    const r = await fetch(suno.base + u.pathname.slice(5) + u.search, { method: req.method, headers: { authorization: req.headers.authorization || '', 'content-type': req.headers['content-type'] || '' }, body: req.method === 'POST' ? body : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
    return res.end(buf);
  }
  if (u.pathname.startsWith('/media/')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': TONE.length }); return res.end(TONE); }
  const f = path.join(WWW, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${srv.address().port}`;

// 假的 Android 原生：和 Bridge.java 一樣的介面
const MOCK = (token) => `
(() => {
  const files = new Map();
  let loggedIn = false;
  const done = (id, ok, v) => setTimeout(() => window.__xkRes(id, ok, v), 5);
  const rewrite = (u) => u.replace('https://studio-api-prod.suno.com', '/fake').replace('https://suno.com/a/', '/fake/a/');
  window.__mock = { files, get loggedIn() { return loggedIn; }, calls: [] };
  window.XiaokeAndroid = {
    appInfo: () => JSON.stringify({ status: 'ok', version: '1.0.5', model: 'Fake Phone' }),
    ttsAvailable: () => false, ttsVoice: () => '', ttsSpeak: (t, r, id) => setTimeout(() => window.__xkTtsDone(id), 10), ttsStop: () => {},
    sunoBounds: (x, y, w, h) => { window.__mock.bounds = { x, y, w, h }; }, sunoVisible: (v) => { window.__mock.visible = v; }, sunoNav: (a, u) => { window.__mock.nav = [a, u]; },
    openUrl: () => true,
    checkUpdate: () => JSON.stringify({ status: 'ok', current: '1.0.5', latest: '9.9.9', url: 'https://github.com/achir1015/xiaoke-suno/releases/download/v9.9.9/XiaokeSuno-9.9.9-android.apk', page: 'https://github.com/x', notes: '新版' }),
    updateStatus: () => JSON.stringify({ state: 'idle', pct: 0 }), installUpdate: () => JSON.stringify({ status: 'ok' }),
    call(id, method, argsJson) {
      const a = JSON.parse(argsJson);
      window.__mock.calls.push(method);
      (async () => {
        switch (method) {
          case 'sunoLogin': return { loggedIn };
          case 'importLogin': { const c = JSON.parse(a[0]); if (!c.some((x) => x[0] === '__client')) throw new Error('沒有登入資料'); loggedIn = true; return { count: c.length }; }
          case 'logout': loggedIn = false; return true;
          case 'suno': {
            if (!loggedIn) return { status: -1 };
            const r = await fetch(rewrite(a[1]), { method: a[0], headers: { Authorization: 'Bearer ${token}', ...(a[2] ? { 'Content-Type': 'application/json' } : {}) }, body: a[2] || undefined });
            return { status: r.status, text: await r.text(), retry: '' };
          }
          case 'download': {
            const r = await fetch(a[0].replace(/^http:\\/\\/127\\.0\\.0\\.1:\\d+/, '/fake'));
            if (!r.ok) throw new Error('下載失敗（' + r.status + '）');
            const b = new Uint8Array(await r.arrayBuffer());
            files.set(a[1], b);
            window.__xkDl && window.__xkDl(a[3], b.length, b.length);
            return { uri: 'content://fake/' + encodeURIComponent(a[1]), path: '下載/小柯SUNO/' + a[1] };
          }
          case 'writeText': files.set(a[0], new TextEncoder().encode(a[1])); return { uri: 'content://fake/' + encodeURIComponent(a[0]), path: '下載/小柯SUNO/' + a[0] };
          case 'listFiles': return [...files.keys()];
          case 'exists': return files.has(decodeURIComponent(a[0].split('/').pop()));
          case 'readText': return new TextDecoder().decode(files.get(decodeURIComponent(a[0].split('/').pop())));
          case 'readB64': return btoa(String.fromCharCode(...files.get(decodeURIComponent(a[0].split('/').pop()))));
          case 'sunoEval': return JSON.stringify(${JSON.stringify([suno.id(5), suno.id(7)])});
          case 'notify': return true;
          default: throw new Error('沒有 ' + method);
        }
      })().then((v) => done(id, true, v), (e) => done(id, false, e.message));
    },
  };
})();`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 412, height: 870 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, locale: 'zh-TW' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
// 假 Suno 的權杖：從 /login 的 Set-Cookie 取得
const lr = await fetch(suno.base + '/login', { redirect: 'manual' });
const tok = (lr.headers.getSetCookie().find((c) => c.startsWith('__session=')) || '').split(';')[0].slice(10);
await page.addInitScript(MOCK(tok));
const waitFor = async (fn, arg, ms = 12000) => { const t = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => false); if (v) return v; if (Date.now() - t > ms) throw new Error('等待逾時：' + fn); await sleep(80); } };
const click = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('找不到 ' + s); e.click(); }, sel);
const clickText = (sel, t) => page.evaluate(([s, x]) => { const e = [...document.querySelectorAll(s)].find((el) => el.textContent.includes(x)); if (!e) throw new Error('找不到 ' + x); e.click(); }, [sel, t]);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') });
const closeModal = () => page.evaluate(() => { const b = [...document.querySelectorAll('.modal-head .icon-btn')].at(-1); b && b.click(); });

try {
  await page.goto(ORIGIN + '/index.html');
  await waitFor(() => document.documentElement.dataset.ready === '1');
  check('手機版網頁啟動（Android 平台介面）', await page.evaluate(() => document.documentElement.classList.contains('mobile')));
  await waitFor(() => document.querySelector('.guide-modal'));
  check('第一次開啟顯示使用說明', true);
  await shot('m-01-guide');
  await closeModal();
  const nav = await page.evaluate(() => { const r = document.querySelector('#side').getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; });
  check('選單改成底部分頁列', nav.top > 700 && nav.w > 380, JSON.stringify(nav));
  const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check('沒有左右捲動', !over);
  await shot('m-02-empty');

  // Suno 分頁：手機的登入方式是掃電腦的 QR Code
  await click('#nav-suno');
  await waitFor(() => document.querySelector('#snQR') && !document.querySelector('#snQR').hidden);
  check('手機版顯示「掃描電腦的 QR Code」，沒有「用 Chrome 登入」', !(await page.evaluate(() => document.querySelector('#snChrome'))));
  check('Suno 網頁位置有告訴原生', await page.evaluate(() => window.__mock.visible === true && window.__mock.bounds.w > 300));
  await shot('m-03-suno');
  // 模擬掃到電腦的 QR Code
  const pair = 'XKSP1:' + JSON.stringify({ c: [['__client', 'fake-client-jwt', 'auth.suno.com', 0], ['__client_uat', '1', '.suno.com', 0]], k: '' });
  const r = await page.evaluate((c) => window.__xkTest = import('./js/platform.js').then((m) => m.xk.suno.importPair(c)), pair);
  check('帶入電腦的登入狀態', r && r.ok, JSON.stringify(r));
  await waitFor(() => document.querySelector('#sunoPill')?.classList.contains('ok'));
  check('上方顯示已登入', true);

  // 讀取歌曲
  await click('#nav-library');
  await click('#btnRefresh');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 5, null, 15000);
  check('讀取全部歌曲 5 首', true);
  await waitFor(() => document.querySelector('#quota')?.textContent.includes('剩 20'));
  check('顯示下載次數', true);
  // 抓取 Suno 網頁目前這一頁
  await click('#btnScan');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 6, null, 15000);
  check('抓取 Suno 網頁這一頁（手機）', true);
  await shot('m-04-library');

  // 下載：全選＋MP3、SRT；先問次數
  await page.evaluate(() => { const c = document.querySelector('#selAll'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await click('#btnDownload');
  await waitFor(() => document.querySelector('.unlock-box'));
  check('下載前問要不要用下載次數', (await text('.unlock-box')).includes('5 首還沒在 Suno 解鎖'));
  await shot('m-05-unlock');
  await clickText('.modal-foot .btn', '解鎖並下載');
  await click('#nav-queue');
  await waitFor(() => document.querySelectorAll('.job').length === 6);
  await waitFor(() => !document.querySelector('.job.run, .job.wait'), null, 40000);
  await shot('m-06-queue');
  const names = await page.evaluate(() => [...window.__mock.files.keys()].sort());
  console.log('  存的檔案：', names.join(' | '));
  check('檔名同 Suno、同名加 (1)', names.includes('夏日微風.mp3') && names.includes('夏日微風 (1).mp3') && names.includes('夏日微風.srt') && names.includes('愛_恨_ 交織_.mp3'));
  check('純音樂沒有 SRT', names.includes('雨夜鋼琴.mp3') && !names.includes('雨夜鋼琴.srt'));
  const srt = await page.evaluate(() => new TextDecoder('utf-8', { ignoreBOM: true }).decode(window.__mock.files.get('夏日微風.srt')));
  check('SRT 內容正確（BOM、提早 0.1 秒）', srt.startsWith('﻿1\r\n00:00:01,900 --> ') && srt.includes('夏天的風吹過海邊'), JSON.stringify(srt.slice(0, 60)));
  check('扣了 5 次（已解鎖的不扣）', suno.state.used === 5, suno.state.used);

  // 邊聽邊看字幕：本機檔案從 /media/ 播放
  await click('#nav-library');
  await waitFor(() => document.querySelectorAll('#libList .fb.mp3').length === 6);
  await page.evaluate((id) => document.querySelector(`.song[data-id="${id}"] .cover`).click(), suno.id(1));
  await waitFor(() => !document.querySelector('#player').hidden);
  check('播放來源是手機裡的 MP3＋已下載的 SRT', (await text('.k-src')).includes('本機 MP3') && (await text('.k-src')).includes('已下載的 SRT'), await text('.k-src'));
  await waitFor(() => document.querySelector('#kCur')?.textContent === '夏天的風吹過海邊', null, 8000);
  check('字幕跟著歌聲亮起', true);
  await shot('m-07-listen');
  await click('.k-btns .icon-btn:last-child');

  // 詳細資料、設定、返回鍵
  await page.evaluate((id) => document.querySelector(`.song[data-id="${id}"] .info`).click(), suno.id(5));
  await waitFor(() => document.querySelectorAll('#srtPreview .sl').length === 5);
  check('歌曲詳細資料（手機版面）', true);
  await shot('m-08-detail');
  check('返回鍵先關對話框', await page.evaluate(() => window.__xkBack()) && !(await page.evaluate(() => document.querySelector('.modal-back'))));
  await click('#btnSettings');
  await click('#st-cloud');
  await shot('m-09-settings');
  await closeModal();
  await click('#btnUpdate');
  await waitFor(() => document.querySelector('.upd')?.textContent.includes('9.9.9'));
  check('檢查更新找到 Android 新版', true);
  await closeModal();
  check('畫面沒有錯誤', errors.length === 0, errors.join('\n'));
} catch (e) {
  fail++;
  console.log('✘ 測試中斷：', e.message);
  console.log(errors.join('\n'));
  await shot('m-99-error').catch(() => {});
}
await browser.close();
srv.close();
suno.close();
console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
