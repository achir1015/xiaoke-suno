// 測試用的假 Suno：網頁（含 Clerk 登入狀態）、studio API、CDN 音檔與封面
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TONE = fs.readFileSync(path.join(here, 'fixtures', 'tone.mp3'));
const COVER = fs.readFileSync(path.join(here, 'fixtures', 'cover.jpg'));
// Clerk 的 __session 是 JWT；Suno 新版網頁不提供 window.Clerk，App 要從 cookie 判斷登入
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64u({ alg: 'RS256' })}.${b64u({ sub: 'user_x', exp: Math.floor(Date.now() / 1000) + 86400 * 30 })}.sig`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// 第一行 [Verse] 標籤、第三行有一個字間隔異常（15 秒）
const LYRICS = [
  ['[Verse]\n夏天的風吹過海邊', 2.0, 5.0],
  ['我們一起唱著歌', 5.5, 8.4],
  ['陽光灑在你的臉', 9.0, 12.0],
  ['[Chorus]\n啦啦啦 微風輕輕', 13.0, 16.5],
  ['永遠記得這一天', 17.0, 20.5],
];

export function makeSongs(base) {
  const mk = (n, title, extra = {}) => ({
    id: id(n), title, status: 'complete', created_at: `2026-10-${String(10 + n).padStart(2, '0')}T08:00:00Z`,
    audio_url: 'https://studio-api.prod.suno.com/api/forbidden', video_url: `${base}/cdn/${id(n)}.mp4`, is_download_unlocked: n === 2, image_url: `${base}/cdn/image_${id(n)}.jpg`, image_large_url: `${base}/cdn/image_large_${id(n)}.jpg`,
    display_name: '小柯測試', handle: 'xiaoke_tester', major_model_version: 'v5', is_liked: n === 1,
    metadata: { duration: 30, tags: n === 3 ? 'ambient piano, instrumental' : 'mandopop, warm acoustic guitar', prompt: n === 3 ? '' : LYRICS.map((l) => l[0]).join('\n'), type: 'gen', make_instrumental: n === 3 },
    ...extra,
  });
  return [
    mk(1, '夏日微風'),
    mk(2, '夏日微風'), // Suno 一次產生兩首同名
    mk(3, '雨夜鋼琴'),
    mk(4, '愛/恨: 交織?'),
    mk(5, '台北的雨'),
    mk(6, '還在產生中', { status: 'streaming' }),
    mk(7, '工作區限定'),
  ];
}

function aligned(clipId) {
  if (clipId === id(3)) return { aligned_words: [], aligned_lyrics: [] };
  const lines = LYRICS.map(([text, s, e], i) => {
    const plain = text.replace(/\[[^\]]*\]\n?/, '');
    const chars = [...plain.replace(/\s/g, '')];
    const step = (e - s) / chars.length;
    const words = chars.map((c, k) => ({ word: c, start_s: s + k * step, end_s: s + (k + 1) * step, success: true }));
    if (i === 2) { words[words.length - 1].start_s += 15; words[words.length - 1].end_s += 15; }
    return { text, start_s: s, end_s: e, words, section: i === 3 ? 'Chorus' : 'Verse' };
  });
  return { aligned_words: [], aligned_lyrics: lines, duration_s: 30 };
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Suno</title></head><body style="background:#111;color:#eee;font:16px sans-serif">
<script>
  document.cookie = 'suno_device_id=dev-123; path=/';
</script>${body}</body></html>`;

export async function fakeSuno() {
  const state = { calls: [], wav: {}, used: 0, dlCalls: [], unlocked: new Set([id(2)]) };
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const songs = makeSongs(base).map((s) => ({ ...s, is_download_unlocked: state.unlocked.has(s.id) }));
    const u = new URL(req.url, base);
    state.calls.push(`${req.method} ${u.pathname}`);
    // 網站版路徑 suno.com/a/api/...：歌曲清單、歌曲資料、對時歌詞和 studio-api 一樣（方案資訊與官方下載只在 /a/api）
    if (/^\/a\/api\/(feed|clips|clip|gen)\//.test(u.pathname) && !/\/download\//.test(u.pathname)) u.pathname = u.pathname.slice(2);
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const html = (s) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
    if (u.pathname === '/') return html(page('<h1>假的 Suno 首頁</h1><a href="/workspace">工作區</a>'));
    if (u.pathname === '/login') { res.writeHead(302, { 'Set-Cookie': [`__session=${TOKEN}; Path=/; Max-Age=2592000`, 'fake_login=1; Path=/; Max-Age=2592000'], Location: '/' }); return res.end(); }
    // 工作區：網頁自己呼叫 API（測試被動收集）並列出 /song/ 連結（測試抓取這一頁）
    if (u.pathname === '/workspace') {
      return html(page(`<h1>我的工作區</h1><div id="list"></div>
<script>fetch('/api/project/ws1?page=1', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(TOKEN)} } }).then((r) => r.json()).then((d) => {
  document.getElementById('list').innerHTML = d.project_clips.map((x) => '<p><a href="/song/' + x.clip.id + '">' + x.clip.title + '</a></p>').join('');
});</script>`));
    }
    if (u.pathname.startsWith('/song/')) return html(page(`<h1>歌曲頁</h1><a href="${u.pathname}">本頁</a>`));
    // 官方下載給的有時效網址（像 S3 的簽章網址）
    if (u.pathname.startsWith('/s3/')) {
      if (u.searchParams.get('Signature') !== 'ok') { res.writeHead(403); return res.end('denied'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': TONE.length, 'Access-Control-Allow-Origin': '*' });
      return res.end(TONE);
    }
    if (u.pathname.startsWith('/cdn/')) {
      if (/\.mp3$/.test(u.pathname)) { res.writeHead(403, { 'Content-Type': 'text/xml' }); return res.end('<Error><Code>MissingKey</Code></Error>'); }
      const isImg = /\.jpg$/.test(u.pathname);
      res.writeHead(200, { 'Content-Type': isImg ? 'image/jpeg' : 'audio/mpeg', 'Content-Length': (isImg ? COVER : TONE).length, 'Access-Control-Allow-Origin': '*' });
      return res.end(isImg ? COVER : TONE);
    }
    // 網站自己的 API：suno.com/a/api/...（官方下載、方案資訊）
    if (u.pathname.startsWith('/a/api/')) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ detail: 'Unauthorized' }, 401);
      if (u.pathname === '/a/api/billing/info/') return json({ plan: { name: 'Pro Plan' }, renews_on: '2026-11-27T01:04:35Z', download_usage: { current_period_downloads_used: state.used, current_period_downloads_limit: 20, additional_download_remaining: 0 } });
      let m;
      if ((m = /^\/a\/api\/download\/clip\/([0-9a-f-]{36})$/.exec(u.pathname))) {
        const cid = m[1];
        state.dlCalls.push(cid);
        // 第一次呼叫就算解鎖（扣 1 次），先回 preparing，下一次才給網址
        if (!state.unlocked.has(cid)) { state.unlocked.add(cid); state.used++; return json({ ok: true, status: 'preparing' }); }
        return json({ ok: true, status: 'ready', download_url: `${base}/s3/studio/uploads/${cid}_paid_wm.${u.searchParams.get('format') || 'mp3'}?AWSAccessKeyId=x&Signature=ok&Expires=9` });
      }
      return json({ detail: 'Not found' }, 404);
    }
    if (u.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ detail: 'Unauthorized' }, 401);
      if (u.pathname === '/api/feed/v3' && req.method === 'POST') {
        let b = '';
        req.on('data', (d) => { b += d; });
        req.on('end', () => {
          const body = JSON.parse(b || '{}');
          state.lastFeed = body;
          const all = songs.filter((s) => s.title !== '工作區限定');
          const at = Number(body.cursor || 0);
          const page = all.slice(at, at + 3);
          json({ clips: page, has_more: at + 3 < all.length, next_cursor: at + 3 < all.length ? String(at + 3) : null });
        });
        return;
      }
      if (u.pathname === '/api/project/ws1') return json({ project_clips: songs.filter((s) => [5, 7].some((n) => s.id === id(n))).map((clip) => ({ clip })) });
      if (u.pathname === '/api/clips/get_songs_by_ids') { const want = u.searchParams.getAll('ids'); return json({ clips: songs.filter((s) => want.includes(s.id)) }); }
      let m;
      if ((m = /^\/api\/clip\/([0-9a-f-]{36})$/.exec(u.pathname))) { const c = songs.find((s) => s.id === m[1]); return c ? json(c) : json({ detail: 'Not found' }, 404); }
      if ((m = /^\/api\/gen\/([0-9a-f-]{36})\/aligned_lyrics\/v2\/$/.exec(u.pathname))) return json(aligned(m[1]));
      if ((m = /^\/api\/gen\/([0-9a-f-]{36})\/convert_wav\/$/.exec(u.pathname))) { state.wav[m[1]] = 0; return json({}); }
      if ((m = /^\/api\/gen\/([0-9a-f-]{36})\/wav_file\/$/.exec(u.pathname))) { state.wav[m[1]]++; return json({ wav_file_url: state.wav[m[1]] >= 2 ? `${base}/cdn/${m[1]}.wav` : null }); }
      return json({ detail: 'Not found' }, 404);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, state, id, close: () => srv.close() };
}
