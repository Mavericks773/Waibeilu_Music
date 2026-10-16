import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Session } from '../shared/models.js';
import { AppError } from '../shared/protocol.js';
import { Database } from './persistence.js';
import type { AppConfig } from './config.js';
interface StoredSession extends Session {
  csrf: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class AuthService {
  private salt: Buffer;
  private passwordHash: Buffer;
  private attempts = new Map<string, { count: number; reset: number }>();
  constructor(
    private config: AppConfig,
    private database: Database,
  ) {
    const storedSalt = database.setting('passwordSalt');
    this.salt = storedSalt ? Buffer.from(storedSalt, 'hex') : randomBytes(16);
    if (!storedSalt) database.setSetting('passwordSalt', this.salt.toString('hex'));
    this.passwordHash = scryptSync(config.password, this.salt, 32);
    const fingerprint = this.passwordHash.toString('hex');
    if (database.setting('passwordFingerprint') !== fingerprint) {
      database.db.exec('DELETE FROM sessions');
      database.setSetting('passwordFingerprint', fingerprint);
    }
  }
  login(password: string, ip: string): { cookie: string; session: StoredSession } {
    const now = Date.now(),
      previous = this.attempts.get(ip);
    const bucket = previous && previous.reset > now ? previous : { count: 0, reset: now + 60000 };
    if (++bucket.count > 10) throw new AppError('RATE_LIMITED', '尝试太频繁，请稍后再试', 429);
    if (this.attempts.size > 1000)
      for (const [key, item] of this.attempts) if (item.reset <= now) this.attempts.delete(key);
    this.attempts.set(ip, bucket);
    if (!timingSafeEqual(scryptSync(password, this.salt, 32), this.passwordHash))
      throw new AppError('WRONG_PASSWORD', '密码不对，再试一次', 401);
    const token = randomBytes(32).toString('hex');
    const session: StoredSession = {
      id: randomBytes(16).toString('hex'),
      nickname: '朋友',
      expiresAt: new Date(now + 7 * 86400000).toISOString(),
      csrf: randomBytes(24).toString('hex'),
    };
    this.database.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(digest(token), JSON.stringify(session), Date.parse(session.expiresAt));
    return { cookie: this.cookie(token), session };
  }
  cookie(token: string, clear = false): string {
    return `room_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 604800}${this.config.secure ? '; Secure' : ''}`;
  }
  authenticate(cookie?: string): StoredSession {
    const token = cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('room_session='))
      ?.slice(13);
    if (!token) throw new AppError('UNAUTHENTICATED', '请输入房间密码', 401);
    const row = this.database.db
      .prepare('SELECT data, expires FROM sessions WHERE hash=?')
      .get(digest(token));
    if (!row || Number(row.expires) <= Date.now())
      throw new AppError('UNAUTHENTICATED', '登录已过期，请重新进入', 401);
    return JSON.parse(row.data as string);
  }
  validateOrigin(origin?: string): void {
    if (origin !== this.config.origin) throw new AppError('FORBIDDEN', '请求来源无效', 403);
  }
  validateCsrf(session: StoredSession, token?: string): void {
    if (token !== session.csrf) throw new AppError('FORBIDDEN', '请求验证失败，请刷新页面', 403);
  }
  updateNickname(session: StoredSession, nickname: string): StoredSession {
    const next = { ...session, nickname: nickname.trim().slice(0, 24) || '朋友' };
    this.database.db
      .prepare("UPDATE sessions SET data=? WHERE json_extract(data,'$.id')=?")
      .run(JSON.stringify(next), session.id);
    return next;
  }
  logout(id: string): void {
    this.database.db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.id')=?").run(id);
  }
  cleanup(): void {
    this.database.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  }
}
