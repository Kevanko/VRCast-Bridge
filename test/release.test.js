// Проверки того, что ломалось у людей, а не у разработчика:
//  · обновление со старой версии на новую (скачать, проверить подпись, дойти до установки);
//  · эфир на свежей сборке FFmpeg (у друзей она новее и строже к параметрам);
//  · добавление по ссылкам и быстрая ссылка без своего сервера — с сетью.
// Сетевые проверки идут только с VRCAST_TEST_NETWORK=1, свежий FFmpeg — с
// VRCAST_TEST_FFMPEG_DIR=<папка с ffmpeg.exe>. Иначе они пропускаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const basePort = Number(process.env.VRCAST_TEST_PORT || 48717) + 400;
let nextPort = basePort;
const СЕТЬ = process.env.VRCAST_TEST_NETWORK === '1';
const СВЕЖИЙ_FFMPEG = process.env.VRCAST_TEST_FFMPEG_DIR || '';

async function запуститьСервер(env = {}) {
  const port = nextPort; nextPort += 10;
  const data = await mkdtemp(join(tmpdir(), 'vrcast-release-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: data, XDG_DATA_HOME: data, ...env },
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`сервер завершился с кодом ${child.exitCode}`);
    if (await fetch(`${base}/api/status?logs=0`).then(r => r.ok, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const status = async () => (await api('/api/status?logs=1')).body;
  const ждать = async (условие, мс, шаг = 500) => {
    const конец = Date.now() + мс;
    let последнее;
    while (Date.now() < конец) { последнее = await status(); if (условие(последнее)) return последнее; await new Promise(r => setTimeout(r, шаг)); }
    return последнее;
  };
  const стоп = async () => {
    await api('/api/stop', {}).catch(() => {});
    await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { origin: base } }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 800));
    child.kill();
    for (let i = 0; i < 5; i++) { try { await rm(data, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 400)); } }
  };
  return { port, base, data, api, status, ждать, стоп };
}

// Подставной «GitHub»: отдаёт релиз с одним exe.
async function подставнойРелиз(файл, версия = '99.0.0') {
  const size = statSync(файл).size;
  const сервер = createHttpServer((req, res) => {
    if (req.url.startsWith('/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: `v${версия}`, body: 'Тестовый релиз',
        assets: [{ name: 'VRCast.Bridge.exe', size, browser_download_url: `http://127.0.0.1:${сервер.address().port}/VRCast.Bridge.exe` }] }));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
    createReadStream(файл).pipe(res);
  });
  await new Promise(resolve => сервер.listen(0, '127.0.0.1', resolve));
  return { api: `http://127.0.0.1:${сервер.address().port}/latest`, закрыть: () => сервер.close() };
}

const ПОДПИСАННЫЙ = join(ROOT, 'VRCast Bridge.exe');

test('обновление: старая версия находит новую, скачивает, проверяет подпись и готова к установке',
  { skip: !existsSync(ПОДПИСАННЫЙ) && 'нет собранного VRCast Bridge.exe', timeout: 180000 }, async () => {
    const релиз = await подставнойРелиз(ПОДПИСАННЫЙ);
    const временная = await mkdtemp(join(tmpdir(), 'vrcast-exe-'));
    const s = await запуститьСервер({ VRCAST_TEST_VERSION: '0.1.0', VRCAST_UPDATE_API: релиз.api, VRCAST_EXE: join(временная, 'VRCast Bridge.exe') });
    try {
      await s.api('/api/update/check', {});
      let st = await s.status();
      assert.equal(st.update.available, true, 'старая версия должна увидеть новую');
      assert.equal(st.update.version, '99.0.0');
      await s.api('/api/update/apply', {});
      st = await s.ждать(x => x.update.swapReady || x.update.error, 150000, 1000);
      assert.equal(st.update.error || '', '', 'обновление не должно падать');
      assert.equal(st.update.swapReady, true, 'после проверки подписи обновление передаётся оболочке');
      const скачано = join(s.data, 'VRCastBridge', 'update', 'VRCast Bridge.exe');
      assert.equal(statSync(скачано).size, statSync(ПОДПИСАННЫЙ).size, 'файл скачан целиком');
    } finally { await s.стоп(); релиз.закрыть(); await rm(временная, { recursive: true, force: true }); }
  });

test('обновление: чужой файл не ставится (подпись не наша)', { timeout: 180000 }, async () => {
  // node.exe подписан, но не нашим сертификатом — ровно тот случай, когда
  // подменили файл релиза.
  const релиз = await подставнойРелиз(process.execPath);
  const временная = await mkdtemp(join(tmpdir(), 'vrcast-exe-'));
  const s = await запуститьСервер({ VRCAST_TEST_VERSION: '0.1.0', VRCAST_UPDATE_API: релиз.api, VRCAST_EXE: join(временная, 'VRCast Bridge.exe') });
  try {
    await s.api('/api/update/check', {});
    await s.api('/api/update/apply', {});
    const st = await s.ждать(x => x.update.swapReady || x.update.error, 150000, 1000);
    assert.equal(Boolean(st.update.swapReady), false, 'чужой файл не должен дойти до установки');
    assert.match(st.update.error, /подпись|издатель/i);
  } finally { await s.стоп(); релиз.закрыть(); await rm(временная, { recursive: true, force: true }); }
});

test('новая версия не предлагается, если стоит самая свежая', { timeout: 60000 }, async () => {
  const релиз = await подставнойРелиз(process.execPath, '0.0.1');
  const временная = await mkdtemp(join(tmpdir(), 'vrcast-exe-'));
  const s = await запуститьСервер({ VRCAST_TEST_VERSION: '0.1.0', VRCAST_UPDATE_API: релиз.api, VRCAST_EXE: join(временная, 'VRCast Bridge.exe') });
  try {
    await s.api('/api/update/check', {});
    assert.equal((await s.status()).update.available, false);
  } finally { await s.стоп(); релиз.закрыть(); await rm(временная, { recursive: true, force: true }); }
});

test('эфир видео и экрана поднимается на свежей сборке FFmpeg',
  { skip: !СВЕЖИЙ_ФФ() && 'задайте VRCAST_TEST_FFMPEG_DIR', timeout: 120000 }, async () => {
    const s = await запуститьСервер({ PATH: `${СВЕЖИЙ_FFMPEG}${delimiter}${process.env.PATH}` });
    try {
      const ролик = join(s.data, 'fresh.mp4');
      const сделан = spawnSync(join(СВЕЖИЙ_FFMPEG, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30',
        '-f', 'lavfi', '-i', 'sine', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-y', ролик], { windowsHide: true });
      assert.equal(сделан.status, 0);
      await s.api('/api/queue/local', { paths: [ролик] });
      assert.equal((await s.api('/api/start/queue', {})).status, 200);
      let st = await s.ждать(x => x.stream?.ready, 20000);
      assert.equal(st.stream.ready, true, 'эфир видео готов');
      assert.ok(!st.logs.some(l => /Error parsing options|cannot be applied/i.test(l.message || l)), 'ffmpeg не должен отвергать параметры');
      await s.api('/api/config', { captureMode: 'region', regionX: 0, regionY: 0, regionWidth: 320, regionHeight: 240, audioMode: 'none' });
      assert.equal((await s.api('/api/start/screen', {})).status, 200);
      st = await s.ждать(x => x.activeKind === 'screen' && x.stream?.ready, 20000);
      assert.equal(st.stream.ready, true, 'эфир экрана готов');
    } finally { await s.стоп(); }
  });
function СВЕЖИЙ_ФФ() { return СВЕЖИЙ_FFMPEG && existsSync(join(СВЕЖИЙ_FFMPEG, 'ffmpeg.exe')); }

test('ссылки: YouTube-ролик добавляется с названием и длительностью, большой плейлист спрашивает',
  { skip: !СЕТЬ && 'нужна сеть: VRCAST_TEST_NETWORK=1', timeout: 180000 }, async () => {
    const s = await запуститьСервер();
    try {
      const ролик = await s.api('/api/queue', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
      assert.equal(ролик.status, 201, ролик.body.error);
      assert.match(ролик.body.added[0].title, /Big Buck Bunny/i);
      assert.ok(ролик.body.added[0].duration > 60, 'длительность известна сразу');
      const плейлист = await s.api('/api/queue', { url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' });
      assert.ok(плейлист.body.ask?.count > 10, 'большой плейлист не добавляется молча');
      assert.equal(плейлист.body.ask.single, true, 'можно добавить только это видео');
      const одно = await s.api('/api/queue', { url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', confirm: 'single' });
      assert.equal(одно.body.added?.length, 1);
    } finally { await s.стоп(); }
  });

test('ссылки: аниме с AnimeLib — серии, озвучки и прямой поток',
  { skip: !СЕТЬ && 'нужна сеть: VRCAST_TEST_NETWORK=1', timeout: 120000 }, async () => {
    const s = await запуститьСервер();
    try {
      const адрес = 'https://animelib.org/ru/anime/246--bleach-anime/watch?episode=8669&team=32457&translation_type=2';
      const info = (await s.api('/api/queue/inspect', { url: адрес })).body;
      assert.equal(info.kind, 'anime');
      assert.ok(info.episodes.length > 300 && info.teams.length > 0);
      const добавлено = await s.api('/api/queue', { url: адрес, anime: { scope: 'one', episode: info.episode, team: info.team, translation: info.translation, quality: 480 } });
      assert.equal(добавлено.status, 201, добавлено.body.error);
      const st = await s.ждать(x => x.queue[0]?.duration > 0, 30000);
      assert.ok(st.queue[0].duration > 600, 'длительность серии подтягивается без скачивания');
    } finally { await s.стоп(); }
  });

test('быстрая ссылка без своего сервера: Serveo поднимается и отдаёт поток',
  { skip: !СЕТЬ && 'нужна сеть: VRCAST_TEST_NETWORK=1', timeout: 120000 }, async () => {
    const s = await запуститьСервер();
    try {
      await s.api('/api/config', { outputMode: 'tunnel', tunnelProvider: 'serveo' });
      const st = await s.ждать(x => x.tunnel.ready || x.tunnel.state === 'error', 60000, 1000);
      assert.equal(st.tunnel.ready, true, st.tunnel.error || 'ссылка не готова');
      const плейлист = await fetch(st.tunnel.url, { headers: { 'User-Agent': 'LibVLC/3.0' } }).then(r => r.text());
      assert.match(плейлист, /#EXTM3U/, 'по публичной ссылке приходит поток');
    } finally { await s.api('/api/config', { outputMode: 'local' }).catch(() => {}); await s.стоп(); }
  });
