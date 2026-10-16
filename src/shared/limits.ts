/** 与已有十进制 MB 配额一致：1 GB = 1,000,000,000 字节。 */
export const PLAYLIST_LIMIT_BYTES = 1_000_000_000;
export const MAX_AUDIO_FILE_BYTES = 50_000_000;
export const AUDIO_FILE_ACCEPT = '.mp3,.ogg,audio/mpeg,audio/ogg,application/ogg';

export function isSupportedAudioName(name: string): boolean {
  return /\.(mp3|ogg)$/i.test(name);
}
