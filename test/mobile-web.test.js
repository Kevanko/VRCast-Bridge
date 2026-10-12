import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress } from '../src/lan.js';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

const lanIp = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address))?.address;
const port = Number(process.env.VRCAST_TEST_PORT || 48717) + 500;
const call = (path, { method = 'GET', body, headers = {}, host = lanIp } = {}) => new Promise((resolve, reject) => {
  const req = request({ host, port, path, method, headers: { Host: `${host}:${port}`, 'Content-Type': 'application/json', ...headers } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});

test('пульт в браузере телефона: страница открывается по сети, привязка по коду из QR, опасное закрыто', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vrcast-mweb-'));
  mkdirSync(join(dir, 'VRCastBridge'), { recursive: true });
  writeFileSync(join(dir, 'VRCastBridge', 'config.json'), JSON.stringify({ lanAccess: true, deviceName: 'Мой ПК' }));
  const server = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore', env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: dir, XDG_DATA_HOME: dir } });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await call('/api/lan-info', { host: '127.0.0.1' }).then(r => r.status === 200, () => false); if (!up) await new Promise(r => setTimeout(r, 150)); }
    assert.ok(up, 'сервер запустился');

    const page = await call('/m');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /VRCast/);
    assert.equal((await call('/m/m.js')).status, 200);
    assert.equal((await call('/m/m.css')).status, 200);
    assert.ok([401, 403].includes((await call('/')).status), 'главная страница программы по сети не открывается');
    assert.ok([401, 403].includes((await call('/app.js')).status));

    // Код привязки показан на компьютере (в QR): браузер меняет его на ключ.
    const pin = JSON.parse((await call('/api/pair/pin', { host: '127.0.0.1' })).text).pin;
    assert.equal((await call('/api/pair', { method: 'POST', body: { code: '000000', name: 'Хитрый' } })).status, 403);
    const paired = await call('/api/pair', { method: 'POST', body: { code: pin, name: 'Телефон (браузер)', kind: 'web' } });
    assert.equal(paired.status, 200);
    const token = JSON.parse(paired.text).token;
    assert.ok(token);

    // Экран ПК может запускать только привязанный браузер; настройки без привязки закрыты.
    assert.equal((await call('/api/start/screen', { method: 'POST', body: {} })).status, 401);
    const withKey = await call('/api/start/screen', { method: 'POST', body: {}, headers: { 'X-VRCast-Token': token } });
    assert.notEqual(withKey.status, 401);
    assert.notEqual(withKey.status, 403);
    assert.equal((await call('/api/shutdown', { method: 'POST', body: {}, headers: { 'X-VRCast-Token': token } })).status, 403, 'выключить программу с телефона нельзя');

    assert.equal((await call('/api/status?logs=0')).status, 401, 'без привязки статус закрыт');
    const state = JSON.parse((await call('/api/status?logs=0', { headers: { 'X-VRCast-Token': token } })).text);
    assert.ok(Array.isArray(state.queue));
    const list = JSON.parse((await call('/api/status?logs=0', { host: '127.0.0.1' })).text).config.pairedPhones;
    assert.equal(list[0].kind, 'web');
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
