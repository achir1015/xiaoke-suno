// 「Suno 網頁」分頁：工具列＋內建的 Suno 網站（原生視窗蓋在 #sunoHost 上）
import { h, fill, $ } from './util.js';
import { toast, confirmBox } from './ui.js';
import { xk } from './platform.js';
import { S } from './state.js';
import { scanPage, enqueue, loadSongs } from './library.js';
import { syncSunoView } from './app.js';

const LINKS = [
  ['🏠', '首頁', 'https://suno.com/'],
  ['🎼', '我的歌曲庫', 'https://suno.com/me'],
  ['✨', '建立／工作區', 'https://suno.com/create'],
];

export function renderSuno(host) {
  const nav = (a) => () => xk.suno.nav(a);
  fill(host,
    h('div', { class: 'suno-bar' },
      h('button', { class: 'icon-btn', id: 'snBack', title: '上一頁', onclick: nav('back') }, '◀'),
      h('button', { class: 'icon-btn', id: 'snFwd', title: '下一頁', onclick: nav('forward') }, '▶'),
      h('button', { class: 'icon-btn', title: '重新整理', onclick: nav('reload') }, '⟳'),
      LINKS.map(([ic, t, u]) => h('button', { class: 'btn small ghost', onclick: () => xk.suno.nav('url', u) }, ic, ' ', t)),
      h('span', { class: 'url', id: 'snUrl' }),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn small', id: 'snSong', hidden: true, onclick: downloadThis }, '⬇️ 下載這首'),
      h('button', { class: 'btn small primary', id: 'snScan', onclick: () => scanPage() }, '📥 抓取這一頁的歌曲'),
      h('button', { class: 'btn small ghost', id: 'snLogout', hidden: true, title: '登出 Suno（清除內建網頁的登入資料）', onclick: logout }, '登出')),
    h('div', { class: 'suno-host', id: 'sunoHost' }, h('div', { class: 'suno-ph' }, h('img', { src: 'img/robot96.png', alt: '', width: 72, height: 72 }), h('p', {}, 'Suno 網頁載入中…'))),
    h('div', { class: 'suno-tip', id: 'snTip' }, '🔑 請在上面登入您的 Suno 帳號。登入後，您在這裡瀏覽到的歌（工作區、播放清單）都會自動加入歌曲庫。'));
  new ResizeObserver(() => layoutSuno()).observe($('#sunoHost'));
}

export function layoutSuno() {
  const el = $('#sunoHost');
  if (!el || S.view !== 'suno') return;
  const r = el.getBoundingClientRect();
  xk.suno.bounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}

const songId = (url) => (/\/(?:song|edit)\/([0-9a-f-]{36})/i.exec(url || '') || [])[1];

export function sunoStateChanged() {
  const s = S.suno;
  const u = $('#snUrl');
  if (!u) return;
  u.textContent = s.url ? decodeURI(s.url).replace(/^https?:\/\//, '') : '';
  $('#snBack').disabled = !s.canBack;
  $('#snFwd').disabled = !s.canForward;
  $('#snSong').hidden = !songId(s.url);
  $('#snLogout').hidden = !s.loggedIn;
  const tip = $('#snTip');
  if (s.error) tip.textContent = `⚠️ ${s.error}，請按 ⟳ 重新整理或檢查網路。`;
  else if (s.loggedIn) tip.textContent = '✅ 已登入。打開工作區或播放清單再按「抓取這一頁的歌曲」，或回到歌曲庫按「讀取我的全部歌曲」。網頁上 Suno 自己的下載鈕也會存到下載資料夾。';
  else tip.textContent = '🔑 請在上面登入您的 Suno 帳號（帳號密碼直接交給 Suno，小柯不會看到）。登入後，您在這裡瀏覽到的歌都會自動加入歌曲庫。';
}

async function downloadThis() {
  const id = songId(S.suno.url);
  if (!id) return;
  if (!S.songs.find((x) => x.id === id)) {
    const r = await scanPage();
    if (!r || !r.ids.includes(id)) return;
    await loadSongs();
  }
  enqueue([id]);
}

async function logout() {
  if (!(await confirmBox('要登出 Suno 嗎？內建網頁的登入資料會被清除，歌曲庫與已下載的檔案不受影響。', { ok: '登出' }))) return;
  await xk.suno.logout();
  toast('已登出 Suno');
  syncSunoView();
}
