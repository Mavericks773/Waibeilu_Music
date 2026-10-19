import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RoomState, Track, PlaybackMode, Session } from '../shared/models.js';
import { AppError, positionAt, type Command } from '../shared/protocol.js';
import { Database } from './persistence.js';
export class SerialCommandQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
}
type PlaybackRecordOptions = { history?: boolean; shuffle?: boolean };

export class PlaybackOrder {
  private history: string[] = [];
  private recent: string[] = [];
  private shuffleCounts = new Map<string, number>();
  constructor(private random = Math.random) {}
  record(id: string, { history = true, shuffle = false }: PlaybackRecordOptions = {}): void {
    if (history) {
      this.history.push(id);
      if (this.history.length > 100) this.history.shift();
    }
    // 独立保存最近播放，回退历史不会让刚听过的歌曲重新进入随机候选。
    this.recent = this.recent.filter((trackId) => trackId !== id);
    this.recent.push(id);
    if (this.recent.length > 3) this.recent.shift();
    if (shuffle) this.shuffleCounts.set(id, (this.shuffleCounts.get(id) ?? 0) + 1);
  }
  choose(
    mode: PlaybackMode,
    current: string | null,
    tracks: Track[],
    reason: 'ended' | 'next' | 'previous',
  ): string | null {
    if (!tracks.length) return null;
    if (mode === 'repeat-one') {
      if (reason === 'ended' && tracks.some((t) => t.id === current)) return current;
      const i = tracks.findIndex((t) => t.id === current);
      return tracks[(i + (reason === 'previous' ? -1 : 1) + tracks.length) % tracks.length].id;
    }
    if (reason === 'previous') {
      if (this.history.at(-1) === current) this.history.pop();
      while (this.history.length && !tracks.some((t) => t.id === this.history.at(-1)))
        this.history.pop();
      return this.history.at(-1) || current || tracks[0].id;
    }
    const available = new Set(tracks.map((t) => t.id));
    for (const id of this.shuffleCounts.keys())
      if (!available.has(id)) this.shuffleCounts.delete(id);
    // 新歌从当前最低次数开始，避免为了追平历史次数而长时间反复播放新歌。
    let baseline = Infinity;
    for (const count of this.shuffleCounts.values()) baseline = Math.min(baseline, count);
    if (baseline === Infinity) baseline = 0;
    for (const id of available)
      if (!this.shuffleCounts.has(id)) this.shuffleCounts.set(id, baseline);

    const excluded = new Set<string>();
    const recentLimit = Math.min(3, tracks.length - 1);
    if (recentLimit && current && available.has(current)) excluded.add(current);
    for (const id of this.recent.toReversed()) {
      if (excluded.size >= recentLimit) break;
      if (available.has(id)) excluded.add(id);
    }
    const eligible = tracks.filter((t) => !excluded.has(t.id));
    let minimum = Infinity;
    for (const track of eligible) minimum = Math.min(minimum, this.shuffleCounts.get(track.id)!);
    const choices = eligible.filter((t) => this.shuffleCounts.get(t.id) === minimum);
    return choices[Math.floor(this.random() * choices.length)].id;
  }
}
export class RoomService {
  private state: RoomState;
  readonly order = new PlaybackOrder();
  private seen = new Map<string, { revision: number; time: number }>();
  constructor(
    private database: Database,
    private now = () => performance.now(),
  ) {
    const c = database.checkpoint(),
      track = c?.trackId ? database.track(c.trackId) : undefined;
    this.state = {
      epoch: randomUUID(),
      revision: 0,
      trackId: track?.status === 'ready' ? track.id : null,
      status: 'paused',
      playbackMode: c?.playbackMode || 'repeat-one',
      anchorPositionSeconds: Math.min(c?.positionSeconds || 0, track?.durationSeconds || 0),
      anchorTimeMs: now(),
      durationSeconds: track?.durationSeconds || 0,
      updatedBy: null,
    };
    if (this.state.trackId) this.order.record(this.state.trackId);
  }
  getState(): RoomState {
    return { ...this.state };
  }
  position(): number {
    return positionAt(this.state, this.now());
  }
  private update(patch: Partial<RoomState>): RoomState {
    const previous = this.state;
    this.state = {
      ...this.state,
      anchorPositionSeconds: this.position(),
      anchorTimeMs: this.now(),
      ...patch,
      revision: previous.revision + 1,
    };
    try {
      this.save();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return this.getState();
  }
  private select(id: string | null, options: PlaybackRecordOptions = {}): RoomState {
    const track = id ? this.database.track(id) : undefined;
    if (id && (!track || track.status !== 'ready'))
      throw new AppError('TRACK_NOT_FOUND', '歌曲已不存在', 404);
    const state = this.update({
      trackId: track?.id || null,
      durationSeconds: track?.durationSeconds || 0,
      anchorPositionSeconds: 0,
      status: track ? 'playing' : 'stopped',
    });
    if (track) this.order.record(track.id, options);
    return state;
  }
  apply(command: Command, actor: Session): RoomState {
    if (command.epoch !== this.state.epoch)
      throw new AppError('STALE_EPOCH', '服务已重启，请等待重新同步', 409);
    const key = actor.id + ':' + command.commandId;
    if (this.seen.has(key)) return this.getState();
    const tracks = this.database.allTracks().filter((t) => t.status === 'ready');
    switch (command.action) {
      case 'selectTrack':
        this.select(command.trackId);
        break;
      case 'setPlaybackMode':
        this.update({ playbackMode: command.playbackMode });
        break;
      case 'next':
      case 'previous':
        this.select(
          this.order.choose(this.state.playbackMode, this.state.trackId, tracks, command.action),
          {
            history: command.action !== 'previous',
            shuffle: this.state.playbackMode === 'shuffle' && command.action === 'next',
          },
        );
        break;
      case 'play':
        if (!this.state.trackId) this.select(tracks[0]?.id || null);
        else
          this.update({
            status: 'playing',
            anchorPositionSeconds:
              this.position() >= this.state.durationSeconds ? 0 : this.position(),
          });
        break;
      case 'pause':
        this.update({ status: this.state.trackId ? 'paused' : 'stopped' });
        break;
      case 'seek':
        if (command.trackId !== this.state.trackId)
          throw new AppError('TRACK_NOT_FOUND', '歌曲已切换，已刷新播放状态', 409);
        this.update({
          anchorPositionSeconds: Math.min(command.positionSeconds, this.state.durationSeconds),
        });
        break;
    }
    this.state.updatedBy = actor.nickname;
    this.seen.set(key, { revision: this.state.revision, time: Date.now() });
    for (const [k, v] of this.seen)
      if (v.time < Date.now() - 300000 || this.seen.size > 2000) this.seen.delete(k);
    return this.getState();
  }
  ended(): boolean {
    if (this.state.status !== 'playing' || this.position() < this.state.durationSeconds)
      return false;
    const id = this.order.choose(
      this.state.playbackMode,
      this.state.trackId,
      this.database.allTracks().filter((t) => t.status === 'ready'),
      'ended',
    );
    this.select(id, { shuffle: this.state.playbackMode === 'shuffle' });
    return true;
  }
  deleted(id: string): void {
    if (this.state.trackId === id) this.select(null);
  }
  pauseWhenEmpty(): boolean {
    if (this.state.status !== 'playing') return false;
    this.update({ status: 'paused' });
    return true;
  }
  save(): void {
    this.database.saveCheckpoint({
      trackId: this.state.trackId,
      positionSeconds: this.position(),
      playbackMode: this.state.playbackMode,
      savedAt: new Date().toISOString(),
    });
  }
}
