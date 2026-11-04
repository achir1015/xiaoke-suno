// SRT 轉換、檔名、雲端程式（真正的 gas/suno.gs）、Suno 回應解析
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadGas } from './gas-mock.mjs';

const require = createRequire(import.meta.url);
const srt = require('../src/main/srt.js');
const { sanitize, pickBase, existingBases } = require('../src/main/naming.js');
const { encodePairing, decodePairing } = require('../src/main/cloud.js');

const line = (text, s, e, words) => ({ text, start_s: s, end_s: e, words: words || [] });

test('SRT：去掉段落標籤、時間提早、結尾餘韻不重疊', () => {
  const payload = { aligned_lyrics: [line('[Verse]\n第一句', 1.0, 2.0), line('第二句', 2.3, 3.0), line('[Chorus]', 3.5, 3.6), line('第三句', 10, 11)], duration_s: 12 };
  const r = srt.convert(payload, { startOffset: -0.1 });
  assert.deepEqual(r.lines.map((l) => l.text), ['第一句', '第二句', '第三句']);
  assert.equal(r.lines[0].start, 0.9);
  assert.equal(r.lines[0].end, r.lines[1].start, '離下一句很近就接到下一句');
  assert.equal(r.lines[2].end, 12, '結尾餘韻 1.5 秒，但不超過歌曲長度 12 秒');
  assert.match(r.srt, /^1\r\n00:00:00,900 --> 00:00:02,200\r\n第一句\r\n/);
  assert.match(r.lrc, /\[00:00\.90\]第一句/);
});

test('SRT：開始補正 0 秒時不提早', () => {
  const r = srt.convert({ aligned_lyrics: [line('只有一句', 5, 6)] }, { startOffset: 0 });
  assert.equal(r.lines[0].start, 5);
  assert.equal(r.lines[0].end, 7.5);
});

test('SRT：字間隔異常（15 秒）會縮回', () => {
  const words = [{ start_s: 1, end_s: 1.3 }, { start_s: 1.3, end_s: 1.6 }, { start_s: 16.6, end_s: 17 }];
  const r = srt.convert({ aligned_lyrics: [line('一二三', 1, 17, words), line('下一句', 20, 21, [{ start_s: 20, end_s: 21 }])] }, { startOffset: 0 });
  assert.ok(r.lines[0].end < 6, `第一句結束應該被縮短，實際 ${r.lines[0].end}`);
});

test('SRT：Suno 的英文風格指示行不當成歌詞；純音樂回傳空的', () => {
  const r = srt.convert({ aligned_lyrics: [line('(uptempo trance beat with warm synth pads)', 0, 0.3), line('真的歌詞', 1, 2)] });
  assert.deepEqual(r.lines.map((l) => l.text), ['真的歌詞']);
  assert.equal(srt.convert({ aligned_lyrics: [] }).lines.length, 0);
  assert.equal(srt.convert(null).lines.length, 0);
});

test('SRT：寫出再讀回時間一致', () => {
  const r = srt.convert({ aligned_lyrics: [line('甲', 1.234, 2), line('乙', 3.5, 4)] });
  const back = srt.parseSrt('﻿' + r.srt);
  assert.deepEqual(back.map((l) => [l.text, l.start, l.end]), r.lines.map((l) => [l.text, l.start, l.end]));
});

test('檔名：非法字元、保留名稱、空白', () => {
  assert.equal(sanitize('愛/恨: 交織?'), '愛_恨_ 交織_');
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(sanitize('  歌名.  '), '歌名');
  assert.equal(sanitize('', 'abc'), 'abc');
});

test('檔名：同名時加 (1)、ID 或覆蓋', () => {
  const taken = new Set(['夏日微風', '夏日微風 (1)']);
  const clip = { id: 'abcdef12-0000', title: '夏日微風' };
  assert.equal(pickBase(clip, 'number', (b) => taken.has(b)), '夏日微風 (2)');
  assert.equal(pickBase(clip, 'id', (b) => taken.has(b)), '夏日微風 [abcdef12]');
  assert.equal(pickBase(clip, 'overwrite', (b) => taken.has(b)), '夏日微風');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xks-'));
  fs.writeFileSync(path.join(dir, 'A.MP3'), 'x');
  fs.writeFileSync(path.join(dir, 'B.srt'), 'x');
  fs.writeFileSync(path.join(dir, 'C.doc'), 'x');
  assert.deepEqual([...existingBases(dir, ['mp3', 'srt'])].sort(), ['a', 'b']);
});

test('設定碼：編碼、解碼、拒絕其他網址', () => {
  const code = encodePairing('https://script.google.com/macros/s/X/exec', 'tok');
  assert.deepEqual(decodePairing(code), { url: 'https://script.google.com/macros/s/X/exec', token: 'tok' });
  assert.equal(decodePairing('XKS1.' + Buffer.from(JSON.stringify({ url: 'https://evil.example/', token: 't' })).toString('base64')), null);
  assert.equal(decodePairing('XKT1.abc'), null);
});

test('雲端 suno.gs：金鑰、同步、新的贏、上傳同名覆蓋', () => {
  const g = loadGas('k1');
  assert.equal(g.post({ token: 'bad', action: 'ping' }).ok, false);
  assert.equal(g.post({ token: 'k1', action: 'ping' }).count, 0);
  let r = g.post({ token: 'k1', action: 'sync', since: 0, changes: [{ k: 'song', id: 'a', u: 10, r: { id: 'a', title: '一' } }, { k: 'bad', id: 'x', u: 1, r: {} }] });
  assert.equal(r.seq, 1);
  assert.equal(r.changes.length, 1);
  r = g.post({ token: 'k1', action: 'sync', since: 1, changes: [{ k: 'song', id: 'a', u: 5, r: { id: 'a', title: '舊' } }] });
  assert.equal(r.changes[0].r.title, '一', '比較舊的被駁回，回傳伺服器的版本');
  r = g.post({ token: 'k1', action: 'sync', since: 1, changes: [{ k: 'song', id: 'a', u: 20, r: { id: 'a', title: '新' } }] });
  assert.equal(r.seq, 2);
  assert.equal(g.post({ token: 'k1', action: 'ping' }).count, 1);
  const data = Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n歌\r\n').toString('base64');
  assert.equal(g.post({ token: 'k1', action: 'upload', folder: 'srt', name: '夏日微風.srt', mime: 'text/plain', data }).ok, true);
  assert.equal(g.post({ token: 'k1', action: 'upload', folder: 'SRT', name: '夏日微風.srt', mime: 'text/plain', data }).ok, true);
  const files = g.post({ token: 'k1', action: 'files', folder: 'SRT' }).files;
  assert.equal(files.length, 1, '同名只留一份');
  assert.equal(g.post({ token: 'k1', action: 'upload', folder: '../x', name: 'a', data }).ok, false);
  const root = g.drive.folders.find((f) => f.name === '小柯SUNO');
  assert.ok(root.files.some((f) => /^suno-backup-\d{8}\.json$/.test(f.name)), '每天第一次寫入有備份');
});

test('雲端 suno.gs：setupSuno 產生金鑰與設定碼', () => {
  const g = loadGas(null);
  const code = g.ctx.setupSuno();
  assert.ok(g.props.SUNO_TOKEN && g.props.SUNO_TOKEN.length >= 32);
  const o = decodePairing(code);
  assert.equal(o.token, g.props.SUNO_TOKEN);
  assert.equal(g.ctx.setupSuno(), code, '再執行一次金鑰不變');
});

test('Suno 回應解析：工作區格式、CDN 網址、解鎖狀態、不可下載的歌', () => {
  const { toClip, harvest, downloadable, jwtExp } = require('../src/main/suno.js');
  const jwt = 'a.' + Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64').replace(/=+$/, '') + '.s';
  assert.equal(jwtExp(jwt), 1893456000);
  assert.equal(jwtExp('壞掉'), 0);
  const id = '11111111-2222-4333-8444-555555555555';
  const c = toClip({ clip: { id, title: ' 歌 ', audio_url: 'https://audiopipe.suno.ai/?item_id=x', image_url: 'https://cdn2.suno.ai/a.jpeg', status: 'complete', metadata: { duration: 12.5, tags: 'pop', prompt: '詞' } } });
  assert.equal(c.title, '歌');
  assert.equal(c.audio, '', '舊的公開音檔網址已失效，MP3 要走官方下載');
  assert.equal(toClip({ id, title: 'x', audio_url: 'https://studio-api.prod.suno.com/api/forbidden', is_download_unlocked: true, video_url: 'https://cdn2.suno.ai/v.mp4', metadata: {} }).unlocked, true);
  assert.equal(toClip({ id, title: 'x', audio_url: 'https://studio-api.prod.suno.com/api/forbidden', video_url: 'https://cdn2.suno.ai/v.mp4', metadata: {} }).video, 'https://cdn1.suno.ai/v.mp4');
  assert.equal(c.thumb, 'https://cdn1.suno.ai/a.jpeg');
  assert.equal(c.lyrics, '詞');
  const found = harvest({ project_clips: [{ clip: { id, audio_url: '', status: 'complete', metadata: {} } }], other: { id: 'not-uuid', audio_url: '' } });
  assert.deepEqual([...found.keys()], [id]);
  assert.equal(downloadable({ ...c, status: 'streaming' }), false);
  assert.equal(downloadable({ ...c, task: 'infill' }), false);
  assert.equal(downloadable(c), true);
});
