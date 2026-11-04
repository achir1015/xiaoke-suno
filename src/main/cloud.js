'use strict';
// 雲端儲存：Google Apps Script（「小柯上傳」專案的 suno.gs）
// 歌曲清單與標記用紀錄層級同步（修改時間新的贏）；SRT、MP3 可以備份到雲端硬碟「小柯SUNO」資料夾
const fs = require('fs');
const path = require('path');

function encodePairing(url, token) { return 'XKS1.' + Buffer.from(JSON.stringify({ url, token }), 'utf8').toString('base64'); }
function decodePairing(code) {
  const m = /^XKS1\.([A-Za-z0-9+/=_-]+)$/.exec(String(code || '').trim());
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return o && /^https:\/\/script\.google(usercontent)?\.com\//.test(o.url) && o.token ? o : null;
  } catch { return null; }
}

class Cloud {
  constructor({ getConf, setConf, lib, onState }) {
    this.getConf = getConf; // → { url, token, cursor, pushed }
    this.setConf = setConf;
    this.lib = lib;
    this.onState = onState || (() => {});
    this.st = { status: 'off', at: 0, error: '' };
    this.busy = null;
  }

  state() { return { ...this.st }; }
  set(s) { this.st = { ...this.st, ...s }; this.onState(this.state()); }

  async post(body, timeoutMs = 60000) {
    const { url, token } = this.getConf();
    if (!url || !token) throw new Error('還沒有設定雲端儲存');
    const sep = url.includes('?') ? '&' : '?';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}${sep}app=suno`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, ...body }), redirect: 'follow', signal: ctl.signal });
      const text = await res.text();
      let r;
      try { r = JSON.parse(text); } catch {
        if (/forbidden|找不到|not found/i.test(text) || res.status === 404) throw new Error('雲端程式還沒更新，請先在 Apps Script 加入 suno.gs 並部署新版本');
        throw new Error(`雲端回應不正確（${res.status}）`);
      }
      if (!r.ok) throw new Error(r.error || '雲端回應錯誤');
      return r;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('雲端連線逾時');
      throw e;
    } finally { clearTimeout(t); }
  }

  // 只同步「這首歌是什麼」與「標記」，不含電腦上的檔案路徑
  record(c) {
    const { id, title, audio, image, thumb, duration, tags, lyrics, created, artist, handle, model, instrumental, liked } = c;
    return { id, title, audio, image, thumb, duration, tags, lyrics: String(lyrics || '').slice(0, 6000), created, artist, handle, model, instrumental, liked, marks: this.lib.data.marks[id] || [] };
  }

  async sync() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.set({ status: 'busy' });
      try {
        const conf = this.getConf();
        const pushed = Number(conf.pushed) || 0;
        const changes = Object.values(this.lib.data.clips).filter((c) => (c.u || 0) > pushed).map((c) => ({ k: 'song', id: c.id, u: c.u || Date.now(), r: this.record(c) }));
        const started = Date.now();
        let sent = 0, applied = 0, cursor = Number(conf.cursor) || 0;
        // 一次最多送 300 筆，避免超過 Apps Script 的請求大小
        for (let i = 0; i === 0 || i < changes.length; i += 300) {
          const part = changes.slice(i, i + 300);
          const r = await this.post({ action: 'sync', since: cursor, changes: part });
          sent += part.length;
          for (const x of r.changes || []) {
            if (x.k !== 'song' || !x.r || !x.r.id) continue;
            const cur = this.lib.data.clips[x.id];
            if (cur && (cur.u || 0) >= x.u) continue;
            const { marks, ...rest } = x.r;
            this.lib.data.clips[x.id] = { ...cur, ...rest, seen: (cur && cur.seen) || x.u, src: (cur && cur.src) || 'cloud', u: x.u };
            if (marks && marks.length) this.lib.data.marks[x.id] = marks; else delete this.lib.data.marks[x.id];
            applied++;
          }
          cursor = r.seq || cursor;
        }
        this.lib.save();
        this.setConf({ cursor, pushed: started });
        this.set({ status: 'ok', at: Date.now(), error: '' });
        return { sent, applied };
      } catch (e) {
        this.set({ status: 'error', error: String(e.message || e) });
        throw e;
      } finally { this.busy = null; }
    })();
    return this.busy;
  }

  // 備份一個檔案到雲端硬碟（同名覆蓋）。Apps Script 單次請求上限約 50MB
  async upload(kind, file) {
    const buf = fs.readFileSync(file);
    if (buf.length > 35 * 1024 * 1024) throw new Error('檔案太大，無法備份到雲端');
    const mime = { mp3: 'audio/mpeg', srt: 'application/x-subrip', lrc: 'text/plain', txt: 'text/plain', jpg: 'image/jpeg', wav: 'audio/wav' }[kind] || 'application/octet-stream';
    return this.post({ action: 'upload', folder: kind.toUpperCase(), name: path.basename(file), mime, data: buf.toString('base64') }, 180000);
  }
}

module.exports = { Cloud, encodePairing, decodePairing };
