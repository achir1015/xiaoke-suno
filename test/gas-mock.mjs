// 用記憶體模擬 Apps Script 的 DriveApp、LockService 等，直接載入真正的 gas/suno.gs 來測試
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

function makeFolder(name) {
  const folder = { name, files: [], folders: [] };
  const makeFile = (n, content) => {
    const f = {
      name: n, content, id: crypto.randomUUID(), trashed: false,
      getName: () => f.name, getId: () => f.id, getSize: () => (Buffer.isBuffer(f.content) ? f.content.length : Buffer.byteLength(String(f.content))),
      getLastUpdated: () => new Date(),
      getBlob: () => ({ getDataAsString: () => String(f.content) }),
      setContent: (c) => { f.content = c; },
      getParents: () => iter([folder]),
      makeCopy: (nn, dest) => (dest || folder).createFile(nn, f.content),
      setTrashed: () => { f.trashed = true; folder.files = folder.files.filter((x) => x !== f); },
    };
    return f;
  };
  Object.assign(folder, {
    getName: () => name,
    getFilesByName: (n) => iter(folder.files.filter((f) => f.name === n)),
    getFiles: () => iter([...folder.files]),
    getFoldersByName: (n) => iter(folder.folders.filter((f) => f.name === n)),
    createFolder: (n) => { const f = makeFolder(n); folder.folders.push(f); return f; },
    createFile: (a, c) => {
      const f = typeof a === 'string' ? makeFile(a, c) : makeFile(a.name, a.bytes);
      folder.files.push(f);
      return f;
    },
  });
  return folder;
}

export function loadGas(token = 'test-token') {
  const drive = makeFolder('我的雲端硬碟');
  const props = token ? { SUNO_TOKEN: token } : {};
  const ctx = {
    console,
    DriveApp: { getFoldersByName: (n) => drive.getFoldersByName(n), createFolder: (n) => drive.createFolder(n) },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, ''),
      getUuid: () => crypto.randomUUID(),
      Charset: { UTF_8: 'utf8' },
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (bytes, mime, name) => ({ bytes: Buffer.from(bytes), mime, name }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'gas', 'suno.gs'), 'utf8'), ctx);
  const post = (body) => JSON.parse(ctx.sunoPost_({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, drive, props, post };
}
