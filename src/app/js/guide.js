// 使用說明：文字＋語音朗讀（進來就自動念、念完自動下一課）、示意圖、「指給我看」聚光燈
import { h, fill, $ } from './util.js';
import { modal } from './ui.js';
import { voice } from './voice.js';
import { go } from './app.js';

// 每一課：標題、內文（會被念出來）、示意圖亮哪一塊、「指給我看」的目標與要先切到的分頁
export const LESSONS = [
  { t: '歡迎使用', hl: 'all', target: null,
    m: ['您好，我是小柯機器人！這個工具可以把您在 Suno 做的歌，一次批量下載成 MP3 音檔和 SRT 字幕，檔名和 Suno 上的歌名一模一樣，存在手機的「下載/小柯SUNO」資料夾。',
      '畫面下方是分頁：歌曲庫、Suno 網頁、下載佇列和小柯助手；上面有使用說明、檢查更新和設定。接下來我一課一課帶您看。'],
    p: ['您好，我是小柯機器人！這個工具可以把您在 Suno 做的歌，一次批量下載成 MP3 音檔和 SRT 字幕，檔名和 Suno 上的歌名一模一樣，剪影片、做卡拉 OK 都很方便。',
      '畫面左邊是選單：歌曲庫、Suno 網頁、下載佇列；上面有使用說明、檢查更新和設定。接下來我一課一課帶您看。'] },
  { t: '登入 Suno', hl: 'side', target: '#nav-suno', view: 'suno',
    m: ['用 Google 帳號的話，Google 不允許在 App 裡面登入。請在電腦版小柯的「Suno 網頁」按「帶到手機」，電腦會顯示一個 QR Code。',
      '再到手機的「Suno 網頁」按「掃描電腦的 QR Code」，對準電腦畫面，就登入好了，雲端設定也會一起帶過來。用電子郵件等其他方式，也可以直接在 App 裡面登入。'],
    p: ['第一步，按左邊的「Suno 網頁」。這是 App 裡面的 Suno 網站，請在這裡登入您的 Suno 帳號。帳號密碼是直接交給 Suno 的，小柯看不到。',
      '如果您是用 Google 帳號登入，Google 不允許在 App 裡面登入，請按右上角的「用 Chrome 登入」：小柯會打開一個 Chrome 視窗，在那裡登入 Suno，看到自己的歌後關掉視窗，登入狀態就會自動帶進來。登入一次就會記住，右上角會顯示您的 Suno 名稱。'] },
  { t: '讀取全部歌曲', hl: 'tools', target: '#btnRefresh', view: 'library',
    p: ['回到「歌曲庫」，按右上角的「讀取我的全部歌曲」，小柯會把您 Suno 帳號裡的歌全部列出來，包含封面、風格、長度和歌詞。',
      '歌很多的時候要等一兩分鐘，按鈕上會顯示已經讀到幾首。'] },
  { t: '抓取工作區或播放清單', hl: 'tools', target: '#snScan', view: 'suno',
    p: ['只想下載某個工作區或播放清單的歌嗎？在「Suno 網頁」打開那一頁，按「抓取這一頁的歌曲」，小柯會自動往下捲，把整頁的歌都抓進來，而且幫您勾選好。',
      '另外，您在 Suno 網頁瀏覽過的歌，也會自動加進歌曲庫。打開單首歌的頁面時，還可以直接按「下載這首」。'] },
  { t: '搜尋與篩選', hl: 'tools', target: '#q', view: 'library',
    p: ['搜尋框可以找歌名、風格，甚至歌詞裡的一句話。旁邊可以只看未下載、已下載、有歌詞、純音樂或按讚的歌，也可以換排序。',
      '點歌曲封面可以直接試聽，點歌名會打開詳細資料，看完整歌詞和字幕預覽。'] },
  { t: '邊聽邊看字幕', hl: 'body', target: '#libList .cover', view: 'library',
    p: ['點歌曲的封面就會開始播放，畫面最下面的播放列會跟著歌聲一句一句亮起歌詞，就是 SRT 字幕的時間，可以馬上確認字幕對不對得上。按麥克風圖案可以放大成卡拉 OK 畫面，點任何一句就跳到那裡。',
      '已經下載的歌，播放的是電腦裡的 MP3 和下載好的 SRT 檔；還沒下載的歌，就用 Suno 線上的聲音和即時產生的字幕。在歌曲詳細資料裡調整「提早幾秒」，字幕也會馬上跟著變。'] },
  { t: '批量下載 MP3 與 SRT', hl: 'body', target: '#btnDownload', view: 'library',
    p: ['勾選想要的歌，或按「全選」，再按「下載所選」。上面的小按鈕可以選格式：MP3 音檔、SRT 字幕、LRC 卡拉 OK 歌詞、純文字歌詞、封面圖，付費方案還可以下載 WAV 無損音質。',
      '檔名會和 Suno 上的歌名一樣。Suno 常常一次做兩首同名的歌，第二首會自動加上 (1)，而且同一首歌的 MP3 和 SRT 一定同名，剪輯軟體一拖就對得上。',
      '要注意：Suno 現在下載 MP3 或 WAV 要先「解鎖」，每首用掉 1 次方案的下載次數，解鎖過的歌以後隨時可以再下載、不會重複扣。下載列會顯示還剩幾次；有歌還沒解鎖時，小柯會先問您，也可以選「只下載已解鎖的」。SRT 字幕不用解鎖。'] },
  { t: 'SRT 字幕時間', hl: 'tools', target: '#offset', view: 'library',
    p: ['SRT 字幕是用 Suno 的對時歌詞做的。「字幕提早」可以讓字幕比歌聲早一點點出現，觀眾比較跟得上，建議 0.1 秒。',
      '小提醒：在 Suno 上修改過歌詞的歌，對時會變得比較不準，最好在改歌詞之前下載字幕。下載後可以在詳細資料裡預覽，有問題就加上「字幕待修」標記。'] },
  { t: '下載佇列', hl: 'side', target: '#nav-queue', view: 'queue',
    p: ['按下載以後，到「下載佇列」可以看到每一首的進度。可以暫停、全部取消，失敗的按「重試失敗的」再下載一次。',
      '關閉小柯的時候，如果還在下載，會先問您要不要繼續；關閉以後所有下載都會停止，已完成的檔案會留著。'] },
  { t: '標記、小圖案與顏色', hl: 'side', target: '#btnMarks', view: 'library',
    p: ['左邊的「標記」可以幫歌分類，例如最愛、影片用、字幕待修。按「管理標記」可以新增標記，點圓形換小圖案和顏色。',
      '在設定的「外觀與顏色」，還可以換深色或淺色畫面，以及整個工具的主題色。'] },
  { t: '小柯助手', hl: 'side', target: '#btnAgent', view: 'library',
    p: ['左下角的「小柯助手」是 AI 幫手。您可以直接說：幫我下載所有標題有「愛」的歌、列出還沒下載字幕的歌、幫我寫一首台語歌的歌詞和 Suno 風格提示。',
      '第一次使用要在設定的「AI 助手」貼上 OpenAI 金鑰。金鑰會加密保存在這台電腦，費用由您的 OpenAI 帳戶計算。'] },
  { t: '雲端儲存', hl: 'top', target: '#cloudPill', view: 'library',
    p: ['在設定的「雲端儲存」貼上設定碼，歌曲清單和標記就會存到您自己的 Google 雲端硬碟，換電腦也能接著用。',
      '還可以勾選下載完成後自動備份 SRT 或 MP3 到雲端硬碟的「小柯SUNO」資料夾。'] },
  { t: '版本更新', hl: 'top', target: '#btnUpdate', view: 'library',
    p: ['小柯每次開啟都會自動檢查新版本。有新版本時「檢查更新」會出現小紅點，按一下就會自動下載、安裝並重新開啟，歌曲庫和設定都不會受影響。',
      '有任何問題，隨時按「使用說明」或鍵盤上的 F1 再聽一次。祝您創作愉快！'] },
];

function art(hl) {
  const on = (k) => (hl === k || hl === 'all' ? 'on' : '');
  return `<svg viewBox="0 0 320 180" class="guide-art">
  <rect x="2" y="2" width="316" height="176" rx="10" class="frame"/>
  <rect x="8" y="8" width="304" height="20" rx="6" class="blk ${on('top')}"/>
  <rect x="8" y="34" width="62" height="138" rx="6" class="blk ${on('side')}"/>
  ${[44, 58, 72].map((y) => `<rect x="14" y="${y}" width="50" height="8" rx="3" class="ln"/>`).join('')}
  <rect x="14" y="150" width="50" height="14" rx="4" class="blk2"/>
  <rect x="76" y="34" width="236" height="30" rx="6" class="blk ${on('tools')}"/>
  <rect x="84" y="42" width="90" height="12" rx="4" class="blk2"/><rect x="250" y="42" width="54" height="14" rx="4" class="acc"/>
  <rect x="76" y="70" width="236" height="102" rx="6" class="blk ${on('body')}"/>
  ${[78, 98, 118, 138, 158].map((y) => `<rect x="84" y="${y}" width="12" height="12" rx="3" class="blk2"/><rect x="102" y="${y}" width="16" height="12" rx="3" class="acc"/><rect x="124" y="${y + 2}" width="${110 + (y % 40)}" height="8" rx="3" class="ln"/>`).join('')}
</svg>`;
}

let state = { i: 0, auto: true };

export function openGuide(start) {
  // 手機版有些課用不同的說法（m）
  const list0 = document.documentElement.classList.contains('mobile') ? LESSONS.map((l) => ({ ...l, p: l.m || l.p })) : LESSONS;
  if (typeof start === 'number') state.i = start;
  let alive = true, token = 0;
  const list = h('div', { class: 'g-list' });
  const pic = h('div', { class: 'g-art' });
  const title = h('h3');
  const text = h('div', { class: 'g-text' });
  const playBtn = h('button', { class: 'btn', id: 'guidePlay' });
  const autoChk = h('input', { type: 'checkbox', checked: state.auto, onchange: () => { state.auto = autoChk.checked; } });
  const showBtn = h('button', { class: 'btn', id: 'guideShow', onclick: () => pointAt() }, '👉 指給我看');
  const prev = h('button', { class: 'btn', onclick: () => goto(state.i - 1) }, '◀ 上一課');
  const next = h('button', { class: 'btn primary', id: 'guideNext' }, '下一課 ▶');
  const novoice = h('div', { class: 'hint g-novoice' });

  const renderList = () => fill(list, ...list0.map((l, i) => h('button', { class: `g-item ${i === state.i ? 'on' : ''}`, onclick: () => goto(i) }, h('span', { class: 'n' }, String(i + 1)), l.t)));
  const setPlaying = (p) => { playBtn.textContent = p ? '⏸ 停止朗讀' : '🔊 朗讀這一課'; playBtn.dataset.on = p ? '1' : ''; };

  async function speakLesson(force) {
    const my = ++token;
    setPlaying(true);
    const L = list0[state.i];
    const paras = [...text.children];
    for (let k = 0; k < L.p.length; k++) {
      if (!alive || my !== token) return;
      paras.forEach((p, j) => p.classList.toggle('reading', j === k));
      await voice.speak((k === 0 ? `第${state.i + 1}課，${L.t}。` : '') + L.p[k], { force });
    }
    if (!alive || my !== token) return;
    paras.forEach((p) => p.classList.remove('reading'));
    setPlaying(false);
    if (state.auto && state.i < list0.length - 1) { await new Promise((r) => setTimeout(r, 700)); if (alive && my === token) goto(state.i + 1); }
  }
  function stop() { token++; voice.stop(); setPlaying(false); for (const p of text.children) p.classList.remove('reading'); }
  playBtn.onclick = () => { if (playBtn.dataset.on) stop(); else speakLesson(true); };

  function goto(i, speak = true) {
    if (i < 0 || i >= list0.length) return;
    stop();
    state.i = i;
    const L = list0[i];
    renderList();
    pic.innerHTML = art(L.hl);
    title.textContent = `第 ${i + 1} 課　${L.t}`;
    fill(text, ...L.p.map((p) => h('p', {}, p)));
    prev.disabled = i === 0;
    next.textContent = i === list0.length - 1 ? '看完了 ✔' : '下一課 ▶';
    next.onclick = () => (i === list0.length - 1 ? m.close(true) : goto(i + 1));
    showBtn.style.visibility = L.target ? '' : 'hidden';
    if (speak && voice.enabled) speakLesson();
  }

  // 暫時收起說明視窗、切到該分頁，把目標框起來
  async function pointAt() {
    const L = list0[state.i];
    stop();
    m.card.parentElement.style.display = 'none';
    if (L.view) { go(L.view); await new Promise((r) => setTimeout(r, 120)); }
    const el = L.target && $(L.target);
    if (el) await spotlight(el, L.t, L.p[0]);
    m.card.parentElement.style.display = '';
  }

  const body = h('div', { class: 'guide' },
    list,
    h('div', { class: 'g-main' },
      h('div', { class: 'g-top' }, h('img', { src: 'img/logo64.png', width: 48, height: 48, alt: '' }), title),
      pic, text, novoice,
      h('div', { class: 'g-ctrl' }, playBtn, showBtn, h('label', { class: 'chk' }, autoChk, '念完自動下一課'), h('span', { class: 'sp' }), prev, next)));
  const m = modal({ title: '📖 使用說明（小柯機器人語音導覽）', body, wide: true, cls: 'guide-modal', onClose: () => { alive = false; stop(); } });
  if (!voice.available) novoice.textContent = '※ 找不到中文語音，只能看文字。可在 Windows 設定 → 時間與語言 → 語音 新增「中文（台灣）」語音。';
  else if (!voice.enabled) novoice.textContent = '※ 語音朗讀已在設定中關閉，按「朗讀這一課」仍可播放。';
  goto(state.i, true);
  return m.done;
}

// 聚光燈：把某個元件以外的地方變暗，旁邊顯示說明泡泡
export function spotlight(el, title, text) {
  return new Promise((resolve) => {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const pad = 6;
    const hole = h('div', { class: 'spot-hole', style: { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' } });
    const tip = h('div', { class: 'spot-tip' }, h('img', { src: 'img/logo64.png', width: 40, height: 40, alt: '' }), h('div', {}, h('b', {}, title), h('p', {}, text), h('small', {}, '點一下任何地方回到說明')));
    const ov = h('div', { class: 'spot' }, hole, tip);
    document.body.append(ov);
    const below = r.bottom + 180 < innerHeight;
    tip.style.left = Math.max(12, Math.min(innerWidth - 380, r.left)) + 'px';
    tip.style.top = (below ? r.bottom + 16 : Math.max(12, r.top - 16 - tip.offsetHeight)) + 'px';
    voice.speak('在這裡。' + text);
    const end = () => { voice.stop(); ov.remove(); removeEventListener('keydown', key, true); resolve(); };
    const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); end(); } };
    ov.addEventListener('click', end);
    addEventListener('keydown', key, true);
  });
}
