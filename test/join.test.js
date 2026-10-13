import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBase } from '../src/join.js';

const base = Number(process.env.VRCAST_TEST_PORT || 38717) + 400;
const portA = base, portB = base + 20;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
// «fetch failed» без причины не объясняет, упал сервер или оборвалось соединение:
// причину (cause) пишем в текст ошибки.
const call = async (port, path, { method = 'GET', body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
    .catch(error => { throw new Error(`${method} ${port}${path}: ${error.message} (${error.cause?.code || ''} ${error.cause?.message || ''})`); });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const waitFor = async check => { for (let i = 0; i < 80; i++) { if (await check().catch(() => false)) return true; await new Promise(r => setTimeout(r, 150)); } return false; };

test('адрес другого устройства приводится к виду http://адрес:порт', () => {
  assert.equal(normalizeBase('192.168.0.5'), 'http://192.168.0.5:4717');
  assert.equal(normalizeBase('http://pc.local:5000/'), 'http://pc.local:5000');
  assert.throws(() => normalizeBase(''), /адрес/i);
  assert.throws(() => normalizeBase('https://x'), /Нужен адрес/);
});

test('ПК подключается к другому ПК: файлы общие, пока на связи; управление и отключение', { skip: !hasFfmpeg && 'нет ffmpeg' }, async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'vrcast-join-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'vrcast-join-b-'));
  const clip = join(dirB, 'clip.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]).status, 0);
  mkdirSync(join(dirA, 'VRCastBridge'), { recursive: true });
  mkdirSync(join(dirB, 'VRCastBridge'), { recursive: true });
  writeFileSync(join(dirA, 'VRCastBridge', 'config.json'), JSON.stringify({ lanAccess: true, deviceName: 'Админ-ПК' }));
  writeFileSync(join(dirB, 'VRCastBridge', 'config.json'), JSON.stringify({ deviceName: 'Второй-ПК' }));
  writeFileSync(join(dirB, 'VRCastBridge', 'queue.json'), JSON.stringify([{ id: 'b1', title: 'Файл второго ПК', sourceUrl: clip, thumbnail: '', local: true, probed: true, unavailable: false, hasVideo: true, hasAudio: true, duration: 2 }]));
  // Вывод серверов копим: если тест упал, по нему видно, что случилось внутри.
  const вывод = {};
  const run = (port, dir) => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, VRCAST_PORT: String(port), VRCAST_GROUP_GRACE_MS: '800', LOCALAPPDATA: dir, XDG_DATA_HOME: dir } });
    вывод[port] = '';
    const копить = chunk => { вывод[port] = (вывод[port] + chunk).slice(-6000); };
    child.stdout.on('data', копить); child.stderr.on('data', копить);
    child.on('exit', (code, signal) => копить(`
[сервер ${port} завершился: код ${code}, сигнал ${signal}]
`));
    return child;
  };
  const a = run(portA, dirA), b = run(portB, dirB);
  try {
    for (const port of [portA, portB]) assert.ok(await waitFor(async () => (await call(port, '/api/status?logs=0')).status === 200), `сервер ${port}`);
    const pin = (await call(portA, '/api/pair/pin')).data.pin;

    const wrong = await call(portB, '/api/join', { method: 'POST', body: { address: `127.0.0.1:${portA}`, code: '000000' } });
    assert.equal(wrong.status, 400, 'неверный код не пускает');
    assert.match(wrong.data.error, /код/i);

    const joined = await call(portB, '/api/join', { method: 'POST', body: { address: `127.0.0.1:${portA}`, code: pin } });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.joined.name, 'Админ-ПК');

    assert.ok(await waitFor(async () => (await call(portA, '/api/status?logs=0')).data.queue.some(item => item.title === 'Файл второго ПК')), 'файл виден у админа');
    const seen = (await call(portA, '/api/status?logs=0')).data;
    const shared = seen.queue.find(item => item.title === 'Файл второго ПК');
    assert.equal(shared.owner, 'Второй-ПК');
    assert.equal(seen.group.members.find(m => m.name === 'Второй-ПК')?.kind, 'pc');
    assert.ok((await call(portB, '/api/status?logs=0')).data.joined.online, 'у второго ПК видно, что он на связи');

    // Файл отдаётся только по ключу.
    assert.equal((await call(portB, '/api/media/b1?k=wrong-wrong-wrong-wrong')).status, 403);

    // Управление админом с второго ПК: эфир ведёт тот, кто взял.
    assert.equal((await call(portB, '/api/join/control', { method: 'POST', body: { action: 'take' } })).status, 200);
    assert.equal((await call(portA, '/api/status?logs=0')).data.group.controller?.name, 'Второй-ПК');

    // Отключение: у админа всё пропадает.
    assert.equal((await call(portB, '/api/join/leave', { method: 'POST', body: {} })).status, 200);
    assert.ok(await waitFor(async () => !(await call(portA, '/api/status?logs=0')).data.queue.some(item => item.title === 'Файл второго ПК')), 'файл пропал у админа');
    assert.equal((await call(portB, '/api/status?logs=0')).data.joined, null);
  } catch (error) {
    for (const [port, текст] of Object.entries(вывод)) console.log(`--- сервер ${port}:
${текст}`);
    throw error;
  } finally {
    a.kill(); b.kill();
    await new Promise(r => setTimeout(r, 300));
    await rm(dirA, { recursive: true, force: true }).catch(() => {});
    await rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});
