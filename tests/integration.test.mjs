import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../dist/server/main.js';

test('房间：MP3 上传、五人席位、并发控制、循环、容量和恢复', { timeout: 90000 }, async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/integration-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    password: 'test-room-12345',
    secure: false,
    dataDirectory: directory,
    publicDirectory: resolve('dist/public'),
    limitBytes: 1000000000,
    maxFileBytes: 50000000,
  };
  let runtime = await createServer(config);
  const sockets = [];
  try {
    await runtime.start();
    const port = runtime.server.address().port;
    config.origin = `http://127.0.0.1:${port}`;
    const request = async (path, method = 'GET', data, session, headers = {}) => {
      const response = await fetch(config.origin + path, {
        method,
        headers: {
          Origin: config.origin,
          ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
          ...headers,
          ...(data !== undefined && !(data instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      });
      return response;
    };
    assert.equal((await request('/api/tracks')).status, 401);
    assert.equal((await request('/api/login', 'POST', { password: 'bad-password' })).status, 401);
    const sessions = [];
    for (let i = 0; i < 6; i++) {
      const r = await request('/api/login', 'POST', { password: config.password });
      assert.equal(r.status, 200);
      const json = await r.json();
      sessions.push({
        cookie: r.headers.get('set-cookie').split(';')[0],
        csrf: json.csrfToken,
        session: json.session,
      });
    }
    const session = sessions[0];
    assert.equal(
      (await request('/api/session', 'PATCH', { nickname: '测试朋友' }, session)).status,
      200,
    );
    assert.equal(
      (
        await request('/api/session', 'PATCH', { nickname: 'test' }, session, {
          'X-CSRF-Token': 'bad',
        })
      ).status,
      403,
    );
    const fixture = await readFile('yumetohazakura.mp3');
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'audio/mpeg' }), 'yumetohazakura.mp3');
    const result = await request('/api/tracks', 'POST', form, session, {
      'X-File-Size': String(fixture.length),
    });
    const uploaded = await result.json();
    assert.equal(result.status, 201, JSON.stringify(uploaded));
    const track = uploaded.track;
    assert.ok(track.durationSeconds > 100);
    assert.ok(track.title);
    assert.ok(track.artist);
    let storage = await (await request('/api/storage', 'GET', undefined, session)).json();
    assert.equal(storage.occupiedBytes, fixture.length);
    assert.equal(storage.reservedBytes, 0);
    assert.equal(storage.limitBytes, 1000000000);
    assert.equal(
      (await request(`/api/tracks/${track.id}/audio`, 'GET', undefined, session)).status,
      403,
    );
    const connect = async (s) => {
      const socket = new WebSocket(config.origin.replace('http:', 'ws:') + '/ws', {
        headers: { Cookie: s.cookie, Origin: config.origin },
      });
      sockets.push(socket);
      const messages = [];
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      const wait = async (predicate) => {
        for (let i = 0; i < 500; i++) {
          const at = messages.findIndex(predicate);
          if (at >= 0) return messages.splice(at, 1)[0];
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error('WS response timeout: ' + JSON.stringify(messages.slice(-2)));
      };
      await wait((m) => m.type === 'hello');
      return { socket, wait, send: (m) => socket.send(JSON.stringify(m)) };
    };
    const clients = [];
    for (let i = 0; i < 6; i++) {
      const c = await connect(sessions[i]);
      clients.push(c);
      c.send({ type: 'join', requestId: 'join-' + i });
      const reply = await c.wait((m) => m.type === 'joined' || m.type === 'error');
      assert.equal(reply.type, i < 5 ? 'joined' : 'error');
      if (i === 5) assert.equal(reply.code, 'ROOM_FULL');
    }
    let roomView = await (await request('/api/room', 'GET', undefined, session)).json();
    assert.deepEqual(roomView.presence.nicknames, ['测试朋友', '朋友', '朋友', '朋友', '朋友']);
    await request('/api/session', 'PATCH', { nickname: '改名后的朋友' }, session);
    roomView = await (await request('/api/room', 'GET', undefined, session)).json();
    assert.equal(roomView.presence.nicknames[0], '改名后的朋友');
    assert.equal(roomView.presence.activeCount, 5);
    const competing = await connect(session);
    competing.send({ type: 'join', requestId: 'compete' });
    assert.equal((await competing.wait((m) => m.type === 'error')).code, 'TAKEOVER_REQUIRED');
    const closed = new Promise((resolve) => clients[0].socket.once('close', resolve));
    clients[0].socket.close();
    await closed;
    const reconnected = await connect(session);
    reconnected.send({ type: 'join', requestId: 'reload' });
    assert.equal(
      (await reconnected.wait((m) => m.type === 'joined' || m.type === 'error')).type,
      'joined',
    );
    clients[0] = reconnected;
    const audio = await request(`/api/tracks/${track.id}/audio`, 'GET', undefined, session, {
      Range: 'bytes=100-199',
    });
    assert.equal(audio.status, 206);
    assert.equal((await audio.arrayBuffer()).byteLength, 100);
    assert.deepEqual(
      Buffer.from(
        await (
          await request(`/api/tracks/${track.id}/audio`, 'GET', undefined, session, {
            Range: 'bytes=100-199',
          })
        ).arrayBuffer(),
      ),
      fixture.subarray(100, 200),
    );
    const suffix = await request(`/api/tracks/${track.id}/audio`, 'HEAD', undefined, session, {
      Range: 'bytes=-100',
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-length'), '100');
    assert.equal(
      (
        await request(`/api/tracks/${track.id}/audio`, 'GET', undefined, session, {
          Range: 'bytes=999999999-',
        })
      ).status,
      416,
    );
    let commandNo = 0;
    const command = async (i, action) => {
      const id = 'cmd-' + commandNo++;
      clients[i].send({
        type: 'control',
        commandId: id,
        epoch: runtime.app.room.getState().epoch,
        ...action,
      });
      const reply = await clients[i].wait(
        (m) => m.commandId === id || (m.requestId === id && m.type === 'error'),
      );
      assert.equal(reply.type, 'ack', JSON.stringify(reply));
    };
    await command(0, { action: 'selectTrack', trackId: track.id });
    await Promise.all(
      clients
        .slice(0, 5)
        .map((_, i) => command(i, { action: 'seek', trackId: track.id, positionSeconds: 10 + i })),
    );
    for (let cycle = 0; cycle < 8; cycle++)
      await Promise.all(
        clients
          .slice(0, 5)
          .map((_, i) =>
            command(i, { action: 'seek', trackId: track.id, positionSeconds: cycle + i }),
          ),
      );
    await command(4, { action: 'pause' });
    assert.equal(runtime.app.room.getState().status, 'paused');
    await command(2, { action: 'setPlaybackMode', playbackMode: 'shuffle' });
    assert.equal(runtime.app.room.getState().playbackMode, 'shuffle');
    await command(1, { action: 'play' });
    await command(0, { action: 'seek', trackId: track.id, positionSeconds: track.durationSeconds });
    await runtime.app.tick();
    assert.equal(runtime.app.room.getState().trackId, track.id);
    assert.ok(runtime.app.room.position() < 2);
    const duplicateForm = new FormData();
    duplicateForm.append('file', new Blob([fixture]), 'duplicate.mp3');
    const duplicateResult = await (
      await request('/api/tracks', 'POST', duplicateForm, session, {
        'X-File-Size': String(fixture.length),
      })
    ).json();
    assert.equal(duplicateResult.track.id, track.id);
    assert.equal(runtime.app.tracks().length, 1);
    // Invalid MP3 must not consume quota.
    const bad = new FormData();
    bad.append('file', new Blob(['not mp3']), 'fake.mp3');
    assert.equal(
      (await request('/api/tracks', 'POST', bad, session, { 'X-File-Size': '7' })).status,
      400,
    );
    storage = await (await request('/api/storage', 'GET', undefined, session)).json();
    assert.equal(storage.reservedBytes, 0);
    // Simulate nearly full storage with pending deletion: cannot reserve beyond quota.
    runtime.database.db
      .prepare('INSERT INTO reservations VALUES (?,?)')
      .run('test-full', 1000000000 - fixture.length - 10);
    const over = new FormData();
    over.append('file', new Blob([fixture]), 'full.mp3');
    assert.equal(
      (
        await request('/api/tracks', 'POST', over, session, {
          'X-File-Size': String(fixture.length),
        })
      ).status,
      409,
    );
    runtime.database.db.prepare('DELETE FROM reservations WHERE id=?').run('test-full');
    await command(0, { action: 'pause' });
    await command(0, { action: 'seek', trackId: track.id, positionSeconds: 25 });
    assert.equal((await request('/api/logout', 'POST', undefined, sessions[4])).status, 200);
    roomView = await (await request('/api/room', 'GET', undefined, session)).json();
    assert.equal(roomView.presence.activeCount, 4);
    assert.equal(roomView.presence.nicknames.length, 4);
    runtime.app.seats.requireLease(sessions[3].session.id).expiresAtMs = Date.now() - 1;
    await runtime.app.tick();
    assert.equal(runtime.app.seats.presence().nicknames.length, 3);
    for (const s of sockets) s.terminate();
    await runtime.stop();
    runtime = await createServer(config);
    assert.equal(runtime.app.room.getState().status, 'paused');
    assert.equal(runtime.app.room.getState().playbackMode, 'shuffle');
    assert.equal(runtime.app.room.getState().anchorPositionSeconds, 25);
    assert.equal(runtime.app.tracks().length, 1);
    await runtime.start();
    const nextPort = runtime.server.address().port;
    config.origin = `http://127.0.0.1:${nextPort}`;
    assert.equal(
      (await request(`/api/tracks/${track.id}`, 'DELETE', undefined, session)).status,
      200,
    );
    assert.equal(runtime.app.room.getState().trackId, null);
    await runtime.storage.cleanup();
    assert.equal(runtime.storage.usage().occupiedBytes, 0);
    assert.equal((await request('/api/logout', 'POST', undefined, session)).status, 200);
    assert.equal((await request('/api/tracks', 'GET', undefined, session)).status, 401);
  } finally {
    sockets.forEach((s) => s.terminate());
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('播放顺序、空歌单、旧指令和随机历史', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/order-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    password: 'order-test-12345',
    secure: false,
    dataDirectory: directory,
    publicDirectory: resolve('dist/public'),
    limitBytes: 1000000000,
    maxFileBytes: 50000000,
  };
  const runtime = await createServer(config);
  try {
    const room = runtime.app.room,
      actor = {
        id: 'tester',
        nickname: '测试',
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
    let n = 0;
    const control = (action) =>
      room.apply({ commandId: String(n++), epoch: room.getState().epoch, ...action }, actor);
    control({ action: 'play' });
    assert.equal(room.getState().status, 'stopped');
    for (let i = 0; i < 3; i++)
      runtime.database.putTrack({
        id: 't' + i,
        title: 'Track ' + i,
        artist: 'Artist',
        storageKey: 'unused.mp3',
        sizeBytes: 100,
        durationSeconds: 60,
        sha256: 'hash' + i,
        createdAt: new Date().toISOString(),
        status: 'ready',
      });
    control({ action: 'selectTrack', trackId: 't0' });
    control({ action: 'setPlaybackMode', playbackMode: 'shuffle' });
    control({ action: 'next' });
    assert.notEqual(room.getState().trackId, 't0');
    control({ action: 'previous' });
    assert.equal(room.getState().trackId, 't0');
    control({ action: 'setPlaybackMode', playbackMode: 'repeat-one' });
    control({ action: 'seek', trackId: 't0', positionSeconds: 60 });
    room.ended();
    assert.equal(room.getState().trackId, 't0');
    assert.ok(room.position() < 1);
    const id = 'duplicate';
    room.apply({ commandId: id, epoch: room.getState().epoch, action: 'next' }, actor);
    const after = room.getState();
    room.apply({ commandId: id, epoch: after.epoch, action: 'next' }, actor);
    assert.equal(room.getState().revision, after.revision);
    assert.throws(
      () => room.apply({ commandId: 'stale', epoch: 'old', action: 'pause' }, actor),
      /服务已重启/,
    );
    assert.throws(
      () => control({ action: 'seek', trackId: 'deleted', positionSeconds: 10 }),
      /歌曲已切换/,
    );
    control({ action: 'pause' });
    const before = room.position();
    control({ action: 'setPlaybackMode', playbackMode: 'shuffle' });
    assert.equal(room.getState().status, 'paused');
    assert.equal(room.position(), before);
    room.pauseWhenEmpty();
    assert.equal(room.getState().status, 'paused');
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
