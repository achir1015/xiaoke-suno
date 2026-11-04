// 全域狀態
export const S = {
  settings: null,
  sysInfo: null,
  view: 'library',
  songs: [],          // 歌曲庫
  selected: new Set(), // 勾選的歌
  filter: { q: '', show: 'all', mark: '', sort: 'new' },
  suno: { loggedIn: false },
  queue: { jobs: [], paused: false },
  cloud: { status: 'off' },
  zoom: 1,
  update: null,
};

export const songById = (id) => S.songs.find((s) => s.id === id);
