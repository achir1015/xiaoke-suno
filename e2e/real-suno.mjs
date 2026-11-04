// 用真正的 Suno 帳號實測（開發版＋獨立設定檔 realtest，不影響使用者的 App）
// 登入狀態借用 %APPDATA%\xiaoke-suno\chrome-login（使用者之前「用 Chrome 登入」的設定檔）
// 安全：只下載「已解鎖」的歌，而且 allowUnlock=false，程式不會呼叫解鎖，不會扣 Suno 下載次數
// 用法：node e2e/real-suno.mjs [歌名]
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = process.argv[2] || '草間清蓮迎曙光';
const appData = process.env.APPDATA;
const userData = path.join(appData, 'xiaoke-suno-realtest');
const src = path.join(appData, 'xiaoke-suno', 'chrome-login');
if (!fs.existsSync(src)) { console.log('找不到 Chrome 登入設定檔，請先在 App 用 Chrome 登入'); process.exit(1); }
fs.rmSync(userData, { recursive: true, force: true });
fs.cpSync(src, path.join(userData, 'chrome-login'), { recursive: true, filter: (p) => !/(Cache|Code Cache|GPUCache|Service Worker|DevToolsActivePort|Singleton)/i.test(p) });
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'xks-real-'));

const app = await electron.launch({
  executablePath: require('electron'), args: ['.', '--profile=realtest', '--hidden'],
  env: { ...process.env, XIAOKE_SUNO_DIR: DL, XIAOKE_CHROME_ARGS: '--window-position=-4000,0 --window-size=900,700' },
});
let win = null;
for (let i = 0; i < 200 && !win; i++) { win = app.windows().find((w) => w.url().startsWith('app://')); if (!win) await sleep(100); }
const ev = (fn, arg) => win.evaluate(fn, arg);
try {
  await ev(() => new Promise((r) => { const t = setInterval(() => { if (document.documentElement.dataset.ready === '1') { clearInterval(t); r(); } }, 100); }));
  // 用 Chrome 登入：設定檔已經登入，開起來就關掉，把登入狀態帶進 App
  const login = ev(() => window.xk.suno.chromeLogin());
  await sleep(6000);
  await ev(() => window.xk.suno.chromeDone());
  const lr = await login;
  console.log('登入：', lr.ok ? '成功' : '失敗', lr.error || '', JSON.stringify(lr.user || {}));
  if (!lr.ok) throw new Error('沒有登入');
  const q = await ev(() => window.xk.suno.quota());
  console.log('下載次數：', JSON.stringify(q));
  const r = await ev(() => window.xk.lib.refresh({}));
  console.log('讀取歌曲：', r.total, '首');
  const songs = await ev(() => window.xk.lib.list());
  const unlocked = songs.filter((s) => s.unlocked);
  console.log('已解鎖：', unlocked.length, '首 →', unlocked.map((s) => s.title).join('、'));
  const s = songs.find((x) => x.title === want && x.unlocked);
  if (!s) throw new Error(`找不到已解鎖的「${want}」，為了不扣次數不下載`);
  console.log('測試歌曲：', s.title, s.id, '長度', s.duration, '秒');
  await ev(([id]) => window.xk.dl.add([id], ['mp3', 'srt'], { allowUnlock: false }), [s.id]);
  let snap;
  for (let i = 0; i < 120; i++) { snap = await ev(() => window.xk.dl.state()); if (!snap.jobs.some((j) => j.state === 'run' || j.state === 'wait')) break; await sleep(1000); }
  const j = snap.jobs[0];
  console.log('下載結果：', j.state, '完成', j.done.join(','), j.msg ? '｜' + j.msg : '');
  for (const f of fs.readdirSync(DL)) console.log('  檔案：', f, Math.round(fs.statSync(path.join(DL, f)).size / 1024), 'KB');
  const q2 = await ev(() => window.xk.suno.quota());
  console.log('下載後次數：', q2.remaining, q2.remaining === q.remaining ? '（沒有扣）' : '（變了！）');
  // 邊聽邊看字幕：本機 MP3＋本機 SRT
  const p = await ev(([id]) => window.xk.lib.play(id), [s.id]);
  console.log('試聽來源：', p.localAudio ? '本機 MP3' : p.audioSrc, '｜字幕', p.lyricSrc, p.lines.length, '句｜前三句：', p.lines.slice(0, 3).map((l) => `${l.start.toFixed(2)} ${l.text}`).join(' / '));
  console.log('DIR', DL);
} catch (e) {
  console.log('✘', e.message);
} finally {
  await app.close().catch(() => {});
}
