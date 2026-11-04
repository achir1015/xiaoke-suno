'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, shell, session, safeStorage, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { Updater } = require('./updater');
const { Suno } = require('./suno');
const { Library, Downloader, FORMATS } = require('./downloader');
const { Cloud, encodePairing, decodePairing } = require('./cloud');
const { ChromeLogin, toElectronCookie } = require('./chrome-login');
const srt = require('./srt');

const APP_TITLE = '小柯機器人SUNO工具';
const APP_ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(1);
const argVal = (name) => { const a = argv.find((s) => s.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const PROFILE = argVal('profile');

app.setName(APP_TITLE);
if (process.platform === 'win32') app.setAppUserModelId('com.achir.xiaokesuno');
app.setPath('userData', path.join(app.getPath('appData'), 'xiaoke-suno' + (PROFILE ? '-' + PROFILE.replace(/[^\w-]/g, '') : '')));
if (!PROFILE && !app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------------- 設定 ----------------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function defaults() {
  return {
    theme: 'dark',
    accent: '#f97316',
    autoUpdate: true,
    welcomed: false,
    notify: true,
    voice: { enabled: true, rate: 1, name: '' },
    ai: { keyEnc: '', model: 'gpt-6.1-terra' },
    cloud: { url: '', tokenEnc: '', cursor: 0, pushed: 0, auto: true, uploadSrt: false, uploadMp3: false },
    download: {
      dir: process.env.XIAOKE_SUNO_DIR || path.join(app.getPath('music'), '小柯SUNO'),
      formats: ['mp3', 'srt'],
      startOffset: -0.1,
      dupe: 'number',
      subfolders: false,
      bom: true,
      skipExisting: true,
      parallel: 2,
    },
    marks: [
      { id: 'fav', name: '最愛', icon: '⭐', color: '#eab308' },
      { id: 'video', name: '影片用', icon: '🎬', color: '#3b82f6' },
      { id: 'fix', name: '字幕待修', icon: '📝', color: '#ef4444' },
    ],
  };
}
let settings = defaults();
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    const d = defaults();
    settings = { ...d, ...raw, voice: { ...d.voice, ...(raw.voice || {}) }, ai: { ...d.ai, ...(raw.ai || {}) }, cloud: { ...d.cloud, ...(raw.cloud || {}) }, download: { ...d.download, ...(raw.download || {}) }, marks: Array.isArray(raw.marks) ? raw.marks : d.marks };
  } catch { settings = defaults(); saveSettings(); }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  const tmp = SETTINGS_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE());
}

// 金鑰用作業系統的加密功能保存，不會明文存檔
function encrypt(s) {
  s = String(s || '').trim();
  if (!s) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s, 'utf8').toString('base64');
}
function decrypt(enc) {
  if (!enc) return '';
  try {
    if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch { return ''; }
}
const getAiKey = () => decrypt(settings.ai.keyEnc) || process.env.OPENAI_API_KEY || '';

function publicSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  s.ai = { model: settings.ai.model, hasKey: !!getAiKey() };
  const { tokenEnc, ...c } = settings.cloud;
  s.cloud = { ...c, hasToken: !!decrypt(tokenEnc) };
  return s;
}

// ---------------- 視窗 ----------------
let win = null;
let suno = null;
let allowQuit = false;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
function iconPath() {
  const p = path.join(APP_ROOT, 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}
function fitWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1480, wa.width), height = Math.min(940, wa.height);
  return { width, height, minWidth: Math.min(860, width), minHeight: Math.min(520, height) };
}
function createWindow() {
  win = new BrowserWindow({
    ...fitWindow(),
    title: APP_TITLE + (PROFILE ? ` [${PROFILE}]` : ''),
    icon: iconPath(),
    backgroundColor: '#0d0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://local/src/app/index.html');
  win.once('ready-to-show', () => {
    if (argv.includes('--hidden')) return;
    if (!PROFILE) win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  // 關閉：還在下載時先問；關掉後停止所有下載與 Suno 網頁
  win.on('close', (e) => {
    if (allowQuit) return;
    const busy = downloader && downloader.jobs.some((j) => j.state === 'run' || j.state === 'wait');
    if (busy && !argv.includes('--hidden')) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['繼續下載', '停止並關閉'], defaultId: 0, cancelId: 0, title: APP_TITLE, message: '還有歌曲正在下載，確定要關閉嗎？', detail: '關閉後會停止下載，已下載完成的檔案會保留。' });
      if (r === 0) { e.preventDefault(); return; }
    }
    allowQuit = true;
    shutdown();
  });
  win.on('closed', () => { win = null; });
  const fitZoom = () => {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const z = Math.max(0.65, Math.min(1, w / 1240, h / 700));
    if (Math.abs(win.webContents.getZoomFactor() - z) > 0.01) { win.webContents.setZoomFactor(z); send('app:zoom', z); }
  };
  win.on('resize', fitZoom);
  win.webContents.on('did-finish-load', fitZoom);
  win.once('ready-to-show', () => setTimeout(fitZoom, 50));

  suno = new Suno({
    win,
    onClips: (clips, src) => { const n = lib.upsert(clips, src); libChanged(n); },
    onState: (s) => send('suno:state', s),
    onDownload: (item) => {
      const dir = settings.download.dir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, item.getFilename());
      item.setSavePath(file);
      item.once('done', (e, state) => send('app:toast', state === 'completed' ? { text: `已存到下載資料夾：${path.basename(file)}` } : { text: `下載失敗：${item.getFilename()}`, type: 'error' }));
    },
  });
  suno.create();
}

function shutdown() {
  try { downloader && downloader.cancelAll(); } catch {}
  try { chromeLogin.close(); } catch {}
  try { suno && suno.destroy(); } catch {}
  try { lib && lib.save(true); } catch {}
  for (const w of BrowserWindow.getAllWindows()) if (w !== win) try { w.destroy(); } catch {}
}

// ---------------- app:// 協定 ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// 已下載的音檔：app://media/<歌曲id>.mp3（支援 Range，試聽時才能拖曳進度）
function mediaResponse(req, url) {
  const m = /^\/([0-9a-f-]{36})\.(mp3|wav)$/i.exec(url.pathname);
  const f = m && lib.fileState(m[1]);
  const file = f && f[m[2].toLowerCase()];
  if (!file) return new Response('not found', { status: 404 });
  const size = fs.statSync(file).size;
  const type = m[2].toLowerCase() === 'wav' ? 'audio/wav' : 'audio/mpeg';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0, end = size - 1, status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
  }
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
  const headers = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(stream, { status, headers });
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host === 'media') return mediaResponse(req, url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.normalize(path.join(APP_ROOT, rel));
    if (url.host !== 'local' || !/^(src|build)[\\/]/.test(path.relative(APP_ROOT, abs))) return new Response('forbidden', { status: 403 });
    let st;
    try { st = fs.statSync(abs); } catch { return new Response('not found', { status: 404 }); }
    if (!st.isFile()) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(abs), { status: 200, headers: { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  });
}

// ---------------- 歌曲庫、下載、雲端 ----------------
let lib = null, downloader = null, cloud = null;
let libTimer = null, libAdded = 0;
function libChanged(added = 0) {
  libAdded += added;
  if (libTimer) return;
  libTimer = setTimeout(() => {
    libTimer = null;
    send('lib:changed', { added: libAdded, total: Object.keys(lib.data.clips).length });
    libAdded = 0;
    if (cloudReady() && settings.cloud.auto) syncSoon();
  }, 400);
}
const cloudReady = () => !!(settings.cloud.url && decrypt(settings.cloud.tokenEnc));
let syncTimer = null;
function syncSoon(ms = 8000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => cloud.sync().then((r) => { if (r.applied) libChanged(0); }).catch(() => {}), ms);
}

function initData() {
  lib = new Library(path.join(app.getPath('userData'), 'library.json'));
  downloader = new Downloader({
    lib,
    suno: { aligned: (id) => suno.aligned(id), wavUrl: (id, s) => suno.wavUrl(id, s) },
    getSettings: () => settings,
    fetcher: (url, opt) => suno.ses.fetch(url, opt),
    onUpdate: (snap) => { send('dl:update', snap); maybeNotify(snap); },
    afterFile: async (kind, file) => {
      if (!cloudReady()) return;
      if ((kind === 'srt' && settings.cloud.uploadSrt) || (kind === 'mp3' && settings.cloud.uploadMp3)) {
        try { await cloud.upload(kind, file); } catch (e) { send('app:toast', { text: `雲端備份失敗：${e.message}`, type: 'error' }); }
      }
    },
  });
  cloud = new Cloud({
    lib,
    getConf: () => ({ url: settings.cloud.url, token: decrypt(settings.cloud.tokenEnc), cursor: settings.cloud.cursor, pushed: settings.cloud.pushed }),
    setConf: (p) => { Object.assign(settings.cloud, p); saveSettings(); },
    onState: (s) => send('cloud:state', s),
  });
}

// 整批下載完成時通知一次
let wasBusy = false;
function maybeNotify(snap) {
  const busy = snap.jobs.some((j) => j.state === 'run' || j.state === 'wait');
  if (wasBusy && !busy && settings.notify) {
    const ok = snap.jobs.filter((j) => j.state === 'done').length, bad = snap.jobs.filter((j) => j.state === 'error').length;
    try { if (Notification.isSupported() && !(win && win.isFocused())) new Notification({ title: APP_TITLE, body: `下載完成：${ok} 首${bad ? `，${bad} 首失敗` : ''}`, icon: iconPath() }).show(); } catch {}
  }
  wasBusy = busy;
}

// ---------------- IPC ----------------
function handle(ch, fn) { ipcMain.handle(ch, (e, ...a) => fn(...a)); }

handle('settings:get', () => publicSettings());
handle('settings:set', (patch) => {
  patch = patch || {};
  for (const k of ['theme', 'accent', 'autoUpdate', 'welcomed', 'notify']) if (k in patch) settings[k] = patch[k];
  if (patch.voice) settings.voice = { ...settings.voice, ...patch.voice };
  if (Array.isArray(patch.marks)) settings.marks = patch.marks.filter((m) => m && m.id && m.name).slice(0, 30);
  if (patch.download) {
    const d = patch.download;
    if (Array.isArray(d.formats)) settings.download.formats = FORMATS.filter((f) => d.formats.includes(f));
    if ('startOffset' in d && srt.START_OFFSETS.some((o) => Math.abs(o - Number(d.startOffset)) < 1e-4)) settings.download.startOffset = Number(d.startOffset);
    if (['number', 'id', 'overwrite'].includes(d.dupe)) settings.download.dupe = d.dupe;
    for (const k of ['subfolders', 'bom', 'skipExisting']) if (k in d) settings.download[k] = !!d[k];
    if ('parallel' in d) settings.download.parallel = Math.max(1, Math.min(4, Number(d.parallel) || 2));
  }
  if (patch.ai) {
    if ('key' in patch.ai) settings.ai.keyEnc = encrypt(patch.ai.key);
    if (patch.ai.model) settings.ai.model = String(patch.ai.model);
  }
  if (patch.cloud) {
    const c = patch.cloud;
    if ('token' in c) settings.cloud.tokenEnc = encrypt(c.token);
    if ('url' in c) { const u = String(c.url).trim(); if (u !== settings.cloud.url) { settings.cloud.cursor = 0; settings.cloud.pushed = 0; } settings.cloud.url = u; }
    for (const k of ['auto', 'uploadSrt', 'uploadMp3']) if (k in c) settings.cloud[k] = !!c[k];
  }
  saveSettings();
  return publicSettings();
});

handle('sys:info', () => ({ platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged, profile: PROFILE || '', userData: app.getPath('userData'), electron: process.versions.electron }));
handle('app:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

// Suno 網頁：畫面告訴主程式要顯示在哪一塊（CSS 像素，要乘上縮放）
ipcMain.on('suno:bounds', (e, r) => {
  if (!suno || !win) return;
  const z = win.webContents.getZoomFactor();
  suno.setBounds({ x: r.x * z, y: r.y * z, width: r.width * z, height: r.height * z });
});
ipcMain.on('suno:visible', (e, v) => suno && suno.setVisible(v));
handle('suno:nav', (action, url) => suno && suno.nav(action, url));
handle('suno:state', () => (suno ? suno.state() : { loggedIn: false }));
handle('suno:logout', async () => {
  await suno.ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  suno.lastToken = ''; suno.user = null;
  suno.nav('home');
  return true;
});

// 用 Chrome 登入（Google 帳號不能在內建網頁登入時用）
const chromeLogin = new ChromeLogin(path.join(app.getPath('userData'), 'chrome-login'));
handle('suno:chromeInfo', () => { const b = chromeLogin.browser; return { name: b ? b.name : '', open: !!chromeLogin.child }; });
handle('suno:chromeLogin', async () => {
  // 測試時可用環境變數改登入網址、cookie 網域與 Chrome 參數（例如放到螢幕外）
  const name = await chromeLogin.open(process.env.XIAOKE_SUNO_LOGIN_URL || 'https://suno.com/me', (process.env.XIAOKE_CHROME_ARGS || '').split(' ').filter(Boolean));
  const list = await chromeLogin.cookies(process.env.XIAOKE_COOKIE_MATCH ? new RegExp(process.env.XIAOKE_COOKIE_MATCH) : undefined);
  if (!list.some((c) => /^__client/.test(c.name) || c.name === '__session' || c.name === process.env.XIAOKE_LOGIN_COOKIE)) return { ok: false, browser: name, error: `在 ${name} 裡還沒有登入 Suno，請再試一次，登入完成看到自己的歌以後再關掉視窗` };
  let n = 0;
  for (const c of list) { try { await suno.ses.cookies.set(toElectronCookie(c)); n++; } catch {} }
  await suno.ses.cookies.flushStore().catch(() => {});
  suno.lastToken = '';
  suno.nav('url', process.env.XIAOKE_SUNO_HOME || 'https://suno.com/me');
  // 等內建網頁用新的 cookie 登入完成
  let st = { loggedIn: false };
  for (let i = 0; i < 40 && !st.loggedIn; i++) { await new Promise((r) => setTimeout(r, 500)); st = await suno.state().catch(() => st); if (st.loggedIn && !st.checking) break; }
  send('suno:state', st);
  return { ok: !!st.loggedIn, browser: name, count: n, user: st.user, error: st.loggedIn ? '' : '登入資料已帶入，但 Suno 還沒有認得，請按 ⟳ 重新整理看看' };
});
handle('suno:chromeDone', () => chromeLogin.close());

handle('lib:list', () => lib.list());
handle('lib:refresh', async (opt = {}) => {
  const clips = await suno.listAll({ liked: !!opt.liked, onPage: (n) => send('lib:progress', { n }) });
  const added = lib.upsert(clips, 'library');
  libChanged(0);
  return { total: clips.length, added };
});
handle('lib:scan', async () => {
  const clips = await suno.scanPage((n) => send('lib:progress', { n, scan: true }));
  const added = lib.upsert(clips, 'web');
  libChanged(0);
  return { total: clips.length, added, ids: clips.map((c) => c.id) };
});
handle('lib:remove', (ids) => { lib.remove(ids || []); libChanged(0); return true; });
handle('lib:mark', (ids, markId, on) => { lib.setMarks(ids || [], markId, !!on); libChanged(0); return true; });
// 歌詞：歌曲庫裡沒有時向 Suno 再要一次
handle('lib:detail', async (id) => {
  let c = lib.data.clips[id];
  if (c && !c.lyrics) { try { const full = await suno.clip(id); if (full) { lib.upsert([full], c.src); c = lib.data.clips[id]; } } catch {} }
  return c ? { ...c, files: lib.fileState(id), marks: lib.data.marks[id] || [] } : null;
});
handle('lib:srt', async (id, offset) => {
  const c = lib.data.clips[id];
  if (!c) throw new Error('找不到這首歌');
  const payload = await suno.aligned(id);
  const r = srt.convert(payload || {}, { startOffset: Number(offset ?? settings.download.startOffset), duration: c.duration, title: c.title, artist: c.artist });
  return { lines: r.lines, srt: r.srt, instrumental: c.instrumental };
});

// 邊聽邊看字幕：已下載的就用本機 MP3＋本機 SRT（確認下載的檔案時間正確），否則用 Suno 線上音檔＋即時產生的字幕
handle('lib:play', async (id, offset) => {
  const c = lib.data.clips[id];
  if (!c) throw new Error('找不到這首歌');
  const f = lib.fileState(id) || {};
  const out = { id, title: c.title, image: c.image || c.thumb, audio: f.mp3 ? `app://media/${id}.mp3` : c.audio, localAudio: !!f.mp3, lines: [], lyricSrc: '', srtFile: '' };
  if (f.srt && offset == null) {
    try { out.lines = srt.parseSrt(fs.readFileSync(f.srt, 'utf8')); out.lyricSrc = 'file'; out.srtFile = f.srt; } catch {}
  }
  if (!out.lines.length) {
    try {
      const payload = await suno.aligned(id);
      out.lines = srt.convert(payload || {}, { startOffset: Number(offset ?? settings.download.startOffset), duration: c.duration }).lines;
      out.lyricSrc = out.lines.length ? 'suno' : '';
    } catch (e) { out.error = e.message; }
  }
  out.instrumental = c.instrumental;
  return out;
});

handle('dl:add',(ids, formats) => downloader.add(ids || [], formats || settings.download.formats));
handle('dl:state', () => downloader.snapshot());
handle('dl:pause', (v) => downloader.pause(v));
handle('dl:cancel', () => downloader.cancelAll());
handle('dl:clear', () => downloader.clearDone());
handle('dl:retry', () => downloader.retryFailed());

handle('dir:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: '選擇下載資料夾', defaultPath: settings.download.dir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.download.dir = r.filePaths[0];
  saveSettings();
  return settings.download.dir;
});
handle('dir:open', async (p) => { const d = p || settings.download.dir; fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
handle('file:show', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
handle('file:saveText', async (name, text) => {
  const r = await dialog.showSaveDialog(win, { title: '另存新檔', defaultPath: path.join(settings.download.dir, name), filters: [{ name: path.extname(name).slice(1).toUpperCase() || 'TXT', extensions: [path.extname(name).slice(1) || 'txt'] }] });
  if (r.canceled || !r.filePath) return '';
  fs.writeFileSync(r.filePath, (settings.download.bom ? '﻿' : '') + text, 'utf8');
  return r.filePath;
});

// ---------------- OpenAI：金鑰留在主程序 ----------------
const OPENAI_BASE = () => (process.env.XIAOKE_OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
function aiErrorText(status, data) {
  const msg = (data && data.error && data.error.message) || '';
  if (status === 401) return '金鑰不正確，請到設定檢查 OpenAI 金鑰';
  if (status === 429) return '額度用完或請求太頻繁，請到 OpenAI 帳戶確認';
  if (status === 404) return `找不到這個模型：${msg}`;
  return msg || `OpenAI 回應錯誤（${status}）`;
}
handle('ai:post', async (body) => {
  const key = getAiKey();
  if (!key) throw new Error('還沒有設定 OpenAI 金鑰');
  const res = await fetch(`${OPENAI_BASE()}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(aiErrorText(res.status, data));
  return data;
});
handle('ai:test', async () => {
  const key = getAiKey();
  if (!key) return { ok: false, error: '還沒有設定 OpenAI 金鑰' };
  try {
    const res = await fetch(`${OPENAI_BASE()}/models`, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: aiErrorText(res.status, data) };
    return { ok: true, models: (data.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort().reverse() };
  } catch (e) { return { ok: false, error: `連不上 OpenAI：${e.message}` }; }
});

// ---------------- 雲端 ----------------
handle('cloud:connect', async (code) => {
  const o = decodePairing(code);
  if (!o) throw new Error('設定碼不正確（應該是 XKS1. 開頭）');
  // /dev 只有在瀏覽器登入的本人能用，App 連過去會被拒絕（401）
  if (/\/dev(\?|$)/.test(o.url)) throw new Error('這個設定碼是 /dev 測試網址，App 連不上。請把 suno.gs 的 SUNO_EXEC_URL 填成部署的 /exec 網址，再執行一次 setupSuno，貼上新的設定碼');
  settings.cloud.url = o.url;
  settings.cloud.tokenEnc = encrypt(o.token);
  settings.cloud.cursor = 0; settings.cloud.pushed = 0;
  saveSettings();
  const ping = await cloud.post({ action: 'ping' });
  const r = await cloud.sync();
  libChanged(0);
  return { ...r, count: ping.count };
});
handle('cloud:disconnect', () => { settings.cloud.url = ''; settings.cloud.tokenEnc = ''; settings.cloud.cursor = 0; settings.cloud.pushed = 0; saveSettings(); cloud.set({ status: 'off' }); return publicSettings(); });
handle('cloud:sync', async () => { const r = await cloud.sync(); libChanged(0); return r; });
handle('cloud:state', () => cloud.state());
handle('cloud:code', () => (cloudReady() ? encodePairing(settings.cloud.url, decrypt(settings.cloud.tokenEnc)) : ''));
handle('cloud:upload', async (ids, kind) => {
  let n = 0;
  for (const id of ids || []) {
    const f = lib.fileState(id);
    if (f && f[kind]) { await cloud.upload(kind, f[kind]); n++; }
  }
  return n;
});

// ---------------- 版本更新 ----------------
const updater = new Updater();
handle('update:check', () => updater.check());
ipcMain.handle('update:download', async (e) => updater.download((got, total) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', { got, total }); }));
handle('update:install', (file) => { allowQuit = true; shutdown(); return updater.install(file); });
handle('update:openPage', () => shell.openExternal((updater.info && updater.info.page) || 'https://github.com/achir1015/xiaoke-suno/releases/latest'));

// ---------------- 啟動 ----------------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { allowQuit = true; });
app.whenReady().then(() => {
  loadSettings();
  initData();
  registerProtocol();
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  createWindow();
  if (cloudReady() && settings.cloud.auto) syncSoon(3000);
});
