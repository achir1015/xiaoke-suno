// 平台介面：桌面版由 preload 提供 window.xk；手機版、線上版之後在這裡補上自己的實作
export const xk = window.xk;
if (!xk) throw new Error('找不到平台介面（請用桌面版開啟）');
export const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
