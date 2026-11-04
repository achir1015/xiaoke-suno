'use strict';
// Suno 網頁（App 內建的瀏覽區）＋ Suno 網站自己用的 API
// 登入由使用者在內建網頁完成；取歌單、歌詞都借用那個網頁的登入狀態，帳號密碼不經過本程式
const { WebContentsView, session } = require('electron');

const HOME = process.env.XIAOKE_SUNO_HOME || 'https://suno.com/';
const API = (process.env.XIAOKE_SUNO_API || 'https://studio-api-prod.suno.com').replace(/\/$/, '');
// 網站自己用的 API（官方下載、方案資訊）：https://suno.com/a/api/...
const SITE_API = (process.env.XIAOKE_SUNO_SITE_API || new URL(HOME).origin + '/a').replace(/\/$/, '');
const PARTITION = process.env.XIAOKE_SUNO_PARTITION || 'persist:suno';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jwtExp(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).exp || 0; } catch { return 0; }
}

// 各種 API 回應裡的歌曲物件 → 統一格式
function toClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw.clip && typeof raw.clip === 'object' ? raw.clip : raw;
  if (typeof c.id !== 'string' || !UUID.test(c.id)) return null;
  if (!('audio_url' in c) && !('metadata' in c)) return null;
  const md = c.metadata || {};
  const cdn = (u) => String(u || '').replace('cdn2.suno.ai', 'cdn1.suno.ai');
  // 2026-11 起 Suno 的 audio_url 一律是 …/api/forbidden，MP3 要用官方下載（會用到下載次數）
  let audio = cdn(c.audio_url);
  if (!audio || /audiopipe|\/api\/forbidden/.test(audio)) audio = '';
  return {
    id: c.id,
    title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Untitled',
    audio,
    image: cdn(c.image_large_url || c.image_url),
    thumb: cdn(c.image_url || c.image_large_url),
    duration: Number(md.duration) || 0,
    tags: String(md.tags || ''),
    lyrics: String(c.lyrics || md.prompt || ''),
    created: String(c.created_at || ''),
    status: String(c.status || 'complete'),
    type: String(md.type || ''),
    task: String(md.task || ''),
    model: String(c.major_model_version || c.model_name || ''),
    artist: String(c.display_name || c.user_display_name || ''),
    handle: String(c.handle || c.user_handle || ''),
    userId: String(c.user_id || ''),
    liked: !!c.is_liked,
    trashed: !!c.is_trashed,
    instrumental: md.make_instrumental === true || md.has_vocal === false,
    video: cdn(c.video_url),
    unlocked: c.is_download_unlocked === true,
  };
}

// 可以下載的歌：已完成，且不是 Suno 內部的片段
const downloadable = (c) => c && c.status === 'complete' && !['rendered_context_window'].includes(c.type) && !['infill', 'fixed_infill'].includes(c.task);

// 在 JSON 裡找出所有歌曲物件（工作區、播放清單、首頁動態的格式都不一樣）
function harvest(json, out = new Map(), depth = 0) {
  if (!json || typeof json !== 'object' || depth > 7) return out;
  if (Array.isArray(json)) { for (const x of json) harvest(x, out, depth + 1); return out; }
  const c = toClip(json);
  if (c) out.set(c.id, c);
  for (const k of Object.keys(json)) if (json[k] && typeof json[k] === 'object') harvest(json[k], out, depth + 1);
  return out;
}

class Suno {
  constructor({ win, onClips, onState, onDownload }) {
    this.win = win;
    this.onClips = onClips || (() => {});
    this.onState = onState || (() => {});
    this.onDownload = onDownload;
    this.view = null;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.lastToken = '';
    this.user = null;
  }

  get ses() { return session.fromPartition(PARTITION); }
  get wc() { return this.view && this.view.webContents; }

  create() {
    const ses = this.ses;
    // 用一般 Chrome 的身分開網頁，Google 等登入頁才不會擋
    ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`);
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen', 'media'].includes(perm)));
    // 使用者在網頁上按 Suno 自己的「下載」：直接存到下載資料夾，檔名用 Suno 給的
    ses.on('will-download', (e, item) => { if (this.onDownload) this.onDownload(item); });
    this.view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    this.view.setBackgroundColor('#101014');
    const wc = this.wc;
    wc.setWindowOpenHandler(({ url }) => (/^https?:/.test(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, title: '登入', webPreferences: { partition: PARTITION } } }
      : { action: 'deny' }));
    const emit = () => this.state().then((s) => this.onState(s)).catch(() => {});
    wc.on('did-navigate', emit);
    wc.on('did-navigate-in-page', emit);
    wc.on('did-finish-load', () => { emit(); setTimeout(emit, 2500); });
    wc.on('did-fail-load', (e, code, desc, url, main) => { if (main && code !== -3) this.onState({ ok: false, loggedIn: false, url, error: `網頁打不開（${desc}）` }); });
    this.watchNetwork();
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(false);
    wc.loadURL(HOME).catch(() => {});
    // 登入狀態每 20 秒確認一次（Clerk 的權杖只有一分鐘效期，順便更新）
    this.timer = setInterval(emit, 20000);
  }

  destroy() {
    clearInterval(this.timer);
    try { if (this.wc && this.wc.debugger.isAttached()) this.wc.debugger.detach(); } catch {}
    try { this.wc && this.wc.close(); } catch {}
    this.view = null;
  }

  // 被動收集：使用者在網頁上看到的歌（工作區、播放清單）都會自動加進歌曲庫
  watchNetwork() {
    const dbg = this.wc.debugger;
    try { dbg.attach('1.3'); } catch { return; }
    const want = new Map();
    const apiHost = new URL(API).host;
    dbg.on('message', async (e, method, p) => {
      if (method === 'Network.responseReceived') {
        const u = p.response && p.response.url || '';
        if (p.type !== 'Preflight' && /json/i.test(p.response.mimeType || '') && (u.includes(apiHost) || /\/api\//.test(u))) want.set(p.requestId, u);
      } else if (method === 'Network.loadingFinished' && want.has(p.requestId)) {
        want.delete(p.requestId);
        try {
          const r = await dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId });
          const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
          if (!text || text.length > 20 * 1024 * 1024) return;
          const found = [...harvest(JSON.parse(text)).values()].filter(downloadable);
          if (found.length) this.onClips(found, 'web');
        } catch {}
      } else if (method === 'Network.loadingFailed') want.delete(p.requestId);
    });
    dbg.on('detach', () => {});
    dbg.sendCommand('Network.enable', { maxResourceBufferSize: 20 * 1024 * 1024, maxTotalBufferSize: 100 * 1024 * 1024 }).catch(() => {});
  }

  setBounds(b) {
    this.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
    if (this.view) { this.view.setBounds(this.bounds); this.view.setVisible(this.visible && this.bounds.width > 0); }
  }

  setVisible(v) {
    this.visible = !!v;
    if (!this.view) return;
    this.view.setVisible(this.visible && this.bounds.width > 0);
    if (this.visible) this.wc.focus();
  }

  nav(action, url) {
    const wc = this.wc;
    if (!wc) return;
    const h = wc.navigationHistory;
    if (action === 'back' && h.canGoBack()) h.goBack();
    else if (action === 'forward' && h.canGoForward()) h.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'home') wc.loadURL(HOME);
    else if (action === 'url' && /^https?:\/\//.test(url || '')) wc.loadURL(url);
  }

  onSuno() {
    try { return new URL(this.wc.getURL()).host === new URL(HOME).host; } catch { return false; }
  }

  async run(js) { return this.wc.executeJavaScript(js, true); }

  // 登入狀態與使用者名稱
  // Clerk 的 __session JWT：還沒過期就算登入中
  async sessionToken() {
    const ck = await this.ses.cookies.get({ name: '__session' }).catch(() => []);
    const now = Date.now() / 1000;
    for (const c of ck.filter((x) => /suno|127\.0\.0\.1|localhost/.test(x.domain))) {
      const exp = jwtExp(c.value);
      if (!exp || exp > now - 300) return c.value;
    }
    return '';
  }

  async state() {
    const url = this.wc ? this.wc.getURL() : '';
    const base = { ok: true, url, canBack: !!this.wc && this.wc.navigationHistory.canGoBack(), canForward: !!this.wc && this.wc.navigationHistory.canGoForward() };
    if (!this.wc || !this.onSuno()) return { ...base, loggedIn: !!this.lastToken, user: this.user };
    const r = await this.run(`(async () => {
      const C = window.Clerk;
      if (!C) return { ready: false };
      try { if (C.load && !C.loaded) await C.load(); } catch (e) {}
      const s = C.session;
      if (!s) return { ready: !!C.loaded, token: '' };
      let token = '';
      try { token = await s.getToken(); } catch (e) {}
      const u = C.user || {};
      return { ready: true, token: token || '', user: { name: u.fullName || u.firstName || '', username: u.username || '', email: (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || '', image: u.imageUrl || '' } };
    })()`).catch(() => ({ ready: false }));
    if (r.token) { this.lastToken = r.token; this.user = r.user; }
    else if (r.ready) { this.lastToken = ''; this.user = null; }
    if (r.ready) return { ...base, loggedIn: !!r.token, user: this.user };
    // 網頁沒有 Clerk 物件（Suno 新版）：用 __session cookie 判斷
    const tok = await this.sessionToken();
    if (tok) this.lastToken = tok;
    this.user = tok ? (this.userHint ? this.userHint() : { username: '' }) : null;
    return { ...base, loggedIn: !!tok, user: this.user };
  }

  async token() {
    if (this.wc && this.onSuno()) {
      const t = await this.run('(async()=>{try{return (window.Clerk&&window.Clerk.session)?await window.Clerk.session.getToken():""}catch(e){return ""}})()').catch(() => '');
      if (t) { this.lastToken = t; return t; }
    }
    // Suno 新版網頁沒有 window.Clerk，或網頁不在 Suno：用 __session cookie
    const t = (await this.sessionToken()) || this.lastToken;
    if (!t) throw new Error('還沒有登入 Suno，請到「Suno 網頁」登入');
    return t;
  }

  // 呼叫 Suno API：優先在 Suno 網頁裡發出（跟網站自己發的一樣），網頁不在 Suno 時才由程式直接連
  async api(method, path, body, { base = API } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.token();
      let r;
      if (this.wc && this.onSuno()) {
        r = await this.run(`(async () => {
          try {
            const dev = (document.cookie.match(/suno_device_id=([^;]+)/) || [])[1];
            const h = { Authorization: 'Bearer ' + ${JSON.stringify(token)} };
            if (dev) h['device-id'] = dev;
            ${body ? "h['Content-Type'] = 'application/json';" : ''}
            const res = await fetch(${JSON.stringify(base + path)}, { method: ${JSON.stringify(method)}, headers: h, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}, credentials: 'omit' });
            const text = await res.text();
            return { status: res.status, text, retry: res.headers.get('retry-after') };
          } catch (e) { return { status: 0, text: String(e && e.message || e) }; }
        })()`);
      } else {
        try {
          const res = await this.ses.fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
          r = { status: res.status, text: await res.text(), retry: res.headers.get('retry-after') };
        } catch (e) { r = { status: 0, text: e.message }; }
      }
      if (r.status >= 200 && r.status < 300) { try { return r.text ? JSON.parse(r.text) : {}; } catch { throw new Error('Suno 回應格式不正確'); } }
      if (r.status === 429 || r.status >= 500 || r.status === 0) { await sleep(Math.min(15000, (Number(r.retry) || 0) * 1000 || 1500 * (attempt + 1) ** 2)); continue; }
      if (r.status === 401 || r.status === 403) { this.lastToken = ''; if (attempt < 1) { await sleep(800); continue; } throw new Error('Suno 登入已過期，請到「Suno 網頁」重新登入'); }
      if (r.status === 404) { const e = new Error('Suno 找不到這筆資料'); e.code = 404; throw e; }
      throw new Error(`Suno 回應錯誤（${r.status}）${String(r.text || '').slice(0, 120)}`);
    }
    throw new Error('Suno 目前太忙或連不上，請稍後再試');
  }

  // 整個歌曲庫（排除垃圾桶）；liked=true 只取按讚的
  async listAll({ liked = false, max = 5000, onPage } = {}) {
    const all = new Map();
    let cursor = null;
    for (let page = 0; page < 200; page++) {
      const filters = { trashed: 'False' };
      if (liked) filters.liked = 'True';
      const body = { limit: 50, filters };
      if (cursor) body.cursor = cursor;
      const r = await this.api('POST', '/api/feed/v3', body);
      const clips = (r.clips || []).map(toClip).filter(downloadable);
      for (const c of clips) all.set(c.id, c);
      if (onPage) onPage(all.size, clips);
      cursor = r.next_cursor || null;
      if (!r.has_more || !cursor || all.size >= max) break;
      await sleep(250);
    }
    return [...all.values()];
  }

  async byIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const q = ids.slice(i, i + 20).map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const r = await this.api('GET', `/api/clips/get_songs_by_ids?${q}`);
      out.push(...[...harvest(r).values()]);
      if (i + 20 < ids.length) await sleep(250);
    }
    return out;
  }

  async clip(id) { return toClip(await this.api('GET', `/api/clip/${id}`)); }

  async aligned(id) {
    try { return await this.api('GET', `/api/gen/${id}/aligned_lyrics/v2/`); } catch (e) { if (e.code === 404) return null; throw e; }
  }

  // 方案的下載次數：每期上限 − 已用 ＋ 加購剩下的
  async quota() {
    const b = await this.api('GET', '/api/billing/info/', null, { base: SITE_API });
    const u = (b && b.download_usage) || {};
    const limit = Number(u.current_period_downloads_limit) || 0, used = Number(u.current_period_downloads_used) || 0, extra = Number(u.additional_download_remaining) || 0;
    return { plan: (b.plan && b.plan.name) || '', limit, used, extra, remaining: Math.max(0, limit - used) + extra, renews: b.renews_on || b.period_end || '' };
  }

  // 官方下載（和網站上「下載 → MP3／WAV」一樣）：還沒解鎖的歌會用掉 1 次下載次數，之後隨時可再下載
  // 回傳有時效的簽章網址；Suno 準備檔案時會先回 status 不是 ready，要等一下再問
  async downloadUrl(id, format = 'mp3', signal) {
    for (let i = 0; i < 90; i++) {
      if (signal && signal.aborted) throw new Error('已取消');
      const r = await this.api('GET', `/api/download/clip/${id}?format=${format}`, null, { base: SITE_API });
      if (r && r.download_url && (!r.status || r.status === 'ready')) return r.download_url;
      if (r && (r.ok === false || r.status === 'error' || r.status === 'failed')) throw new Error(r.detail || r.message || 'Suno 無法提供這首歌的下載');
      await sleep(Math.min(5000, 1500 + i * 300));
    }
    throw new Error('Suno 準備檔案逾時');
  }

  // 抓取目前網頁上的歌：自動往下捲，收集所有 /song/ 連結
  async scanPage(onProgress) {
    if (!this.wc || !this.onSuno()) throw new Error('請先在「Suno 網頁」打開工作區、播放清單或歌曲頁');
    const ids = await this.run(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const found = new Set();
      const m0 = location.pathname.match(/\\/(?:song|edit)\\/([0-9a-f-]{36})/i);
      if (m0) found.add(m0[1]);
      const collect = () => { for (const a of document.querySelectorAll('a[href*="/song/"]')) { const id = (a.getAttribute('href').split('/song/')[1] || '').split(/[?#/]/)[0]; if (/^[0-9a-f-]{36}$/i.test(id)) found.add(id); } };
      const box = (() => { let el = document.querySelector('a[href*="/song/"]'); el = el && el.parentElement; while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el; el = el.parentElement; } return document.scrollingElement; })();
      collect();
      let stable = 0, last = found.size, lastPos = -1;
      for (let i = 0; i < 300 && stable < 5; i++) {
        box.scrollTop += 600; await sleep(450); collect();
        const atEnd = box.scrollTop === lastPos; lastPos = box.scrollTop;
        stable = found.size === last && atEnd ? stable + 1 : 0; last = found.size;
      }
      box.scrollTop = 0;
      return [...found];
    })()`);
    if (onProgress) onProgress(ids.length);
    if (!ids.length) return [];
    return (await this.byIds(ids)).filter(downloadable);
  }
}

module.exports = { Suno, toClip, harvest, downloadable, jwtExp, HOME, API, SITE_API };
