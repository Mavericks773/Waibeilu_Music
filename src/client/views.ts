import type { TrackSummary, StorageUsage } from '../shared/models.js';
import type { ClientStore, UploadTaskView } from './state.js';
import { element } from './shell.js';
export function time(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export function storageCapacity(bytes: number): string {
  return bytes >= 1e9
    ? `${Number((bytes / 1e9).toFixed(2))} GB`
    : `${Number((bytes / 1e6).toFixed(1))} MB`;
}
export class PlaylistView {
  constructor(
    private play: (id: string) => void,
    private remove: (track: TrackSummary) => void,
  ) {}
  render(store: ClientStore): void {
    const root = element('playlist');
    root.replaceChildren();
    element('track-count').textContent = `${store.tracks.length} 首`;
    const filtered = store.tracks.filter((t) =>
      `${t.title} ${t.artist}`.toLowerCase().includes(store.search.toLowerCase()),
    );
    for (const track of filtered) {
      const row = document.createElement('div');
      row.className = `track-row${store.room?.trackId === track.id ? ' current' : ''}`;
      const play = document.createElement('button');
      play.className = 'icon-button';
      play.textContent = '▶';
      play.setAttribute('aria-label', `播放 ${track.title}`);
      play.disabled = !store.joined || !store.connected;
      play.onclick = () => this.play(track.id);
      const info = document.createElement('div');
      info.className = 'song-info';
      const title = document.createElement('p');
      title.className = 'song-title';
      title.textContent = track.title;
      title.title = track.title;
      const artist = document.createElement('p');
      artist.className = 'song-artist';
      artist.textContent = track.artist;
      info.append(title, artist);
      const remove = document.createElement('button');
      remove.className = 'icon-button delete-button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除 ${track.title}`);
      remove.onclick = () => this.remove(track);
      row.append(play, info, remove);
      root.append(row);
    }
    if (!filtered.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = store.tracks.length ? '没有匹配的歌曲' : '歌单还空着，上传第一首音乐吧';
      root.append(p);
    }
  }
  storage(s: StorageUsage): void {
    element('storage-remaining').textContent =
      `剩余 ${(s.remainingBytes / 1e6).toFixed(1)} MB / 共 ${storageCapacity(s.limitBytes)}`;
    element('storage-used').style.width =
      `${((s.occupiedBytes - s.pendingDeleteBytes) / s.limitBytes) * 100}%`;
    element('storage-pending').style.width = `${(s.pendingDeleteBytes / s.limitBytes) * 100}%`;
    element('storage-reserved').style.width = `${(s.reservedBytes / s.limitBytes) * 100}%`;
    element('storage-detail').textContent =
      `已用 ${(s.occupiedBytes / 1e6).toFixed(1)} MB · 待清理 ${(s.pendingDeleteBytes / 1e6).toFixed(1)} · 预留 ${(s.reservedBytes / 1e6).toFixed(1)}`;
  }
  uploads(tasks: UploadTaskView[]): void {
    const root = element('uploads');
    root.replaceChildren();
    for (const task of tasks.slice(-5)) {
      const row = document.createElement('div');
      row.className = 'upload-task';
      const name = document.createElement('span');
      name.textContent = task.fileName;
      const status = document.createElement('span');
      status.textContent =
        task.phase === 'uploading'
          ? `${Math.round((task.sentBytes / task.totalBytes) * 100)}%`
          : task.phase === 'validating'
            ? '校验中…'
            : task.phase === 'completed'
              ? '已加入歌单'
              : task.phase === 'queued'
                ? '排队中'
                : task.errorMessage || '上传失败';
      row.append(name, status);
      root.append(row);
    }
  }
}
export class PlayerView {
  dragging = false;
  render(store: ClientStore, status: string, position: number): void {
    const s = store.room,
      track = store.tracks.find((t) => t.id === s?.trackId);
    element('current-title').textContent =
      track?.title || (store.tracks.length ? '选择一首开始播放' : '上传第一首音乐');
    element('current-artist').textContent = track?.artist || '与朋友分享此刻';
    element('play-status').textContent =
      s?.status === 'playing' ? 'NOW PLAYING' : s?.trackId ? 'PAUSED' : 'READY TO LISTEN';
    element('sync-status').textContent = status;
    element('toggle-play').textContent = s?.status === 'playing' ? 'Ⅱ' : '▶';
    element('toggle-play').setAttribute('aria-label', s?.status === 'playing' ? '暂停' : '播放');
    document
      .querySelector('.record-art')
      ?.classList.toggle('playing', s?.status === 'playing' && store.joined);
    const seek = element<HTMLInputElement>('seek');
    seek.max = String(s?.durationSeconds || 1);
    if (!this.dragging) {
      seek.value = String(position);
      element('position').textContent = time(position);
    }
    element('duration').textContent = time(s?.durationSeconds || 0);
    for (const id of ['previous', 'next', 'toggle-play', 'repeat-mode', 'shuffle-mode', 'seek'])
      element<HTMLButtonElement>(id).disabled =
        !store.connected || !store.joined || (id === 'seek' && !s?.trackId);
    element('repeat-mode').setAttribute('aria-pressed', String(s?.playbackMode === 'repeat-one'));
    element('shuffle-mode').setAttribute('aria-pressed', String(s?.playbackMode === 'shuffle'));
    const presence = element('presence');
    const names = store.presence?.nicknames || [];
    const key = JSON.stringify(names);
    if (presence.dataset.members !== key) {
      presence.dataset.members = key;
      presence.replaceChildren();
      for (const name of names) {
        const member = document.createElement('li');
        member.className = 'member-chip';
        member.textContent = name;
        presence.append(member);
      }
      if (!names.length) {
        const empty = document.createElement('li');
        empty.className = 'members-empty';
        empty.textContent = '暂无成员';
        presence.append(empty);
      }
    }
  }
}
export class DeleteDialog {
  track: TrackSummary | null = null;
  readonly dialog = element<HTMLDialogElement>('delete-dialog');
  open(track: TrackSummary): void {
    this.track = track;
    element('delete-title').textContent = track.title;
    element('delete-error').textContent = '';
    element<HTMLButtonElement>('delete-confirm').disabled = false;
    this.dialog.showModal();
  }
  close(): void {
    this.track = null;
    this.dialog.close();
  }
}
