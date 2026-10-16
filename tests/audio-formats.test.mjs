import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../dist/server/main.js';

test(
  '1 GB 配额与真实 Ogg Vorbis / Opus 的上传、读取、恢复和拒绝伪造',
  { timeout: 60000 },
  async () => {
    await mkdir('test-results', { recursive: true });
    const directory = await mkdtemp(resolve('test-results/ogg-'));
    const config = {
      port: 0,
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
      password: 'ogg-test-1234',
      secure: false,
      dataDirectory: directory,
      publicDirectory: resolve('dist/public'),
      limitBytes: 1000000000,
      maxFileBytes: 50000000,
    };
    let runtime = await createServer(config);
    let socket;
    let cookie = '',
      csrf = '';
    const request = (path, method = 'GET', body, headers = {}) =>
      fetch(config.origin + path, {
        method,
        headers: { Origin: config.origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
        body,
      });
    const upload = (bytes, name, mime = 'audio/ogg') => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), name);
      return request('/api/tracks', 'POST', form, { 'X-File-Size': String(bytes.length) });
    };
    try {
      await runtime.start();
      config.origin = `http://127.0.0.1:${runtime.server.address().port}`;
      const login = await request(
        '/api/login',
        'POST',
        JSON.stringify({ password: config.password }),
        { 'Content-Type': 'application/json' },
      );
      cookie = login.headers.get('set-cookie').split(';')[0];
      csrf = (await login.json()).csrfToken;
      socket = new WebSocket(config.origin.replace('http:', 'ws:') + '/ws', {
        headers: { Origin: config.origin, Cookie: cookie },
      });
      await new Promise((resolve, reject) => {
        socket.on('message', (raw) => {
          const m = JSON.parse(raw);
          if (m.type === 'hello') socket.send(JSON.stringify({ type: 'join', requestId: 'join' }));
          if (m.type === 'joined') resolve();
          if (m.type === 'error') reject(Error(m.message));
        });
        socket.on('error', reject);
      });

      const tracks = [];
      for (const kind of ['vorbis', 'opus']) {
        const bytes = await readFile(`tests/fixtures/tone-${kind}.ogg`);
        const response = await upload(bytes, `音频 ${kind}.OGG`, 'application/octet-stream');
        const result = await response.json();
        assert.equal(response.status, 201, JSON.stringify(result));
        const track = result.track;
        tracks.push(track);
        assert.equal(track.title, `音频 ${kind}`);
        assert.equal(track.artist, '未知歌手');
        assert.ok(track.durationSeconds > 1.9 && track.durationSeconds < 2.1);
        const full = await request(`/api/tracks/${track.id}/audio`);
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('content-type'), 'audio/ogg');
        assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
        const range = await request(`/api/tracks/${track.id}/audio`, 'GET', undefined, {
          Range: 'bytes=0-63',
        });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('content-type'), 'audio/ogg');
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 64));
        const head = await request(`/api/tracks/${track.id}/audio`, 'HEAD');
        assert.equal(head.headers.get('content-length'), String(bytes.length));
        assert.equal(head.headers.get('content-type'), 'audio/ogg');
      }

      const vorbis = await readFile('tests/fixtures/tone-vorbis.ogg');
      const duplicate = await (await upload(vorbis, 'duplicate.ogg')).json();
      assert.equal(duplicate.track.id, tracks[0].id);
      assert.equal((await upload(vorbis, 'renamed.mp3')).status, 400);
      const mp3 = await readFile('yumetohazakura.mp3');
      assert.equal((await upload(mp3, 'renamed.ogg')).status, 400);
      assert.equal((await upload(Buffer.from('OggS fake audio'), 'fake.ogg')).status, 400);
      assert.equal(
        (await upload(vorbis.subarray(0, vorbis.length - 8), 'truncated.ogg')).status,
        400,
      );
      const corrupt = Buffer.from(vorbis);
      corrupt[corrupt.length - 1] ^= 1;
      assert.equal((await upload(corrupt, 'corrupt.ogg')).status, 400);
      assert.equal((await upload(vorbis, 'not-supported.wav')).status, 400);
      let storage = runtime.storage.usage();
      assert.equal(storage.reservedBytes, 0);

      // More than the old 300 MB is already occupied/reserved: valid uploads still succeed.
      runtime.database.db
        .prepare('INSERT INTO reservations VALUES (?,?)')
        .run('over-old-limit', 350000000);
      assert.equal((await upload(vorbis, 'above-old-capacity.ogg')).status, 201);
      runtime.database.db.prepare('DELETE FROM reservations WHERE id=?').run('over-old-limit');
      storage = runtime.storage.usage();
      const freeAfterExactReservation = storage.remainingBytes - vorbis.length;
      runtime.database.db
        .prepare('INSERT INTO reservations VALUES (?,?)')
        .run('exact-boundary', freeAfterExactReservation);
      assert.equal((await upload(vorbis, 'exact-boundary.ogg')).status, 201);
      runtime.database.db.prepare('DELETE FROM reservations WHERE id=?').run('exact-boundary');
      runtime.database.db
        .prepare('INSERT INTO reservations VALUES (?,?)')
        .run('full', storage.remainingBytes - vorbis.length + 1);
      assert.equal((await upload(vorbis, 'over-boundary.ogg')).status, 409);
      runtime.database.db.prepare('DELETE FROM reservations WHERE id=?').run('full');
      assert.equal(runtime.storage.usage().remainingBytes, storage.remainingBytes);

      // Reopen the same database without migration: both formats and pending deletion survive.
      await runtime.app.deleteTrack(tracks[1].id);
      assert.ok(runtime.storage.usage().pendingDeleteBytes > 0);
      socket.terminate();
      await runtime.stop();
      runtime = await createServer(config);
      assert.deepEqual(
        runtime.app.tracks().map((t) => t.id),
        [tracks[0].id],
      );
      assert.equal(runtime.storage.usage().pendingDeleteBytes, 0);
      assert.equal(runtime.storage.usage().limitBytes, 1000000000);
      assert.equal(runtime.storage.usage().reservedBytes, 0);
    } finally {
      socket?.terminate();
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
