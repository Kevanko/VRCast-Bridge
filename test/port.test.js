import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const first = Number(process.env.VRCAST_TEST_PORT || 38717) + 300;
const second = first + 10;
const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
const waitFor = async check => { for (let i = 0; i < 60; i++) { if (await check().catch(() => false)) return true; await new Promise(r => setTimeout(r, 150)); } return false; };

test('смена порта в настройках действует сразу, без перезапуска; занятый порт отклоняется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vrcast-port-'));
  mkdirSync(join(dir, 'VRCastBridge'), { recursive: true });
  writeFileSync(join(dir, 'VRCastBridge', 'config.json'), JSON.stringify({ port: first }));
  // Без VRCAST_PORT: порт берётся из настроек, как у обычного запуска.
  const env = { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir };
  delete env.VRCAST_PORT; delete env.VRCAST_RTSP_PORT;
  const server = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore', env });
  const busy = createServer();
  try {
    assert.ok(await waitFor(async () => (await get(first, '/api/status?logs=0')).status === 200), 'сервер запустился на порту из настроек');

    await new Promise(resolve => busy.listen(second + 1, '0.0.0.0', resolve));
    const refused = await post(first, '/api/config', { port: second + 1 });
    assert.equal(refused.status, 400, 'занятый порт не принимается');
    assert.equal((await get(first, '/api/status?logs=0')).status, 200, 'старый порт продолжает работать');

    assert.equal((await post(first, '/api/config', { port: second })).status, 200);
    assert.ok(await waitFor(async () => (await get(second, '/api/status?logs=0')).status === 200), 'новый порт отвечает');
    const state = await (await get(second, '/api/status?logs=0')).json();
    assert.equal(state.port, second);
    await assert.rejects(get(first, '/api/status?logs=0'), 'старый порт закрыт');
  } finally {
    busy.close();
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
