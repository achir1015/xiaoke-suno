// 「Suno 網頁」分頁：工具列＋內建的 Suno 網站（原生視窗蓋在 #sunoHost 上）
import { h, fill, $ } from './util.js';
import { toast, confirmBox, modal } from './ui.js';
import { xk, cleanErr } from './platform.js';
import { S } from './state.js';
import { scanPage, enqueue, loadSongs, refreshQuota } from './library.js';
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
      h('button', { class: 'btn small primary', id: 'snChrome', title: 'Google 帳號不能在這裡登入時用：開 Chrome 登入後把登入狀態帶進來', onclick: () => chromeLogin() }, '🔑 用 Chrome 登入'),
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
  $('#snChrome').hidden = !!s.loggedIn;
  if (s.loggedIn && !S.quota) refreshQuota();
  // Google 擋下內建網頁的登入：直接帶使用者改用 Chrome 登入
  if (/accounts\.google\.com\/.*(rejected|disallowed)/.test(s.url || '') && !chromeBusy && rejectedShown !== s.url) { rejectedShown = s.url; chromeLogin(true); }
  const tip = $('#snTip');
  if (s.error) tip.textContent = `⚠️ ${s.error}，請按 ⟳ 重新整理或檢查網路。`;
  else if (s.loggedIn) tip.textContent = '✅ 已登入。打開工作區或播放清單再按「抓取這一頁的歌曲」，或回到歌曲庫按「讀取我的全部歌曲」。網頁上 Suno 自己的下載鈕也會存到下載資料夾。';
  else tip.textContent = '🔑 請在上面登入您的 Suno 帳號（帳號密碼直接交給 Suno，小柯不會看到）。用 Google 帳號登入的話，請按右上角「用 Chrome 登入」。';
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

// ---------------- 用 Chrome 登入 ----------------
let chromeBusy = false, rejectedShown = '';
export async function chromeLogin(fromGoogle) {
  if (chromeBusy) return;
  const info = await xk.suno.chromeInfo();
  if (!info.name) { toast('找不到 Chrome 或 Edge。請先安裝 Google Chrome，或在 Suno 用其他方式（電子郵件、Discord…）登入', { type: 'error', ms: 8000 }); return; }
  chromeBusy = true;
  const msg = h('p', { class: 'hint', id: 'chMsg' }, `⏳ 正在打開 ${info.name}…`);
  const done = h('button', { class: 'btn primary', id: 'chDone', onclick: () => { done.disabled = true; msg.textContent = `⏳ 正在關閉 ${info.name} 並帶入登入資料…`; xk.suno.chromeDone(); } }, '✅ 我登入好了');
  const m = modal({ title: '🔑 用 Chrome 登入 Suno', noClose: true, body: h('div', { class: 'chrome-login' },
    fromGoogle && h('div', { class: 'note' }, 'Google 不允許在 App 內建的網頁登入，所以改用真正的 Chrome 登入，一樣安全。'),
    h('ol', {},
      h('li', {}, `小柯打開了一個新的 ${info.name} 視窗（和您平常的 ${info.name} 分開）。`),
      h('li', {}, '在那個視窗登入 Suno（用 Google 登入沒問題），看到自己的歌曲就好了。'),
      h('li', {}, info.mac ? `按下面的「我登入好了」，或在 ${info.name} 按 ⌘Q 結束它（Mac 只關視窗不會結束），小柯會自動把登入狀態帶進來。` : `關掉那個 ${info.name} 視窗，或按下面的「我登入好了」，小柯會自動把登入狀態帶進來。`)),
    h('p', { class: 'muted' }, '帳號密碼是直接交給 Google 和 Suno，小柯只會帶入 Suno 的登入狀態。'),
    msg),
    buttons: [{ label: '取消', onClick: (close) => { xk.suno.chromeDone(); cancelled = true; close(); } }] });
  let cancelled = false;
  m.card.querySelector('.modal-foot').append(done);
  setTimeout(() => { if (!done.disabled) msg.textContent = `👉 請到 ${info.name} 視窗登入 Suno`; }, 1500);
  try {
    const r = await xk.suno.chromeLogin();
    if (cancelled) return;
    if (r.ok) {
      m.close();
      const u = r.user || {};
      toast(`✅ 已登入 Suno：${u.username || u.name || u.email || ''}`);
    } else { msg.textContent = `❌ ${r.error}`; done.disabled = true; m.card.querySelector('.modal-foot .btn').textContent = '關閉'; }
  } catch (e) {
    if (!cancelled) { msg.textContent = `❌ ${cleanErr(e)}`; m.card.querySelector('.modal-foot .btn').textContent = '關閉'; }
  } finally { chromeBusy = false; syncSunoView(); }
}
