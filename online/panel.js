// 小柯機器人SUNO工具 — 線上版（書籤小工具）
// 在 suno.com 點書籤時載入：在 Suno 自己的網頁裡讀取歌曲、官方下載 MP3、產生 SRT，檔名同 Suno 歌名，存到瀏覽器的「下載」資料夾。
// 登入用的是這個瀏覽器原本的 Suno 登入（__session），帳號密碼不經過小柯；SRT 轉換與檔名規則和桌面版同一份程式（srt.js、naming.js）。
(async () => {
  'use strict';
  const BASE = (document.currentScript && document.currentScript.src.replace(/[^/]*$/, '')) || 'https://achir1015.github.io/xiaoke-suno/online/';
  const VERSION = '1.0.8';
  if (window.__xksPanel) { window.__xksPanel.show(); return; }
  if (!/(^|\.)suno\.com$/.test(location.hostname) && !window.__xksTest) { alert('請先打開 suno.com 並登入，再點一次「小柯SUNO」書籤。'); return; }

  const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = BASE + src + '?v=' + VERSION; s.onload = res; s.onerror = () => rej(new Error('載入失敗：' + src)); document.head.append(s); });
  if (!window.XkSrt) await load('srt.js');
  if (!window.XkNaming) await load('naming.js');
  const SRT = window.XkSrt, NAMING = window.XkNaming;
  const SITE = (window.__xksTest && window.__xksTest.site) || location.origin + '/a';
  const API = (window.__xksTest && window.__xksTest.api) || 'https://studio-api-prod.suno.com';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const KEY = 'xks.online';
  const pref = (() => { try { return { formats: ['mp3', 'srt'], offset: -0.1, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { formats: ['mp3', 'srt'], offset: -0.1 }; } })();
  const savePref = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch {} };

  // ---------------- Suno 連線（同一個網站，用 Suno 自己的登入） ----------------
  const token = () => (document.cookie.split('; ').find((c) => c.startsWith('__session=')) || '').slice(10);
  async function api(method, url, body) {
    for (let i = 0; i < 4; i++) {
      const t = token();
      if (!t) throw new Error('還沒有登入 Suno：請先在這個網頁登入');
      const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'include' });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1) ** 2); continue; }
      if (r.status === 401 && i < 2) { await sleep(1500); continue; }   // Suno 每分鐘換一次登入權杖
      if (r.status === 404) { const e = new Error('Suno 找不到這筆資料'); e.code = 404; throw e; }
      throw new Error('Suno 回應錯誤（' + r.status + '）');
    }
    throw new Error('Suno 目前太忙，請稍後再試');
  }
  // 先用網站自己的 /a/api（同一個網站、不會被擋），找不到或連不上再改用 studio-api
  async function apiAny(path) {
    try { return await api('GET', SITE + path); } catch (e) { if (e.code !== 404 && !(e instanceof TypeError)) throw e; }
    return api('GET', API + path);
  }
  function toClip(raw) {
    const c = raw && raw.clip && typeof raw.clip === 'object' ? raw.clip : raw;
    if (!c || typeof c.id !== 'string' || !UUID.test(c.id) || (!('audio_url' in c) && !('metadata' in c))) return null;
    const md = c.metadata || {};
    const cdn = (u) => String(u || '').replace('cdn2.suno.ai', 'cdn1.suno.ai');
    return { id: c.id, title: (typeof c.title === 'string' && c.title.trim()) || 'Untitled', image: cdn(c.image_large_url || c.image_url), thumb: cdn(c.image_url || c.image_large_url),
      duration: Number(md.duration) || 0, tags: String(md.tags || ''), lyrics: String(c.lyrics || md.prompt || ''), created: String(c.created_at || ''), status: String(c.status || 'complete'),
      type: String(md.type || ''), task: String(md.task || ''), artist: String(c.display_name || ''), instrumental: md.make_instrumental === true || md.has_vocal === false, unlocked: c.is_download_unlocked === true };
  }
  const okClip = (c) => c && c.status === 'complete' && c.type !== 'rendered_context_window' && !['infill', 'fixed_infill'].includes(c.task);
  function harvest(j, out = new Map(), d = 0) {
    if (!j || typeof j !== 'object' || d > 7) return out;
    if (Array.isArray(j)) { j.forEach((x) => harvest(x, out, d + 1)); return out; }
    const c = toClip(j);
    if (c) out.set(c.id, c);
    for (const k of Object.keys(j)) if (j[k] && typeof j[k] === 'object') harvest(j[k], out, d + 1);
    return out;
  }
  async function listAll(onPage) {
    const all = new Map();
    let cursor = null;
    for (let p = 0; p < 200; p++) {
      const body = { limit: 50, filters: { trashed: 'False' } };
      if (cursor) body.cursor = cursor;
      const r = await api('POST', SITE + '/api/feed/v3', body);
      for (const c of (r.clips || []).map(toClip).filter(okClip)) all.set(c.id, c);
      onPage(all.size);
      cursor = r.next_cursor || null;
      if (!r.has_more || !cursor) break;
      await sleep(250);
    }
    return [...all.values()];
  }
  async function scanPage() {
    const found = new Set();
    const m0 = location.pathname.match(/\/(?:song|edit)\/([0-9a-f-]{36})/i);
    if (m0) found.add(m0[1]);
    const collect = () => { for (const a of document.querySelectorAll('a[href*="/song/"]')) { const id = (a.getAttribute('href').split('/song/')[1] || '').split(/[?#/]/)[0]; if (UUID.test(id)) found.add(id); } };
    const box = (() => { let el = document.querySelector('a[href*="/song/"]'); el = el && el.parentElement; while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el; el = el.parentElement; } return document.scrollingElement; })();
    collect();
    let stable = 0, last = found.size, pos = -1;
    for (let i = 0; i < 300 && stable < 5; i++) { box.scrollTop += 600; await sleep(450); collect(); const end = box.scrollTop === pos; pos = box.scrollTop; stable = found.size === last && end ? stable + 1 : 0; last = found.size; }
    box.scrollTop = 0;
    const ids = [...found], out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const q = ids.slice(i, i + 20).map((id) => 'ids=' + encodeURIComponent(id)).join('&');
      out.push(...harvest(await apiAny('/api/clips/get_songs_by_ids?' + q)).values());
    }
    return out.filter(okClip);
  }
  async function quota() {
    const b = await api('GET', SITE + '/api/billing/info/');
    const u = (b && b.download_usage) || {};
    const limit = +u.current_period_downloads_limit || 0, used = +u.current_period_downloads_used || 0, extra = +u.additional_download_remaining || 0;
    return { plan: (b.plan && b.plan.name) || '', limit, used, extra, remaining: Math.max(0, limit - used) + extra, renews: b.renews_on || '' };
  }
  // 官方下載（和網站的「下載 → MP3」一樣）：還沒解鎖的歌會用掉 1 次下載次數
  async function downloadUrl(id, fmt) {
    for (let i = 0; i < 90; i++) {
      if (stopFlag) throw new Error('已取消');
      const r = await api('GET', SITE + '/api/download/clip/' + id + '?format=' + fmt);
      if (r && r.download_url && (!r.status || r.status === 'ready')) return r.download_url;
      if (r && (r.ok === false || r.status === 'error' || r.status === 'failed')) throw new Error(r.detail || 'Suno 無法提供這首歌的下載');
      await sleep(Math.min(5000, 1500 + i * 300));
    }
    throw new Error('Suno 準備檔案逾時');
  }
  const aligned = async (id) => { try { return await apiAny('/api/gen/' + id + '/aligned_lyrics/v2/'); } catch (e) { if (e.code === 404) return null; throw e; } };

  // 存到瀏覽器的「下載」資料夾（檔名同 Suno 歌名）
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function saveUrl(url, name) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('下載失敗（' + r.status + '）');
    const b = await r.blob();
    if (b.size < 1000) throw new Error('檔案內容不完整');
    saveBlob(b, name);
  }

  // ---------------- 面板（Shadow DOM，不受 Suno 網頁樣式影響） ----------------
  const host = document.createElement('div');
  host.id = 'xks-panel';
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:"Microsoft JhengHei UI","PingFang TC","Noto Sans TC",system-ui,sans-serif}
    .p{width:min(440px,calc(100vw - 24px));max-height:calc(100vh - 24px);display:flex;flex-direction:column;background:#15151d;color:#ececf3;border:1px solid #3a3a4c;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.55);font-size:14px;overflow:hidden}
    .h{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(90deg,#3b1d2e,#15151d)}
    .h img{width:30px;height:30px;border-radius:8px}.h b{flex:1;font-size:15px}
    button{font:inherit;color:inherit;cursor:pointer;border:1px solid #3a3a4c;background:#262633;border-radius:8px;padding:6px 10px}
    button:hover{border-color:#a9a9bb}button:disabled{opacity:.5;cursor:default}
    .pri{background:linear-gradient(135deg,#f97316,#db2777);border-color:transparent;color:#fff;font-weight:700}
    .x{border:0;background:transparent;font-size:16px;padding:4px 8px}
    .b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .st{color:#a9a9bb;font-size:12.5px}.ok{color:#4ade80}.warn{color:#fbbf24}.err{color:#f87171}
    input[type=search],select{background:#0d0d12;border:1px solid #3a3a4c;border-radius:8px;padding:6px 8px;color:inherit;font:inherit}
    input[type=search]{flex:1;min-width:120px}
    .chip{border-radius:999px;padding:3px 10px;font-size:12.5px;background:#0d0d12}.chip.on{background:rgba(249,115,22,.22);border-color:#f97316;font-weight:700}
    .list{border:1px solid #2c2c3a;border-radius:10px;max-height:300px;overflow:auto}
    .s{display:flex;gap:8px;align-items:center;padding:5px 8px;border-bottom:1px solid #22222d;cursor:pointer}.s:last-child{border-bottom:0}
    .s img{width:34px;height:34px;border-radius:6px;object-fit:cover;flex:none;background:#333}
    .s .t{flex:1;min-width:0}.s .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.s .t small{color:#75758a}
    .tag{font-size:11px;padding:0 6px;border-radius:999px;background:rgba(34,197,94,.22);margin-left:4px}
    .dlg{background:#1d1d28;border:1px solid #f97316;border-radius:12px;padding:10px 12px;line-height:1.65}
    .bar{height:6px;background:#262633;border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#f97316,#ec4899)}
    .log{font-size:12.5px;max-height:120px;overflow:auto;color:#a9a9bb}
    .f{font-size:11.5px;color:#75758a;text-align:center;padding:6px}
  </style>
  <div class="p">
    <div class="h"><img src="${BASE}icon.png" alt=""><b>小柯SUNO 批量下載</b><button class="x" id="min" title="收起">—</button><button class="x" id="close" title="關閉">✕</button></div>
    <div class="b" id="body">
      <div class="st" id="who">檢查登入中…</div>
      <div class="row"><button class="pri" id="all">☁️ 讀取我的全部歌曲</button><button id="scan">📥 抓取這一頁</button></div>
      <div class="row"><input type="search" id="q" placeholder="🔍 搜尋歌名、風格、歌詞"><label class="st"><input type="checkbox" id="selAll"> 全選</label></div>
      <div class="list" id="list"><div class="st" style="padding:10px">按上面的按鈕讀取歌曲；在工作區或播放清單頁按「抓取這一頁」只抓那一頁。</div></div>
      <div class="row" id="fmts"></div>
      <div class="row"><select id="off"></select><span class="st" id="quota"></span></div>
      <div id="ask"></div>
      <button class="pri" id="go">⬇️ 下載所選</button>
      <div class="bar"><i id="pb"></i></div>
      <div class="log" id="log"></div>
      <div class="f">小柯機器人SUNO工具 線上版 v${VERSION}・系統開發：吳玉柱 先生 與 Claude AI Opus 5.5</div>
    </div>
  </div>`;
  const $ = (id) => root.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const log = (t, cls = '') => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; $('log').prepend(d); };
  let songs = [], picked = new Set(), stopFlag = false, busy = false, Q = null;
  window.__xksPanel = { show: () => { host.style.display = ''; }, songs: () => songs };
  $('close').onclick = () => { stopFlag = true; host.remove(); delete window.__xksPanel; };
  $('min').onclick = () => { const b = $('body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };

  const FMTS = [['mp3', '🎵 MP3'], ['srt', '💬 SRT'], ['lrc', '🎤 LRC'], ['txt', '📄 歌詞'], ['jpg', '🖼️ 封面'], ['wav', '💎 WAV']];
  for (const [f, t] of FMTS) {
    const b = document.createElement('button');
    b.className = 'chip' + (pref.formats.includes(f) ? ' on' : '');
    b.textContent = t;
    b.dataset.f = f;
    b.onclick = () => { const s = new Set(pref.formats); s.has(f) ? s.delete(f) : s.add(f); pref.formats = FMTS.map((x) => x[0]).filter((x) => s.has(x)); b.classList.toggle('on', s.has(f)); savePref(); };
    $('fmts').append(b);
  }
  for (const o of SRT.START_OFFSETS) { const op = document.createElement('option'); op.value = o; op.textContent = '字幕提早 ' + Math.abs(o).toFixed(1) + ' 秒'; if (Math.abs(o - pref.offset) < 1e-4) op.selected = true; $('off').append(op); }
  $('off').onchange = () => { pref.offset = Number($('off').value); savePref(); };

  const dur = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '');
  function shown() { const q = $('q').value.trim().toLowerCase(); return songs.filter((s) => !q || (s.title + '\n' + s.tags + '\n' + s.lyrics).toLowerCase().includes(q)); }
  function render() {
    const list = shown();
    $('list').innerHTML = list.length ? list.map((s) => `<label class="s"><input type="checkbox" data-id="${s.id}" ${picked.has(s.id) ? 'checked' : ''}>${s.thumb ? `<img src="${esc(s.thumb)}" loading="lazy" alt="">` : ''}<div class="t"><div>${esc(s.title)}${s.unlocked ? '<span class="tag" title="已解鎖，下載 MP3 不扣次數">🔓</span>' : ''}</div><small>${esc(dur(s.duration))} ${esc(s.tags.slice(0, 40))}</small></div></label>`).join('') : '<div class="st" style="padding:10px">沒有符合的歌曲</div>';
    $('selAll').checked = list.length > 0 && list.every((s) => picked.has(s.id));
    $('go').textContent = picked.size ? `⬇️ 下載所選 ${picked.size} 首` : '⬇️ 下載所選';
  }
  $('list').onchange = (e) => { const id = e.target.dataset && e.target.dataset.id; if (!id) return; e.target.checked ? picked.add(id) : picked.delete(id); render(); };
  $('q').oninput = render;
  $('selAll').onchange = () => { for (const s of shown()) $('selAll').checked ? picked.add(s.id) : picked.delete(s.id); render(); };

  async function refreshQuota() {
    try { Q = await quota(); $('quota').innerHTML = `🎫 下載次數剩 <b>${Q.remaining}</b>`; $('quota').className = Q.remaining < 5 ? 'st warn' : 'st'; } catch { Q = null; $('quota').textContent = ''; }
  }
  function setBusy(v) { busy = v; for (const id of ['all', 'scan', 'go']) $(id).disabled = v; }
  function merge(list) { const m = new Map(songs.map((s) => [s.id, s])); for (const c of list) m.set(c.id, { ...m.get(c.id), ...c }); songs = [...m.values()].sort((a, b) => String(b.created).localeCompare(String(a.created))); }

  $('all').onclick = async () => {
    setBusy(true);
    try { const list = await listAll((n) => { $('all').textContent = '⏳ 已讀取 ' + n + ' 首…'; }); merge(list); log('✅ 讀取完成：' + list.length + ' 首', 'ok'); render(); refreshQuota(); }
    catch (e) { log('❌ ' + e.message, 'err'); } finally { $('all').textContent = '☁️ 讀取我的全部歌曲'; setBusy(false); }
  };
  $('scan').onclick = async () => {
    setBusy(true);
    $('scan').textContent = '⏳ 抓取中…';
    try { const list = await scanPage(); merge(list); list.forEach((s) => picked.add(s.id)); log('✅ 這一頁抓到 ' + list.length + ' 首，已勾選', 'ok'); render(); refreshQuota(); }
    catch (e) { log('❌ ' + e.message, 'err'); } finally { $('scan').textContent = '📥 抓取這一頁'; setBusy(false); }
  };

  // 有歌還沒解鎖：先問要不要用下載次數
  function ask(lockedN) {
    return new Promise((resolve) => {
      const can = Q ? Math.min(Q.remaining, lockedN) : 0;
      const box = $('ask');
      box.innerHTML = `<div class="dlg"><b>🎫 會用到 Suno 下載次數</b><br>其中 <b>${lockedN}</b> 首還沒在 Suno 解鎖：下載 MP3／WAV 每首用 1 次，解鎖過的以後再下載不扣。SRT、LRC、歌詞、封面不受影響。<br>${Q ? `目前剩 <b>${Q.remaining}</b> 次（${esc(Q.plan)}：本期 ${Q.used}／${Q.limit}${Q.extra ? `，加購剩 ${Q.extra}` : ''}）` : '<span class="warn">讀不到剩餘次數</span>'}${Q && Q.remaining < lockedN ? `<br><span class="warn">次數不夠：只能解鎖前 ${can} 首。</span>` : ''}
        <div class="row" style="margin-top:8px"><button id="a0">取消</button><button id="a1">只下載已解鎖的（不扣次數）</button>${can > 0 ? `<button class="pri" id="a2">解鎖並下載（用 ${can} 次）</button>` : ''}</div></div>`;
      const done = (v) => { box.innerHTML = ''; resolve(v); };
      $('a0').onclick = () => done(null);
      $('a1').onclick = () => done(0);
      if ($('a2')) $('a2').onclick = () => done(can);
    });
  }

  $('go').onclick = async () => {
    const list = songs.filter((s) => picked.has(s.id));
    if (!list.length) { log('請先勾選要下載的歌', 'warn'); return; }
    if (!pref.formats.length) { log('請至少選一種格式', 'warn'); return; }
    const audio = pref.formats.includes('mp3') || pref.formats.includes('wav');
    const locked = audio ? list.filter((s) => !s.unlocked) : [];
    let allow = new Set();
    if (locked.length) {
      await refreshQuota();
      const n = await ask(locked.length);
      if (n === null) return;
      allow = new Set(locked.slice(0, n).map((s) => s.id));
    }
    setBusy(true);
    stopFlag = false;
    // 檔名：同名的歌第二首起加 (1)、(2)…，同一首的 MP3 與 SRT 一定同名
    const used = new Set();
    let done = 0, bad = 0;
    for (const s of list) {
      if (stopFlag) break;
      const base = NAMING.pickBase(s, 'number', (b) => used.has(b.toLowerCase()));
      used.add(base.toLowerCase());
      let al;
      for (const f of pref.formats) {
        const name = base + '.' + f;
        try {
          if (f === 'mp3' || f === 'wav') {
            if (!s.unlocked && !allow.has(s.id)) throw new Error('還沒解鎖，已略過（不扣次數）');
            const u = await downloadUrl(s.id, f);
            s.unlocked = true;
            await saveUrl(u, name);
          } else if (f === 'jpg') { if (!s.image) throw new Error('沒有封面'); await saveUrl(s.image, name); }
          else if (f === 'txt') { if (!s.lyrics.trim()) throw new Error('沒有歌詞'); saveBlob(new Blob(['﻿' + s.lyrics.replace(/\r?\n/g, '\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' }), name); }
          else {
            if (al === undefined) al = await aligned(s.id);
            const r = SRT.convert(al || {}, { startOffset: pref.offset, duration: s.duration, title: s.title, artist: s.artist });
            if (!r.lines.length) throw new Error(s.instrumental ? '純音樂，沒有歌詞' : 'Suno 沒有提供對時歌詞');
            saveBlob(new Blob(['﻿' + (f === 'srt' ? r.srt : r.lrc)], { type: 'text/plain;charset=utf-8' }), name);
          }
          log('✔ ' + name);
        } catch (e) { bad++; log('⚠️ ' + name + '：' + e.message, 'warn'); }
        await sleep(400);   // 瀏覽器連續下載太快會擋
      }
      done++;
      $('pb').style.width = (done / list.length) * 100 + '%';
    }
    log(`🎉 完成 ${done} 首${bad ? `（${bad} 個檔案沒有下載，原因在上面）` : ''}，檔案在瀏覽器的「下載」資料夾`, 'ok');
    render();
    refreshQuota();
    setBusy(false);
  };

  // 登入狀態
  if (token()) { $('who').innerHTML = '<span class="ok">✅ 已登入 Suno</span>（用這個瀏覽器原本的登入）'; refreshQuota(); }
  else $('who').innerHTML = '<span class="warn">🔑 還沒有登入 Suno：請先在這個網頁登入，再按讀取</span>';
})();
