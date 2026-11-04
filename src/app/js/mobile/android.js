// 手機版（Android／iPhone／iPad）的平台介面（取代桌面版 preload 的 window.xk）
// 桌面版主程式（Node）做的事：歌曲庫、下載佇列、Suno 連線、雲端、AI、更新，在這裡用網頁 JS 完成；
// 存檔（下載/小柯SUNO）、帶登入 cookie 的連線、Suno 網頁、語音、安裝新版交給 Android 原生（window.XiaokeAndroid）
// iPhone／iPad：WKWebView 的 window.webkit.messageHandlers.xks（有回覆的 postMessage），包成和 Android 一樣的介面
const IOS = !window.XiaokeAndroid && !!window.XiaokeIOS;
function iosBridge() {
  const post = (cmd, args) => window.webkit.messageHandlers.xks.postMessage({ cmd, args });
  return {
    call: (id, method, argsJson) => post('call', [method, argsJson]).then((r) => window.__xkRes(id, true, r), (e) => window.__xkRes(id, false, String((e && e.message) || e))),
    appInfo: () => JSON.stringify({ status: 'ok', ...window.XiaokeIOS }),
    sunoBounds: (x, y, w, h) => { post('sunoBounds', [x, y, w, h]); },
    sunoVisible: (v) => { post('sunoVisible', [!!v]); },
    sunoNav: (a, u) => { post('sunoNav', [a, u || '']); },
    openUrl: (u) => { post('openUrl', [u]); return true; },
  };
}
const A = IOS ? iosBridge() : window.XiaokeAndroid;
const SRT = window.XkSrt;
const NAMING = window.XkNaming;
const API = 'https://studio-api-prod.suno.com';
const SITE = 'https://suno.com/a';
const FOLDER = IOS ? '檔案 App →「我的 iPhone／iPad」→ 小柯SUNO' : '下載/小柯SUNO';
const FORMATS = ['mp3', 'srt', 'lrc', 'txt', 'jpg', 'wav'];
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', srt: 'application/x-subrip', lrc: 'text/plain', txt: 'text/plain', jpg: 'image/jpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 呼叫原生（非同步，結果由 window.__xkRes 送回） ----------------
let seq = 0;
const waits = new Map();
window.__xkRes = (id, ok, data) => {
  const w = waits.get(id);
  if (!w) return;
  waits.delete(id);
  if (ok) w.res(data); else w.rej(new Error(data));
};
function nat(method, ...args) {
  return new Promise((res, rej) => {
    const id = 'r' + ++seq;
    waits.set(id, { res, rej });
    A.call(id, method, JSON.stringify(args));
  });
}

// 事件
const subs = {};
const on = (ch) => (fn) => { (subs[ch] = subs[ch] || new Set()).add(fn); return () => subs[ch].delete(fn); };
const emit = (ch, d) => { for (const fn of subs[ch] || []) try { fn(d); } catch (e) { console.error(e); } };

// ---------------- 設定（存在這支手機） ----------------
const KEY = 'xks.settings';
function defaults() {
  return {
    theme: 'dark', accent: '#f97316', autoUpdate: true, welcomed: false, notify: true,
    voice: { enabled: true, rate: 1, name: '' },
    ai: { key: '', model: 'gpt-6.1-terra' },
    cloud: { url: '', token: '', cursor: 0, pushed: 0, auto: true, uploadSrt: false, uploadMp3: false },
    download: { dir: FOLDER, formats: ['mp3', 'srt'], startOffset: -0.1, dupe: 'number', subfolders: false, bom: true, skipExisting: true, parallel: 2 },
    marks: [
      { id: 'fav', name: '最愛', icon: '⭐', color: '#eab308' },
      { id: 'video', name: '影片用', icon: '🎬', color: '#3b82f6' },
      { id: 'fix', name: '字幕待修', icon: '📝', color: '#ef4444' },
    ],
  };
}
let settings = defaults();
try {
  const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
  const d = defaults();
  settings = { ...d, ...raw, voice: { ...d.voice, ...(raw.voice || {}) }, ai: { ...d.ai, ...(raw.ai || {}) }, cloud: { ...d.cloud, ...(raw.cloud || {}) }, download: { ...d.download, ...(raw.download || {}), dir: FOLDER, subfolders: false }, marks: Array.isArray(raw.marks) ? raw.marks : d.marks };
} catch {}
const saveSettings = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };
function publicSettings() {
  const s = JSON.parse(JSON.stringify(settings));
  s.ai = { model: settings.ai.model, hasKey: !!settings.ai.key };
  const { token, ...c } = settings.cloud;
  s.cloud = { ...c, hasToken: !!token };
  return s;
}
function setSettings(patch = {}) {
  for (const k of ['theme', 'accent', 'autoUpdate', 'welcomed', 'notify']) if (k in patch) settings[k] = patch[k];
  if (patch.voice) settings.voice = { ...settings.voice, ...patch.voice };
  if (Array.isArray(patch.marks)) settings.marks = patch.marks.filter((m) => m && m.id && m.name).slice(0, 30);
  if (patch.download) {
    const d = patch.download;
    if (Array.isArray(d.formats)) settings.download.formats = FORMATS.filter((f) => d.formats.includes(f));
    if ('startOffset' in d && SRT.START_OFFSETS.some((o) => Math.abs(o - Number(d.startOffset)) < 1e-4)) settings.download.startOffset = Number(d.startOffset);
    if (['number', 'id', 'overwrite'].includes(d.dupe)) settings.download.dupe = d.dupe;
    for (const k of ['bom', 'skipExisting']) if (k in d) settings.download[k] = !!d[k];
    if ('parallel' in d) settings.download.parallel = Math.max(1, Math.min(3, Number(d.parallel) || 2));
  }
  if (patch.ai) {
    if ('key' in patch.ai) settings.ai.key = String(patch.ai.key || '').trim();
    if (patch.ai.model) settings.ai.model = String(patch.ai.model);
  }
  if (patch.cloud) {
    const c = patch.cloud;
    if ('token' in c) settings.cloud.token = String(c.token || '');
    if ('url' in c) { const u = String(c.url).trim(); if (u !== settings.cloud.url) { settings.cloud.cursor = 0; settings.cloud.pushed = 0; } settings.cloud.url = u; }
    for (const k of ['auto', 'uploadSrt', 'uploadMp3']) if (k in c) settings.cloud[k] = !!c[k];
  }
  saveSettings();
  return publicSettings();
}

// ---------------- 歌曲庫 ----------------
const LIB = 'xks.library';
const lib = { clips: {}, files: {}, marks: {} };
try { Object.assign(lib, JSON.parse(localStorage.getItem(LIB) || '{}')); } catch {}
let libTimer = 0;
const saveLib = (now) => {
  clearTimeout(libTimer);
  const go = () => { try { localStorage.setItem(LIB, JSON.stringify(lib)); } catch (e) { console.error('歌曲庫存檔失敗', e); } };
  if (now) go(); else libTimer = setTimeout(go, 600);
};
addEventListener('pagehide', () => saveLib(true));

function upsert(clips, src) {
  let added = 0;
  const now = Date.now();
  for (const c of clips) {
    const old = lib.clips[c.id];
    if (!old) added++;
    const next = { ...old, ...c, lyrics: c.lyrics || (old && old.lyrics) || '', seen: (old && old.seen) || now, src: (old && old.src) || src };
    const same = old && ['title', 'audio', 'image', 'duration', 'tags', 'lyrics', 'liked', 'unlocked'].every((k) => old[k] === next[k]);
    next.u = same ? old.u : now;
    lib.clips[c.id] = next;
  }
  if (clips.length) saveLib();
  return added;
}
const fileState = (id) => { const f = lib.files[id]; if (!f) return null; const o = { dir: f.dir, base: f.base, at: f.at }; for (const k of FORMATS) if (f[k]) o[k] = f[k]; return o; };
const listLib = () => Object.values(lib.clips).map((c) => ({ ...c, files: fileState(c.id), marks: lib.marks[c.id] || [] }));
let changeTimer = 0, changeAdded = 0;
function libChanged(added = 0) {
  changeAdded += added;
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = 0;
    emit('lib:changed', { added: changeAdded, total: Object.keys(lib.clips).length });
    changeAdded = 0;
    if (settings.cloud.token && settings.cloud.auto) syncSoon();
  }, 400);
}

// ---------------- Suno 連線（登入 cookie 在原生的 CookieManager，權杖由原生向 auth.suno.com 換） ----------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function toClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw.clip && typeof raw.clip === 'object' ? raw.clip : raw;
  if (typeof c.id !== 'string' || !UUID.test(c.id)) return null;
  if (!('audio_url' in c) && !('metadata' in c)) return null;
  const md = c.metadata || {};
  const cdn = (u) => String(u || '').replace('cdn2.suno.ai', 'cdn1.suno.ai');
  let audio = cdn(c.audio_url);
  if (!audio || /audiopipe|\/api\/forbidden/.test(audio)) audio = '';
  return {
    id: c.id, title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Untitled', audio,
    image: cdn(c.image_large_url || c.image_url), thumb: cdn(c.image_url || c.image_large_url),
    duration: Number(md.duration) || 0, tags: String(md.tags || ''), lyrics: String(c.lyrics || md.prompt || ''),
    created: String(c.created_at || ''), status: String(c.status || 'complete'), type: String(md.type || ''), task: String(md.task || ''),
    model: String(c.major_model_version || c.model_name || ''), artist: String(c.display_name || c.user_display_name || ''),
    handle: String(c.handle || c.user_handle || ''), liked: !!c.is_liked, trashed: !!c.is_trashed,
    instrumental: md.make_instrumental === true || md.has_vocal === false, video: cdn(c.video_url), unlocked: c.is_download_unlocked === true,
  };
}
const downloadable = (c) => c && c.status === 'complete' && c.type !== 'rendered_context_window' && !['infill', 'fixed_infill'].includes(c.task);
function harvest(json, out = new Map(), depth = 0) {
  if (!json || typeof json !== 'object' || depth > 7) return out;
  if (Array.isArray(json)) { for (const x of json) harvest(x, out, depth + 1); return out; }
  const c = toClip(json);
  if (c) out.set(c.id, c);
  for (const k of Object.keys(json)) if (json[k] && typeof json[k] === 'object') harvest(json[k], out, depth + 1);
  return out;
}

async function api(method, url, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await nat('suno', method, url, body ? JSON.stringify(body) : '');
    if (r.status >= 200 && r.status < 300) { try { return r.text ? JSON.parse(r.text) : {}; } catch { throw new Error('Suno 回應格式不正確'); } }
    if (r.status === -1) throw new Error('還沒有登入 Suno：請到「Suno 網頁」掃描電腦的 QR Code，或直接登入');
    if (r.status === 429 || r.status >= 500 || r.status === 0) { await sleep(Math.min(15000, (Number(r.retry) || 0) * 1000 || 1500 * (attempt + 1) ** 2)); continue; }
    if (r.status === 401 || r.status === 403) { if (attempt < 1) { await sleep(800); continue; } throw new Error('Suno 登入已過期，請重新從電腦帶入或重新登入'); }
    if (r.status === 404) { const e = new Error('Suno 找不到這筆資料'); e.code = 404; throw e; }
    throw new Error(`Suno 回應錯誤（${r.status}）${String(r.text || '').slice(0, 120)}`);
  }
  throw new Error('Suno 目前太忙或連不上，請稍後再試');
}

const suno = {
  user() {
    const n = {};
    for (const c of Object.values(lib.clips)) if (c.handle) n[c.handle] = (n[c.handle] || 0) + 1;
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    return { username: top ? top[0] : '' };
  },
  async listAll({ liked = false, onPage } = {}) {
    const all = new Map();
    let cursor = null;
    for (let page = 0; page < 200; page++) {
      const filters = { trashed: 'False' };
      if (liked) filters.liked = 'True';
      const body = { limit: 50, filters };
      if (cursor) body.cursor = cursor;
      const r = await api('POST', `${API}/api/feed/v3`, body);
      for (const c of (r.clips || []).map(toClip).filter(downloadable)) all.set(c.id, c);
      if (onPage) onPage(all.size);
      cursor = r.next_cursor || null;
      if (!r.has_more || !cursor) break;
      await sleep(250);
    }
    return [...all.values()];
  },
  async byIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const q = ids.slice(i, i + 20).map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      out.push(...harvest(await api('GET', `${API}/api/clips/get_songs_by_ids?${q}`)).values());
    }
    return out;
  },
  async clip(id) { return toClip(await api('GET', `${API}/api/clip/${id}`)); },
  async aligned(id) { try { return await api('GET', `${API}/api/gen/${id}/aligned_lyrics/v2/`); } catch (e) { if (e.code === 404) return null; throw e; } },
  async quota() {
    const b = await api('GET', `${SITE}/api/billing/info/`);
    const u = (b && b.download_usage) || {};
    const limit = Number(u.current_period_downloads_limit) || 0, used = Number(u.current_period_downloads_used) || 0, extra = Number(u.additional_download_remaining) || 0;
    return { plan: (b.plan && b.plan.name) || '', limit, used, extra, remaining: Math.max(0, limit - used) + extra, renews: b.renews_on || b.period_end || '' };
  },
  // 官方下載：還沒解鎖的歌會用掉 1 次下載次數
  async downloadUrl(id, format = 'mp3', signal) {
    for (let i = 0; i < 90; i++) {
      if (signal && signal.aborted) throw new Error('已取消');
      const r = await api('GET', `${SITE}/api/download/clip/${id}?format=${format}`);
      if (r && r.download_url && (!r.status || r.status === 'ready')) return r.download_url;
      if (r && (r.ok === false || r.status === 'error' || r.status === 'failed')) throw new Error(r.detail || r.message || 'Suno 無法提供這首歌的下載');
      await sleep(Math.min(5000, 1500 + i * 300));
    }
    throw new Error('Suno 準備檔案逾時');
  },
};

// 內建 Suno 網頁的狀態（原生在網頁換頁時呼叫 window.__xkSuno）
let sunoPage = { url: '', canBack: false, canForward: false };
let sunoLogged = null;
async function sunoState() {
  try { sunoLogged = await nat('sunoLogin'); } catch { sunoLogged = { loggedIn: false }; }
  return { ok: true, ...sunoPage, loggedIn: !!sunoLogged.loggedIn, user: sunoLogged.loggedIn ? suno.user() : null };
}
window.__xkSuno = (p) => { sunoPage = { ...sunoPage, ...p }; sunoState().then((s) => emit('suno:state', s)); };

// 抓取 Suno 網頁目前這一頁的歌（自動往下捲收集 /song/ 連結）
const SCAN_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = new Set();
  const m0 = location.pathname.match(/\\/(?:song|edit)\\/([0-9a-f-]{36})/i);
  if (m0) found.add(m0[1]);
  const collect = () => { for (const a of document.querySelectorAll('a[href*="/song/"]')) { const id = (a.getAttribute('href').split('/song/')[1] || '').split(/[?#/]/)[0]; if (/^[0-9a-f-]{36}$/i.test(id)) found.add(id); } };
  const box = (() => { let el = document.querySelector('a[href*="/song/"]'); el = el && el.parentElement; while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el; el = el.parentElement; } return document.scrollingElement; })();
  collect();
  let stable = 0, last = found.size, lastPos = -1;
  for (let i = 0; i < 200 && stable < 5; i++) { box.scrollTop += 600; await sleep(450); collect(); const atEnd = box.scrollTop === lastPos; lastPos = box.scrollTop; stable = found.size === last && atEnd ? stable + 1 : 0; last = found.size; }
  box.scrollTop = 0;
  return JSON.stringify([...found]);
})()`;

// ---------------- 下載佇列 ----------------
const dl = { jobs: [], running: 0, paused: false, seq: 0, ctl: new AbortController(), emitTimer: 0 };
const snapshot = () => ({ paused: dl.paused, jobs: dl.jobs.map(({ key, id, title, formats, state, step, pct, msg, done, failed, base, dir }) => ({ key, id, title, formats, state, step, pct, msg, done, failed, base, dir })) });
function dlEmit(now) {
  if (now) { clearTimeout(dl.emitTimer); dl.emitTimer = 0; emit('dl:update', snapshot()); return; }
  if (dl.emitTimer) return;
  dl.emitTimer = setTimeout(() => { dl.emitTimer = 0; emit('dl:update', snapshot()); }, 200);
}
const progress = new Map();
window.__xkDl = (key, got, total) => { const fn = progress.get(key); if (fn && total > 0) fn(got / total); };

function dlAdd(ids, formats, { allowUnlock = false } = {}) {
  formats = FORMATS.filter((f) => formats.includes(f));
  if (!formats.length) throw new Error('請至少選一種要下載的格式');
  let n = 0;
  for (const id of ids) {
    const clip = lib.clips[id];
    if (!clip || dl.jobs.some((j) => j.id === id && (j.state === 'wait' || j.state === 'run'))) continue;
    dl.jobs.push({ key: ++dl.seq, id, title: clip.title, formats, allowUnlock: !!allowUnlock, state: 'wait', step: '', pct: 0, msg: '', done: [], failed: [] });
    n++;
  }
  dlEmit(true);
  pump();
  return n;
}
function pump() {
  const max = Math.max(1, Math.min(3, Number(settings.download.parallel) || 2));
  while (!dl.paused && dl.running < max) {
    const j = dl.jobs.find((x) => x.state === 'wait');
    if (!j) break;
    dl.running++;
    j.state = 'run';
    runJob(j, dl.ctl.signal).catch((e) => { if (j.state !== 'cancel') { j.state = 'error'; j.msg = String(e.message || e); } })
      .finally(() => { dl.running--; dlEmit(true); saveLib(); pump(); });
  }
}
let names = null;
async function takenNames() { if (!names) { try { names = new Set((await nat('listFiles')).map((n) => n.toLowerCase())); } catch { names = new Set(); } } return names; }
async function baseFor(clip) {
  const reg = lib.files[clip.id];
  if (reg && reg.base) return reg.base;
  const disk = await takenNames();
  const onDisk = new Set([...disk].map((n) => n.replace(/\.[^.]+$/, '')));
  const used = new Set(Object.entries(lib.files).filter(([id]) => id !== clip.id).map(([, f]) => String(f.base).toLowerCase()));
  const busy = new Set(dl.jobs.filter((j) => j.id !== clip.id && j.base && j.state === 'run').map((j) => j.base.toLowerCase()));
  return NAMING.pickBase(clip, settings.download.dupe, (b) => { const k = b.toLowerCase(); return onDisk.has(k) || used.has(k) || busy.has(k); });
}
async function runJob(j, signal) {
  const clip = lib.clips[j.id];
  if (!clip) throw new Error('歌曲庫裡找不到這首歌');
  j.dir = FOLDER;
  j.base = await baseFor(clip);
  dlEmit();
  const reg = lib.files[clip.id] = { ...(lib.files[clip.id] || {}), dir: FOLDER, base: j.base, at: Date.now() };
  const text = (s) => (settings.download.bom ? '﻿' : '') + s;
  let aligned;
  const getAligned = async () => (aligned !== undefined ? aligned : (aligned = await suno.aligned(clip.id)));
  const steps = j.formats.length;
  for (let i = 0; i < steps; i++) {
    const fmt = j.formats[i];
    if (signal.aborted) throw new Error('已取消');
    const name = `${j.base}.${fmt}`;
    j.step = fmt.toUpperCase();
    j.pct = i / steps;
    dlEmit();
    try {
      if (settings.download.skipExisting && reg[fmt] && await nat('exists', reg[fmt])) { j.done.push(fmt); continue; }
      const key = `${j.key}-${fmt}`;
      progress.set(key, (p) => { j.pct = (i + p) / steps; dlEmit(); });
      let r;
      if (fmt === 'mp3' || fmt === 'wav') {
        if (!clip.unlocked && !j.allowUnlock) throw new Error('還沒解鎖，下載要用 1 次 Suno 下載次數');
        const url = await suno.downloadUrl(clip.id, fmt, signal);
        clip.unlocked = true;
        clip.u = Date.now();
        r = await nat('download', url, name, MIME[fmt], key);
      } else if (fmt === 'jpg') {
        if (!clip.image) throw new Error('沒有封面');
        r = await nat('download', clip.image, name, MIME.jpg, key);
      } else if (fmt === 'txt') {
        if (!clip.lyrics.trim()) throw new Error('沒有歌詞');
        r = await nat('writeText', name, text(clip.lyrics.replace(/\r?\n/g, '\r\n') + '\r\n'), MIME.txt);
      } else {
        const payload = await getAligned();
        const c = SRT.convert(payload || {}, { startOffset: Number(settings.download.startOffset), duration: clip.duration, title: clip.title, artist: clip.artist });
        if (!c.lines.length) throw new Error(clip.instrumental ? '純音樂，沒有歌詞' : 'Suno 沒有提供對時歌詞');
        r = await nat('writeText', name, text(fmt === 'srt' ? c.srt : c.lrc), MIME[fmt]);
      }
      progress.delete(key);
      reg[fmt] = r.uri;
      if (names) names.add(name.toLowerCase());
      j.done.push(fmt);
      if (settings.cloud.token && ((fmt === 'srt' && settings.cloud.uploadSrt) || (fmt === 'mp3' && settings.cloud.uploadMp3))) cloud.upload(fmt, r.uri, name).catch((e) => emit('app:toast', { text: `雲端備份失敗：${e.message}`, type: 'error' }));
    } catch (e) {
      if (signal.aborted) throw new Error('已取消');
      j.failed.push(`${fmt}:${String(e.message || e)}`);
    }
    await sleep(100);
  }
  j.pct = 1;
  j.step = '';
  j.state = j.done.length ? 'done' : 'error';
  j.msg = j.failed.length ? j.failed.map((f) => { const [k, ...m] = f.split(':'); return `${k.toUpperCase()}：${m.join(':')}`; }).join('；') : '';
  if (!dl.jobs.some((x) => x.state === 'wait' || x.state === 'run') && settings.notify) {
    const ok = dl.jobs.filter((x) => x.state === 'done').length;
    nat('notify', `下載完成：${ok} 首`).catch(() => {});
  }
}

// ---------------- 雲端（Apps Script，網頁直接連） ----------------
const cloud = {
  st: { status: 'off', at: 0, error: '' },
  busy: null,
  set(s) { this.st = { ...this.st, ...s }; emit('cloud:state', { ...this.st }); },
  async post(body, ms = 60000) {
    const { url, token } = settings.cloud;
    if (!url || !token) throw new Error('還沒有設定雲端儲存');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}app=suno`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, ...body }), redirect: 'follow', signal: ctl.signal });
      const r = JSON.parse(await res.text());
      if (!r.ok) throw new Error(r.error || '雲端回應錯誤');
      return r;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('雲端連線逾時');
      if (e instanceof SyntaxError) throw new Error('雲端程式還沒更新，請先在 Apps Script 加入 suno.gs 並部署新版本');
      throw e;
    } finally { clearTimeout(t); }
  },
  record(c) {
    const { id, title, audio, image, thumb, duration, tags, lyrics, created, artist, handle, model, instrumental, liked } = c;
    return { id, title, audio, image, thumb, duration, tags, lyrics: String(lyrics || '').slice(0, 6000), created, artist, handle, model, instrumental, liked, marks: lib.marks[id] || [] };
  },
  async sync() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.set({ status: 'busy' });
      try {
        const pushed = Number(settings.cloud.pushed) || 0;
        const changes = Object.values(lib.clips).filter((c) => (c.u || 0) > pushed).map((c) => ({ k: 'song', id: c.id, u: c.u || Date.now(), r: this.record(c) }));
        const started = Date.now();
        let sent = 0, applied = 0, cursor = Number(settings.cloud.cursor) || 0;
        for (let i = 0; i === 0 || i < changes.length; i += 300) {
          const part = changes.slice(i, i + 300);
          const r = await this.post({ action: 'sync', since: cursor, changes: part });
          sent += part.length;
          for (const x of r.changes || []) {
            if (x.k !== 'song' || !x.r || !x.r.id) continue;
            const cur = lib.clips[x.id];
            if (cur && (cur.u || 0) >= x.u) continue;
            const { marks, ...rest } = x.r;
            lib.clips[x.id] = { ...cur, ...rest, seen: (cur && cur.seen) || x.u, src: (cur && cur.src) || 'cloud', u: x.u };
            if (marks && marks.length) lib.marks[x.id] = marks; else delete lib.marks[x.id];
            applied++;
          }
          cursor = r.seq || cursor;
        }
        saveLib();
        settings.cloud.cursor = cursor;
        settings.cloud.pushed = started;
        saveSettings();
        this.set({ status: 'ok', at: Date.now(), error: '' });
        return { sent, applied };
      } catch (e) {
        this.set({ status: 'error', error: String(e.message || e) });
        throw e;
      } finally { this.busy = null; }
    })();
    return this.busy;
  },
  async upload(kind, uri, name) {
    const data = await nat('readB64', uri);
    if (data.length > 47 * 1024 * 1024) throw new Error('檔案太大，無法備份到雲端');
    return this.post({ action: 'upload', folder: kind.toUpperCase(), name, mime: MIME[kind] || 'application/octet-stream', data }, 180000);
  },
};
let syncTimer = 0;
function syncSoon(ms = 8000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => cloud.sync().then((r) => { if (r.applied) libChanged(0); }).catch(() => {}), ms); }

function decodePairing(code) {
  const m = /^XKS1\.([A-Za-z0-9+/=_-]+)$/.exec(String(code || '').replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return o && /^https:\/\/script\.google(usercontent)?\.com\//.test(o.url) && o.token ? o : null;
  } catch { return null; }
}
const encodePairing = (url, token) => 'XKS1.' + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ url, token }))));

async function cloudConnect(code) {
  const o = decodePairing(code);
  if (!o) throw new Error('設定碼不正確（應該是 XKS1. 開頭）');
  if (/\/dev(\?|$)/.test(o.url)) throw new Error('這個設定碼是 /dev 測試網址，App 連不上，請改用 /exec 網址的設定碼');
  Object.assign(settings.cloud, { url: o.url, token: o.token, cursor: 0, pushed: 0 });
  saveSettings();
  const ping = await cloud.post({ action: 'ping' });
  const r = await cloud.sync();
  libChanged(0);
  return { ...r, count: ping.count };
}

// ---------------- OpenAI（網頁直接連，金鑰只存在這支手機） ----------------
function aiErrorText(status, data) {
  const msg = (data && data.error && data.error.message) || '';
  if (status === 401) return '金鑰不正確，請到設定檢查 OpenAI 金鑰';
  if (status === 429) return '額度用完或請求太頻繁，請到 OpenAI 帳戶確認';
  if (status === 404) return `找不到這個模型：${msg}`;
  return msg || `OpenAI 回應錯誤（${status}）`;
}

// ---------------- 版本更新（GitHub Releases 的 APK） ----------------
let updInfo = null;

// ---------------- 文字轉語音：給 voice.js 用 ----------------
const ttsDone = new Map();
window.__xkTtsDone = (id) => { const f = ttsDone.get(id); if (f) { ttsDone.delete(id); f(); } };
// iPhone／iPad 的 WKWebView 有網頁語音（speechSynthesis），不用原生
window.xkNative = IOS ? { mobile: true } : {
  mobile: true,
  tts: {
    available: () => A.ttsAvailable(),
    voiceName: () => A.ttsVoice(),
    speak: (text, rate) => new Promise((res) => { const id = 't' + ++seq; ttsDone.set(id, res); A.ttsSpeak(String(text), Number(rate) || 1, id); setTimeout(() => window.__xkTtsDone(id), 8000 + String(text).length * 400); }),
    stop: () => A.ttsStop(),
  },
};

// ---------------- 對外介面：和桌面版 window.xk 一樣 ----------------
export function makeXk() {
  const info = JSON.parse(A.appInfo());
  return {
    platform: IOS ? 'ios' : 'android',
    mobile: true,
    settings: { get: async () => publicSettings(), set: async (p) => setSettings(p) },
    sys: { info: async () => ({ platform: IOS ? 'ios' : 'android', version: info.version, packaged: true, userData: FOLDER, model: info.model }) },
    openExternal: async (url) => A.openUrl(url),
    onToast: on('app:toast'),
    onZoom: on('app:zoom'),
    suno: {
      bounds: (r) => A.sunoBounds(r.x, r.y, r.width, r.height),
      visible: (v) => A.sunoVisible(!!v),
      nav: async (action, url) => A.sunoNav(action, url || ''),
      state: () => sunoState(),
      logout: async () => { await nat('logout'); emit('suno:state', await sunoState()); return true; },
      quota: () => suno.quota(),
      chromeInfo: async () => ({ name: '' }),
      // 掃描電腦的 QR Code：內容是 XKSP1:{c:[[名稱,值,網域,到期]], k:雲端設定碼}
      importPair: async (code) => {
        const m = /^XKSP1:(\{[\s\S]*\})$/.exec(String(code || '').trim());
        if (!m) throw new Error('這不是小柯SUNO工具的 QR Code');
        const o = JSON.parse(m[1]);
        await nat('importLogin', JSON.stringify(o.c || []));
        const st = await sunoState();
        emit('suno:state', st);
        if (!st.loggedIn) throw new Error('登入資料帶入了，但 Suno 沒有認得，請在電腦重新按「用 Chrome 登入」後再試');
        let cloudOk = false;
        if (o.k && !settings.cloud.token) { try { await cloudConnect(o.k); cloudOk = true; } catch {} }
        A.sunoNav('url', 'https://suno.com/me');
        return { ok: true, cloud: cloudOk };
      },
      onState: on('suno:state'),
    },
    lib: {
      list: async () => listLib(),
      refresh: async (opt = {}) => {
        const clips = await suno.listAll({ liked: !!opt.liked, onPage: (n) => emit('lib:progress', { n }) });
        const added = upsert(clips, 'library');
        libChanged(0);
        return { total: clips.length, added };
      },
      scan: async () => {
        const ids = JSON.parse((await nat('sunoEval', SCAN_JS)) || '[]');
        emit('lib:progress', { n: ids.length, scan: true });
        const clips = ids.length ? (await suno.byIds(ids)).filter(downloadable) : [];
        const added = upsert(clips, 'web');
        libChanged(0);
        return { total: clips.length, added, ids: clips.map((c) => c.id) };
      },
      remove: async (ids) => { for (const id of ids || []) { delete lib.clips[id]; delete lib.marks[id]; } saveLib(); libChanged(0); return true; },
      mark: async (ids, markId, on2) => {
        for (const id of ids || []) {
          const set = new Set(lib.marks[id] || []);
          if (on2) set.add(markId); else set.delete(markId);
          if (set.size) lib.marks[id] = [...set]; else delete lib.marks[id];
          if (lib.clips[id]) lib.clips[id].u = Date.now();
        }
        saveLib();
        libChanged(0);
        return true;
      },
      detail: async (id) => {
        let c = lib.clips[id];
        if (c && !c.lyrics) { try { const full = await suno.clip(id); if (full) { upsert([full], c.src); c = lib.clips[id]; } } catch {} }
        return c ? { ...c, files: fileState(id), marks: lib.marks[id] || [] } : null;
      },
      srt: async (id, offset) => {
        const c = lib.clips[id];
        if (!c) throw new Error('找不到這首歌');
        const r = SRT.convert((await suno.aligned(id)) || {}, { startOffset: Number(offset ?? settings.download.startOffset), duration: c.duration, title: c.title, artist: c.artist });
        return { lines: r.lines, srt: r.srt, instrumental: c.instrumental };
      },
      play: async (id, offset) => {
        const c = lib.clips[id];
        if (!c) throw new Error('找不到這首歌');
        const f = fileState(id) || {};
        const local = f.mp3 && await nat('exists', f.mp3).catch(() => false);
        const out = { id, title: c.title, image: c.image || c.thumb, audio: local ? `${location.origin}/media/${encodeURIComponent(f.mp3)}` : '', localAudio: !!local, lines: [], lyricSrc: '', instrumental: c.instrumental };
        if (!out.audio && c.unlocked) { try { out.audio = await suno.downloadUrl(id, 'mp3'); out.audioSrc = 'unlocked'; } catch {} }
        if (!out.audio && c.video) { out.audio = c.video; out.audioSrc = 'video'; }
        if (!out.audio) throw new Error('Suno 沒有提供這首歌的試聽音檔');
        if (f.srt && offset == null) { try { out.lines = SRT.parseSrt(await nat('readText', f.srt)); out.lyricSrc = 'file'; } catch {} }
        if (!out.lines.length) {
          try { out.lines = SRT.convert((await suno.aligned(id)) || {}, { startOffset: Number(offset ?? settings.download.startOffset), duration: c.duration }).lines; out.lyricSrc = out.lines.length ? 'suno' : ''; } catch (e) { out.error = e.message; }
        }
        return out;
      },
      onChanged: on('lib:changed'),
      onProgress: on('lib:progress'),
    },
    dl: {
      add: async (ids, formats, opts) => dlAdd(ids || [], formats || settings.download.formats, opts || {}),
      state: async () => snapshot(),
      pause: async (v) => { dl.paused = !!v; dlEmit(true); if (!dl.paused) pump(); },
      cancel: async () => { dl.ctl.abort(); dl.ctl = new AbortController(); for (const j of dl.jobs) if (j.state === 'wait' || j.state === 'run') { j.state = 'cancel'; j.msg = '已取消'; } dlEmit(true); },
      clear: async () => { dl.jobs = dl.jobs.filter((j) => j.state === 'wait' || j.state === 'run'); dlEmit(true); },
      retry: async () => {
        for (const j of dl.jobs) if (j.state === 'error' || j.state === 'cancel' || (j.state === 'done' && j.failed.length)) {
          j.formats = j.state === 'done' ? j.failed.map((f) => f.split(':')[0]) : j.formats;
          Object.assign(j, { state: 'wait', step: '', pct: 0, msg: '', done: [], failed: [] });
        }
        dlEmit(true);
        pump();
      },
      onUpdate: on('dl:update'),
    },
    dir: { choose: async () => null, open: async () => { emit('app:toast', { text: `檔案存在手機的「${FOLDER}」資料夾，用「我的檔案」App 可以找到` }); } },
    file: {
      show: async () => emit('app:toast', { text: `檔案在手機的「${FOLDER}」資料夾` }),
      saveText: async (name, text) => { const r = await nat('writeText', NAMING.sanitize(name.replace(/\.[^.]+$/, '')) + (name.match(/\.[^.]+$/) || ['.txt'])[0], (settings.download.bom ? '﻿' : '') + text, 'text/plain'); return r.path; },
    },
    ai: {
      post: async (body) => {
        if (!settings.ai.key) throw new Error('還沒有設定 OpenAI 金鑰');
        const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${settings.ai.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(aiErrorText(res.status, data));
        return data;
      },
      test: async () => {
        if (!settings.ai.key) return { ok: false, error: '還沒有設定 OpenAI 金鑰' };
        try {
          const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${settings.ai.key}` } });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) return { ok: false, error: aiErrorText(res.status, data) };
          return { ok: true, models: (data.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort().reverse() };
        } catch (e) { return { ok: false, error: `連不上 OpenAI：${e.message}` }; }
      },
    },
    cloud: {
      connect: (code) => cloudConnect(code),
      disconnect: async () => { Object.assign(settings.cloud, { url: '', token: '', cursor: 0, pushed: 0 }); saveSettings(); cloud.set({ status: 'off' }); return publicSettings(); },
      sync: async () => { const r = await cloud.sync(); libChanged(0); return r; },
      state: async () => ({ ...cloud.st }),
      code: async () => (settings.cloud.token ? encodePairing(settings.cloud.url, settings.cloud.token) : ''),
      upload: async (ids, kind) => { let n = 0; for (const id of ids || []) { const f = fileState(id); if (f && f[kind]) { await cloud.upload(kind, f[kind], `${f.base}.${kind}`); n++; } } return n; },
      onState: on('cloud:state'),
    },
    update: {
      check: async () => {
        // iPhone／iPad：查 GitHub 最新版，安裝要回到安裝頁（itms-services）
        const r = IOS ? await iosLatest() : JSON.parse(A.checkUpdate());
        if (r.status !== 'ok') throw new Error(r.message || '查詢失敗');
        const cmp = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };
        updInfo = { current: r.current, latest: r.latest, newer: cmp(r.latest, r.current) > 0, notes: r.notes || '', page: r.page, asset: r.url ? { name: r.url.split('/').pop(), url: r.url } : null, canInstall: !IOS && !!r.url };
        return updInfo;
      },
      // 交給 Android 下載 APK 並打開安裝畫面；進度用輪詢
      download: async () => {
        if (!updInfo || !updInfo.asset) throw new Error('找不到 Android 安裝檔');
        JSON.parse(A.installUpdate(updInfo.asset.url, updInfo.latest));
        for (;;) {
          const s = JSON.parse(A.updateStatus());
          emit('update:progress', { got: s.pct || 0, total: 100 });
          if (s.state === 'permission') throw new Error('請先允許「小柯SUNO」安裝應用程式，再按一次「下載並安裝」');
          if (s.state === 'error') throw new Error('下載失敗，請稍後再試');
          if (s.state === 'launching') return 'apk';
          await sleep(500);
        }
      },
      install: async () => ({ manual: true, path: '安裝畫面已打開，請按「更新」' }),
      openPage: async () => A.openUrl((updInfo && updInfo.page) || 'https://github.com/achir1015/xiaoke-suno/releases/latest'),
      onProgress: on('update:progress'),
    },
  };
}

async function iosLatest() {
  const res = await fetch('https://api.github.com/repos/achir1015/xiaoke-suno/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`查詢失敗（${res.status}）`);
  const o = await res.json();
  return { status: 'ok', current: JSON.parse(A.appInfo()).version, latest: String(o.tag_name || '').replace(/^v/, ''), notes: o.body || '', page: 'https://achir1015.github.io/xiaoke-suno/ios/', url: '' };
}

// 啟動時：雲端自動同步一次
if (settings.cloud.token && settings.cloud.auto) syncSoon(3000);
