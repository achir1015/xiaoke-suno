// 主畫面：上方列、左側選單、三個分頁（歌曲庫、Suno 網頁、下載佇列）與各種事件
import { h, fill, $, $$, debounce } from './util.js';
import { toast } from './ui.js';
import { xk } from './platform.js';
import { S } from './state.js';
import { voice } from './voice.js';
import { renderLibrary, loadSongs, renderMarksNav } from './library.js';
import { renderSuno, layoutSuno, sunoStateChanged } from './sunoview.js';
import { renderQueue } from './queue.js';
import { openSettings, applyTheme, checkUpdateQuiet, openUpdate } from './settings.js';
import { openGuide } from './guide.js';
import { toggleAgent } from './agent-ui.js';

const NAV = [
  ['library', '🎵', '歌曲庫'],
  ['suno', '🌐', 'Suno 網頁'],
  ['queue', '⬇️', '下載佇列'],
];

export function go(view) {
  S.view = view;
  for (const [id] of NAV) {
    $(`#nav-${id}`)?.classList.toggle('on', id === view);
    $(`#v-${id}`).hidden = id !== view;
  }
  if (view === 'library') renderLibrary();
  if (view === 'queue') renderQueue();
  syncSunoView();
}

// Suno 網頁是蓋在畫面上的原生視窗：有對話框、選單或聚光燈時要先藏起來，不然會擋住
export function syncSunoView() {
  const covered = !!document.querySelector('.modal-back, .pop, .spot');
  const show = S.view === 'suno' && !covered;
  if (show) layoutSuno();
  xk.suno.visible(show);
}

function topbar() {
  fill($('#topbar'),
    h('img', { src: 'img/logo64.png', class: 'logo', alt: '', width: 34, height: 34 }),
    h('div', { class: 'brand' }, h('b', {}, '小柯機器人SUNO工具'), h('small', {}, '批量下載 MP3 ＋ SRT 字幕')),
    h('span', { class: 'sp' }),
    h('button', { class: 'pill', id: 'sunoPill', title: 'Suno 登入狀態', onclick: () => go('suno') }, '🔑 尚未登入 Suno'),
    h('button', { class: 'pill', id: 'cloudPill', title: '雲端儲存', onclick: () => openSettings('cloud') }, '☁️ 未連線'),
    h('button', { class: 'tb-btn', id: 'btnGuide', onclick: () => openGuide() }, '📖 使用說明'),
    h('button', { class: 'tb-btn', id: 'btnUpdate', onclick: () => openUpdate() }, '🔄 檢查更新'),
    h('button', { class: 'tb-btn', id: 'btnSettings', onclick: () => openSettings() }, '⚙️ 設定'));
}

function side() {
  fill($('#side'),
    h('div', { class: 'nav' }, NAV.map(([id, ic, t]) => h('button', { class: `nav-item ${S.view === id ? 'on' : ''}`, id: `nav-${id}`, onclick: () => go(id) },
      h('span', { class: 'ni' }, ic), h('span', { class: 'nt' }, t), h('span', { class: 'badge', id: `badge-${id}` })))),
    h('div', { class: 'side-sec' }, h('small', {}, '標記'), h('div', { id: 'markNav' })),
    h('span', { class: 'sp' }),
    h('button', { class: 'agent-btn', id: 'btnAgent', onclick: () => toggleAgent() }, h('img', { src: 'img/robot96.png', alt: '', width: 40, height: 40 }), h('span', {}, h('b', {}, '小柯助手'), h('small', {}, 'AI 幫您找歌、下載、寫歌詞'))));
}

export function updateBadges() {
  const lib = $('#badge-library');
  if (lib) lib.textContent = S.songs.length ? String(S.songs.length) : '';
  const act = S.queue.jobs.filter((j) => j.state === 'run' || j.state === 'wait').length;
  const q = $('#badge-queue');
  if (q) { q.textContent = act ? String(act) : ''; q.classList.toggle('hot', act > 0); }
}

function sunoPill() {
  const p = $('#sunoPill');
  if (!p) return;
  const s = S.suno;
  const u = s.user || {};
  p.textContent = s.loggedIn ? `👤 ${u.username || u.name || u.email || '已登入 Suno'}` : (s.checking ? '⏳ 連線 Suno…' : '🔑 尚未登入 Suno');
  p.classList.toggle('ok', !!s.loggedIn);
  p.classList.toggle('warn', !s.loggedIn && !s.checking);
}

export function cloudPill() {
  const p = $('#cloudPill');
  if (!p) return;
  const c = S.cloud;
  if (!S.settings.cloud.hasToken) { p.textContent = '☁️ 雲端未設定'; p.className = 'pill'; return; }
  p.textContent = c.status === 'busy' ? '☁️ 同步中…' : c.status === 'error' ? '☁️ 同步失敗' : '☁️ 已同步';
  p.className = `pill ${c.status === 'error' ? 'warn' : 'ok'}`;
  p.title = c.error || (c.at ? `上次同步 ${new Date(c.at).toLocaleTimeString('zh-TW')}` : '雲端儲存');
}

async function init() {
  S.settings = await xk.settings.get();
  S.sysInfo = await xk.sys.info();
  applyTheme();
  voice.configure(S.settings.voice);
  topbar();
  side();
  renderSuno($('#v-suno'));
  renderMarksNav();
  await loadSongs();
  S.queue = await xk.dl.state();
  go('library');
  updateBadges();

  xk.suno.onState((s) => { S.suno = s; sunoPill(); sunoStateChanged(); });
  xk.suno.state().then((s) => { S.suno = s; sunoPill(); sunoStateChanged(); }).catch(() => {});
  xk.lib.onChanged(async (d) => {
    await loadSongs();
    if (d.added) toast(`🎵 新增 ${d.added} 首歌到歌曲庫`);
  });
  // 有歌下載結束：重新讀取歌曲庫的檔案狀態（不管現在在哪個分頁）
  let ended = '';
  const reload = debounce(() => loadSongs(), 400);
  xk.dl.onUpdate((snap) => {
    S.queue = snap;
    updateBadges();
    const e = snap.jobs.filter((j) => j.state !== 'run' && j.state !== 'wait').map((j) => j.key + j.state).join(',');
    if (e !== ended) { ended = e; reload(); }
    if (S.view === 'queue') renderQueue(); else if (S.view === 'library') renderLibrary(true);
  });
  xk.cloud.onState(async (c) => { S.cloud = c; if (!S.settings.cloud.hasToken && c.status !== 'off') S.settings = await xk.settings.get(); cloudPill(); });
  xk.cloud.state().then((c) => { S.cloud = c; cloudPill(); });
  xk.onToast((t) => toast(t.text, { type: t.type || 'info' }));
  xk.onZoom((z) => { S.zoom = z; syncSunoView(); });
  new MutationObserver(() => syncSunoView()).observe(document.body, { childList: true });
  addEventListener('resize', () => syncSunoView());
  // 離開時停止朗讀
  addEventListener('pagehide', () => voice.stop());
  addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); openGuide(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'f' && S.view === 'library') { e.preventDefault(); $('#q')?.focus(); }
  });

  if (!S.settings.welcomed) {
    await xk.settings.set({ welcomed: true });
    S.settings.welcomed = true;
    setTimeout(() => openGuide(0), 600);
  }
  if (S.settings.autoUpdate) setTimeout(checkUpdateQuiet, 4000);
  document.documentElement.dataset.ready = '1';
}

init().catch((e) => { document.body.append(h('pre', { class: 'fatal' }, `啟動失敗：${e.stack || e}`)); });

export { $$ };
