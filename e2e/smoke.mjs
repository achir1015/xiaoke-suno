// 端對端測試：用假的 Suno／OpenAI／Apps Script／GitHub 實際操作 App
// 用法：node e2e/smoke.mjs；XK_EXE=打包後的 exe 可測打包版
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
import http from 'node:http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fakeSuno } from './fake-suno.mjs';
import { loadGas } from '../test/gas-mock.mjs';

const require = createRequire(import.meta.url);
const outDir = 'e2e/out';
fs.mkdirSync(outDir, { recursive: true });
const appData = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
fs.rmSync(path.join(appData, 'xiaoke-suno-e2e'), { recursive: true, force: true });
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoke-suno-dl-'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('✔', name); } else { fail++; console.log('✘', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s)); });
const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));

const suno = await fakeSuno();
// 假 OpenAI：先叫一次 list_songs，再回答
const ai = { calls: [], script: [] };
const aiSrv = http.createServer(async (req, res) => {
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer sk-test-key') return json({ error: { message: 'bad key' } }, 401);
  if (req.url.endsWith('/models')) return json({ data: [{ id: 'gpt-6.1-terra' }] });
  const b = JSON.parse(await body(req));
  ai.calls.push(b);
  json(ai.script.shift() || { id: 'r-end', output: [{ type: 'message', content: [{ type: 'output_text', text: '找到了！' }] }] });
});
const aiBase = `http://127.0.0.1:${await listen(aiSrv)}/v1`;
// 假 Apps Script：直接跑真正的 gas/suno.gs
const gas = loadGas('cloud-key');
const gasSrv = http.createServer(async (req, res) => {
  const out = gas.ctx.sunoPost_({ parameter: { app: 'suno' }, postData: { contents: await body(req) } });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(out.text);
});
const gasUrl = `http://127.0.0.1:${await listen(gasSrv)}/macros/s/TEST/exec`;
// 假 GitHub Release
const relSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://example/', body: '新功能', assets: [{ name: 'XiaokeSuno-9.9.9-win-x64.exe', browser_download_url: 'http://127.0.0.1/x.exe', size: 1 }] })); });
const relUrl = `http://127.0.0.1:${await listen(relSrv)}/latest`;

const opts = process.env.XK_EXE ? { executablePath: process.env.XK_EXE, args: ['--profile=e2e', '--hidden'] } : { executablePath: require('electron'), args: ['.', '--profile=e2e', '--hidden'] };
opts.env = { ...process.env, XIAOKE_SUNO_HOME: suno.base + '/', XIAOKE_SUNO_API: suno.base, XIAOKE_SUNO_PARTITION: 'persist:suno-e2e', XIAOKE_SUNO_DIR: DL, XIAOKE_OPENAI_BASE: aiBase, XIAOKE_UPDATE_API: relUrl };
const app = await electron.launch(opts);
// Suno 網頁（WebContentsView）也會被當成一個視窗，要挑 app:// 的那個
let win = null;
for (let i = 0; i < 200 && !win; i++) { win = app.windows().find((w) => w.url().startsWith('app://')); if (!win) await sleep(100); }
if (!win) throw new Error('找不到主視窗');
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setPosition(-6000, 0); w.setSize(1400, 860); w.showInactive(); });
const errors = [];
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
win.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
const waitFor = async (fn, arg, ms = 12000) => {
  const t = Date.now();
  for (;;) {
    const v = await win.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('等待逾時：' + fn);
    await sleep(80);
  }
};
const shot = async (name) => {
  await sleep(250);
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(b64, 'base64'));
};
const click = (sel) => win.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('找不到 ' + s); e.click(); }, sel);
const clickText = (sel, t) => win.evaluate(([s, x]) => { const e = [...document.querySelectorAll(s)].find((el) => el.textContent.includes(x)); if (!e) throw new Error('找不到 ' + x); e.click(); }, [sel, t]);
const text = (sel) => win.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const count = (sel) => win.evaluate((s) => document.querySelectorAll(s).length, sel);
const closeModal = () => win.evaluate(() => { const b = [...document.querySelectorAll('.modal-head .icon-btn')].at(-1); b && b.click(); });
const sunoView = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const v = w.contentView.children[0]; return v ? { visible: v.getVisible(), b: v.getBounds(), url: v.webContents.getURL() } : null; });

try {
  await waitFor(() => document.documentElement.dataset.ready === '1');
  // 第一次開啟會自動打開使用說明
  await waitFor(() => document.querySelector('.guide-modal'));
  check('第一次開啟自動顯示使用說明', true);
  check('使用說明有 13 課', (await count('.g-item')) === 13, await count('.g-item'));
  await click('#guideNext');
  check('下一課', (await text('.g-main h3')).includes('第 2 課'));
  await shot('01-guide');
  await closeModal();
  check('歌曲庫空的時顯示步驟說明', !!(await text('.empty h3'))?.includes('空的'));
  await shot('02-empty');

  // Suno 網頁：未登入 → 登入
  await click('#nav-suno');
  await sleep(400);
  let v = await sunoView();
  check('Suno 網頁顯示在畫面上', v && v.visible && v.b.width > 400 && v.b.height > 200, JSON.stringify(v));
  await waitFor(() => document.querySelector('#sunoPill')?.textContent.includes('尚未登入'));
  check('未登入時顯示「尚未登入 Suno」', true);
  await win.evaluate((u) => window.xk.suno.nav('url', u), suno.base + '/login');
  await waitFor(() => document.querySelector('#sunoPill')?.textContent.includes('xiaoke_tester'), null, 15000);
  check('登入後顯示 Suno 使用者名稱', true);
  // 開設定時 Suno 網頁要藏起來
  await click('#btnSettings');
  await sleep(200);
  check('開對話框時 Suno 網頁會藏起來', !(await sunoView()).visible);
  await closeModal();
  await sleep(200);
  check('關掉對話框後 Suno 網頁回來', (await sunoView()).visible);
  await shot('03-suno');

  // 讀取全部歌曲（cursor 分頁）
  await click('#nav-library');
  await click('#btnRefresh');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 5, null, 15000);
  check('讀取全部歌曲：5 首（排除產生中的）', true);
  check('feed/v3 帶 trashed=False 過濾', suno.state.lastFeed && suno.state.lastFeed.filters.trashed === 'False');
  check('分頁讀到第 2 頁', suno.state.calls.filter((c) => c === 'POST /api/feed/v3').length === 2);
  check('看不到 Suno 網頁（在歌曲庫時）', !(await sunoView()).visible);

  // 工作區：被動收集＋抓取這一頁
  await win.evaluate((u) => window.xk.suno.nav('url', u), suno.base + '/workspace');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 6, null, 15000);
  check('瀏覽工作區時自動加入網頁上看到的歌', true);
  await click('#btnScan');
  await waitFor(() => document.querySelector('#selText')?.textContent.includes('已選 2 首'), null, 20000);
  check('抓取目前頁面並自動勾選 2 首', true);

  // 搜尋與篩選
  await win.fill('#q', '夏日');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 2);
  check('搜尋歌名', true);
  await win.fill('#q', '');
  await clickText('#show button', '純音樂');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 1);
  check('篩選純音樂', true);
  await clickText('#show button', '全部');

  // 批量下載：全選、MP3＋SRT＋LRC＋歌詞＋封面
  for (const f of ['lrc', 'txt', 'jpg']) await click(`#fmts .chip[data-f="${f}"]`);
  await waitFor(() => document.querySelectorAll('#fmts .chip.on').length === 5);
  check('格式按鈕：選了 5 種', true);
  await waitFor(() => document.querySelectorAll('#libList .song').length === 6);
  await win.evaluate(() => { const c = document.querySelector('#selAll'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await click('#btnDownload');
  await click('#nav-queue');
  await waitFor(() => document.querySelectorAll('.job').length === 6);
  check('佇列有 6 首', true);
  await waitFor(() => !document.querySelector('.job.run, .job.wait'), null, 40000);
  await shot('04-queue');
  const files = fs.readdirSync(DL).sort();
  console.log('  下載的檔案：', files.join(' | '));
  check('檔名同 Suno 歌名', files.includes('夏日微風.mp3') && files.includes('夏日微風.srt') && files.includes('台北的雨.mp3'));
  check('同名第二首加 (1)，MP3 與 SRT 同名', files.includes('夏日微風 (1).mp3') && files.includes('夏日微風 (1).srt'));
  check('非法字元換成底線', files.includes('愛_恨_ 交織_.mp3'));
  check('LRC、歌詞、封面', files.includes('台北的雨.lrc') && files.includes('台北的雨.txt') && files.includes('台北的雨.jpg'));
  check('純音樂沒有 SRT', files.includes('雨夜鋼琴.mp3') && !files.includes('雨夜鋼琴.srt'));
  check('純音樂的 SRT 顯示原因', (await text('#v-queue')).includes('純音樂'));
  const srtText = fs.readFileSync(path.join(DL, '夏日微風.srt'), 'utf8');
  check('SRT 有 BOM、去掉 [Verse]、提早 0.1 秒', srtText.startsWith('﻿1\r\n00:00:01,900 --> ') && srtText.includes('夏天的風吹過海邊') && !srtText.includes('[Verse]'), JSON.stringify(srtText.slice(0, 80)));
  check('MP3 內容完整', fs.statSync(path.join(DL, '夏日微風.mp3')).size === fs.statSync('e2e/fixtures/tone.mp3').size);
  // 再下載一次：沿用同樣檔名、不會變成 (2)
  await win.evaluate(async (id) => { await window.xk.dl.add([id], ['srt']); }, suno.id(2));
  await waitFor(() => !document.querySelector('.job.run, .job.wait'), null, 15000);
  check('同一首再下載沿用原本檔名', !fs.readdirSync(DL).some((f) => f.includes('(2)')));
  await click('#nav-library');
  await waitFor(() => document.querySelectorAll('#libList .fb.mp3').length === 6);
  check('歌曲庫顯示已下載的格式', true);

  // 邊聽邊看字幕：已下載的歌用本機 MP3＋本機 SRT
  await win.evaluate((id) => document.querySelector(`.song[data-id="${id}"] .cover`).click(), suno.id(1));
  await waitFor(() => !document.querySelector('#player').hidden);
  check('播放列出現', true);
  check('來源是本機 MP3＋已下載的 SRT', (await text('.k-src')).includes('本機 MP3') && (await text('.k-src')).includes('已下載的 SRT'), await text('.k-src'));
  await waitFor(() => document.querySelector('#kCur')?.textContent === '夏天的風吹過海邊', null, 8000);
  const t1 = await win.evaluate(() => document.querySelector('audio, #kSeek') && Number(document.querySelector('#kSeek').value));
  check('唱到第一句時亮起第一句字幕', t1 >= 1.85 && t1 < 5.6, t1);
  await shot('05-listen');
  // 跳到副歌
  await win.evaluate(() => { const s = document.querySelector('#kSeek'); s.value = 13.3; s.dispatchEvent(new Event('change')); });
  await waitFor(() => document.querySelector('#kCur')?.textContent === '啦啦啦 微風輕輕');
  check('拖曳進度到副歌，字幕跟著跳', true);
  await click('#kBig');
  await waitFor(() => document.querySelector('.kl.on'));
  check('放大卡拉 OK 畫面，目前這句亮起', (await text('.kl.on')).includes('啦啦啦'));
  await shot('06-karaoke');
  await closeModal();

  // 歌曲詳細資料：字幕清單同步、點一句從那裡聽
  await win.evaluate((id) => document.querySelector(`.song[data-id="${id}"] .info`).click(), suno.id(5));
  await waitFor(() => document.querySelectorAll('#srtPreview .sl').length === 5);
  check('詳細資料列出 5 句字幕', true);
  check('詳細資料有歌詞', (await text('pre.lyrics')).includes('永遠記得這一天'));
  await win.evaluate(() => document.querySelectorAll('#srtPreview .sl')[4].click());
  await waitFor(() => document.querySelector('#srtPreview .sl.on')?.textContent.includes('永遠記得這一天'), null, 8000);
  check('點一句從那裡聽，目前這句亮起', true);
  await shot('07-detail');
  await win.evaluate(() => { const o = document.querySelector('.d-h select'); o.value = '0'; o.dispatchEvent(new Event('change')); });
  await waitFor(() => document.querySelector('#srtPreview .sl small')?.textContent.startsWith('0:02.00'));
  check('改「提早秒數」字幕時間跟著變', true);
  await closeModal();
  await click('.k-btns .icon-btn:last-child');
  check('停止播放後播放列消失', await win.evaluate(() => document.querySelector('#player').hidden));

  // 標記
  await win.evaluate((id) => window.xk.lib.mark([id], 'fav', true), suno.id(5));
  await waitFor(() => document.querySelector('.mark-nav .mc')?.textContent === '1');
  await click('.mark-nav');
  await waitFor(() => document.querySelectorAll('#libList .song').length === 1);
  check('標記與左側篩選', true);
  await click('.mark-nav');
  await click('#btnMarks');
  await click('#markAdd');
  await waitFor(() => document.querySelectorAll('.mark-row').length === 4);
  check('新增標記', true);
  await closeModal();

  // 設定：換主題色
  await click('#btnSettings');
  await click('#st-look');
  await win.evaluate(() => document.querySelectorAll('.swatches.big .swatch')[2].click());
  check('換主題色', (await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#a855f7');
  await click('#st-dl');
  check('設定顯示下載資料夾', (await text('#stDir')) === DL);
  await shot('08-settings');

  // AI 助手
  await click('#st-ai');
  await win.fill('#stKey', 'sk-test-key');
  await click('#stKeySave');
  await waitFor(() => document.querySelector('#stKeyMsg')?.textContent.includes('可以使用'));
  check('OpenAI 金鑰測試', true);
  await closeModal();
  ai.script.push({ id: 'r1', output: [{ type: 'function_call', name: 'list_songs', call_id: 'c1', arguments: JSON.stringify({ query: '夏日' }) }] });
  ai.script.push({ id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: '找到 **2 首**夏日微風。' }] }] });
  await click('#btnAgent');
  await win.fill('#agentInput', '找夏日的歌');
  await click('#agentSend');
  await waitFor(() => document.querySelector('.ag-msg.bot .md')?.textContent.includes('2 首'));
  const toolOut = ai.calls[1] && ai.calls[1].input[0] && JSON.parse(ai.calls[1].input[0].output);
  check('AI 助手呼叫 list_songs 並拿到 2 首', toolOut && toolOut.共 === 2, JSON.stringify(toolOut));
  check('AI 指示是繁體中文且帶工具', ai.calls[0].instructions.includes('繁體中文') && ai.calls[0].tools.length >= 8);
  await shot('09-agent');
  await click('#btnAgent');

  // 雲端：貼上設定碼後同步
  const r = await win.evaluate(async ([u]) => {
    await window.xk.settings.set({ cloud: { url: u, token: 'cloud-key' } });
    return window.xk.cloud.sync();
  }, [gasUrl]);
  check('雲端同步上傳 6 首', r.sent === 6, JSON.stringify(r));
  check('雲端資料檔有 6 首', gas.post({ token: 'cloud-key', action: 'ping' }).count === 6);
  await waitFor(() => document.querySelector('#cloudPill')?.textContent.includes('已同步'));
  check('上方顯示已同步', true);
  const n = await win.evaluate(async (id) => window.xk.cloud.upload([id], 'srt'), suno.id(1));
  const up = gas.post({ token: 'cloud-key', action: 'files', folder: 'SRT' });
  check('備份 SRT 到雲端硬碟', n === 1 && up.files.length === 1 && /^夏日微風( \(1\))?\.srt$/.test(up.files[0].name), JSON.stringify([n, up]));

  // 版本更新
  await click('#btnUpdate');
  await waitFor(() => document.querySelector('.upd')?.textContent.includes('9.9.9'));
  check('檢查更新找到新版本', true);
  await closeModal();

  check('畫面沒有錯誤訊息', errors.length === 0, errors.join('\n'));
} catch (e) {
  fail++;
  console.log('✘ 測試中斷：', e.message);
  console.log(errors.join('\n'));
  await shot('99-error').catch(() => {});
}

await app.close().catch(() => {});
suno.close(); aiSrv.close(); gasSrv.close(); relSrv.close();
fs.rmSync(DL, { recursive: true, force: true });
console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
