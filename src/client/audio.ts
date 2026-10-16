import type { RoomState, ClockSample, TrackSummary } from '../shared/models.js';
import { positionAt } from '../shared/protocol.js';
export class ClockEstimator {
  private samples: { rtt: number; offset: number }[] = [];
  private offset = 0;
  ready = false;
  addSample(s: ClockSample): void {
    const rtt = s.clientReceivedMs - s.clientSentMs - (s.serverSentMs - s.serverReceivedMs);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.samples.push({
      rtt,
      offset: (s.serverReceivedMs - s.clientSentMs + s.serverSentMs - s.clientReceivedMs) / 2,
    });
    if (this.samples.length > 20) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt)[0];
    this.offset = best.offset;
    this.ready = true;
  }
  serverNow(): number {
    return performance.now() + this.offset;
  }
  reset(): void {
    this.samples = [];
    this.ready = false;
  }
}
export class AudioPlayer {
  trackId: string | null = null;
  private silence?: string;
  constructor(readonly element: HTMLAudioElement) {
    element.volume = 0.8;
    element.playbackRate = 1;
    element.loop = false;
  }
  async unlock(): Promise<void> {
    if (this.trackId) {
      await this.element.play();
      return;
    }
    const data = new ArrayBuffer(44 + 1600),
      view = new DataView(data);
    const str = (at: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    view.setUint32(4, data.byteLength - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, 1600, true);
    this.silence ||= URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    this.element.src = this.silence;
    await this.element.play();
    this.element.pause();
  }
  load(id: string): void {
    if (id === this.trackId) return;
    this.trackId = id;
    this.element.src = `/api/tracks/${id}/audio`;
    this.element.load();
  }
  stop(): void {
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
    this.trackId = null;
  }
}
export class SyncController {
  state: RoomState | null = null;
  active = false;
  connected = false;
  status = '尚未收听';
  private lastSeek = -Infinity;
  constructor(
    readonly audio: AudioPlayer,
    readonly clock: ClockEstimator,
  ) {}
  accept(state: RoomState): void {
    if (this.state?.epoch === state.epoch && this.state.revision > state.revision) return;
    const force =
      !this.state || state.epoch !== this.state.epoch || state.revision !== this.state.revision;
    if (this.state && state.epoch !== this.state.epoch) this.clock.reset();
    this.state = state;
    void this.reconcile(force);
  }
  async reconcile(force = false): Promise<void> {
    if (!this.active || !this.connected || !this.clock.ready || !this.state) return;
    const state = this.state,
      el = this.audio.element;
    if (!state.trackId) {
      if (this.audio.trackId) this.audio.stop();
      this.status = '等待选曲';
      return;
    }
    this.audio.load(state.trackId);
    if (el.readyState < 1) {
      this.status = '正在缓冲';
      return;
    }
    const target = positionAt(state, this.clock.serverNow());
    const error = Math.abs(el.currentTime - target);
    if (error > 0.35 && (force || performance.now() - this.lastSeek > 1000)) {
      try {
        el.currentTime = target;
        this.lastSeek = performance.now();
      } catch {}
    }
    el.playbackRate = 1;
    el.loop = false;
    if (state.status === 'playing') {
      if (el.paused) {
        try {
          await el.play();
        } catch (e) {
          if (this.state !== state || !this.active) return;
          this.status =
            e instanceof DOMException && e.name === 'NotAllowedError'
              ? '需要点击继续收听'
              : '正在缓冲';
          return;
        }
        if (!this.active || !this.connected || this.state?.status !== 'playing') el.pause();
      }
      this.status = el.readyState < 3 ? '正在缓冲' : error <= 0.5 ? '已同步' : '正在对齐';
    } else {
      el.pause();
      this.status = '已暂停';
    }
  }
  disconnect(): void {
    this.connected = false;
    this.audio.element.pause();
    this.status = '连接中断，正在重连';
  }
}
export class MediaSessionBridge {
  attach(actions: {
    play(): void;
    pause(): void;
    next(): void;
    previous(): void;
    seek(seconds: number): void;
  }): void {
    if (!('mediaSession' in navigator)) return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: actions.play,
      pause: actions.pause,
      nexttrack: actions.next,
      previoustrack: actions.previous,
      seekto: (detail) => {
        if (detail.seekTime !== undefined) actions.seek(detail.seekTime);
      },
    };
    for (const [key, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(key as MediaSessionAction, handler!);
      } catch {}
    }
  }
  update(track: TrackSummary | undefined, state: RoomState | null, position: number): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata =
      track && typeof MediaMetadata !== 'undefined'
        ? new MediaMetadata({ title: track.title, artist: track.artist })
        : null;
    navigator.mediaSession.playbackState = state?.status === 'playing' ? 'playing' : 'paused';
    try {
      if (track && track.durationSeconds > 0)
        navigator.mediaSession.setPositionState({
          duration: track.durationSeconds,
          playbackRate: 1,
          position: Math.min(track.durationSeconds, Math.max(0, position)),
        });
    } catch {}
  }
}
