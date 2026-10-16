import { mkdir, readdir, rm, stat, statfs, rename, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import type { Readable } from 'node:stream';
import type { Track, StorageUsage } from '../shared/models.js';
import { AppError } from '../shared/protocol.js';
import { Database } from './persistence.js';
import type { AppConfig } from './config.js';
/** 检查实际 MPEG Layer III 帧，禁止仅凭扩展名/ID3 接受数据。 */
async function verifyFrames(path: string): Promise<void> {
  const file = await open(path, 'r');
  try {
    const b = Buffer.alloc(65536);
    await file.read(b, 0, b.length, 0);
    let offset = 0;
    if (b.toString('ascii', 0, 3) === 'ID3')
      offset =
        10 +
        (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127)) +
        (b[5] & 16 ? 10 : 0);
    const sample = Buffer.alloc(65536);
    const result = await file.read(sample, 0, sample.length, offset);
    const size = result.bytesRead;
    let frames = 0;
    for (let i = 0; i < size - 4;) {
      const a = sample[i],
        b1 = sample[i + 1],
        c = sample[i + 2];
      const version = (b1 >> 3) & 3,
        layer = (b1 >> 1) & 3,
        br = c >> 4,
        sr = (c >> 2) & 3;
      if (
        a !== 255 ||
        (b1 & 224) !== 224 ||
        version === 1 ||
        layer !== 1 ||
        !br ||
        br === 15 ||
        sr === 3
      ) {
        if (frames) break;
        i++;
        continue;
      }
      const bitrates =
        version === 3
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const rate = [44100, 48000, 32000][sr] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const length =
        Math.floor(((version === 3 ? 144 : 72) * bitrates[br] * 1000) / rate) + ((c >> 1) & 1);
      if (++frames >= 3) return;
      i += length;
    }
    throw new AppError('INVALID_MP3', '文件不是有效的 MP3 音频');
  } finally {
    await file.close();
  }
}
export class MusicStorage {
  readonly musicDirectory: string;
  readonly tempDirectory: string;
  private active = 0;
  constructor(
    private database: Database,
    private config: AppConfig,
    private changed: () => void,
  ) {
    this.musicDirectory = join(config.dataDirectory, 'music');
    this.tempDirectory = join(config.dataDirectory, 'uploads');
  }
  path(key: string): string {
    if (!/^[a-f0-9-]+\.mp3$/.test(key)) throw new Error('Invalid storage key');
    return join(this.musicDirectory, key);
  }
  usage(): StorageUsage {
    const tracks = this.database.allTracks();
    const occupiedBytes = tracks.reduce((n, t) => n + t.sizeBytes, 0);
    const reservedBytes = Number(
      this.database.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM reservations').get()!
        .total,
    );
    return {
      limitBytes: 300000000,
      occupiedBytes,
      pendingDeleteBytes: tracks
        .filter((t) => t.status === 'pending-delete')
        .reduce((n, t) => n + t.sizeBytes, 0),
      reservedBytes,
      remainingBytes: Math.max(0, this.config.limitBytes - occupiedBytes - reservedBytes),
    };
  }
  async initialize(): Promise<void> {
    await mkdir(this.musicDirectory, { recursive: true });
    await mkdir(this.tempDirectory, { recursive: true });
    // No uploads survive restart. Keep reservations until all temporary files have been cleaned.
    for (const file of await readdir(this.tempDirectory))
      await rm(join(this.tempDirectory, file), { force: true });
    this.database.db.exec('DELETE FROM reservations');
    const known = new Set(this.database.allTracks().map((t) => t.storageKey));
    for (const file of await readdir(this.musicDirectory))
      if (!known.has(file)) await rm(join(this.musicDirectory, file), { force: true });
    for (const t of this.database.allTracks()) {
      try {
        await stat(this.path(t.storageKey));
      } catch {
        this.database.removeTrack(t.id);
      }
    }
    await this.cleanup();
  }
  async upload(source: Readable, name: string, declaredBytes: number): Promise<Track> {
    if (!name.toLowerCase().endsWith('.mp3'))
      throw new AppError('INVALID_MP3', '只能上传 MP3 文件');
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1 ||
      declaredBytes > this.config.maxFileBytes
    )
      throw new AppError('FILE_TOO_LARGE', '单首音乐最多 50 MB');
    if (this.active >= 2) throw new AppError('BUSY', '已有音乐正在上传，请稍后再试', 429);
    const disk = await statfs(this.config.dataDirectory);
    if (disk.bavail * disk.bsize < 1e9 + declaredBytes)
      throw new AppError('DISK_FULL', '服务器剩余磁盘不足', 507);
    // statfs awaits IO; another request may have claimed a slot in the meantime.
    if (this.active >= 2) throw new AppError('BUSY', '已有音乐正在上传，请稍后再试', 429);
    const id = randomUUID(),
      temp = join(this.tempDirectory, id),
      key = id + '.mp3';
    this.database.transaction(() => {
      if (declaredBytes > this.usage().remainingBytes)
        throw new AppError('QUOTA_EXCEEDED', '歌单剩余空间不足', 409);
      this.database.db.prepare('INSERT INTO reservations VALUES (?,?)').run(id, declaredBytes);
    });
    this.active++;
    this.changed();
    let bytes = 0,
      moved = false,
      committed = false;
    const hash = createHash('sha256');
    const timeout = setTimeout(
      () => source.destroy(new AppError('UPLOAD_TIMEOUT', '上传超时，请重试')),
      180000,
    );
    try {
      await pipeline(
        source,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > declaredBytes)
              return callback(new AppError('FILE_TOO_LARGE', '上传大小超过声明或限制'));
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(temp, { flags: 'wx' }),
      );
      if (bytes !== declaredBytes) throw new AppError('INCOMPLETE_UPLOAD', '文件上传不完整');
      await verifyFrames(temp);
      const meta = await parseFile(temp, { duration: true, skipCovers: true });
      const duration = meta.format.duration;
      if (
        !duration ||
        !Number.isFinite(duration) ||
        (meta.format.codec !== 'MPEG 1 Layer 3' && !meta.format.codec?.includes('Layer 3'))
      )
        throw new AppError('INVALID_MP3', '无法读取 MP3 时长或编码');
      const sha256 = hash.digest('hex');
      const existing = this.database
        .allTracks()
        .find((t) => t.sha256 === sha256 && t.status === 'ready');
      if (existing) return existing;
      const clean = (s: string) =>
        s
          .replace(/[\u0000-\u001f]/g, '')
          .trim()
          .slice(0, 200);
      const track: Track = {
        id,
        title: clean(meta.common.title || basename(name).replace(/\.mp3$/i, '')),
        artist: clean(meta.common.artist || '未知歌手'),
        storageKey: key,
        sizeBytes: bytes,
        durationSeconds: duration,
        sha256,
        createdAt: new Date().toISOString(),
        status: 'ready',
      };
      await rename(temp, this.path(key));
      moved = true;
      // Another upload of the same file may have completed while rename awaited IO.
      const duplicate = this.database
        .allTracks()
        .find((t) => t.sha256 === sha256 && t.status === 'ready');
      if (duplicate) return duplicate;
      this.database.transaction(() => {
        this.database.putTrack(track);
        this.database.db.prepare('DELETE FROM reservations WHERE id=?').run(id);
      });
      committed = true;
      return track;
    } finally {
      clearTimeout(timeout);
      this.active--;
      if (!committed) {
        try {
          await rm(moved ? this.path(key) : temp, { force: true });
          this.database.db.prepare('DELETE FROM reservations WHERE id=?').run(id);
        } catch (e) {
          console.error('Upload cleanup failed', e);
        }
      }
      this.changed();
    }
  }
  async cleanup(): Promise<void> {
    for (const track of this.database.allTracks().filter((t) => t.status === 'pending-delete')) {
      try {
        await rm(this.path(track.storageKey), { force: true });
        this.database.removeTrack(track.id);
      } catch (e) {
        console.error('Pending file cleanup failed', e);
      }
    }
    this.changed();
  }
}
