// 對話框、提示、彈出選單、小圖案與顏色選擇器
import { h, $ } from './util.js';
import { COLORS, EMOJI } from './defs.js';

export function modal({ title, body, wide, cls, buttons, onClose, noClose }) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    removeEventListener('keydown', key, true);
    back.remove();
    onClose && onClose(v);
    resolve(v);
  };
  const key = (e) => {
    if (e.key === 'Escape' && !noClose && back === [...document.querySelectorAll('.modal-back')].at(-1)) { e.stopPropagation(); close(); }
  };
  const foot = buttons && h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => (b.onClick ? b.onClick(close) : close(b.value)) }, b.label)));
  const card = h('div', { class: `modal ${wide ? 'wide' : ''} ${cls || ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', {}, title), !noClose && h('button', { class: 'icon-btn', title: '關閉', 'aria-label': '關閉', onclick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, body),
    foot);
  const back = h('div', { class: 'modal-back', onpointerdown: (e) => { if (e.target === back && !noClose) close(); } }, card);
  document.body.append(back);
  addEventListener('keydown', key, true);
  const first = card.querySelector('[autofocus], .modal-body input:not([type=checkbox]):not([type=color]):not([type=range]), .modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { card, close, done };
}

export function confirmBox(text, { ok = '確定', danger = false, title = '請確認' } = {}) {
  const body = h('div', { class: 'confirm-text' }, String(text).split('\n').map((t) => h('p', {}, t)));
  return modal({ title, body, buttons: [{ label: '取消', value: false }, { label: ok, value: true, primary: !danger, danger }] }).done.then((v) => !!v);
}

export function promptBox(title, { value = '', placeholder = '', ok = '確定', multiline = false, label = '' } = {}) {
  const input = multiline ? h('textarea', { rows: 5, value, placeholder }) : h('input', { type: 'text', value, placeholder });
  const m = modal({
    title,
    body: h('label', { class: 'field' }, label && h('span', {}, label), input),
    buttons: [{ label: '取消', value: null }, { label: ok, primary: true, onClick: (close) => close(input.value.trim()) }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline && !e.isComposing) { e.preventDefault(); m.close(input.value.trim()); } });
  setTimeout(() => input.select(), 40);
  return m.done.then((v) => v ?? null);
}

export function toast(text, { type = 'info', ms = 3200, action } = {}) {
  const box = $('#toasts') || document.body.appendChild(h('div', { id: 'toasts' }));
  const el = h('div', { class: `toast ${type}`, role: 'status' }, h('span', {}, text),
    action && h('button', { class: 'link', onclick: () => { action.onClick(); el.remove(); } }, action.label));
  box.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// 彈出面板：同時只開一個；點外面或按 Esc 關閉
let openPop = null;
export function closePopover() { if (openPop) { const f = openPop; openPop = null; f(); } }

export function popover(anchor, content, { width, onClose, align = 'left' } = {}) {
  closePopover();
  const el = h('div', { class: 'pop', style: width ? { width: width + 'px' } : null }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, ht = el.offsetHeight;
    let x = align === 'right' ? r.right - w : r.left;
    let y = r.bottom + 4;
    if (y + ht > innerHeight - 8) y = Math.max(8, r.top - ht - 4);
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.maxHeight = innerHeight - 16 + 'px';
  };
  place();
  const down = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target) && !e.target.closest('.modal-back')) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  setTimeout(() => addEventListener('pointerdown', down, true), 0);
  addEventListener('keydown', key, true);
  openPop = () => {
    removeEventListener('pointerdown', down, true);
    removeEventListener('keydown', key, true);
    el.remove();
    onClose && onClose();
  };
  const first = el.querySelector('input:not([type=checkbox]):not([type=color]), textarea');
  if (first) setTimeout(() => first.focus(), 20);
  return { el, place, close: closePopover };
}

// 選單：items = [{ icon, label, onClick, danger, checked, sep, hint }]
export function menu(anchor, items, opt = {}) {
  const list = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => (it.sep
    ? h('div', { class: 'sep' }, it.title || null)
    : h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', disabled: it.disabled, onclick: () => { if (!it.keep) closePopover(); it.onClick && it.onClick(); } },
      h('span', { class: 'mi-icon' }, it.checked ? '✔' : it.icon || ''), h('span', { class: 'mi-label' }, it.label), it.hint && h('span', { class: 'mi-hint' }, it.hint)))));
  return popover(anchor, list, opt);
}

// 小圖案＋顏色：選了立刻套用
export function iconColorPicker(anchor, { icon, color, onChange, noColor }) {
  let cur = { icon, color };
  const fire = () => onChange({ ...cur });
  const colors = !noColor && h('div', { class: 'swatches' },
    COLORS.map((c) => h('button', { class: `swatch ${c.c === cur.color ? 'on' : ''}`, title: c.n, 'aria-label': c.n, style: { background: c.c }, onclick: (e) => { cur.color = c.c; [...e.target.parentElement.children].forEach((x) => x.classList.remove('on')); e.target.classList.add('on'); fire(); } })),
    h('label', { class: 'swatch custom', title: '自訂顏色' }, '＋', h('input', { type: 'color', value: cur.color || '#3b82f6', oninput: (e) => { cur.color = e.target.value; fire(); } })));
  const groups = Object.entries(EMOJI).map(([name, list]) => h('div', { class: 'emoji-group' }, h('small', {}, name), h('div', { class: 'emoji-grid' }, list.map((e) => h('button', { class: `emoji ${e === cur.icon ? 'on' : ''}`, onclick: () => { cur.icon = e; fire(); closePopover(); } }, e)))));
  const content = h('div', { class: 'picker' },
    colors,
    h('div', { class: 'emoji-scroll' }, groups),
    h('div', { class: 'picker-foot' },
      h('input', { type: 'text', placeholder: '或貼上任何小圖案', maxLength: 8, value: cur.icon || '', onchange: (e) => { cur.icon = e.target.value.trim(); fire(); } }),
      h('button', { class: 'btn small', onclick: () => { cur.icon = ''; fire(); closePopover(); } }, '不要圖案')));
  return popover(anchor, content, { width: 318 });
}

// 表單列
export const row = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint && h('small', { class: 'hint' }, hint));
