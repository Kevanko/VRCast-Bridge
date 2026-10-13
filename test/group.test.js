import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress } from '../src/lan.js';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hideMemberSource, parseMediaBase, sanitizeContribution, sharedQueueItem, takeInitiative } from '../src/group.js';

const lanIp = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address))?.address;
const KEY = 'k'.repeat(24);

test('группа: проверка присланного — чужой адрес, мусор и лишнее отбрасываются', () => {
  assert.equal(parseMediaBase({ base: 'http://192.168.1.7:5000', key: KEY }, '::ffff:192.168.1.7').base, 'http://192.168.1.7:5000');
  assert.equal(parseMediaBase({ base: 'http://192.168.1.99:5000', key: KEY }, '192.168.1.7'), null, 'другой адрес — нельзя направить админа на чужое устройство');
  assert.equal(parseMediaBase({ base: 'http://192.168.1.7', key: KEY }, '192.168.1.7'), null, 'без порта');
  assert.equal(parseMediaBase({ base: 'https://192.168.1.7:5000', key: KEY }, '192.168.1.7'), null, 'только http в своей сети');
  assert.equal(parseMediaBase({ base: 'http://192.168.1.7:5000', key: 'коротко' }, '192.168.1.7'), null, 'ключ слишком простой');
  const media = { base: 'http://192.168.1.7:5000', key: KEY };
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, title: `t${i}` }));
  const shared = sanitizeContribution({ media, queue: [{ id: 'a b' }, { id: '../x' }, { id: 'ok', title: 'Ролик\u0000', duration: -5 }, { id: 'ok' }, ...many],
    servers: [{ host: 'bad host', publishKey: 'x' }, { host: '203.0.113.1', publishKey: '' }, { host: 'vps.example.com', publishKey: 'k1', rtspPort: 99999, name: 'VPS' }] }, '192.168.1.7');
  assert.equal(shared.queue.length, 200, 'не больше 200 файлов');
  assert.equal(shared.queue[0].id, 'ok');
  assert.equal(shared.queue[0].title, 'Ролик');
  assert.equal(shared.queue[0].duration, null);
  assert.equal(shared.queue.filter(item => item.id === 'ok').length, 1, 'повторы убираются');
  assert.deepEqual(shared.servers.map(item => [item.host, item.rtspPort]), [['vps.example.com', 8554]]);
  assert.equal(sanitizeContribution({ queue: [{ id: 'a' }] }, '192.168.1.7').queue.length, 0, 'без адреса файлов список пуст');
  const item = sharedQueueItem({ id: 'm1', name: 'Телефон' }, shared.queue[0], media);
  assert.equal(item.id, 'm1.ok');
  assert.ok(item.direct && item.member === 'm1' && item.sourceUrl.includes(`k=${KEY}`));
  assert.equal(hideMemberSource(item).sourceUrl, '', 'ключ доступа к устройству наружу не уходит');
  assert.equal(hideMemberSource({ id: 'own', sourceUrl: 'C:/a.mp4' }).sourceUrl, 'C:/a.mp4');
});

test('группа: эфиром управляет тот, кто начал последним', () => {
  const first = takeInitiative(null, { id: 'a', name: 'А', kind: 'phone' }, 1);
  assert.deepEqual(first, { id: 'a', name: 'А', kind: 'phone', at: 1 });
  assert.equal(takeInitiative(first, { id: 'b', name: 'Б', kind: 'pc' }, 2).id, 'b');
  assert.equal(takeInitiative(first, null), first, 'неизвестный запрос ничего не перехватывает');
});

// ── Живой сервер ─────────────────────────────────────────────────────────────
const port = Number(process.env.VRCAST_TEST_PORT || 38717) + 200;
let server, dataDirectory, mediaServer, mediaPort, mediaFile;
const mediaHits = [];

const call = (path, { method = 'GET', body, token, host = `${lanIp}:${port}`, to = lanIp, collect = true } = {}) => new Promise((resolve, reject) => {
  const headers = { Host: host, 'Content-Type': 'application/json', ...(token ? { 'X-VRCast-Token': token } : {}) };
  const req = request({ host: to, port, path, method, headers }, res => {
    if (!collect) return resolve({ status: res.statusCode, res });
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => { let data = null; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, data }); });
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const local = (path, options = {}) => call(path, { ...options, host: `127.0.0.1:${port}`, to: '127.0.0.1' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = async token => (await call('/api/status?logs=0', { token })).data;
async function until(check, message, tries = 80, step = 250) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await sleep(step); }
  assert.fail(message);
}

test.before(async () => {
  if (!lanIp) return;
  dataDirectory = await mkdtemp(join(tmpdir(), 'vrcast-group-'));
  const tools = join(dataDirectory, 'VRCastBridge', 'tools');
  mkdirSync(tools, { recursive: true });
  const installed = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'VRCastBridge', 'tools', 'mediamtx');
  if (process.platform === 'linux' && existsSync(installed)) copyFileSync(installed, join(tools, 'mediamtx'));
  // Файл «с телефона»: короткий ролик, который админ реально проиграет по сети.
  mediaFile = join(dataDirectory, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', mediaFile]);
  assert.equal(made.status, 0, 'ffmpeg должен собрать пробный ролик');
  mediaServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    mediaHits.push(`${req.method} ${url.pathname}?k=${url.searchParams.get('k')}`);
    if (url.pathname !== '/api/media/clip' || url.searchParams.get('k') !== KEY) { res.writeHead(403); return res.end(); }
    const size = statSync(mediaFile).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return createReadStream(mediaFile, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
    createReadStream(mediaFile).pipe(res);
  });
  await new Promise(resolve => mediaServer.listen(0, lanIp, resolve));
  mediaPort = mediaServer.address().port;
  writeFileSync(join(dataDirectory, 'VRCastBridge', 'config.json'), JSON.stringify({ lanAccess: true, deviceName: 'Главный ПК' }));
  server = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore',
    env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: dataDirectory, XDG_DATA_HOME: dataDirectory, VRCAST_GROUP_GRACE_MS: '1500' } });
  for (let i = 0; i < 80; i++) { try { if ((await call('/api/lan-info')).status === 200) return; } catch {} await sleep(150); }
  throw new Error('сервер не запустился');
});
test.after(async () => {
  server?.kill(); mediaServer?.close();
  await sleep(300);
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
});

const skip = !lanIp && 'нет сетевого интерфейса';

async function join_(name, kind = 'phone') {
  const pin = (await local('/api/pair/pin')).data.pin;
  const reply = await call('/api/pair', { method: 'POST', body: { code: pin, name, kind } });
  assert.equal(reply.status, 200, reply.text);
  const token = reply.data.token;
  // Открытый поток событий — признак, что устройство «в сети».
  const stream = await call('/api/events', { token, collect: false });
  stream.res.on('data', () => {}); stream.res.on('error', () => {});
  const me = (await state(token)).group.members.find(member => member.name === name);
  return { token, id: me.id, stream: stream.res, name };
}

const contribute = (device, extra = {}) => call('/api/group/contribute', { method: 'POST', token: device.token, body: {
  media: { base: `http://${lanIp}:${mediaPort}`, key: KEY },
  queue: [{ id: 'clip', title: 'Видео с телефона А', hasVideo: true, hasAudio: true }],
  servers: [{ id: 'vps', name: 'VPS телефона А', host: '203.0.113.7', rtspPort: 8554, publishKey: 'secret-publish-key' }], ...extra } });

test('группа: файлы и серверы участника видны всем, пока он подключён', { skip, timeout: 120000 }, async () => {
  const info = (await call('/api/lan-info')).data;
  assert.ok(info.id && info.kind === 'pc', 'ПК отдаёт постоянный номер и тип');
  const a = await join_('Телефон А');
  const b = await join_('Телефон Б');
  assert.equal((await call('/api/group/contribute', { method: 'POST', body: {} })).status, 401, 'без привязки обмениваться нельзя');

  const reply = await contribute(a);
  assert.equal(reply.status, 200, reply.text);
  const seen = await state(b.token);
  const item = seen.queue.find(entry => entry.member === a.id);
  assert.ok(item, 'файл телефона А виден телефону Б');
  assert.equal(item.owner, 'Телефон А');
  assert.equal(item.sourceUrl, '', 'ссылка с ключом наружу не уходит');
  const server_ = seen.config.servers.find(entry => entry.owner === 'Телефон А');
  assert.ok(server_ && server_.name === 'VPS телефона А', 'сервер телефона А виден всем');
  assert.equal(server_.publishKey, undefined, 'ключ публикации не показывается');
  // Телефон длительность не знает — ПК определяет её сам по сети и делает обложку.
  const probed = await until(async () => (await state(b.token)).queue.find(entry => entry.member === a.id && entry.duration > 10 && entry.thumbnail), 'ПК должен узнать длительность и сделать превью файла телефона');
  assert.ok(Math.abs(probed.duration - 20) < 1);
  assert.equal(probed.hasVideo, true);
  const members = seen.group.members;
  assert.deepEqual(members.map(m => [m.name, m.online]).sort(), [['Телефон А', true], ['Телефон Б', true]]);
  assert.equal(members.find(m => m.id === a.id).files, 1);
  assert.equal(seen.group.admin.name, 'Главный ПК');

  // Чужие адреса не принимаются: файлы не появляются.
  const evil = await contribute(b, { media: { base: 'http://192.168.77.77:9999', key: KEY } });
  assert.equal(evil.status, 200);
  assert.equal((await state(b.token)).queue.filter(entry => entry.member === b.id).length, 0, 'чужой адрес файлов отвергнут');

  // Второе устройство тоже может добавить свой файл, оба живут в одном списке.
  await contribute(b, { queue: [{ id: 'clip', title: 'Видео Б', duration: 20 }], servers: [] });
  const both = await state(a.token);
  assert.deepEqual(both.queue.filter(entry => entry.member).map(entry => entry.owner).sort(), ['Телефон А', 'Телефон Б']);

  // Очередь на диск админа не пишется.
  await sleep(300);
  const saved = JSON.parse(readQueueFile());
  assert.equal(saved.filter(entry => entry.member).length, 0, 'файлы устройств не сохраняются на диск админа');

  // Выход потока на время (смена сети) не убирает файлы сразу.
  a.stream.destroy();
  await sleep(300);
  assert.ok((await state(b.token)).queue.some(entry => entry.member === a.id), 'короткий обрыв терпим');
  const again = await call('/api/events', { token: a.token, collect: false });
  again.res.on('data', () => {}); a.stream = again.res;
  await sleep(2200);
  assert.ok((await state(b.token)).queue.some(entry => entry.member === a.id), 'вернулся вовремя — файлы на месте');

  // Ушёл насовсем: файлы и серверы исчезают у всех.
  a.stream.destroy();
  await until(async () => !(await state(b.token)).queue.some(entry => entry.member === a.id), 'файлы ушедшего устройства должны исчезнуть');
  assert.equal((await state(b.token)).config.servers.some(entry => entry.owner === 'Телефон А'), false, 'и его серверы тоже');
  assert.equal((await state(b.token)).group.members.find(m => m.id === a.id).online, false);

  b.stream.destroy();
  await local('/api/pair/clear', { method: 'POST' });
});

test('группа: эфир идёт с файла участника, его ведёт тот, кто начал последним, убранный чужой файл возвращается владельцу', { skip, timeout: 180000 }, async () => {
  const a = await join_('Телефон А');
  const b = await join_('Телефон Б');
  await contribute(a);
  const itemId = `${a.id}.clip`;

  // Эфир запускает Б — он и ведёт.
  await until(async () => {
    const reply = await call('/api/start/queue', { method: 'POST', token: b.token, body: { id: itemId } });
    return reply.status === 200 ? reply : (await sleep(1500), null);
  }, 'эфир с файла телефона должен запуститься', 60, 100);
  const live = await until(async () => { const s = await state(a.token); return s.activeKind === 'queue' && s.currentId === itemId ? s : null; }, 'идёт очередь');
  assert.equal(live.group.controller.name, 'Телефон Б', 'ведёт тот, кто начал эфир');
  await until(() => mediaHits.some(hit => hit.includes(`k=${KEY}`)), 'админ должен забрать файл у телефона по сети');

  // А перехватывает: просто запускает с начала.
  assert.equal((await call('/api/playback', { method: 'POST', token: a.token, body: { action: 'jump', id: itemId } })).status, 200);
  assert.equal((await state(b.token)).group.controller.name, 'Телефон А', 'последний начавший ведёт');
  assert.equal((await call('/api/group/take', { method: 'POST', token: b.token })).data.controller.name, 'Телефон Б', 'перехват без перезапуска');

  // Любой участник останавливает эфир.
  assert.equal((await call('/api/stop', { method: 'POST', token: b.token })).status, 200);
  await until(async () => !(await state(a.token)).running, 'эфир остановлен');

  // Б убирает файл А — А узнаёт об этом при обмене и уберёт у себя.
  assert.equal((await call(`/api/queue/${encodeURIComponent(itemId)}`, { method: 'DELETE', token: b.token })).status, 200);
  assert.equal((await state(a.token)).queue.some(entry => entry.id === itemId), false);
  const reply = await contribute(a);
  assert.deepEqual(reply.data.removed, ['clip'], 'владельцу сообщили, что файл убрали');
  assert.equal((await state(a.token)).queue.some(entry => entry.id === itemId), false, 'пока владелец не убрал у себя, файл не возвращается');
  const done = await contribute(a, { queue: [] });
  assert.deepEqual(done.data.removed, [], 'убрал у себя — отметка снимается');

  // Админ удаляет устройство: всё его исчезает сразу.
  await contribute(b, { queue: [{ id: 'clip', title: 'Видео Б', duration: 20 }] });
  assert.ok((await state(a.token)).queue.some(entry => entry.member === b.id));
  await local('/api/pair/remove', { method: 'POST', body: { id: b.id } });
  assert.equal((await state(a.token)).queue.some(entry => entry.member === b.id), false, 'админ убрал устройство — файлы исчезли сразу');
  assert.equal((await call('/api/group/contribute', { method: 'POST', token: b.token, body: {} })).status, 401, 'удалённому устройству ключ больше не подходит');

  // Участник сам выходит из группы.
  await contribute(a);
  assert.equal((await call('/api/group/leave', { method: 'POST', token: a.token })).status, 200);
  assert.equal((await local('/api/status?logs=0')).data.queue.some(entry => entry.member === a.id), false);
  a.stream.destroy(); b.stream.destroy();
});

function readQueueFile() {
  return existsSync(join(dataDirectory, 'VRCastBridge', 'queue.json')) ? readFileSync_(join(dataDirectory, 'VRCastBridge', 'queue.json')) : '[]';
}
import { readFileSync as readFileSync_ } from 'node:fs';
