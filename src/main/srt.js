'use strict';
// Suno 對時歌詞（aligned_lyrics/v2）→ SRT／LRC
// 時間校正的規則改寫自 cityedge/suno_srt_downloader v1.2.0（MIT，見 THIRD_PARTY_NOTICES.md）

const DEFAULTS = {
  startOffset: -0.1,       // 開始補正（秒）
  endPadding: 1.5,         // 結束餘韻
  maxExtension: 0.4,       // 離下一行很近時直接延長到下一行
  gap: 0,                  // 字幕間隔
  minDuration: 0.1,        // 最短顯示時間
  tokenIntervalThreshold: 3.0, // 字與字間隔超過幾秒算異常
  tokenIntervalRetain: 1.5,    // 異常間隔修復後保留幾秒
};
const START_OFFSETS = [0, -0.1, -0.2, -0.3, -0.4, -0.5];

const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 2;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function clean(v) {
  return String(v || '').replace(/\r/g, '').replace(/[​-‍⁠﻿]/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 去掉行首的 [Verse]、[Chorus] 這類段落標籤
function stripTags(v) {
  let text = clean(v);
  let removed = 0;
  while (/^\s*\[[^\]\r\n]*\]\s*/.test(text)) { text = text.replace(/^\s*\[[^\]\r\n]*\]\s*/, ''); removed++; }
  return { text: text.trim(), removed, tagOnly: removed > 0 && !text.trim() };
}

function rawText(line) {
  if (typeof line?.text === 'string' && line.text) return line.text;
  if (typeof line?.word === 'string' && line.word) return line.word;
  if (Array.isArray(line?.words)) return line.words.map((w) => w?.text ?? w?.word ?? '').join('');
  return '';
}

function durationOf(payload) {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  for (const c of [payload?.duration_s, payload?.duration, payload?.metadata?.duration, payload?.metadata?.duration_s, root?.duration_s, root?.duration, root?.metadata?.duration, root?.metadata?.duration_s]) {
    const n = finite(c);
    if (n !== null && n > 0) return n;
  }
  return null;
}

function rawLines(payload) {
  if (Array.isArray(payload?.aligned_lyrics)) return payload.aligned_lyrics;
  if (Array.isArray(payload?.data?.aligned_lyrics)) return payload.data.aligned_lyrics;
  return [];
}

// 像「(uptempo trance beat with warm pads)」這種 Suno 風格指示，不是要唱的歌詞
function isInstruction(text, section, start, end) {
  const m = clean(text).match(/^(?:\((.*)\)|（(.*)）)$/);
  if (!m) return false;
  const inner = clean(m[1] ?? m[2] ?? '');
  const latin = inner.match(/[A-Za-z][A-Za-z0-9'’\-]*/g) || [];
  if (latin.length < 3) return false;
  const sectionCue = /(?:interlude|instrumental|break|solo|drop|build(?:-?up)?|transition|intro|outro|間奏|インスト)/i.test(section || '');
  const prompt = inner.match(/(?:tempo|beat|trance|house|techno|rhythm|synth|pads?|mix|production|delivery|vocal|drums?|bass|guitar|piano|ambient|cinematic|tribal|organic|warm|deep|uptempo|downtempo|mid-tempo|melodic|groove|texture|arrangement)/gi) || [];
  const dur = start !== null && end !== null && end > start ? end - start : null;
  const compressed = dur !== null && latin.length >= 5 && dur <= Math.max(0.6, latin.length * 0.08);
  return prompt.length >= 2 || compressed || (sectionCue && prompt.length >= 1);
}

// 整行都是括號裡的說明（例如「(竹笛悠揚起音，古箏輕撥)」）：Suno 不會唱，只給不到一秒、還跟下一句擠在同一刻
function isStageDirection(text, start, end, nextStart, words) {
  if (!/^(?:\s*(?:\([^()]*\)|（[^（）]*）)\s*)+$/.test(text)) return false;
  const dur = start !== null && end !== null ? end - start : null;
  const sameAsNext = start !== null && nextStart !== null && Math.abs(nextStart - start) < 0.05;
  return sameAsNext || (dur !== null && dur < 1.0) || words <= 1;
}

// 行首、行尾的演唱角色標記，例如「(男童音)」「（女聲）」「(合唱)」：不是唱出來的詞
const ROLE_TAG = /^(?:男|女|童|合|和|獨|領|伴|旁|口)[^()（）]{0,5}(?:音|聲|唱|白)$/;
// 括號裡寫的是樂器、編曲說明（例如「(古箏餘音收束，笛音淡出)」），也不是唱出來的詞；像「(我愛你)」這種和聲歌詞會保留
const DIRECTION = /笛|箏|鼓|琴|弦|吉他|貝斯|伴奏|間奏|前奏|尾奏|淡出|淡入|漸強|漸弱|漸進|收束|起音|餘音|音效|節奏|鋪墊|instrumental|interlude|fade/i;
const isTag = (x) => ROLE_TAG.test(x) || DIRECTION.test(x);
function stripRoleTags(text) {
  let t = text, prev;
  do {
    prev = t;
    t = t.replace(/^\s*[(（]([^()（）]{1,40})[)）]\s*/, (m, x) => (isTag(x.trim()) ? '' : m));
    t = t.replace(/\s*[(（]([^()（）]{1,40})[)）]\s*$/, (m, x) => (isTag(x.trim()) ? '' : m));
  } while (t !== prev);
  return t.trim();
}

// 同一行裡字與字之間突然空了十幾秒（Suno 對時出錯）時，把那一行縮回合理範圍
function repairGap(line, S) {
  const out = { ...line };
  const t = line.tokens;
  if (t.length < 2 || out.wordStart === null || out.wordEnd === null) return out;
  let big = null;
  for (let i = 0; i < t.length - 1; i++) {
    const iv = Math.max(t[i + 1].start - t[i].start, t[i + 1].end - t[i].end);
    if (!Number.isFinite(iv) || iv <= S.tokenIntervalThreshold) continue;
    if (!big || iv > big.iv) big = { i, iv };
  }
  if (!big) return out;
  const shift = big.iv - S.tokenIntervalRetain;
  if (shift <= 0.001) return out;
  if (line.firstAfterMeta) out.wordStart = round3(clamp(out.wordStart + shift, out.wordStart, out.wordEnd - 0.02));
  else out.wordEnd = round3(clamp(out.wordEnd - shift, out.wordStart + 0.02, out.wordEnd));
  return out;
}

function normalize(payload, S) {
  const lines = [];
  let pending = false;
  const raw = rawLines(payload);
  for (let li = 0; li < raw.length; li++) {
    const line = raw[li];
    const c = stripTags(rawText(line));
    if (!c.text) { if (c.tagOnly) pending = true; continue; }
    const lineStart = finite(line?.start_s), lineEnd = finite(line?.end_s);
    const section = clean(line?.section || '');
    const nextStart = li + 1 < raw.length ? finite(raw[li + 1]?.start_s) : null;
    const instr = isInstruction(c.text, section, lineStart, lineEnd) || isStageDirection(c.text, lineStart, lineEnd, nextStart, Array.isArray(line?.words) ? line.words.length : 0);
    if (!instr) c.text = stripRoleTags(c.text);
    if (!instr && !c.text) continue;
    const firstAfterMeta = (pending || c.removed > 0) && !instr;
    if (instr) { if (pending || c.removed > 0) pending = true; continue; }
    pending = false;
    const tokens = (Array.isArray(line?.words) ? line.words : []).map((w) => {
      const s = finite(w?.start_s), e = finite(w?.end_s);
      return s !== null && e !== null && e > s ? { start: s, end: e } : null;
    }).filter(Boolean);
    lines.push(repairGap({
      text: c.text, lineStart, lineEnd,
      wordStart: tokens.length ? Math.min(...tokens.map((x) => x.start)) : null,
      wordEnd: tokens.length ? Math.max(...tokens.map((x) => x.end)) : null,
      tokens, firstAfterMeta,
    }, S));
  }
  return { lines, duration: durationOf(payload) };
}

function score(lines, type, source) {
  const key = source === 'words' ? (type === 'start' ? 'wordStart' : 'wordEnd') : (type === 'start' ? 'lineStart' : 'lineEnd');
  let valid = 0, breaks = 0, prev = null;
  for (const l of lines) {
    const v = l[key];
    if (v === null) continue;
    valid++;
    if (prev !== null && v + 0.001 < prev) breaks++;
    prev = v;
  }
  return { valid, breaks, ratio: valid / Math.max(lines.length, 1) };
}

// 字的時間比較準就用字的；字的時間亂掉時改用整行的時間
function source(lines, type) {
  const w = score(lines, type, 'words');
  const l = score(lines, type, 'line');
  if (w.ratio >= 0.7 && w.breaks <= 1) return 'word';
  if (l.valid > 0) return 'line';
  return 'word';
}

function pick(line, type, pref) {
  const w = type === 'start' ? line.wordStart : line.wordEnd;
  const l = type === 'start' ? line.lineStart : line.lineEnd;
  return (pref === 'line' ? l : w) ?? (pref === 'line' ? w : l) ?? null;
}

function adjust(norm, S) {
  const { lines } = norm;
  const durs = lines.map((l) => {
    const s = l.wordStart ?? l.lineStart, e = l.wordEnd ?? l.lineEnd;
    return s !== null && e !== null && e > s ? e - s : null;
  }).filter((v) => v !== null && v > 0 && v < 30);
  const fallback = clamp(median(durs), 0.5, 8);
  const sSrc = source(lines, 'start'), eSrc = source(lines, 'end');
  const rawS = lines.map((l) => pick(l, 'start', sSrc));
  const rawE = lines.map((l) => pick(l, 'end', eSrc));
  const starts = [];
  let prev = -0.001;
  for (let i = 0; i < lines.length; i++) {
    let st = rawS[i];
    if (st === null) {
      let next = null;
      for (let j = i + 1; j < rawS.length; j++) if (rawS[j] !== null) { next = rawS[j] + S.startOffset; break; }
      st = i === 0 && next !== null ? Math.max(0, next - fallback) : Math.max(0, prev + Math.max(S.minDuration, 0.5));
    } else st += S.startOffset;
    st = Math.max(0, st);
    if (st < prev) st = prev + 0.001;
    starts.push(round3(st));
    prev = st;
  }
  return lines.map((l, i) => {
    const start = starts[i];
    const nextStart = i + 1 < starts.length ? starts[i + 1] : null;
    const limit = nextStart === null ? null : nextStart - S.gap;
    let base = rawE[i];
    if (base === null || (rawS[i] !== null && base <= rawS[i]) || base <= start) base = nextStart !== null && nextStart > start ? nextStart : start + fallback;
    let end = base + S.endPadding;
    if (limit !== null) {
      const remain = limit - end;
      if (end > limit || (remain >= 0 && remain <= S.maxExtension)) end = limit;
    }
    if (end < start + S.minDuration) end = start + S.minDuration;
    if (limit !== null && end > limit) end = limit;
    if (end <= start) end = start + 0.02;
    if (norm.duration !== null && i === lines.length - 1) {
      end = Math.min(end, norm.duration);
      if (end <= start) end = start + 0.02;
    }
    return { text: l.text, start, end: round3(end) };
  });
}

function srtTime(sec) {
  const t = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))},${p(t % 1000, 3)}`;
}

function lrcTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
}

// 主要入口：回傳字幕行、SRT 與 LRC 文字；沒有可用歌詞時 lines 是空陣列
function convert(payload, opts = {}) {
  const S = { ...DEFAULTS, ...opts };
  const norm = normalize(payload, S);
  if (norm.duration === null && opts.duration) norm.duration = Number(opts.duration) || null;
  const lines = norm.lines.length ? adjust(norm, S) : [];
  const srt = lines.map((l, i) => `${i + 1}\r\n${srtTime(l.start)} --> ${srtTime(l.end)}\r\n${l.text}\r\n`).join('\r\n');
  const head = [opts.title && `[ti:${clean(opts.title)}]`, opts.artist && `[ar:${clean(opts.artist)}]`, '[by:小柯機器人SUNO工具]'].filter(Boolean);
  const lrc = lines.length ? [...head, ...lines.map((l) => lrcTime(l.start) + l.text)].join('\r\n') + '\r\n' : '';
  return { lines, srt, lrc };
}

// 讀回 SRT 檔（試聽已下載的字幕用）
function parseSrt(text) {
  const t = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : null; };
  const out = [];
  for (const block of String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = t(a), end = t(b);
    const txt = lines.slice(i + 1).join(' ').trim();
    if (start !== null && end !== null && txt) out.push({ text: txt, start, end });
  }
  return out;
}

module.exports = { convert, parseSrt, srtTime, lrcTime, START_OFFSETS, DEFAULTS, clean };
