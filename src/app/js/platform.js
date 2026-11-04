// 平台介面：桌面版由 preload 提供 window.xk；Android 版用 mobile/android.js（網頁 JS＋原生 window.XiaokeAndroid）
export const xk = window.xk || (window.XiaokeAndroid ? (await import('./mobile/android.js')).makeXk() : null);
if (!xk) throw new Error('找不到平台介面（請用桌面版開啟）');
export const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
