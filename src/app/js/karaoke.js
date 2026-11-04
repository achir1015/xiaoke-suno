// 邊聽邊看字幕：歌曲播放時，SRT 字幕依時間同步亮起（下方播放列＋放大的卡拉 OK 畫面）
// 已下載的歌播放本機 MP3＋本機 SRT，可以直接確認下載的檔案時間對不對
import { h, fill, $ } from './util.js';
import { modal, toast } from './ui.js';
import { xk, cleanErr } from './platform.js';

const audio = new Audio();
audio.preload = 'auto';
const K = { id: '', song: null, lines: [], idx: -1, raf: 0, subs: new Set() };

const mmss = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

export const playingId = () => K.id;
export const isPlaying = () => !!K.id && !audio.paused;

// 目前這一行：已開始、還沒結束的那行；在兩行之間時維持上一行（字幕結束後到下一行前不顯示）
export function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].start <= t) { at = m; lo = m + 1; } else hi = m - 1; }
  return at;
}

// 其他畫面（歌曲詳細資料）也可以跟著同步：fn({ id, t, idx })
export function subscribe(fn) { K.subs.add(fn); return () => K.subs.delete(fn); }

function tick() {
  cancelAnimationFrame(K.raf);
  const t = audio.currentTime;
  const idx = lineAt(K.lines, t);
  const showing = idx >= 0 && t < K.lines[idx].end ? idx : -1;
  if (showing !== K.idx) { K.idx = showing; paintLines(); }
  const seek = $('#kSeek');
  if (seek && !seek.dataset.drag) { seek.max = audio.duration || K.song?.duration || 0; seek.value = t; }
  const tm = $('#kTime');
  if (tm) tm.textContent = `${mmss(t)} / ${mmss(audio.duration)}`;
  for (const fn of K.subs) fn({ id: K.id, t, idx: showing, near: idx });
  if (!audio.paused) K.raf = requestAnimationFrame(tick);
}

function paintLines() {
  const cur = $('#kCur'), prev = $('#kPrev'), next = $('#kNext');
  if (!cur) return;
  const L = K.lines;
  const near = lineAt(L, audio.currentTime);
  if (!L.length) { cur.textContent = K.song?.instrumental ? '♪ 純音樂 ♪' : '（沒有字幕）'; prev.textContent = next.textContent = ''; return; }
  cur.textContent = K.idx >= 0 ? L[K.idx].text : '♪';
  const pi = K.idx >= 0 ? K.idx - 1 : near;
  prev.textContent = pi >= 0 ? L[pi].text : '';
  next.textContent = L[(K.idx >= 0 ? K.idx : near) + 1]?.text || '';
  cur.classList.toggle('on', K.idx >= 0);
  const big = $('#kBigList');
  if (big) {
    big.querySelectorAll('.kl.on').forEach((e) => e.classList.remove('on'));
    const el = K.idx >= 0 && big.children[K.idx];
    if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
}

function bar() {
  const el = $('#player');
  if (!el) return;
  const s = K.song;
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  const seek = h('input', { type: 'range', id: 'kSeek', min: 0, step: 0.01, value: 0, 'aria-label': '播放進度',
    oninput: () => { seek.dataset.drag = '1'; }, onchange: () => { delete seek.dataset.drag; audio.currentTime = Number(seek.value); tick(); } });
  fill(el,
    s.image ? h('img', { class: `k-cover ${audio.paused ? '' : 'spin'}`, src: s.image, alt: '' }) : h('span', { class: 'k-cover ph' }, '🎵'),
    h('div', { class: 'k-main' },
      h('div', { class: 'k-top' }, h('b', {}, s.title), h('span', { class: `k-src ${s.lyricSrc}` }, srcText(s)), h('span', { class: 'sp' }), h('span', { class: 'k-time', id: 'kTime' }, '0:00')),
      h('div', { class: 'k-lines' }, h('div', { class: 'kp', id: 'kPrev' }), h('div', { class: 'kc', id: 'kCur' }, '♪'), h('div', { class: 'kn', id: 'kNext' })),
      seek),
    h('div', { class: 'k-btns' },
      h('button', { class: 'icon-btn', id: 'kPlay', title: '播放／暫停', onclick: () => toggle() }, audio.paused ? '▶' : '⏸'),
      h('button', { class: 'icon-btn', title: '放大字幕（卡拉 OK 畫面）', id: 'kBig', onclick: () => openBig() }, '🎤'),
      h('button', { class: 'icon-btn', title: '停止', onclick: () => stop() }, '⏹')));
  paintLines();
  tick();
}

const srcText = (s) => [s.localAudio ? '本機 MP3' : s.audioSrc === 'video' ? '線上試聽（影片音軌）' : s.audioSrc === 'unlocked' ? 'Suno 官方音檔' : '線上試聽', s.lyricSrc === 'file' ? '已下載的 SRT' : s.lyricSrc === 'suno' ? 'Suno 對時字幕' : ''].filter(Boolean).join('＋');

// 播放並同步字幕；offset 有給時改用即時產生的字幕（詳細資料裡調整「提早秒數」用）
export async function listen(id, { offset, at } = {}) {
  try {
    if (K.id === id && offset == null && at == null) { toggle(); return; }
    const r = await xk.lib.play(id, offset);
    const same = K.id === id && audio.src.endsWith(r.audio.split('/').pop());
    K.id = id; K.song = r; K.lines = r.lines || []; K.idx = -1;
    if (!same) audio.src = r.audio;
    if (at != null) audio.currentTime = at;
    await audio.play();
    if (r.error && !K.lines.length) toast(`字幕讀取失敗：${r.error}`, { type: 'error' });
  } catch (e) { toast(`無法播放：${cleanErr(e)}`, { type: 'error' }); }
  bar();
  notify();
}

export function seekTo(t) { if (!K.id) return; audio.currentTime = Math.max(0, t); if (audio.paused) audio.play(); tick(); }

export function toggle() { if (!K.id) return; if (audio.paused) audio.play(); else audio.pause(); }

export function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  K.id = ''; K.song = null; K.lines = []; K.idx = -1;
  bar();
  notify();
}

const changeFns = new Set();
export function onChange(fn) { changeFns.add(fn); }
function notify() { for (const fn of changeFns) fn(); }

audio.addEventListener('play', () => { $('#kPlay') && ($('#kPlay').textContent = '⏸'); $('.k-cover')?.classList.add('spin'); tick(); notify(); });
audio.addEventListener('pause', () => { $('#kPlay') && ($('#kPlay').textContent = '▶'); $('.k-cover')?.classList.remove('spin'); tick(); notify(); });
audio.addEventListener('ended', () => { K.idx = -1; paintLines(); notify(); });
audio.addEventListener('seeked', () => tick());
addEventListener('pagehide', () => audio.pause());

// 放大的卡拉 OK 畫面：全部歌詞，目前這行亮起並置中；點任何一行跳到那裡
function openBig() {
  if (!K.song) return;
  const s = K.song;
  const list = h('div', { class: 'k-big-list', id: 'kBigList' }, K.lines.length ? K.lines.map((l) => h('button', { class: 'kl', title: `${mmss(l.start)} 開始`, onclick: () => seekTo(l.start) }, h('small', {}, mmss(l.start)), l.text)) : h('p', { class: 'muted' }, s.instrumental ? '♪ 純音樂 ♪' : '這首歌沒有字幕'));
  modal({ title: `🎤 ${s.title}`, wide: true, cls: 'k-big', body: h('div', { class: 'k-big-body', style: s.image ? { '--bgimg': `url("${s.image}")` } : null },
    h('div', { class: 'k-big-side' }, s.image ? h('img', { src: s.image, alt: '' }) : h('div', { class: 'd-cover ph' }, '🎵'), h('p', { class: 'muted' }, srcText(s)),
      h('div', { class: 'row-gap' }, h('button', { class: 'btn', onclick: () => toggle() }, '⏯ 播放／暫停'), h('button', { class: 'btn ghost', onclick: () => seekTo(0) }, '⏮ 從頭'))),
    list) });
  setTimeout(paintLines, 30);
}
