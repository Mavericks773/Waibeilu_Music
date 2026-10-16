import type { Session, TrackSummary } from '../shared/models.js';
import type { Command } from '../shared/protocol.js';
import { Database } from './persistence.js';
import { RoomService, SerialCommandQueue } from './playback.js';
import { SeatRegistry } from './seats.js';
export class MusicApplication {
  readonly queue = new SerialCommandQueue();
  constructor(
    readonly database: Database,
    readonly room: RoomService,
    readonly seats: SeatRegistry,
    readonly broadcast: () => void,
  ) {}
  tracks(): TrackSummary[] {
    return this.database
      .allTracks()
      .filter((t) => t.status === 'ready')
      .map(({ id, title, artist, durationSeconds }) => ({ id, title, artist, durationSeconds }));
  }
  control(session: Session, connectionId: string, command: Command): Promise<void> {
    return this.queue.run(() => {
      this.seats.touch(session.id, connectionId);
      this.room.apply(command, session);
      this.broadcast();
    });
  }
  deleteTrack(id: string): Promise<void> {
    return this.queue.run(() => {
      const track = this.database.track(id);
      if (!track) return;
      this.room.deleted(id);
      this.database.putTrack({ ...track, status: 'pending-delete' });
      this.broadcast();
    });
  }
  tick(): Promise<void> {
    return this.queue.run(() => {
      this.seats.expire();
      if (!this.seats.presence().activeCount) this.room.pauseWhenEmpty();
      else this.room.ended();
      this.broadcast();
    });
  }
}
