// 小柯機器人SUNO工具：雲端儲存（加在「小柯上傳」Apps Script 專案的新檔案，不要再寫 doGet）
// 資料存在雲端硬碟「小柯SUNO」資料夾：suno-data.json（歌曲清單與標記）、MP3／SRT 等子資料夾（備份的檔案）
// 機器人上傳照片、專案追蹤的功能完全不受影響
//
// 要配合 doPost 第一行加上：
//   if (e && e.parameter && e.parameter.app === 'suno') return sunoPost_(e);
//
// 通訊方式：POST ?app=suno，內容是 JSON（text/plain）
//   { token, action: 'ping' }                               → { ok, seq, count }
//   { token, action: 'sync', since, changes: [] }           → { ok, seq, changes }
//   { token, action: 'upload', folder, name, mime, data }   → { ok, id, size }（data 是 base64，同名覆蓋）
//   { token, action: 'files', folder }                      → { ok, files: [{ name, size, updated }] }
// changes 的每一筆：{ k: 'song', id, u, r }；u 是修改時間，新的贏

const SUNO_FOLDER = '小柯SUNO';
const SUNO_FILE = 'suno-data.json';
const SUNO_BACKUPS = 14;
const SUNO_SUBFOLDERS = ['MP3', 'SRT', 'LRC', 'TXT', 'JPG', 'WAV'];
const SUNO_EXEC_URL = ''; // 部署後的 …/exec 網址；空白時用 getUrl()，但專案有多個部署時可能拿到 /dev

function sunoToken_() {
  return PropertiesService.getScriptProperties().getProperty('SUNO_TOKEN') || '';
}

function sunoJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sunoPost_(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return sunoJson_({ ok: false, error: '資料格式錯誤' }); }
  const token = sunoToken_();
  if (!req || !token || req.token !== token) return sunoJson_({ ok: false, error: '雲端金鑰不正確' });
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return sunoJson_({ ok: false, error: '伺服器忙碌，請稍後再試' });
  }
  try {
    const root = sunoRoot_();
    if (req.action === 'upload') return sunoJson_(sunoUpload_(root, req));
    if (req.action === 'files') return sunoJson_(sunoFiles_(root, req.folder));
    const file = sunoFile_(root);
    const store = sunoRead_(file);
    if (req.action === 'ping') return sunoJson_({ ok: true, seq: store.seq, count: Object.keys(store.recs).length });
    if (req.action === 'sync') {
      const before = store.seq;
      const out = sunoMerge_(store, req.changes || [], Number(req.since) || 0);
      if (store.seq !== before) {
        sunoBackup_(file, root);
        file.setContent(JSON.stringify(store));
      }
      return sunoJson_({ ok: true, seq: store.seq, changes: out });
    }
    return sunoJson_({ ok: false, error: '不認得的動作' });
  } catch (err) {
    return sunoJson_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function sunoMerge_(store, changes, since) {
  const rejected = {};
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c || !c.id || !c.r || c.k !== 'song') continue;
    const key = c.k + ':' + c.id;
    const cur = store.recs[key];
    if (cur && cur.u > c.u) { rejected[key] = true; continue; }
    if (cur && cur.u === c.u) continue;
    store.seq++;
    store.recs[key] = { k: c.k, id: c.id, u: c.u, s: store.seq, r: c.r };
  }
  const out = [];
  for (const key in store.recs) {
    const x = store.recs[key];
    if (x.s > since || rejected[key]) out.push({ k: x.k, id: x.id, u: x.u, r: x.r });
  }
  return out;
}

function sunoRoot_() {
  const it = DriveApp.getFoldersByName(SUNO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(SUNO_FOLDER);
}

function sunoSub_(root, name) {
  if (SUNO_SUBFOLDERS.indexOf(name) < 0) throw new Error('不支援的資料夾：' + name);
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function sunoFile_(root) {
  const files = root.getFilesByName(SUNO_FILE);
  return files.hasNext() ? files.next() : root.createFile(SUNO_FILE, JSON.stringify({ seq: 0, recs: {} }), MimeType.PLAIN_TEXT);
}

function sunoRead_(file) {
  const store = JSON.parse(file.getBlob().getDataAsString('UTF-8') || '{}');
  return { seq: store.seq || 0, recs: store.recs || {} };
}

// 檔名不能有路徑；同名的舊檔丟到垃圾桶後再存新的
function sunoUpload_(root, req) {
  const name = String(req.name || '').replace(/[\\/]/g, '_').slice(0, 200);
  if (!name || !req.data) return { ok: false, error: '缺少檔名或內容' };
  const folder = sunoSub_(root, String(req.folder || '').toUpperCase());
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'application/octet-stream', name);
  const f = folder.createFile(blob);
  return { ok: true, id: f.getId(), size: f.getSize() };
}

function sunoFiles_(root, name) {
  const folder = sunoSub_(root, String(name || '').toUpperCase());
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext() && out.length < 2000) {
    const f = it.next();
    out.push({ name: f.getName(), size: f.getSize(), updated: f.getLastUpdated().getTime() });
  }
  return { ok: true, files: out };
}

function sunoBackup_(file, root) {
  const day = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const name = 'suno-backup-' + day + '.json';
  if (root.getFilesByName(name).hasNext()) return;
  file.makeCopy(name, root);
  const list = [];
  const files = root.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (/^suno-backup-\d{8}\.json$/.test(f.getName())) list.push(f);
  }
  list.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  while (list.length > SUNO_BACKUPS) list.shift().setTrashed(true);
}

// 在編輯器選這個函式按「執行」一次：完成授權、建立資料夾、產生雲端金鑰
// 執行記錄會印出「設定碼」，貼到 App 的 設定 → 雲端儲存 → 貼上設定碼 就連上了
function setupSuno() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('SUNO_TOKEN');
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SUNO_TOKEN', token);
  }
  const root = sunoRoot_();
  const file = sunoFile_(root);
  const url = SUNO_EXEC_URL || ScriptApp.getService().getUrl();
  if (/\/dev$/.test(url)) Logger.log('注意：這是 /dev 測試網址，App 連不上。請把 SUNO_EXEC_URL 填成 /exec 網址再執行一次');
  const code = 'XKS1.' + Utilities.base64Encode(JSON.stringify({ url: url, token: token }), Utilities.Charset.UTF_8);
  Logger.log('資料夾：' + root.getName() + '，歌曲 ' + Object.keys(sunoRead_(file).recs).length + ' 首');
  Logger.log('網址：' + url);
  Logger.log('設定碼：' + code);
  return code;
}
