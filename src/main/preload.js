'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => { const h = (e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.off(ch, h); };

contextBridge.exposeInMainWorld('xk', {
  platform: 'desktop',
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  sys: { info: inv('sys:info') },
  openExternal: inv('app:openExternal'),
  onToast: on('app:toast'),
  onZoom: on('app:zoom'),
  suno: {
    bounds: (r) => ipcRenderer.send('suno:bounds', r),
    visible: (v) => ipcRenderer.send('suno:visible', v),
    nav: inv('suno:nav'), state: inv('suno:state'), logout: inv('suno:logout'),
    quota: inv('suno:quota'),
    chromeInfo: inv('suno:chromeInfo'), chromeLogin: inv('suno:chromeLogin'), chromeDone: inv('suno:chromeDone'),
    onState: on('suno:state'),
  },
  lib: {
    list: inv('lib:list'), refresh: inv('lib:refresh'), scan: inv('lib:scan'), remove: inv('lib:remove'), mark: inv('lib:mark'), detail: inv('lib:detail'), srt: inv('lib:srt'), play: inv('lib:play'),
    onChanged: on('lib:changed'), onProgress: on('lib:progress'),
  },
  dl: {
    add: inv('dl:add'), state: inv('dl:state'), pause: inv('dl:pause'), cancel: inv('dl:cancel'), clear: inv('dl:clear'), retry: inv('dl:retry'),
    onUpdate: on('dl:update'),
  },
  dir: { choose: inv('dir:choose'), open: inv('dir:open') },
  file: { show: inv('file:show'), saveText: inv('file:saveText') },
  ai: { post: inv('ai:post'), test: inv('ai:test') },
  cloud: { connect: inv('cloud:connect'), disconnect: inv('cloud:disconnect'), sync: inv('cloud:sync'), state: inv('cloud:state'), code: inv('cloud:code'), upload: inv('cloud:upload'), onState: on('cloud:state') },
  update: {
    check: inv('update:check'), download: inv('update:download'), install: inv('update:install'), openPage: inv('update:openPage'),
    onProgress: on('update:progress'),
  },
});
