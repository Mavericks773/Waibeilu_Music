import type { RoomState, TrackSummary, StorageUsage, Presence } from '../shared/models.js';
export type RoomTab = 'playlist' | 'player';
export interface UploadTaskView {
  id: string;
  fileName: string;
  sentBytes: number;
  totalBytes: number;
  phase: 'queued' | 'uploading' | 'validating' | 'completed' | 'failed';
  errorMessage?: string;
}
export class ClientStore {
  room: RoomState | null = null;
  tracks: TrackSummary[] = [];
  storage: StorageUsage | null = null;
  presence: Presence | null = null;
  uploads: UploadTaskView[] = [];
  tab: RoomTab = 'playlist';
  search = '';
  connected = false;
  joined = false;
}
