// 設定：下載與檔名、外觀與顏色、AI 助手、雲端儲存、語音、關於與更新
import { h, fill, $ } from './util.js';
import { modal, row, toast, confirmBox, promptBox } from './ui.js';
import { xk, cleanErr } from './platform.js';
import { S } from './state.js';
import { FORMATS, ACCENTS } from './defs.js';
import { MODELS } from './agent.js';
import { voice } from './voice.js';
import { cloudPill } from './app.js';
import { openMarks, renderLibrary } from './library.js';

const TABS = [['dl', '⬇️', '下載與檔名'], ['look', '🎨', '外觀與顏色'], ['ai', '🤖', 'AI 助手'], ['cloud', '☁️', '雲端儲存'], ['voice', '🔊', '語音'], ['about', 'ℹ️', '關於與更新']];

export function openSettings(tab = 'dl') {
  const body = h('div', { class: 'st-body' });
  const nav = h('nav', { class: 'set-nav' });
  const show = (id) => {
    fill(nav, ...TABS.map(([k, ic, t]) => h('button', { class: k === id ? 'on' : '', id: `st-${k}`, onclick: () => show(k) }, ic, ' ', t)));
    ({ dl: tabDl, look: tabLook, ai: tabAI, cloud: tabCloud, voice: tabVoice, about: tabAbout })[id](body);
  };
  show(tab);
  return modal({ title: '⚙️ 設定', wide: true, cls: 'settings', body: h('div', { class: 'set' }, nav, body), onClose: () => renderLibrary() });
}

const set = async (patch) => { S.settings = await xk.settings.set(patch); return S.settings; };
const chk = (label, on, fn, id) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', id, checked: !!on, onchange: (e) => fn(e.target.checked) }), label);

function tabDl(host) {
  const d = S.settings.download;
  const dir = h('div', { class: 'dir' }, h('code', { id: 'stDir' }, d.dir),
    h('button', { class: 'btn small', id: 'stDirPick', onclick: async () => { const p = await xk.dir.choose(); if (p) { S.settings = await xk.settings.get(); tabDl(host); } } }, '變更…'),
    h('button', { class: 'btn small ghost', onclick: () => xk.dir.open() }, '開啟'));
  const fmts = h('div', { class: 'fmts' }, FORMATS.map((f) => h('label', { class: 'chk', title: f.desc }, h('input', { type: 'checkbox', checked: d.formats.includes(f.id), onchange: async (e) => {
    const s = new Set(S.settings.download.formats);
    if (e.target.checked) s.add(f.id); else s.delete(f.id);
    await set({ download: { formats: [...s] } });
  } }), `${f.icon} ${f.name}`)));
  const dupe = h('select', { id: 'stDupe', onchange: (e) => set({ download: { dupe: e.target.value } }) },
    [['number', '加上 (1)、(2)…（和瀏覽器下載一樣）'], ['id', '加上歌曲 ID 前 8 碼'], ['overwrite', '直接覆蓋同名檔案']].map(([v, t]) => h('option', { value: v, selected: d.dupe === v }, t)));
  const off = h('select', { onchange: (e) => set({ download: { startOffset: Number(e.target.value) } }) }, [0, -0.1, -0.2, -0.3, -0.4, -0.5].map((o) => h('option', { value: o, selected: Math.abs(o - d.startOffset) < 1e-4 }, `${o.toFixed(1)} 秒${o === -0.1 ? '（建議）' : ''}`)));
  const par = h('select', { onchange: (e) => set({ download: { parallel: Number(e.target.value) } }) }, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: d.parallel === n }, `${n} 首`)));
  fill(host,
    h('div', { class: 'field' }, h('span', {}, '下載資料夾'), dir),
    h('div', { class: 'field' }, h('span', {}, '預設下載格式'), fmts),
    row('同名歌曲', dupe, '檔名一律使用 Suno 上的歌名；Suno 常一次產生兩首同名的歌，這裡決定第二首怎麼命名。同一首歌的 MP3 和 SRT 一定同名。'),
    row('SRT 開始補正', off, '字幕比歌聲提早出現的秒數，讓觀眾先看到字。Suno 剛產生、還沒改過歌詞的歌最準。'),
    row('同時下載', par),
    chk('依格式分資料夾（MP3、SRT、LRC…各放一個資料夾）', d.subfolders, (v) => set({ download: { subfolders: v } })),
    chk('已經下載過的檔案就跳過', d.skipExisting, (v) => set({ download: { skipExisting: v } })),
    chk('文字檔加上 UTF-8 BOM（舊版播放器、Windows 記事本中文不會亂碼）', d.bom, (v) => set({ download: { bom: v } })),
    chk('下載完成時通知', S.settings.notify, (v) => set({ notify: v })));
}

export function applyTheme() {
  const t = S.settings.theme;
  const root = document.documentElement;
  root.dataset.theme = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  root.style.setProperty('--accent', S.settings.accent || '#f97316');
}

function tabLook(host) {
  const theme = h('div', { class: 'seg' }, [['dark', '🌙 深色'], ['light', '☀️ 淺色'], ['system', '🖥 跟隨系統']].map(([id, t]) => h('button', { class: S.settings.theme === id ? 'on' : '', onclick: async () => { await set({ theme: id }); applyTheme(); tabLook(host); } }, t)));
  const acc = h('div', { class: 'swatches big' }, ACCENTS.map((c) => h('button', { class: `swatch ${c === S.settings.accent ? 'on' : ''}`, style: { background: c }, 'aria-label': c, onclick: async () => { await set({ accent: c }); applyTheme(); tabLook(host); } })),
    h('label', { class: 'swatch custom', title: '自訂顏色' }, '＋', h('input', { type: 'color', value: S.settings.accent, oninput: (e) => { document.documentElement.style.setProperty('--accent', e.target.value); }, onchange: async (e) => { await set({ accent: e.target.value }); tabLook(host); } })));
  fill(host,
    h('div', { class: 'field' }, h('span', {}, '外觀'), theme),
    h('div', { class: 'field' }, h('span', {}, '主題色'), acc, h('small', { class: 'hint' }, '按鈕、選取、進度條都會換成這個顏色')),
    h('div', { class: 'field' }, h('span', {}, '歌曲標記'), h('div', { class: 'marks' }, S.settings.marks.map((m) => h('span', { class: 'mk on', style: { '--mc': m.color } }, m.icon, ' ', m.name))),
      h('div', { class: 'row-gap' }, h('button', { class: 'btn', onclick: () => openMarks() }, '🏷️ 管理標記（小圖案與顏色）'))));
}

function tabAI(host) {
  const key = h('input', { type: 'password', id: 'stKey', placeholder: S.settings.ai.hasKey ? '已設定（要更換才需要輸入）' : 'sk-…', autocomplete: 'off' });
  const opts = [...MODELS];
  if (!opts.find((m) => m.id === S.settings.ai.model)) opts.push({ id: S.settings.ai.model, name: S.settings.ai.model });
  const model = h('select', { id: 'stModel', onchange: (e) => set({ ai: { model: e.target.value } }) }, opts.map((m) => h('option', { value: m.id, selected: m.id === S.settings.ai.model }, m.name)));
  const msg = h('div', { class: 'hint', id: 'stKeyMsg' });
  const save = h('button', { class: 'btn primary', id: 'stKeySave', onclick: async () => {
    const v = key.value.trim();
    if (v) { await set({ ai: { key: v } }); key.value = ''; key.placeholder = '已設定（要更換才需要輸入）'; }
    msg.textContent = '測試中…';
    const r = await xk.ai.test();
    if (r.ok) {
      msg.textContent = `✅ 金鑰可以使用（找到 ${r.models.length} 個模型）`;
      for (const id of r.models.filter((x) => /^gpt-[5-9]/.test(x) && !/(audio|tts|image|transcribe|realtime|search|embedding)/.test(x))) if (!opts.find((m) => m.id === id)) { model.append(h('option', { value: id }, id)); opts.push({ id }); }
    } else msg.textContent = `❌ ${r.error}`;
  } }, '儲存並測試');
  fill(host,
    h('p', { class: 'muted' }, '小柯助手使用您自己的 OpenAI 金鑰，可以幫您找歌、批量下載、檢查字幕，也能幫您寫 Suno 的歌詞和風格提示。'),
    row('OpenAI 金鑰', key, '金鑰用系統的加密功能保存在這台電腦，不會上傳到雲端；費用由您的 OpenAI 帳戶計算'),
    h('div', { class: 'row-gap' }, save, S.settings.ai.hasKey && h('button', { class: 'btn', onclick: async () => { await set({ ai: { key: '' } }); tabAI(host); toast('已刪除金鑰'); } }, '刪除金鑰'),
      h('button', { class: 'btn ghost', onclick: () => xk.openExternal('https://platform.openai.com/api-keys') }, '到 OpenAI 取得金鑰')),
    msg, row('模型', model, '一般工作用 Terra 就很夠了；按「儲存並測試」會加入您帳戶可用的其他模型'));
}

function tabCloud(host) {
  const c = S.settings.cloud;
  const st = S.cloud;
  const msg = h('div', { class: 'hint', id: 'stCloudMsg' }, !c.hasToken ? '尚未設定雲端儲存（沒有設定也能單機使用）' : st.status === 'error' ? `❌ ${st.error}` : st.at ? `✅ 上次同步 ${new Date(st.at).toLocaleString('zh-TW')}` : '已設定，等待同步');
  const paste = h('button', { class: 'btn primary', id: 'stPaste', onclick: async () => {
    const code = await promptBox('貼上雲端設定碼', { placeholder: 'XKS1.…', label: '在 Apps Script 執行 setupSuno 後，執行記錄會印出設定碼' });
    if (!code) return;
    msg.textContent = '連線中…';
    try { const r = await xk.cloud.connect(code); S.settings = await xk.settings.get(); toast(`✅ 已連上雲端：上傳 ${r.sent} 筆、下載 ${r.applied} 筆`); tabCloud(host); cloudPill(); } catch (e) { msg.textContent = `❌ ${cleanErr(e)}`; }
  } }, '📥 貼上設定碼');
  fill(host,
    h('p', { class: 'muted' }, '歌曲清單與標記會存到您自己的 Google 雲端硬碟（「小柯SUNO」資料夾），換電腦或之後的手機版都看得到同一份；也可以把 SRT、MP3 備份上去。'),
    h('div', { class: 'row-gap' }, paste,
      c.hasToken && h('button', { class: 'btn', id: 'stSync', onclick: async () => { msg.textContent = '同步中…'; try { const r = await xk.cloud.sync(); msg.textContent = `✅ 同步完成：上傳 ${r.sent} 筆、下載 ${r.applied} 筆`; } catch (e) { msg.textContent = `❌ ${cleanErr(e)}`; } } }, '🔄 立即同步'),
      c.hasToken && h('button', { class: 'btn', onclick: async () => { await navigator.clipboard.writeText(await xk.cloud.code()); toast('設定碼已複製（含金鑰，請勿公開）'); } }, '📋 複製設定碼'),
      c.hasToken && h('button', { class: 'btn ghost', onclick: async () => { if (await confirmBox('中斷雲端連線？雲端上的資料不會被刪除。')) { S.settings = await xk.cloud.disconnect(); tabCloud(host); cloudPill(); } } }, '中斷連線')),
    msg,
    c.hasToken && chk('自動同步歌曲清單與標記', c.auto, (v) => set({ cloud: { auto: v } })),
    c.hasToken && chk('下載完成後自動備份 SRT 到雲端硬碟', c.uploadSrt, (v) => set({ cloud: { uploadSrt: v } })),
    c.hasToken && chk('下載完成後自動備份 MP3 到雲端硬碟（檔案較大，較慢）', c.uploadMp3, (v) => set({ cloud: { uploadMp3: v } })));
}

function tabVoice(host) {
  const v = S.settings.voice;
  const rate = h('input', { type: 'range', min: 0.6, max: 1.6, step: 0.1, value: v.rate, oninput: (e) => voice.configure({ rate: e.target.value }), onchange: (e) => set({ voice: { rate: Number(e.target.value) } }) });
  const list = voice.list();
  const sel = list.length > 0 && h('select', { onchange: async (e) => { voice.configure({ name: e.target.value }); await set({ voice: { name: e.target.value } }); } }, h('option', { value: '' }, '自動選擇'), list.map((x) => h('option', { value: x.name, selected: x.name === v.name }, x.name)));
  fill(host,
    chk('開啟使用說明時自動朗讀', v.enabled, async (on) => { await set({ voice: { enabled: on } }); voice.configure({ enabled: on }); }),
    row('語速', rate), sel && row('聲音', sel),
    h('div', { class: 'row-gap' }, h('button', { class: 'btn', onclick: () => voice.speak('您好，我是小柯機器人，很高興為您服務。', { force: true }) }, '🔊 試聽')),
    h('p', { class: 'hint' }, voice.available ? `目前語音：${voice.voiceName}` : '找不到中文語音，可在 Windows 設定 → 時間與語言 → 語音 新增「中文（台灣）」語音'));
}

function tabAbout(host) {
  const info = S.sysInfo || {};
  fill(host,
    h('div', { class: 'about' }, h('img', { src: 'img/logo64.png', alt: '', width: 64, height: 64 }), h('div', {}, h('h3', {}, '小柯機器人SUNO工具'), h('p', { class: 'muted' }, `版本 ${info.version || ''}`), h('p', {}, '系統開發：吳玉柱 先生 與 Claude AI Opus 5.5'))),
    chk('開啟時自動檢查新版本', S.settings.autoUpdate, (v) => set({ autoUpdate: v })),
    h('div', { class: 'row-gap' }, h('button', { class: 'btn primary', onclick: () => openUpdate() }, '🔄 檢查更新')),
    h('p', { class: 'hint' }, '本工具為非官方工具，與 Suno 公司無關；只會下載您自己帳號裡有權限的歌曲，請遵守 Suno 的服務條款。'),
    h('p', { class: 'hint' }, 'SRT 時間校正規則參考 cityedge/suno_srt_downloader（MIT 授權）。'),
    info.userData && h('p', { class: 'hint' }, `資料位置：${info.userData}`));
}

// ---- 版本更新 ----
export async function checkUpdateQuiet() {
  try {
    const r = await xk.update.check();
    S.update = r;
    $('#btnUpdate')?.classList.toggle('dot', !!r.newer);
  } catch { /* 沒網路就算了 */ }
}

export async function openUpdate() {
  const box = h('div', { class: 'upd' }, h('p', {}, '檢查中…'));
  const m = modal({ title: '🔄 版本更新', body: box });
  let r;
  try { r = await xk.update.check(); } catch (e) { fill(box, h('p', {}, `無法檢查更新：${cleanErr(e)}`)); return; }
  S.update = r;
  $('#btnUpdate')?.classList.toggle('dot', !!r.newer);
  if (!r.newer) { fill(box, h('p', {}, `✅ 目前已是最新版（${r.current}）`)); return; }
  const bar = h('span', { style: { width: '0%' } });
  const progress = h('div', { class: 'bar lg', style: { display: 'none' } }, bar);
  const msg = h('p', { class: 'hint' });
  const go = h('button', { class: 'btn primary', id: 'updGo', onclick: async () => {
    go.disabled = true;
    if (!r.canInstall) { xk.update.openPage(); go.disabled = false; return; }
    progress.style.display = '';
    const off = xk.update.onProgress(({ got, total }) => { if (total) bar.style.width = (got / total) * 100 + '%'; msg.textContent = total ? `下載中 ${Math.round((got / total) * 100)}%` : `下載中 ${(got / 1048576).toFixed(1)} MB`; });
    try {
      const file = await xk.update.download();
      off();
      msg.textContent = '安裝中，完成後會自動重新開啟…';
      const out = await xk.update.install(file);
      if (out && out.manual) msg.textContent = `安裝檔已開啟：${out.path}`;
    } catch (e) { off(); go.disabled = false; msg.textContent = `更新失敗：${cleanErr(e)}`; }
  } }, r.canInstall ? '下載並安裝' : '前往下載頁');
  fill(box, h('p', {}, `有新版本 ${r.latest}（目前 ${r.current}）`), r.notes && h('pre', { class: 'notes' }, r.notes), progress, msg, h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => m.close() }, '稍後'), go));
}
