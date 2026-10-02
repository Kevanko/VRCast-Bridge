import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackAddress, isPrivateAddress, lanHostAllowed, lanRouteAllowed } from '../src/lan.js';

test('адреса: свои, частные и чужие', () => {
  assert.ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1'));
  for (const ok of ['192.168.1.5', '10.0.0.7', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::ffff:192.168.0.2', 'fd12:3456::1'])
    assert.ok(isPrivateAddress(ok), ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '1.1.1.1', '2001:db8::1']) assert.ok(!isPrivateAddress(bad), bad);
});

test('Host из сети: IP или .local с нашим портом, иначе нельзя', () => {
  assert.ok(lanHostAllowed('192.168.1.5:4717', 4717));
  assert.ok(lanHostAllowed('my-pc.local:4717', 4717));
  assert.ok(!lanHostAllowed('192.168.1.5:80', 4717));
  assert.ok(!lanHostAllowed('evil.example.com:4717', 4717));
  assert.ok(!lanHostAllowed('', 4717));
});

test('маршруты для сети: управление можно, настройки и выход нельзя', () => {
  for (const [method, path] of [['GET', '/api/status'], ['GET', '/api/events'], ['GET', '/stream/preview.m3u8'], ['GET', '/thumbs/a.jpg'],
    ['POST', '/api/playback'], ['POST', '/api/start/queue'], ['POST', '/api/stop'], ['POST', '/api/queue'], ['DELETE', '/api/queue/abc'], ['HEAD', '/stream/live.m3u8']])
    assert.ok(lanRouteAllowed(method, path), `${method} ${path}`);
  for (const [method, path] of [['POST', '/api/shutdown'], ['POST', '/api/config'], ['GET', '/api/servers'], ['POST', '/api/servers/1/key'],
    ['POST', '/api/update/apply'], ['POST', '/api/logs/open'], ['POST', '/api/cache/clear'], ['POST', '/api/templates'], ['GET', '/api/windows'], ['GET', '/']])
    assert.ok(!lanRouteAllowed(method, path), `${method} ${path}`);
});

const lanIp = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address;
const port = Number(process.env.VRCAST_TEST_PORT || 48717) + 100;
let server, dataDirectory;

// Запрос с заданным Host: fetch не даёт его подменить, поэтому http.request.
const call = (host, path, { method = 'GET', body, headers = {}, to = host.split(':')[0], collect = true } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: to, port, path, method, headers: { Host: host, 'Content-Type': 'application/json', ...headers } }, res => {
    if (!collect) return resolve({ status: res.statusCode, res });
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const local = (path, options) => call(`127.0.0.1:${port}`, path, options);

test.before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'vrcast-lan-'));
  server = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore',
    env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: dataDirectory, XDG_DATA_HOME: dataDirectory } });
  for (let i = 0; i < 80; i++) { try { if ((await local('/api/status?logs=0')).status === 200) return; } catch {} await new Promise(r => setTimeout(r, 150)); }
  throw new Error('сервер не запустился');
});
test.after(async () => { server?.kill(); await new Promise(r => setTimeout(r, 300)); await rm(dataDirectory, { recursive: true, force: true }).catch(() => {}); });

test('по умолчанию пульт выключен: из сети порт не отвечает', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  await assert.rejects(call(`${lanIp}:${port}`, '/api/status'), /ECONNREFUSED/);
});

test('включённый пульт: статус и управление доступны по IP, опасное — нет', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  const enabled = await local('/api/config', { method: 'POST', body: { lanAccess: true } });
  assert.equal(enabled.status, 200);
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 150)); ok = await call(`${lanIp}:${port}`, '/api/status?logs=0').then(r => r.status === 200, () => false); }
  assert.ok(ok, 'статус должен открыться по LAN-IP');

  const host = `${lanIp}:${port}`;
  const state = JSON.parse((await call(host, '/api/status?logs=0')).text);
  assert.deepEqual(state.config.servers, [], 'данные серверов не уходят в сеть');
  const info = JSON.parse((await call(host, '/api/lan-info')).text);
  assert.ok(info.addresses.includes(`http://${lanIp}:${port}`));
  assert.equal((await call(host, '/api/playback', { method: 'POST', body: { action: 'toggle' } })).status === 403, false, 'управление разрешено');

  for (const [method, path] of [['POST', '/api/shutdown'], ['GET', '/api/servers'], ['POST', '/api/logs/open']])
    assert.equal((await call(host, path, { method, body: method === 'POST' ? {} : undefined })).status, 403, `${method} ${path}`);
  assert.equal((await call(host, '/api/config', { method: 'POST', body: {} })).status, 401, 'настройки эфира — только после привязки');
  assert.equal((await call(`evil.example.com:${port}`, '/api/status', { to: lanIp })).status, 403, 'чужое имя в Host');
  assert.equal((await call(host, '/api/status', { headers: { Origin: 'http://evil.example.com' } })).status, 403, 'чужой Origin');
  assert.equal((await call(`abc.trycloudflare.com`, '/api/status', { to: lanIp })).status, 404, 'туннель видит только поток');
});

test('события: статус приходит сразу и обновляется после команды', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  const host = `${lanIp}:${port}`;
  const { res } = await call(host, '/api/events', { collect: false });
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const events = [];
  res.setEncoding('utf8');
  let buffer = '';
  res.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, i); buffer = buffer.slice(i + 2); const line = block.split('\n').find(l => l.startsWith('data: ')); if (line) events.push(JSON.parse(line.slice(6))); } });
  const waitFor = async (predicate, label) => { for (let i = 0; i < 40; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(label); };
  await waitFor(() => events.length >= 1, 'первое событие');
  assert.equal(typeof events[0].running, 'boolean');
  const before = events.length;
  await local('/api/config', { method: 'POST', body: { loopMode: 'all' } });
  await waitFor(() => events.length > before && events.at(-1).config.loopMode === 'all', 'изменение должно прийти событием');
  res.destroy();
});

test('загрузка с телефона: файл попадает в очередь, чужие типы и пути отвергаются, удаление чистит диск', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  await local('/api/config', { method: 'POST', body: { lanAccess: true } });
  const host = `${lanIp}:${port}`;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 150)); if (await call(host, '/api/status?logs=0').then(r => r.status === 200, () => false)) break; }
  const sample = join(dataDirectory, 'phone-clip.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-y', sample]);
  assert.equal(made.status, 0);
  const bytes = readFileSync(sample);
  const send = (name, body) => new Promise((resolve, reject) => {
    const req = request({ host: lanIp, port, path: `/api/queue/upload?name=${encodeURIComponent(name)}`, method: 'POST',
      headers: { Host: host, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject); req.end(body);
  });
  const ok = await send('Мой ролик.mp4', bytes);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.added[0].title, 'Мой ролик.mp4', 'в названии нет служебного префикса');
  assert.ok(ok.json.added[0].duration >= 2);
  const folder = join(dataDirectory, 'VRCastBridge', 'uploads');
  assert.equal(readdirSync(folder).length, 1);
  assert.equal((await send('virus.exe', Buffer.from('MZ'))).status >= 400, true, 'не медиа-файл отвергается');
  const evil = await send('../../escape.mp4', bytes);
  assert.equal(evil.status, 201);
  assert.ok(!existsSync(join(dataDirectory, 'escape.mp4')) && !existsSync(join(dataDirectory, 'VRCastBridge', 'escape.mp4')), 'путь из имени не должен выводить из папки');
  assert.equal((await send('broken.mp4', Buffer.from('это не видео'))).status >= 400, true, 'мусор под видом видео отвергается');
  assert.equal(readdirSync(folder).filter(n => n.endsWith('.part')).length, 0, 'недокачанных файлов не остаётся');
  const queue = JSON.parse((await local('/api/status?logs=0')).text).queue;
  assert.equal(queue.length, 2);
  for (const item of queue) await call(host, `/api/queue/${item.id}`, { method: 'DELETE' });
  assert.equal(readdirSync(folder).length, 0, 'удалённые из очереди файлы стираются');
});

test('экран телефона: поток с телефона становится эфиром, обрыв потока останавливает эфир', { skip: !lanIp && 'нет сетевого интерфейса', timeout: 150000 }, async () => {
  const host = `${lanIp}:${port}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const publish = () => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=500',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '120', '-f', 'rtsp', '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:${port + 1}/phone`], { stdio: 'ignore' });
  let publisher = publish();
  try {
    // MediaMTX докачивается и перезапускается при включении пульта — пробуем, пока не поднимется.
    let started = null;
    for (let i = 0; i < 40 && !started; i++) {
      await sleep(2500);
      if (publisher.exitCode !== null) publisher = publish();
      const r = await call(host, '/api/start/phone', { method: 'POST', body: {} }).catch(() => null);
      if (r?.status === 200) started = r;
    }
    assert.ok(started, 'эфир с экрана телефона должен запуститься');
    const state = JSON.parse((await local('/api/status?logs=0')).text);
    assert.equal(state.running, true);
    assert.equal(state.activeKind, 'screen');
    assert.equal(state.phoneSource, true);
    let playlist = '';
    for (let i = 0; i < 30 && !/#EXTINF/.test(playlist); i++) { await sleep(500); playlist = (await call(host, '/stream/live.m3u8')).text; }
    assert.match(playlist, /#EXTINF/, 'HLS-эфир строится из потока телефона');
    publisher.kill('SIGKILL');
    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i++) { await sleep(500); stopped = JSON.parse((await local('/api/status?logs=0')).text).running === false; }
    assert.ok(stopped, 'обрыв потока телефона останавливает эфир');
    assert.equal(JSON.parse((await local('/api/status?logs=0')).text).phoneSource, false);
  } finally { publisher.kill('SIGKILL'); await local('/api/stop', { method: 'POST', body: {} }).catch(() => {}); }
});

test('привязка телефона: настройки эфира только по коду, лишнего в настройках не меняется', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  const host = `${lanIp}:${port}`;
  const post = (path, body, headers = {}) => call(host, path, { method: 'POST', body, headers });
  const noToken = await post('/api/config', { fps: 60 });
  assert.equal(noToken.status, 401);
  assert.equal(JSON.parse(noToken.text).code, 'pairing');
  assert.equal((await call(host, '/api/pair/pin')).status, 403, 'код видно только на самом ПК');

  const { pin } = JSON.parse((await local('/api/pair/pin')).text);
  assert.match(pin, /^\d{6}$/);
  const wrong = pin === '000000' ? '000001' : '000000';
  assert.equal((await post('/api/pair', { code: wrong })).status, 403);

  const paired = await post('/api/pair', { code: pin, name: 'Тестовый телефон' });
  assert.equal(paired.status, 200);
  const token = JSON.parse(paired.text).token;
  assert.ok(token.length >= 20);
  assert.equal((await post('/api/pair', { code: pin })).status, 403, 'после привязки код меняется');

  const auth = { 'X-VRCast-Token': token };
  assert.equal((await call(host, '/api/pair/check', { headers: auth })).status, 200);
  assert.equal((await call(host, '/api/pair/check', { headers: { 'X-VRCast-Token': 'wrong-token' } })).status, 401);
  const changed = await post('/api/config', { fps: 60, quality: '1080p', port: 5999, cacheRoot: '/tmp/evil', lanAccess: false, whiteIp: '203.0.113.7' }, auth);
  assert.equal(changed.status, 200, changed.text);
  const config = JSON.parse(changed.text).config;
  assert.equal(config.fps, 60);
  assert.equal(config.quality, '1080p');
  assert.equal(config.whiteIp, '203.0.113.7');
  assert.notEqual(config.port, 5999, 'порт с телефона не меняется');
  assert.notEqual(config.cacheRoot, '/tmp/evil', 'папка кеша с телефона не меняется');
  assert.equal(config.lanAccess, true, 'отключить доступ с телефона нельзя');
  assert.equal(config.pairedPhones, undefined, 'список привязок в сеть не уходит');
  assert.equal((await post('/api/shutdown', {}, auth)).status, 403, 'выход из программы и с токеном недоступен');
  assert.equal((await call(host, '/api/servers', { headers: auth })).status, 403);

  await local('/api/config', { method: 'POST', body: { fps: 30, quality: '720p', whiteIp: '' } });
  assert.equal(JSON.parse((await local('/api/pair/pin')).text).phones, 1);
  await local('/api/pair/clear', { method: 'POST', body: {} });
  assert.equal((await call(host, '/api/pair/check', { headers: auth })).status, 401, 'отвязанный телефон теряет доступ');
});

test('привязка: после пяти неверных кодов подряд вход блокируется', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  const host = `${lanIp}:${port}`;
  const post = body => call(host, '/api/pair', { method: 'POST', body });
  const { pin } = JSON.parse((await local('/api/pair/pin')).text);
  const wrong = pin === '111111' ? '222222' : '111111';
  let attempts = 0, blocked = false;
  while (!blocked && attempts < 6) { attempts++; const r = await post({ code: wrong }); blocked = r.status === 429; assert.ok(blocked || r.status === 403); }
  assert.ok(blocked && attempts <= 5, `блокировка после пяти неверных кодов (попыток: ${attempts})`);
  assert.equal((await post({ code: pin })).status, 429, 'даже верный код не принимается во время блокировки');
});

test('выключили пульт: сеть снова закрыта', { skip: !lanIp && 'нет сетевого интерфейса' }, async () => {
  await local('/api/config', { method: 'POST', body: { lanAccess: false } });
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) { await new Promise(r => setTimeout(r, 150)); closed = await call(`${lanIp}:${port}`, '/api/status').then(() => false, () => true); }
  assert.ok(closed);
  assert.equal((await local('/api/status?logs=0')).status, 200, 'на самом ПК всё работает');
});
