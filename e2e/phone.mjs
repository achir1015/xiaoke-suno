// Android 實機測試：透過 adb 連到除錯版 APK 的 WebView，用真正的 Suno 帳號跑一次
// 用法：python android/build.py debug → adb install → 手機解鎖 → node e2e/phone.mjs <帶到手機的登入碼檔案>
// 安全：只下載「已解鎖」的歌，allowUnlock=false，不會扣 Suno 下載次數
import { chromium } from 'playwright-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ADB = process.env.ADB || 'E:/AI Agent/Claude Code/tools/android-sdk/platform-tools/adb.exe';
const SERIAL = process.env.ANDROID_SERIAL || 'R5CY236CQ3B';
const PKG = 'com.achir.xiaokesuno';
const SONG = process.env.SONG || '草間清蓮迎曙光';
const pair = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8').trim() : '';
const outDir = 'e2e/out';
fs.mkdirSync(outDir, { recursive: true });
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const shotPhone = (name) => fs.writeFileSync(path.join(outDir, 'p-' + name + '.png'), execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('✔', name); } else { fail++; console.log('✘', name, extra); } };

if (/isKeyguardShowing=true|mDreamingLockscreen=true/.test(adb('shell', 'dumpsys', 'window'))) { console.log('手機鎖著，請先解鎖'); process.exit(2); }
adb('shell', 'pm', 'clear', PKG);
adb('shell', 'pm', 'grant', PKG, 'android.permission.CAMERA');
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await sleep(3500);
const sock = /@?(webview_devtools_remote_\d+)/.exec(adb('shell', 'cat', '/proc/net/unix'));
if (!sock) { console.log('找不到 WebView 偵錯通道（要用 python android/build.py debug 建置）'); process.exit(2); }
execFileSync(ADB, ['-s', SERIAL, 'forward', 'tcp:9337', 'localabstract:' + sock[1]]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('appassets'));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const waitFor = async (fn, arg, ms = 15000) => { const t = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => false); if (v) return v; if (Date.now() - t > ms) throw new Error('等待逾時：' + fn); await sleep(200); } };
const click = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('找不到 ' + s); e.click(); }, sel);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const X = (fn, arg) => page.evaluate(fn, arg);

try {
  await waitFor(() => document.documentElement.dataset.ready === '1');
  const info = await X(() => ({ android: !!window.XiaokeAndroid, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ver: JSON.parse(window.XiaokeAndroid.appInfo()).version, model: JSON.parse(window.XiaokeAndroid.appInfo()).model }));
  console.log('  ', JSON.stringify(info));
  check('在 Android App 裡執行（原生橋接）', info.android);
  check('版本號正確', info.ver === JSON.parse(fs.readFileSync('package.json', 'utf8')).version, info.ver);
  await waitFor(() => document.querySelector('.guide-modal'));
  check('第一次開啟自動顯示使用說明', true);
  const tts = await X(() => ({ ok: window.XiaokeAndroid.ttsAvailable(), voice: window.XiaokeAndroid.ttsVoice() }));
  console.log('   語音：', JSON.stringify(tts));
  check('語音說明可用（中文語音）', tts.ok);
  await sleep(1500);
  shotPhone('01-guide');
  await X(() => document.querySelector('.modal-head .icon-btn').click());
  check('底部分頁列', await X(() => document.querySelector('#side').getBoundingClientRect().top > innerHeight * 0.8));
  check('沒有左右捲動', await X(() => document.documentElement.scrollWidth <= innerWidth + 1));

  // Suno 網頁（原生 WebView 疊在畫面上）
  await click('#nav-suno');
  await sleep(2500);
  check('顯示「掃描電腦的 QR Code」', await X(() => !!document.querySelector('#snQR') && !document.querySelector('#snQR').hidden));
  shotPhone('02-suno');

  if (pair) {
    const r = await X((c) => import('./js/platform.js').then((m) => m.xk.suno.importPair(c)), pair);
    check('帶入電腦的 Suno 登入（Clerk 換權杖）', r && r.ok, JSON.stringify(r));
    await waitFor(() => document.querySelector('#sunoPill')?.classList.contains('ok'), null, 20000);
    check('上方顯示已登入', true);
    await sleep(3000);
    shotPhone('03-suno-login');
    await click('#nav-library');
    await click('#btnRefresh');
    await waitFor(() => document.querySelectorAll('#libList .song').length > 50, null, 90000);
    const n = await X(() => document.querySelectorAll('#libList .song').length);
    check(`讀取全部歌曲（${n} 首）`, n > 50);
    await waitFor(() => /剩 \d+/.test(document.querySelector('#quota')?.textContent || ''), null, 20000);
    const q0 = await text('#quota');
    console.log('   ', q0, '｜帳號：', await text('#sunoPill'));
    check('讀到 Suno 下載次數', /剩 \d+/.test(q0));
    shotPhone('04-library');
    const song = await X((t) => { const lib = [...document.querySelectorAll('#libList .song')]; const el = lib.find((e) => e.querySelector('.t').textContent.startsWith(t) && e.querySelector('.tag.unl')); return el ? el.dataset.id : null; }, SONG);
    check(`找到已解鎖的「${SONG}」`, !!song);
    if (song) {
      await X((id) => import('./js/platform.js').then((m) => m.xk.dl.add([id], ['mp3', 'srt'], { allowUnlock: false })), song);
      await click('#nav-queue');
      await waitFor(() => document.querySelector('.job') && !document.querySelector('.job.run, .job.wait'), null, 120000);
      const job = await X(() => import('./js/platform.js').then((m) => m.xk.dl.state()).then((s) => s.jobs[0]));
      console.log('   下載：', job.state, job.done.join(','), job.msg || '');
      shotPhone('05-queue');
      check('官方 MP3＋SRT 下載完成', job.state === 'done' && job.done.includes('mp3') && job.done.includes('srt'), JSON.stringify(job));
      const ls = adb('shell', 'ls', '-l', '/sdcard/Download/小柯SUNO/');
      console.log(ls.trim().split('\n').map((l) => '    ' + l).join('\n'));
      check('檔案在手機「下載/小柯SUNO」，檔名同 Suno', ls.includes(`${SONG}.mp3`) && ls.includes(`${SONG}.srt`));
      await click('#nav-library');
      await sleep(800);
      await waitFor(() => /剩 \d+/.test(document.querySelector('#quota')?.textContent || ''));
      const q1 = await text('#quota');
      check('下載次數沒有扣（已解鎖的歌）', q1 === q0, `${q0} → ${q1}`);
      // 邊聽邊看字幕：手機裡的 MP3＋SRT
      await X((id) => document.querySelector(`.song[data-id="${id}"] .cover`).click(), song);
      await waitFor(() => !document.querySelector('#player').hidden && document.querySelector('#kSeek'));
      await X(() => { const s = document.querySelector('#kSeek'); s.value = 9; s.dispatchEvent(new Event('change')); });
      await waitFor(() => document.querySelector('#kCur')?.classList.contains('on'), null, 12000);
      const cur = await text('#kCur');
      const t = await X(() => Number(document.querySelector('#kSeek').value));
      console.log('   播放到', t.toFixed(1), '秒，字幕：', cur);
      check('手機裡的 MP3 能播放、字幕跟著亮起', t > 8.5 && cur.length > 2);
      shotPhone('06-listen');
      await click('.k-btns .icon-btn:last-child');
    }
  }
  check('畫面沒有錯誤', errors.length === 0, errors.join('\n'));
} catch (e) {
  fail++;
  console.log('✘ 測試中斷：', e.message);
  console.log(errors.join('\n'));
  shotPhone('99-error');
}
await browser.close().catch(() => {});
execFileSync(ADB, ['-s', SERIAL, 'forward', '--remove', 'tcp:9337']);
console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
