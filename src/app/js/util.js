// 小工具：建立元素、Markdown、日期文字、拖曳

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, x); else el.style[p] = x; }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list' && !k.startsWith('aria')) el[k] = v;
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c);
  };
  kids.forEach(add);
  return el;
}

// 換掉元素的內容；陣列會攤平，null、false 略過（原生 replaceChildren 會把它們印成文字）
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// 精簡版 Markdown：先跳脫再轉換，只放行 http(s) 連結
export function md(src) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  let list = null, code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src || '').split('\n')) {
    if (/^```/.test(raw)) {
      if (code) { out.push(`<pre>${code.join('\n')}</pre>`); code = null; } else { closeList(); code = []; }
      continue;
    }
    if (code) { code.push(raw); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(raw))) { closeList(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); } else if ((m = /^\s*[-*]\s+\[( |x)\]\s+(.*)$/i.exec(raw))) {
      if (list !== 'ul') { closeList(); out.push('<ul class="tasks">'); list = 'ul'; }
      out.push(`<li>${m[1] === ' ' ? '⬜' : '✅'} ${inline(m[2])}</li>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(raw))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(raw))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (/^\s*$/.test(raw)) closeList();
    else { closeList(); out.push(`<p>${inline(raw)}</p>`); }
  }
  closeList();
  if (code) out.push(`<pre>${code.join('\n')}</pre>`);
  return out.join('');
}

export function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString('zh-TW');
}

export function shortDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

// 依底色決定字色（自訂顏色時也看得清楚）
export function ink(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
  return lum > 165 ? '#1e293b' : '#fff';
}

// 滑鼠與觸控共用的拖曳。手機要長按才開始，才不會搶走捲動
export function startDrag(ev, { onStart, onMove, onEnd, threshold = 6, hold = 260 }) {
  if (ev.button > 0) return;
  const sx = ev.clientX, sy = ev.clientY;
  const touch = ev.pointerType === 'touch';
  let active = false, timer = null, canceled = false;
  const begin = (e) => { active = true; getSelection()?.removeAllRanges(); onStart && onStart(e); document.body.classList.add('dragging'); };
  const move = (e) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!active) {
      if (touch) { if (Math.hypot(dx, dy) > 10) finish(); return; }
      if (Math.hypot(dx, dy) < threshold) return;
      begin(e);
    }
    e.preventDefault();
    onMove && onMove(e, dx, dy);
  };
  const finish = (e) => {
    clearTimeout(timer);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', cancel);
    removeEventListener('keydown', key, true);
    removeEventListener('touchmove', noScroll);
    document.body.classList.remove('dragging');
    if (active) { onEnd && onEnd(e, canceled); suppressClick(); }
  };
  const up = (e) => finish(e);
  const cancel = (e) => { canceled = true; finish(e); };
  const key = (e) => { if (e.key === 'Escape') { canceled = true; finish(); } };
  const noScroll = (e) => { if (active) e.preventDefault(); };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', up);
  addEventListener('pointercancel', cancel);
  addEventListener('keydown', key, true);
  // 手指開始拖曳後不要讓畫面跟著捲動
  addEventListener('touchmove', noScroll, { passive: false });
  if (touch) timer = setTimeout(() => begin(ev), hold);
}

function suppressClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', stop, { capture: true }), 50);
}
