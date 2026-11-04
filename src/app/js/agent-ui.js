// 小柯助手面板：和 AI 對話，它會直接幫您找歌、下載、標記
import { h, fill, $, md } from './util.js';
import { confirmBox } from './ui.js';
import { xk, cleanErr } from './platform.js';
import { S } from './state.js';
import { runAgent, TOOL_LABEL } from './agent.js';
import { voice } from './voice.js';
import { filtered, renderLibrary, enqueue } from './library.js';

const chat = { log: [], previous: null, busy: false, cancel: null };

const SUGGEST = ['列出還沒下載的歌', '幫我把標題有「愛」的歌都下載 MP3 和 SRT', '幫我寫一首台語抒情歌的歌詞和 Suno 風格提示', '下載進度怎麼樣了？'];

export function toggleAgent(force) {
  const el = $('#agent');
  const open = force ?? !el.classList.contains('open');
  el.classList.toggle('open', open);
  document.body.classList.toggle('agent-open', open);
  $('#btnAgent')?.classList.toggle('on', open);
  if (open) { paint(); setTimeout(() => $('#agentInput')?.focus(), 50); }
}

export function askAgent(text) { toggleAgent(true); send(text); }

function ctx() {
  return {
    xk,
    songs: () => S.songs,
    settings: () => S.settings,
    sunoState: () => S.suno,
    filter: (f) => { const keep = S.filter; S.filter = { ...keep, ...f, sort: keep.sort }; try { return filtered(); } finally { S.filter = keep; } },
    select: (ids) => { S.selected = new Set(ids); renderLibrary(); },
    enqueue: (ids, formats) => enqueue(ids, formats),
    confirm: (msg) => confirmBox(msg, { ok: '同意', title: '小柯想做這件事' }),
  };
}

function paint() {
  const el = $('#agent');
  const hasKey = S.settings.ai.hasKey;
  const list = h('div', { class: 'ag-log', id: 'agentLog' });
  if (!chat.log.length) {
    list.append(h('div', { class: 'ag-hello' }, h('img', { src: 'img/robot96.png', alt: '', width: 64, height: 64 }), h('p', {}, '我是小柯！跟我說要找哪些歌、下載什麼格式，或請我幫您寫歌詞。'),
      hasKey && SUGGEST.map((s) => h('button', { class: 'ag-sug', onclick: () => send(s) }, s))));
  }
  for (const m of chat.log) list.append(bubble(m));
  const input = h('textarea', {
    id: 'agentInput', rows: 2, placeholder: hasKey ? '想請小柯做什麼？（Enter 送出，Shift+Enter 換行）' : '請先設定 OpenAI 金鑰', disabled: !hasKey || chat.busy, 'aria-label': '對小柯說',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } },
  });
  fill(el,
    h('div', { class: 'ag-head' }, h('img', { src: 'img/robot96.png', alt: '', width: 28, height: 28 }), h('b', {}, '小柯助手'), h('span', { class: 'sp' }),
      chat.log.length > 0 && h('button', { class: 'icon-btn small', title: '清除對話', disabled: chat.busy, onclick: () => { chat.log = []; chat.previous = null; paint(); } }, '🧹'),
      h('button', { class: 'icon-btn', title: '關閉', 'aria-label': '關閉小柯助手', onclick: () => toggleAgent(false) }, '✕')),
    list,
    hasKey ? h('div', { class: 'ag-input' }, input, chat.busy
      ? h('button', { class: 'btn', onclick: () => { chat.cancel && chat.cancel(); } }, '停止')
      : h('button', { class: 'btn primary', id: 'agentSend', onclick: () => send(input.value) }, '送出'))
      : h('div', { class: 'ag-nokey' }, h('p', {}, 'AI 助手使用您自己的 OpenAI 金鑰，費用由您的 OpenAI 帳戶計算。'), h('button', { class: 'btn primary', onclick: () => import('./settings.js').then((s) => s.openSettings('ai')) }, '前往設定金鑰')));
  list.scrollTop = list.scrollHeight;
}

function bubble(m) {
  if (m.role === 'user') return h('div', { class: 'ag-msg me' }, m.text);
  if (m.role === 'error') return h('div', { class: 'ag-msg err' }, `⚠️ ${m.text}`);
  return h('div', { class: 'ag-msg bot' },
    (m.steps || []).length > 0 && h('div', { class: 'ag-steps' }, m.steps.map((s) => h('span', { class: `ag-step ${s.phase}` }, s.phase === 'error' ? '⚠️' : s.phase === 'done' ? '✔' : '⏳', ' ', TOOL_LABEL[s.tool] || s.tool))),
    m.text ? h('div', { class: 'md', html: md(m.text) }) : h('span', { class: 'muted' }, '思考中…'),
    m.text && h('div', { class: 'ag-actions' },
      h('button', { class: 'link', onclick: () => voice.speak(m.text, { force: true }) }, '🔊 朗讀'),
      h('button', { class: 'link', onclick: () => navigator.clipboard.writeText(m.text) }, '📋 複製')));
}

async function send(text) {
  text = String(text || '').trim();
  if (!text || chat.busy) return;
  if (!S.settings.ai.hasKey) { toggleAgent(true); return; }
  chat.busy = true;
  chat.log.push({ role: 'user', text });
  const m = { role: 'bot', text: '', steps: [] };
  chat.log.push(m);
  paint();
  const ctl = new AbortController();
  chat.cancel = () => ctl.abort();
  try {
    const r = await runAgent({
      post: (body) => { if (ctl.signal.aborted) throw new Error('已取消'); return xk.ai.post(body); },
      text, previous: chat.previous, model: S.settings.ai.model, signal: ctl.signal, ctx: ctx(),
      onStep: (s) => {
        const last = [...m.steps].reverse().find((x) => x.tool === s.tool && x.phase === 'start');
        if (s.phase === 'start') m.steps.push({ ...s }); else if (last) last.phase = s.phase;
        paint();
      },
    });
    chat.previous = r.id;
    m.text = r.text || '好了！';
  } catch (e) {
    chat.log.pop();
    chat.log.push({ role: 'error', text: cleanErr(e) });
  }
  chat.busy = false;
  chat.cancel = null;
  paint();
}
