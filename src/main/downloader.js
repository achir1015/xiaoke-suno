'use strict';
// 歌曲庫（看過的歌、下載紀錄、標記）與批量下載佇列
const path = require('path');
const fs = require('fs');
const srt = require('./srt');
const { pickBase, existingBases } = require('./naming');

const FORMATS = ['mp3', 'srt', 'lrc', 'txt', 'jpg', 'wav'];
const EXT_OF = { mp3: 'mp3', srt: 'srt', lrc: 'lrc', txt: 'txt', jpg: 'jpg', wav: 'wav' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Library {
  constructor(file) {
    this.file = file;
    this.data = { clips: {}, files: {}, marks: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { clips: raw.clips || {}, files: raw.files || {}, marks: raw.marks || {} };
    } catch (e) {
      if (e.code !== 'ENOENT') try { fs.copyFileSync(file, file + '.broken'); } catch {}
    }
    this.timer = null;
  }

  save(now) {
    clearTimeout(this.timer);
    const go = () => { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeAtomic(this.file, JSON.stringify(this.data)); } catch {} };
    if (now) go(); else this.timer = setTimeout(go, 800);
  }

  // 加入或更新歌曲；回傳新加入的數量
  upsert(clips, src) {
    let added = 0;
    const now = Date.now();
    for (const c of clips) {
      const old = this.data.clips[c.id];
      if (!old) added++;
      // 有些 API 回應沒有歌詞：不要用空白蓋掉之前拿到的
      const next = { ...old, ...c, lyrics: c.lyrics || (old && old.lyrics) || '', seen: (old && old.seen) || now, src: (old && old.src) || src };
      // 內容真的有變才更新修改時間（雲端同步只送有變的）
      const same = old && ['title', 'audio', 'image', 'duration', 'tags', 'lyrics', 'liked', 'unlocked'].every((k) => old[k] === next[k]);
      next.u = same ? old.u : now;
      this.data.clips[c.id] = next;
    }
    if (clips.length) this.save();
    return added;
  }

  remove(ids) {
    for (const id of ids) { delete this.data.clips[id]; delete this.data.marks[id]; }
    this.save();
  }

  setMarks(ids, markId, on) {
    for (const id of ids) {
      const set = new Set(this.data.marks[id] || []);
      if (on) set.add(markId); else set.delete(markId);
      if (set.size) this.data.marks[id] = [...set]; else delete this.data.marks[id];
      if (this.data.clips[id]) this.data.clips[id].u = Date.now();
    }
    this.save();
  }

  // 下載紀錄裡的檔案若已被刪掉，就不再算「已下載」
  fileState(id) {
    const f = this.data.files[id];
    if (!f) return null;
    const out = { dir: f.dir, base: f.base, at: f.at };
    for (const k of FORMATS) if (f[k] && fs.existsSync(f[k])) out[k] = f[k];
    return out;
  }

  list() {
    return Object.values(this.data.clips).map((c) => ({ ...c, files: this.fileState(c.id), marks: this.data.marks[c.id] || [] }));
  }
}

class Downloader {
  constructor({ lib, suno, getSettings, onUpdate, afterFile, fetcher }) {
    this.lib = lib;
    this.suno = suno;
    this.getSettings = getSettings;
    this.onUpdate = onUpdate || (() => {});
    this.afterFile = afterFile;
    this.fetcher = fetcher; // (url) → Response（用 Suno 的網頁工作階段）
    this.jobs = [];
    this.running = 0;
    this.paused = false;
    this.seq = 0;
    this.emitTimer = null;
    this.ctl = new AbortController();
  }

  snapshot() {
    return {
      paused: this.paused,
      jobs: this.jobs.map(({ key, id, title, formats, state, step, pct, msg, done, failed, base, dir }) => ({ key, id, title, formats, state, step, pct, msg, done, failed, base, dir })),
    };
  }

  emit(now) {
    if (now) { clearTimeout(this.emitTimer); this.emitTimer = null; this.onUpdate(this.snapshot()); return; }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.onUpdate(this.snapshot()); }, 150);
  }

  // 加入佇列；同一首還在等或下載中就不重複加
  // allowUnlock：使用者同意這批「還沒解鎖」的歌用掉下載次數（MP3／WAV 走 Suno 官方下載）
  add(ids, formats, { allowUnlock = false } = {}) {
    formats = FORMATS.filter((f) => formats.includes(f));
    if (!formats.length) throw new Error('請至少選一種要下載的格式');
    let n = 0;
    for (const id of ids) {
      const clip = this.lib.data.clips[id];
      if (!clip) continue;
      if (this.jobs.some((j) => j.id === id && (j.state === 'wait' || j.state === 'run'))) continue;
      this.jobs.push({ key: ++this.seq, id, title: clip.title, formats, allowUnlock: !!allowUnlock, state: 'wait', step: '', pct: 0, msg: '', done: [], failed: [] });
      n++;
    }
    this.emit(true);
    this.pump();
    return n;
  }

  pause(v) { this.paused = !!v; this.emit(true); if (!this.paused) this.pump(); }

  cancelAll() {
    this.ctl.abort();
    this.ctl = new AbortController();
    for (const j of this.jobs) if (j.state === 'wait' || j.state === 'run') { j.state = 'cancel'; j.msg = '已取消'; }
    this.emit(true);
  }

  clearDone() { this.jobs = this.jobs.filter((j) => j.state === 'wait' || j.state === 'run'); this.emit(true); }

  retryFailed() {
    for (const j of this.jobs) if (j.state === 'error' || j.state === 'cancel' || (j.state === 'done' && j.failed.length)) {
      j.formats = j.state === 'done' ? j.failed.map((f) => f.split(':')[0]) : j.formats;
      Object.assign(j, { state: 'wait', step: '', pct: 0, msg: '', done: [], failed: [] });
    }
    this.emit(true);
    this.pump();
  }

  pump() {
    const max = Math.max(1, Math.min(4, Number(this.getSettings().download.parallel) || 2));
    while (!this.paused && this.running < max) {
      const j = this.jobs.find((x) => x.state === 'wait');
      if (!j) break;
      this.running++;
      j.state = 'run';
      this.runJob(j, this.ctl.signal).catch((e) => { if (j.state !== 'cancel') { j.state = 'error'; j.msg = String(e.message || e); } })
        .finally(() => { this.running--; this.emit(true); this.lib.save(); this.pump(); });
    }
  }

  folderFor(dl, fmt) {
    if (!dl.subfolders) return dl.dir;
    return path.join(dl.dir, { mp3: 'MP3', srt: 'SRT', lrc: 'LRC', txt: '歌詞', jpg: '封面', wav: 'WAV' }[fmt]);
  }

  // 這首歌的檔名：之前下載過（同一個資料夾）就沿用，MP3 與 SRT 一定同名
  baseFor(clip, dl) {
    const reg = this.lib.data.files[clip.id];
    if (reg && reg.dir === dl.dir && reg.base) return reg.base;
    const exts = FORMATS.map((f) => EXT_OF[f]);
    const onDisk = new Set();
    for (const f of FORMATS) for (const b of existingBases(this.folderFor(dl, f), exts)) onDisk.add(b);
    const usedByOthers = new Set(Object.entries(this.lib.data.files).filter(([id, f]) => id !== clip.id && f.dir === dl.dir).map(([, f]) => String(f.base).toLowerCase()));
    const busy = new Set(this.jobs.filter((j) => j.id !== clip.id && j.base && j.dir === dl.dir && (j.state === 'run')).map((j) => j.base.toLowerCase()));
    return pickBase(clip, dl.dupe, (b) => { const k = b.toLowerCase(); return onDisk.has(k) || usedByOthers.has(k) || busy.has(k); });
  }

  async fetchTo(url, file, signal, onPct) {
    const res = await this.fetcher(url, { signal });
    if (!res.ok || !res.body) throw new Error(`下載失敗（${res.status}）`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        if (signal.aborted) throw new Error('已取消');
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (total && onPct) onPct(got / total);
      }
    } catch (e) {
      out.destroy();
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    await new Promise((r) => out.end(r));
    if (got < 1000 && /\.(mp3|wav|jpg)$/.test(file)) { try { fs.unlinkSync(tmp); } catch {} throw new Error('檔案內容不完整'); }
    if (total && got < total) { try { fs.unlinkSync(tmp); } catch {} throw new Error('下載不完整'); }
    fs.renameSync(tmp, file);
  }

  async runJob(j, signal) {
    const S = this.getSettings();
    const dl = S.download;
    const clip = this.lib.data.clips[j.id];
    if (!clip) throw new Error('歌曲庫裡找不到這首歌');
    fs.mkdirSync(dl.dir, { recursive: true });
    j.dir = dl.dir;
    j.base = this.baseFor(clip, dl);
    this.emit();
    const reg = this.lib.data.files[clip.id] = { ...(this.lib.data.files[clip.id] || {}), dir: dl.dir, base: j.base, at: Date.now() };
    const text = (s) => (dl.bom ? '﻿' : '') + s;
    let aligned;
    const getAligned = async () => (aligned !== undefined ? aligned : (aligned = await this.suno.aligned(clip.id)));
    const steps = j.formats.length;
    for (let i = 0; i < j.formats.length; i++) {
      const fmt = j.formats[i];
      if (signal.aborted) throw new Error('已取消');
      const dir = this.folderFor(dl, fmt);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${j.base}.${EXT_OF[fmt]}`);
      j.step = fmt.toUpperCase();
      j.pct = i / steps;
      this.emit();
      try {
        if (dl.skipExisting && reg[fmt] === file && fs.existsSync(file)) { j.done.push(fmt); continue; }
        const onPct = (p) => { j.pct = (i + p) / steps; this.emit(); };
        if (fmt === 'mp3' || fmt === 'wav') {
          // 沒解鎖、使用者也沒同意用下載次數：不呼叫官方下載（呼叫就會扣次數）
          if (!clip.unlocked && !j.allowUnlock) throw new Error('還沒解鎖，下載要用 1 次 Suno 下載次數');
          const url = await this.suno.downloadUrl(clip.id, fmt, signal);
          clip.unlocked = true;
          clip.u = Date.now();
          await this.fetchTo(url, file, signal, onPct);
        } else if (fmt === 'jpg') { if (!clip.image) throw new Error('沒有封面'); await this.fetchTo(clip.image, file, signal, onPct); }
        else if (fmt === 'txt') {
          if (!clip.lyrics.trim()) throw new Error('沒有歌詞');
          writeAtomic(file, text(clip.lyrics.replace(/\r?\n/g, '\r\n') + '\r\n'));
        } else {
          const payload = await getAligned();
          const r = srt.convert(payload || {}, { startOffset: Number(dl.startOffset), duration: clip.duration, title: clip.title, artist: clip.artist });
          if (!r.lines.length) throw new Error(clip.instrumental ? '純音樂，沒有歌詞' : 'Suno 沒有提供對時歌詞');
          writeAtomic(file, text(fmt === 'srt' ? r.srt : r.lrc));
        }
        reg[fmt] = file;
        j.done.push(fmt);
        if (this.afterFile) this.afterFile(fmt, file, clip).catch(() => {});
      } catch (e) {
        if (signal.aborted) throw new Error('已取消');
        j.failed.push(`${fmt}:${String(e.message || e)}`);
      }
      await sleep(150);
    }
    j.pct = 1;
    j.step = '';
    j.state = j.done.length ? 'done' : 'error';
    j.msg = j.failed.length ? j.failed.map((f) => { const [k, ...m] = f.split(':'); return `${k.toUpperCase()}：${m.join(':')}`; }).join('；') : '';
  }
}

module.exports = { Library, Downloader, FORMATS };
