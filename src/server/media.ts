import { open, stat } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import { AppError } from '../shared/protocol.js';

export type AudioExtension = '.mp3' | '.ogg';

export function audioContentType(key: string): string {
  return key.toLowerCase().endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg';
}

/** 检查实际 MPEG Layer III 帧，禁止仅凭扩展名或 ID3 接受数据。 */
async function verifyMp3(path: string): Promise<void> {
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
    const { bytesRead: size } = await file.read(sample, 0, sample.length, offset);
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

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

/** 验证整个 Ogg 页链和校验和；只接受单逻辑音轨，排除视频/多路容器。 */
async function verifyOgg(path: string): Promise<'Vorbis' | 'Opus'> {
  const file = await open(path, 'r');
  const invalid = () => new AppError('INVALID_OGG', 'Ogg 文件损坏或不是支持的 Vorbis / Opus 音频');
  try {
    const size = (await stat(path)).size;
    let offset = 0,
      sequence = 0,
      serial: number | undefined,
      ended = false;
    let codec: 'Vorbis' | 'Opus' | undefined;
    let continued = false;
    while (offset < size) {
      const header = Buffer.alloc(27);
      if (
        (await file.read(header, 0, 27, offset)).bytesRead !== 27 ||
        header.toString('ascii', 0, 4) !== 'OggS' ||
        header[4] !== 0 ||
        ended
      )
        throw invalid();
      const flags = header[5];
      if (
        (flags & ~7) !== 0 ||
        Boolean(flags & 1) !== continued ||
        Boolean(flags & 2) !== (sequence === 0)
      )
        throw invalid();
      const pageSerial = header.readUInt32LE(14);
      serial ??= pageSerial;
      if (serial !== pageSerial || header.readUInt32LE(18) !== sequence++) throw invalid();
      const lacing = Buffer.alloc(header[26]);
      if ((await file.read(lacing, 0, lacing.length, offset + 27)).bytesRead !== lacing.length)
        throw invalid();
      const bodySize = lacing.reduce((sum, length) => sum + length, 0);
      const body = Buffer.alloc(bodySize);
      if ((await file.read(body, 0, bodySize, offset + 27 + lacing.length)).bytesRead !== bodySize)
        throw invalid();
      const expectedCrc = header.readUInt32LE(22);
      header.writeUInt32LE(0, 22);
      let crc = 0;
      for (const bytes of [header, lacing, body])
        for (const byte of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
      if (crc !== expectedCrc) throw invalid();
      if (!codec) {
        let firstPacketSize = 0,
          complete = false;
        for (const length of lacing) {
          firstPacketSize += length;
          if (length < 255) {
            complete = true;
            break;
          }
        }
        if (!complete) throw invalid();
        if (firstPacketSize >= 30 && body[0] === 1 && body.toString('ascii', 1, 7) === 'vorbis')
          codec = 'Vorbis';
        else if (firstPacketSize >= 19 && body.toString('ascii', 0, 8) === 'OpusHead')
          codec = 'Opus';
        else throw invalid();
      }
      if (lacing.length) continued = lacing.at(-1) === 255;
      ended = Boolean(flags & 4);
      if (ended && continued) throw invalid();
      offset += 27 + lacing.length + bodySize;
    }
    if (!codec || !ended || sequence < 2) throw invalid();
    return codec;
  } finally {
    await file.close();
  }
}

export async function inspectAudio(path: string, extension: AudioExtension) {
  const oggCodec = extension === '.ogg' ? await verifyOgg(path) : undefined;
  if (extension === '.mp3') await verifyMp3(path);
  try {
    const meta = await parseFile(path, { duration: true, skipCovers: true });
    const { duration, codec, container } = meta.format;
    const matches =
      extension === '.mp3'
        ? codec?.includes('Layer 3')
        : container === 'Ogg' && codec?.startsWith(oggCodec!);
    if (
      !duration ||
      duration <= 0 ||
      !Number.isFinite(duration) ||
      !matches ||
      !meta.format.numberOfChannels
    )
      throw new Error('Invalid audio metadata');
    return { duration, title: meta.common.title, artist: meta.common.artist };
  } catch {
    throw new AppError(
      extension === '.ogg' ? 'INVALID_OGG' : 'INVALID_MP3',
      '无法读取音频编码或时长，请检查文件是否完整',
    );
  }
}
