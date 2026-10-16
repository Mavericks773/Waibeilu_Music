import { resolve } from 'node:path';
import { PLAYLIST_LIMIT_BYTES, MAX_AUDIO_FILE_BYTES } from '../shared/limits.js';
export interface AppConfig {
  port: number;
  host: string;
  origin: string;
  dataDirectory: string;
  password: string;
  secure: boolean;
  publicDirectory: string;
  limitBytes: number;
  maxFileBytes: number;
}
export function loadConfig(env = process.env): AppConfig {
  const port = Number(env.PORT || 3000);
  const origin = env.PUBLIC_ORIGIN || `http://localhost:${port}`;
  const u = new URL(origin);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.origin !== origin ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('PUBLIC_ORIGIN 或 PORT 配置无效');
  const password = env.ROOM_PASSWORD || '';
  if (password.length < 4 || password.length > 200)
    throw new Error('请设置至少 4 个字符的 ROOM_PASSWORD');
  return {
    port,
    host: env.HOST || '127.0.0.1',
    origin,
    password,
    secure: u.protocol === 'https:',
    dataDirectory: resolve(env.DATA_DIR || 'data'),
    publicDirectory: resolve('dist/public'),
    limitBytes: PLAYLIST_LIMIT_BYTES,
    maxFileBytes: MAX_AUDIO_FILE_BYTES,
  };
}
