// 歌曲庫：搜尋、篩選、勾選、批量下載、試聽、歌曲詳細資料（歌詞與 SRT 預覽）、標記
import { h, fill, $, $$, debounce, esc } from './util.js';
import { modal, toast, confirmBox, menu, iconColorPicker, row } from './ui.js';
import { xk, cleanErr } from './platform.js';
import { S, songById } from './state.js';
import { FORMATS } from './defs.js';
import { go, updateBadges } from './app.js';
import { listen, playingId, isPlaying, subscribe, onChange } from './karaoke.js';

const OFFSETS = [0, -0.1, -0.2, -0.3, -0.4, -0.5];
let built = false;
onChange(() => { if (S.view === 'library') renderList(); });

export async function loadSongs() {
  S.songs = await xk.lib.list();
  const ids = new Set(S.songs.map((s) => s.id));
  for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
  updateBadges();
  renderMarksNav();
  if (S.view === 'library') renderLibrary();
}

const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }); };
const markOf = (id) => S.settings.marks.find((m) => m.id === id);

export function filtered() {
  const f = S.filter;
  const q = f.q.trim().toLowerCase();
  let list = S.songs.filter((s) => {
    if (q && !(`${s.title}\n${s.tags}\n${s.lyrics}`.toLowerCase().includes(q))) return false;
    if (f.mark && !s.marks.includes(f.mark)) return false;
    const has = s.files && s.files.mp3;
    if (f.show === 'todo' && has) return false;
    if (f.show === 'done' && !has) return false;
    if (f.show === 'lyrics' && (s.instrumental || !s.lyrics)) return false;
    if (f.show === 'inst' && !s.instrumental) return false;
    if (f.show === 'liked' && !s.liked) return false;
    return true;
  });
  const by = {
    new: (a, b) => String(b.created).localeCompare(String(a.created)),
    old: (a, b) => String(a.created).localeCompare(String(b.created)),
    title: (a, b) => a.title.localeCompare(b.title, 'zh-Hant'),
    dur: (a, b) => b.duration - a.duration,
  }[f.sort] || (() => 0);
  return list.sort(by);
}

// ---------------- 左側「標記」 ----------------
export function renderMarksNav() {
  const box = $('#markNav');
  if (!box) return;
  const count = (id) => S.songs.filter((s) => s.marks.includes(id)).length;
  fill(box,
    S.settings.marks.map((m) => h('button', { class: `mark-nav ${S.filter.mark === m.id ? 'on' : ''}`, style: { '--mc': m.color }, onclick: () => { S.filter.mark = S.filter.mark === m.id ? '' : m.id; renderMarksNav(); go('library'); } },
      h('span', { class: 'mi' }, m.icon), h('span', { class: 'mt' }, m.name), h('span', { class: 'mc' }, String(count(m.id) || '')))),
    h('button', { class: 'mark-nav add', id: 'btnMarks', onclick: () => openMarks() }, h('span', { class: 'mi' }, '＋'), h('span', { class: 'mt' }, '管理標記')));
}

export function openMarks() {
  const list = h('div', { class: 'marks-edit' });
  let marks = S.settings.marks.map((m) => ({ ...m }));
  const save = async () => { S.settings = await xk.settings.set({ marks }); renderMarksNav(); renderLibrary(); };
  const draw = () => fill(list, marks.map((m, i) => h('div', { class: 'mark-row' },
    h('button', { class: 'mark-ic', style: { background: m.color }, title: '換小圖案與顏色', onclick: (e) => iconColorPicker(e.currentTarget, { icon: m.icon, color: m.color, onChange: (v) => { m.icon = v.icon || '🏷️'; m.color = v.color || m.color; draw(); save(); } }) }, m.icon),
    h('input', { type: 'text', value: m.name, maxLength: 16, onchange: (e) => { m.name = e.target.value.trim() || m.name; save(); } }),
    h('button', { class: 'icon-btn', title: '刪除這個標記', onclick: async () => { if (await confirmBox(`刪除標記「${m.name}」？歌曲本身不受影響。`, { danger: true, ok: '刪除' })) { marks.splice(i, 1); draw(); save(); } } }, '🗑'))));
  draw();
  modal({ title: '🏷️ 管理標記', body: h('div', {}, h('p', { class: 'muted' }, '標記可以幫歌曲分類，例如「最愛」、「影片用」、「字幕待修」。點左邊的圓形可以換小圖案和顏色。'), list,
    h('button', { class: 'btn', id: 'markAdd', onclick: () => { marks.push({ id: 'm' + Date.now().toString(36), name: '新標記', icon: '🎵', color: '#a855f7' }); draw(); save(); } }, '＋ 新增標記')) });
}

// ---------------- 主畫面 ----------------
function buildTools(host) {
  const dl = S.settings.download;
  const q = h('input', { type: 'search', id: 'q', placeholder: '🔍 搜尋歌名、風格或歌詞（Ctrl+F）', value: S.filter.q, oninput: debounce((e) => { S.filter.q = e.target.value; renderList(); }, 200) });
  const show = h('div', { class: 'seg', id: 'show' }, [['all', '全部'], ['todo', '未下載'], ['done', '已下載'], ['lyrics', '有歌詞'], ['inst', '純音樂'], ['liked', '❤️ 按讚']].map(([id, t]) =>
    h('button', { class: S.filter.show === id ? 'on' : '', dataset: { v: id }, onclick: (e) => { S.filter.show = id; $$('#show button').forEach((b) => b.classList.toggle('on', b.dataset.v === id)); renderList(); } }, t)));
  const sort = h('select', { id: 'sort', title: '排序', onchange: (e) => { S.filter.sort = e.target.value; renderList(); } },
    [['new', '最新的在前'], ['old', '最舊的在前'], ['title', '依歌名'], ['dur', '依長度']].map(([v, t]) => h('option', { value: v, selected: S.filter.sort === v }, t)));
  const fmts = h('div', { class: 'fmts', id: 'fmts' }, FORMATS.map((f) => h('button', { class: `chip ${dl.formats.includes(f.id) ? 'on' : ''}`, title: f.desc, dataset: { f: f.id }, onclick: async (e) => {
    const btn = e.currentTarget;
    const set = new Set(S.settings.download.formats);
    if (set.has(f.id)) set.delete(f.id); else set.add(f.id);
    S.settings = await xk.settings.set({ download: { formats: [...set] } });
    btn.classList.toggle('on', S.settings.download.formats.includes(f.id));
  } }, f.icon, ' ', f.name)));
  const off = h('select', { id: 'offset', title: 'SRT 開始補正：字幕比歌聲早出現多少秒', onchange: async (e) => { S.settings = await xk.settings.set({ download: { startOffset: Number(e.target.value) } }); } },
    OFFSETS.map((o) => h('option', { value: o, selected: Math.abs(o - dl.startOffset) < 1e-4 }, `字幕提早 ${Math.abs(o).toFixed(1)} 秒`)));
  fill(host,
    h('div', { class: 'lib-head' },
      h('div', { class: 'tools' }, q, show, sort, h('span', { class: 'sp' }),
        h('button', { class: 'btn', id: 'btnScan', title: '在「Suno 網頁」打開工作區或播放清單後，按這裡把那一頁的歌全部抓進來', onclick: scanPage }, '📥 抓取 Suno 目前頁面'),
        h('button', { class: 'btn primary', id: 'btnRefresh', onclick: refreshAll }, '☁️ 讀取我的全部歌曲')),
      h('div', { class: 'dlbar' },
        h('label', { class: 'chk all' }, h('input', { type: 'checkbox', id: 'selAll', onchange: (e) => { const ids = filtered().map((s) => s.id); if (e.target.checked) ids.forEach((id) => S.selected.add(id)); else ids.forEach((id) => S.selected.delete(id)); renderList(); } }), h('span', { id: 'selText' }, '全選')),
        fmts, off, h('span', { class: 'sp' }),
        h('button', { class: 'btn ghost', id: 'btnOpenDir', title: S.settings.download.dir, onclick: () => xk.dir.open() }, '📂 下載資料夾'),
        h('button', { class: 'btn primary big', id: 'btnDownload', onclick: () => downloadSelected() }, '⬇️ 下載所選'))),
    h('div', { class: 'lib-list', id: 'libList' }));
}

export function renderLibrary(soft) {
  const host = $('#v-library');
  if (!host) return;
  if (!built || !$('#libList')) { buildTools(host); built = true; }
  if (soft) { updateStatuses(); return; }
  renderList();
}

function renderList() {
  const box = $('#libList');
  if (!box) return;
  const list = filtered();
  const scroll = box.scrollTop;
  if (!S.songs.length) {
    fill(box, h('div', { class: 'empty' },
      h('img', { src: 'img/robot96.png', alt: '', width: 96, height: 96 }),
      h('h3', {}, '歌曲庫還是空的'),
      h('ol', {},
        h('li', {}, '先到左邊「🌐 Suno 網頁」登入您的 Suno 帳號。'),
        h('li', {}, '回來按「☁️ 讀取我的全部歌曲」，或在 Suno 打開工作區後按「📥 抓取 Suno 目前頁面」。'),
        h('li', {}, '勾選要的歌，按「⬇️ 下載所選」，MP3 和 SRT 字幕就會用 Suno 的歌名存好。')),
      h('div', { class: 'row-gap' }, h('button', { class: 'btn primary', onclick: () => go('suno') }, '🌐 前往 Suno 登入'), h('button', { class: 'btn', onclick: () => import('./guide.js').then((g) => g.openGuide(0)) }, '📖 聽使用說明'))));
  } else if (!list.length) {
    fill(box, h('div', { class: 'empty small' }, h('p', {}, '沒有符合條件的歌曲'), h('button', { class: 'btn', onclick: () => { S.filter = { ...S.filter, q: '', show: 'all', mark: '' }; built = false; renderMarksNav(); renderLibrary(); } }, '清除篩選')));
  } else {
    fill(box, list.map(songRow));
  }
  box.scrollTop = scroll;
  selText(list);
}

function selText(list = filtered()) {
  const n = S.selected.size;
  const all = $('#selAll');
  if (all) { all.checked = list.length > 0 && list.every((s) => S.selected.has(s.id)); all.indeterminate = !all.checked && list.some((s) => S.selected.has(s.id)); }
  const t = $('#selText');
  if (t) t.textContent = n ? `已選 ${n} 首` : `全選（${list.length} 首）`;
  const b = $('#btnDownload');
  if (b) b.textContent = n ? `⬇️ 下載所選 ${n} 首` : `⬇️ 下載列表全部 ${list.length} 首`;
}

function statusOf(s) {
  const j = [...S.queue.jobs].reverse().find((x) => x.id === s.id);
  if (j && j.state === 'run') return h('span', { class: 'st run' }, `⬇️ ${Math.round(j.pct * 100)}% ${j.step}`);
  if (j && j.state === 'wait') return h('span', { class: 'st wait' }, '⏳ 排隊中');
  const files = s.files || {};
  const got = FORMATS.filter((f) => files[f.id]);
  const err = j && j.state === 'error' && h('span', { class: 'st err', title: j.msg }, '⚠️ 失敗');
  return h('span', { class: 'st' }, err, got.map((f) => h('span', { class: `fb ${f.id}`, title: files[f.id] }, f.name)));
}

function updateStatuses() {
  for (const el of $$('#libList .song')) {
    const s = songById(el.dataset.id);
    const cell = el.querySelector('.st');
    if (s && cell) cell.replaceWith(statusOf(s));
  }
}

function songRow(s) {
  const sel = S.selected.has(s.id);
  const marks = s.marks.map(markOf).filter(Boolean);
  const on = playingId() === s.id;
  return h('div', { class: `song ${sel ? 'sel' : ''} ${on ? 'playing' : ''}`, dataset: { id: s.id } },
    h('input', { type: 'checkbox', checked: sel, 'aria-label': '勾選', onchange: (e) => { if (e.target.checked) S.selected.add(s.id); else S.selected.delete(s.id); e.target.closest('.song').classList.toggle('sel', e.target.checked); selText(); } }),
    h('button', { class: 'cover', title: on && isPlaying() ? '暫停' : '邊聽邊看字幕', onclick: () => listen(s.id) },
      s.thumb ? h('img', { src: s.thumb, alt: '', loading: 'lazy' }) : h('span', {}, '🎵'), h('i', {}, on && isPlaying() ? '⏸' : '▶')),
    h('div', { class: 'info', onclick: () => openDetail(s.id) },
      h('div', { class: 't' }, s.title, s.instrumental && h('span', { class: 'tag inst' }, '純音樂'), s.liked && h('span', { class: 'tag' }, '❤️'),
        marks.map((m) => h('span', { class: 'mk', style: { '--mc': m.color } }, m.icon, ' ', m.name))),
      h('div', { class: 'sub' }, [s.tags, s.model].filter(Boolean).join(' · ') || ' ')),
    h('span', { class: 'du' }, dur(s.duration)),
    h('span', { class: 'da' }, day(s.created)),
    statusOf(s),
    h('div', { class: 'acts' },
      h('button', { class: 'icon-btn', title: '歌詞與 SRT 預覽', onclick: () => openDetail(s.id) }, '💬'),
      h('button', { class: 'icon-btn', title: '下載這首', onclick: () => enqueue([s.id]) }, '⬇️'),
      h('button', { class: 'icon-btn', title: '更多', onclick: (e) => songMenu(e.currentTarget, s) }, '⋯')));
}

function songMenu(anchor, s) {
  menu(anchor, [
    { sep: true, title: '標記' },
    ...S.settings.marks.map((m) => ({ icon: m.icon, label: m.name, checked: s.marks.includes(m.id), onClick: () => xk.lib.mark([s.id], m.id, !s.marks.includes(m.id)) })),
    { sep: true },
    { icon: '📂', label: '在資料夾中顯示', disabled: !(s.files && (s.files.mp3 || s.files.srt)), onClick: () => xk.file.show(s.files.mp3 || s.files.srt) },
    { icon: '🌐', label: '在 Suno 網頁打開', onClick: () => { xk.suno.nav('url', `https://suno.com/song/${s.id}`); go('suno'); } },
    { icon: '🗑', label: '從歌曲庫移除（不刪檔案）', danger: true, onClick: async () => { if (await confirmBox(`從歌曲庫移除「${s.title}」？\n已下載的檔案與 Suno 上的歌都不受影響。`, { ok: '移除' })) xk.lib.remove([s.id]); } },
  ]);
}

// ---------------- 動作 ----------------
async function refreshAll() {
  const b = $('#btnRefresh');
  b.disabled = true;
  const off = xk.lib.onProgress((p) => { b.textContent = `⏳ 已讀取 ${p.n} 首…`; });
  try {
    const r = await xk.lib.refresh({});
    toast(`✅ 讀取完成：共 ${r.total} 首，新增 ${r.added} 首`);
  } catch (e) {
    const msg = cleanErr(e);
    toast(`讀取失敗：${msg}`, { type: 'error', ms: 6000 });
    if (/登入/.test(msg)) go('suno');
  } finally { off(); b.disabled = false; b.textContent = '☁️ 讀取我的全部歌曲'; }
}

export async function scanPage() {
  const b = $('#btnScan');
  if (b) { b.disabled = true; b.textContent = '⏳ 抓取中…'; }
  try {
    const r = await xk.lib.scan();
    if (!r.total) toast('這一頁沒有找到歌曲。請在「Suno 網頁」打開工作區、播放清單或歌曲頁', { type: 'error', ms: 6000 });
    else {
      r.ids.forEach((id) => S.selected.add(id));
      toast(`✅ 抓到 ${r.total} 首（新增 ${r.added} 首），已幫您勾選`);
      go('library');
    }
    return r;
  } catch (e) { toast(cleanErr(e), { type: 'error', ms: 6000 }); return null; } finally { if (b) { b.disabled = false; b.textContent = '📥 抓取 Suno 目前頁面'; } }
}

export async function enqueue(ids, formats) {
  try {
    const n = await xk.dl.add(ids, formats || S.settings.download.formats);
    toast(n ? `⬇️ 已加入下載佇列 ${n} 首` : '這些歌已經在佇列裡了');
    return n;
  } catch (e) { toast(cleanErr(e), { type: 'error' }); return 0; }
}

async function downloadSelected() {
  let ids = [...S.selected];
  if (!ids.length) {
    const list = filtered();
    if (!list.length) return;
    if (!(await confirmBox(`沒有勾選歌曲。要下載目前列表的全部 ${list.length} 首嗎？`, { ok: '全部下載' }))) return;
    ids = list.map((s) => s.id);
  }
  if (!S.settings.download.formats.length) { toast('請先選擇要下載的格式（MP3、SRT…）', { type: 'error' }); return; }
  const n = await enqueue(ids);
  if (n) { S.selected.clear(); renderList(); }
}



// ---------------- 歌曲詳細資料 ----------------
export async function openDetail(id) {
  const body = h('div', { class: 'detail' }, h('p', {}, '讀取中…'));
  const m = modal({ title: '🎵 歌曲詳細資料', body, wide: true, cls: 'detail-modal' });
  let s;
  try { s = await xk.lib.detail(id); } catch (e) { fill(body, h('p', {}, cleanErr(e))); return; }
  if (!s) { fill(body, h('p', {}, '找不到這首歌')); return; }
  const srtBox = h('div', { class: 'srt-list', id: 'srtPreview' }, h('p', { class: 'muted' }, '讀取字幕中…'));
  const off = h('select', { title: '字幕比歌聲提早出現的秒數' }, OFFSETS.map((o) => h('option', { value: o, selected: Math.abs(o - S.settings.download.startOffset) < 1e-4 }, `提早 ${Math.abs(o).toFixed(1)} 秒`)));
  let last = '', lines = [];
  const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  const gen = async () => {
    fill(srtBox, h('p', { class: 'muted' }, '向 Suno 讀取對時歌詞中…'));
    try {
      const r = await xk.lib.srt(id, Number(off.value));
      last = r.srt;
      lines = r.lines;
      if (!lines.length) { fill(srtBox, h('p', { class: 'muted' }, r.instrumental ? '這首是純音樂，沒有歌詞。' : 'Suno 沒有提供這首歌的對時歌詞。')); return; }
      fill(srtBox, lines.map((l, i) => h('button', { class: 'sl', dataset: { i }, title: '從這一句開始聽', onclick: () => listen(id, { offset: Number(off.value), at: Math.max(0, l.start - 0.5) }) },
        h('small', {}, `${mmss(l.start)} → ${mmss(l.end)}`), h('span', {}, l.text))));
    } catch (e) { fill(srtBox, h('p', {}, `❌ ${cleanErr(e)}`)); }
  };
  // 播放這首歌時，目前唱到的那一句亮起來
  const unsub = subscribe(({ id: pid, idx }) => {
    if (pid !== id || !srtBox.isConnected) return;
    const cur = srtBox.querySelector('.sl.on');
    if (cur && Number(cur.dataset.i) === idx) return;
    cur && cur.classList.remove('on');
    const el = idx >= 0 && srtBox.children[idx];
    if (el && el.classList) { el.classList.add('on'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  m.done.then(unsub);
  off.onchange = async () => { await gen(); if (playingId() === id) listen(id, { offset: Number(off.value) }); };
  const hasLocal = s.files && s.files.mp3 && s.files.srt;
  const marks = h('div', { class: 'marks' }, S.settings.marks.map((mk) => h('button', { class: `mk ${s.marks.includes(mk.id) ? 'on' : ''}`, style: { '--mc': mk.color }, onclick: async (e) => { const btn = e.currentTarget; const on = !btn.classList.contains('on'); await xk.lib.mark([id], mk.id, on); btn.classList.toggle('on', on); } }, mk.icon, ' ', mk.name)));
  fill(body,
    h('div', { class: 'd-top' },
      s.image ? h('img', { class: 'd-cover', src: s.image, alt: '' }) : h('div', { class: 'd-cover ph' }, '🎵'),
      h('div', { class: 'd-meta' },
        h('h3', {}, s.title),
        h('p', { class: 'muted' }, [s.tags, dur(s.duration), day(s.created), s.model].filter(Boolean).join(' · ')),
        marks,
        h('div', { class: 'row-gap' },
          h('button', { class: 'btn primary', id: 'dListen', onclick: () => listen(id, { offset: Number(off.value), at: 0 }) }, '▶ 邊聽邊看字幕'),
          hasLocal && h('button', { class: 'btn', id: 'dListenLocal', title: '播放已下載的 MP3，字幕讀取已下載的 SRT 檔', onclick: () => listen(id, { at: 0 }) }, '🎧 聽已下載的 MP3＋SRT'),
          h('button', { class: 'btn', onclick: () => enqueue([id]) }, '⬇️ 下載（目前選的格式）'),
          h('button', { class: 'btn', onclick: () => enqueue([id], ['srt']) }, '💬 只下載 SRT')),
        h('div', { class: 'row-gap' },
          s.files && (s.files.mp3 || s.files.srt) && h('button', { class: 'btn ghost small', onclick: () => xk.file.show(s.files.mp3 || s.files.srt) }, '📂 打開位置'),
          h('button', { class: 'btn ghost small', onclick: () => { m.close(); xk.suno.nav('url', `https://suno.com/song/${id}`); go('suno'); } }, '🌐 在 Suno 打開')))),
    h('div', { class: 'd-cols' },
      h('section', {}, h('div', { class: 'd-h' }, h('b', {}, '📄 歌詞'), h('span', { class: 'sp' }), s.lyrics && h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(s.lyrics); toast('歌詞已複製'); } }, '📋 複製')),
        h('pre', { class: 'lyrics' }, s.lyrics || (s.instrumental ? '（純音樂）' : '（沒有歌詞）'))),
      h('section', {}, h('div', { class: 'd-h' }, h('b', {}, '💬 SRT 字幕（點一句從那裡聽）'), h('span', { class: 'sp' }), off,
        h('button', { class: 'btn small', onclick: async () => { if (!last) await gen(); if (last) { const p = await xk.file.saveText(`${s.title.replace(/[<>:"/\|?*]/g, '_')}.srt`, last); if (p) toast(`已儲存：${p}`); } } }, '💾 另存')),
        srtBox)));
  gen();
}

export { esc, row };
