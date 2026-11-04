'use strict';
// 檔名：跟 Suno 網站「下載」一樣用歌名當檔名；同名的歌（Suno 一次產生兩首）依設定加上序號或 ID

function sanitize(value, fallback = 'Untitled') {
  let name = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length > 150) name = name.slice(0, 150).replace(/[. ]+$/g, '').trim();
  return name || fallback;
}

// 決定一首歌在某個資料夾的檔名（不含副檔名）
// taken(base) → 這個名稱已被「別首歌」用掉了嗎；mode: 'number'＝加 (1)(2)…、'id'＝加 ID 前 8 碼、'overwrite'＝直接覆蓋
function pickBase(clip, mode, taken) {
  const base = sanitize(clip.title, clip.id);
  if (mode === 'overwrite' || !taken(base)) return base;
  if (mode === 'id') {
    const b = `${base} [${String(clip.id).slice(0, 8)}]`;
    if (!taken(b)) return b;
  }
  for (let i = 1; i < 1000; i++) {
    const b = `${base} (${i})`;
    if (!taken(b)) return b;
  }
  return `${base} [${clip.id}]`;
}

// 資料夾裡已經有這些副檔名的哪些檔名（不分大小寫）
function existingBases(dir, exts) {
  const set = new Set();
  try {
    const path = require('path'), fs = require('fs');
    for (const f of fs.readdirSync(dir)) {
      const ext = path.extname(f).slice(1).toLowerCase();
      if (exts.includes(ext)) set.add(f.slice(0, -(ext.length + 1)).toLowerCase());
    }
  } catch {}
  return set;
}

// 桌面版用 require；手機版、線上版的網頁直接載入，放在 window.XkNaming（existingBases 只有桌面版用）
const namingApi = { sanitize, pickBase, existingBases };
if (typeof module !== 'undefined' && module.exports) module.exports = namingApi;
else globalThis.XkNaming = namingApi;
