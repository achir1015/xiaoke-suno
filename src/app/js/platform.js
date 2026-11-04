// 平台介面：桌面版由 preload 提供 window.xk；Android／iPhone／iPad 用 mobile/android.js（網頁 JS＋原生 App）
export const xk = window.xk || (window.XiaokeAndroid || window.XiaokeIOS ? (await import('./mobile/android.js')).makeXk() : null);
if (!xk) throw new Error('找不到平台介面（請用桌面版開啟）');
export const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
