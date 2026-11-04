// 下載佇列：每首歌的進度、失敗原因；暫停、取消、重試
import { h, fill, $ } from './util.js';
import { xk } from './platform.js';
import { S } from './state.js';

const STATE = { wait: ['⏳', '排隊中'], run: ['⬇️', '下載中'], done: ['✅', '完成'], error: ['⚠️', '失敗'], cancel: ['⏹', '已取消'] };

export function renderQueue() {
  const host = $('#v-queue');
  if (!host) return;
  const jobs = S.queue.jobs;
  const n = (st) => jobs.filter((j) => j.state === st).length;
  const active = n('wait') + n('run');
  const partial = jobs.filter((j) => j.state === 'done' && j.failed.length).length;
  fill(host,
    h('div', { class: 'q-head' },
      h('h2', {}, '⬇️ 下載佇列'),
      h('span', { class: 'muted', id: 'qSum' }, jobs.length ? `共 ${jobs.length} 首：完成 ${n('done')}、下載中 ${n('run')}、排隊 ${n('wait')}、失敗 ${n('error')}` : ''),
      h('span', { class: 'sp' }),
      active > 0 && h('button', { class: 'btn', id: 'qPause', onclick: () => xk.dl.pause(!S.queue.paused) }, S.queue.paused ? '▶ 繼續' : '⏸ 暫停'),
      active > 0 && h('button', { class: 'btn', id: 'qCancel', onclick: () => xk.dl.cancel() }, '⏹ 全部取消'),
      (n('error') + n('cancel') + partial) > 0 && h('button', { class: 'btn', id: 'qRetry', onclick: () => xk.dl.retry() }, '🔁 重試失敗的'),
      jobs.length > active && h('button', { class: 'btn ghost', id: 'qClear', onclick: () => xk.dl.clear() }, '🧹 清除已結束'),
      h('button', { class: 'btn ghost', onclick: () => xk.dir.open() }, '📂 開啟下載資料夾')),
    S.queue.paused && h('div', { class: 'note' }, '⏸ 已暫停，按「繼續」接著下載。'),
    jobs.length ? h('div', { class: 'q-list' }, [...jobs].reverse().map(jobRow))
      : h('div', { class: 'empty' }, h('img', { src: 'img/robot96.png', alt: '', width: 80, height: 80 }), h('h3', {}, '目前沒有下載工作'), h('p', { class: 'muted' }, '到「🎵 歌曲庫」勾選歌曲，按「⬇️ 下載所選」就會出現在這裡。')));
}

function jobRow(j) {
  const [ic, t] = STATE[j.state] || ['', j.state];
  return h('div', { class: `job ${j.state}` },
    h('span', { class: 'ji' }, ic),
    h('div', { class: 'jm' },
      h('div', { class: 'jt' }, j.base || j.title),
      h('div', { class: 'bar' }, h('span', { style: { width: `${Math.round((j.pct || 0) * 100)}%` } })),
      h('div', { class: 'jx' },
        h('span', {}, j.state === 'run' && j.step ? `${t}：${j.step}` : t),
        h('span', { class: 'fmts-s' }, j.formats.map((f) => h('span', { class: `fb ${f} ${j.done.includes(f) ? 'ok' : j.failed.some((x) => x.startsWith(f + ':')) ? 'bad' : ''}` }, f.toUpperCase()))),
        j.msg && h('span', { class: 'jerr' }, j.msg))),
    j.dir && j.done.length > 0 && h('button', { class: 'icon-btn', title: '打開資料夾', onclick: () => xk.dir.open(j.dir) }, '📂'));
}
