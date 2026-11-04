'use strict';
// 用 Chrome 登入：Google 不允許在 App 內建的網頁登入，所以開一個真正的 Chrome（獨立的設定檔）讓使用者登入 Suno，
// 使用者關掉那個 Chrome 後，再用無畫面的 Chrome 讀出 Suno 的登入 cookie，帶進 App 的內建網頁
// 登入時 Chrome 是一般模式（沒有遠端除錯），Google 看到的就是普通的 Chrome
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function findBrowser() {
  const env = process.env;
  const list = process.platform === 'win32' ? [
    [path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
    [path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
  ] : process.platform === 'darwin' ? [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
    [path.join(env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Chrome'],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
  ] : [['/usr/bin/google-chrome', 'Chrome'], ['/usr/bin/chromium', 'Chromium'], ['/usr/bin/microsoft-edge', 'Edge']];
  const hit = list.find(([p]) => p && fs.existsSync(p));
  return hit ? { exe: hit[0], name: hit[1] } : null;
}

const BASE_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic'];

class ChromeLogin {
  constructor(profileDir) { this.dir = profileDir; this.child = null; }

  get browser() { return findBrowser(); }

  // 打開 Chrome 讓使用者登入；Chrome 關掉時 resolve
  open(url, extra = []) {
    const b = findBrowser();
    if (!b) throw new Error('找不到 Chrome 或 Edge，請先安裝 Google Chrome');
    if (this.child) throw new Error('Chrome 登入視窗已經開著了');
    fs.mkdirSync(this.dir, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(b.exe, [...BASE_ARGS, ...extra, `--user-data-dir=${this.dir}`, '--new-window', url], { stdio: 'ignore' });
      this.child = child;
      child.once('error', (e) => { this.child = null; reject(e); });
      child.once('exit', () => { this.child = null; resolve(b.name); });
    });
  }

  // 「我登入好了」：請 Chrome 正常關閉（讓它把 cookie 寫進硬碟），不是強制結束
  close() {
    const c = this.child;
    if (!c) return;
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(c.pid)], () => {}); // 不加 /F、/T：送出關閉視窗訊息，Chrome 會先存好 cookie
    else try { c.kill('SIGTERM'); } catch {}
    setTimeout(() => { if (this.child === c) try { c.kill('SIGKILL'); } catch {} }, 15000);
  }

  // 用無畫面的 Chrome 開同一個設定檔，透過 DevTools 協定讀出 cookie
  async cookies(match = /(^|\.)suno\.(com|ai)$|clerk/i) {
    const b = findBrowser();
    if (!b) throw new Error('找不到 Chrome 或 Edge');
    const portFile = path.join(this.dir, 'DevToolsActivePort');
    try { fs.unlinkSync(portFile); } catch {}
    const child = spawn(b.exe, [...BASE_ARGS, '--headless=new', `--user-data-dir=${this.dir}`, '--remote-debugging-port=0', '--remote-allow-origins=*', 'about:blank'], { stdio: 'ignore' });
    try {
      let info = null;
      for (let i = 0; i < 150 && !info; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { const [port, p] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/); if (port && p) info = { port, p }; } catch {}
      }
      if (!info) throw new Error('讀取 Chrome 登入資料逾時');
      const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.p}`);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('連不上 Chrome')); });
      const call = (id, method, params = {}) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('Chrome 沒有回應')), 10000);
        ws.addEventListener('message', function on(ev) {
          const m = JSON.parse(ev.data);
          if (m.id !== id) return;
          clearTimeout(t);
          ws.removeEventListener('message', on);
          if (m.error) rej(new Error(m.error.message)); else res(m.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
      const r = await call(1, 'Storage.getCookies');
      await call(2, 'Browser.close').catch(() => {});
      try { ws.close(); } catch {}
      return (r.cookies || []).filter((c) => match.test(String(c.domain).replace(/^\./, '')));
    } finally {
      setTimeout(() => { try { child.kill(); } catch {} }, 3000);
    }
  }
}

// DevTools 的 cookie → Electron session.cookies.set 的格式
function toElectronCookie(c) {
  const host = String(c.domain).replace(/^\./, '');
  const out = { url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (String(c.domain).startsWith('.')) out.domain = c.domain;
  if (c.expires && c.expires > 0 && !c.session) out.expirationDate = c.expires;
  const ss = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite];
  if (ss) out.sameSite = ss;
  return out;
}

module.exports = { ChromeLogin, findBrowser, toElectronCookie };
