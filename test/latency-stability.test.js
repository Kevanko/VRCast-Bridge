import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Отдельный порт и каталог: этот файл запускается своим процессом и не должен
// драться за 4717х-порт с основным набором тестов.
const port = 48719;
let server;
let dataDirectory;

function launchServer() {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: dataDirectory },
    windowsHide: true, stdio: 'ignore',
  });
}

async function status() {
  return fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Тестовый сервер не запустился');
}

async function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Тяжёлый источник: 720p с движением, чтобы кодировщик реально упирался в
// заданный битрейт (на статичной картинке разницы между 800 и 6000 не видно).
function makeHeavySource(file, seconds, fps = 60) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-y', file],
  { windowsHide: true, timeout: 40000 });
  assert.equal(result.status, 0, result.stderr);
}

async function waitForPlaylist(timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const playlist = await fetch(`http://127.0.0.1:${port}/stream/live.m3u8`);
    if (playlist.ok && /#EXTINF/.test(await playlist.text())) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

async function waitUntilPlaying(timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await status();
    if (!state.playback.busy && state.activeKind === 'queue') return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

const hlsDir = () => join(dataDirectory, 'VRCastBridge', 'hls');

async function segmentStats() {
  const names = (await readdir(hlsDir()).catch(() => [])).filter(name => /^segment-\d+\.ts$/i.test(name));
  const entries = (await Promise.all(names.map(async name => {
    const info = await stat(join(hlsDir(), name));
    return { name, bytes: info.size, modified: info.mtimeMs };
  }))).sort((a, b) => a.modified - b.modified);
  return entries;
}

test.before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'vrcast-lat-'));
  server = launchServer();
  await waitForServer();
});

test.after(async () => {
  server?.kill();
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dataDirectory, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
});

// ── Задержка близка к реальному времени ──────────────────────────────────
// Живой край HLS не должен отставать: свежий сегмент моложе ~2с означает, что
// от кодировщика до плеера проходит около секунды, а не «HLS-хвост» в 5–15с.
// Мгновенный RTSP-канал (именно его берёт AVPro в VRChat) должен подняться.
test('эфир идёт в реальном времени: живой край свежий и RTSP-канал поднимается', async () => {
  await post('/api/queue', undefined).catch(() => {});
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const source = join(dataDirectory, 'realtime.mp4');
  makeHeavySource(source, 14, 30);
  await post('/api/queue/local', { paths: [source] });
  await post('/api/start/queue');
  assert.ok(await waitUntilPlaying(), 'эфир должен начать играть');
  assert.ok(await waitForPlaylist(), 'плейлист должен появиться');

  // Даём каналу набрать сегменты и замеряем свежесть живого края несколько раз.
  const ages = [];
  const rtspLiveAt = { value: null };
  const deadline = Date.now() + 18000;
  const started = Date.now();
  while (Date.now() < deadline) {
    const state = await status();
    if (state.performance?.segmentAge !== null && state.performance?.segmentAge !== undefined) ages.push(state.performance.segmentAge);
    if (rtspLiveAt.value === null && state.rtsp?.live) rtspLiveAt.value = (Date.now() - started) / 1000;
    if (ages.length >= 6 && rtspLiveAt.value !== null) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert.ok(ages.length >= 6, 'нужно несколько замеров свежести края');
  const median = [...ages].sort((a, b) => a - b)[Math.floor(ages.length / 2)];
  assert.ok(median < 2.0, `живой край HLS должен быть свежим (медиана возраста ${median.toFixed(2)}с < 2с)`);
  assert.ok(rtspLiveAt.value !== null, 'мгновенный RTSP-канал (путь VRChat) должен подняться');
  assert.ok(rtspLiveAt.value < 15, `RTSP-канал должен подняться быстро (${(rtspLiveAt.value ?? 99).toFixed(1)}с)`);
  await post('/api/stop');
});

// ── Снижение битрейта увеличивает стабильность ──────────────────────────
// Стабильность на слабом канале = меньше данных на проводе. Замеряем реальный
// размер сегментов при 800 и 6000 Кбит/с: низкий битрейт обязан давать заметно
// меньший поток, и при этом оставаться непрерывным (сегменты идут ровно, без
// провалов) — то есть меньший битрейт безопасен и стабилен, а не «рвётся».
async function measureStream(videoBitrate, seconds = 7) {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const config = await post('/api/config', { outputMode: 'local', mediaQuality: '720p', mediaFps: 60, videoBitrate });
  assert.equal(config.status, 200);
  const applied = (await config.json()).config.videoBitrate;
  assert.equal(applied, videoBitrate, 'битрейт должен примениться');
  const source = join(dataDirectory, `br-${videoBitrate}.mp4`);
  makeHeavySource(source, seconds + 6, 60);
  await post('/api/queue/local', { paths: [source] });
  await post('/api/start/queue');
  assert.ok(await waitUntilPlaying(), `эфир должен играть на ${videoBitrate}k`);
  assert.ok(await waitForPlaylist(), `плейлист должен появиться на ${videoBitrate}k`);
  // Сбрасываем сегменты, снятые до выхода на режим, и копим свежие.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const baseline = new Set((await segmentStats()).map(entry => entry.name));
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const fresh = (await segmentStats()).filter(entry => !baseline.has(entry.name));
  await post('/api/stop');
  assert.ok(fresh.length >= 4, `нужно достаточно свежих сегментов на ${videoBitrate}k (получено ${fresh.length})`);
  const avgBytes = fresh.reduce((sum, entry) => sum + entry.bytes, 0) / fresh.length;
  const gaps = fresh.slice(1).map((entry, index) => (entry.modified - fresh[index].modified) / 1000);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  return { avgBytes, maxGap, count: fresh.length };
}

test('снижение битрейта уменьшает поток и остаётся стабильным', async () => {
  const high = await measureStream(6000);
  const low = await measureStream(800);
  console.log(`  [битрейт] 6000k → ${Math.round(high.avgBytes / 1024)} КБ/сегм, макс.пауза ${high.maxGap.toFixed(2)}с; 800k → ${Math.round(low.avgBytes / 1024)} КБ/сегм, макс.пауза ${low.maxGap.toFixed(2)}с; поток меньше в ${(high.avgBytes / low.avgBytes).toFixed(1)}×`);
  // Низкий битрейт обязан давать существенно меньше данных: меньше данных на
  // проводе — меньше шансов переполнить канал зрителя, то есть выше стабильность.
  assert.ok(low.avgBytes < high.avgBytes * 0.6,
    `800k должен давать заметно меньший поток, чем 6000k: ${Math.round(low.avgBytes / 1024)}КБ/сегм против ${Math.round(high.avgBytes / 1024)}КБ/сегм`);
  // И тот и другой поток должны быть непрерывными (стабильность = ровный ритм).
  assert.ok(high.maxGap < 2.5, `6000k: сегменты должны идти ровно (макс. пауза ${high.maxGap.toFixed(2)}с)`);
  assert.ok(low.maxGap < 2.5, `800k: сегменты должны идти ровно (макс. пауза ${low.maxGap.toFixed(2)}с)`);
});

// ── Восстановление после остановки ───────────────────────────────────────
// Флаг «идёт остановка» раньше залипал в true и навсегда выключал
// переподнятие мгновенного канала: после «Стоп» ссылка молча оставалась
// мёртвой. Здесь проверяем, что второй запуск снова поднимает RTSP-канал.
test('после остановки эфир и мгновенный канал поднимаются заново', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const source = join(dataDirectory, 'restart.mp4');
  makeHeavySource(source, 14, 30);
  await post('/api/queue/local', { paths: [source] });

  const liveAgain = async () => {
    await post('/api/start/queue');
    assert.ok(await waitUntilPlaying(), 'эфир должен играть');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await status()).rtsp?.live) return true;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
  };

  assert.ok(await liveAgain(), 'RTSP-канал должен подняться при первом запуске');
  const stopped = await post('/api/stop');
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).running, false);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(await liveAgain(), 'RTSP-канал должен подняться и после остановки — флаг stopping не должен залипать');
  await post('/api/stop');
});

// ── Задержка не накапливается со временем ────────────────────────────────
// Раньше через 20 минут задержка доходила до 22с. Гоняем короткий клип по
// кругу (каждый цикл — стык producer'ов, главный подозреваемый в дрейфе) и
// следим за перфом: живой край не должен уезжать вперёд от настенных часов, а
// телеметрия обязана считать это (liveLatencySec) и не показывать ложных фризов.
test('задержка живого края не растёт со временем на зацикленном эфире', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const source = join(dataDirectory, 'loop-drift.mp4');
  makeHeavySource(source, 3, 30);
  await post('/api/queue/local', { paths: [source] });
  await post('/api/start/queue');
  await post('/api/playback', { action: 'loop', mode: 'all' });
  assert.ok(await waitUntilPlaying(), 'эфир должен играть');
  assert.ok(await waitForPlaylist(), 'плейлист должен появиться');

  const samples = [];
  let sawTelemetry = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const perf = (await status()).performance;
    assert.ok(perf.quality && typeof perf.quality.freezes === 'number', 'телеметрия качества должна быть в статусе');
    assert.ok(Array.isArray(perf.events), 'журнал событий эфира должен быть массивом');
    if (typeof perf.liveLatencySec === 'number') {
      // Задержка отдаётся величиной, а не знаком: отставание потока (минус)
      // раньше проходило мимо и пика, и коррекции, и этой проверки.
      assert.ok(perf.liveLatencySec >= 0, `задержка должна быть величиной, пришло ${perf.liveLatencySec}`);
      samples.push(perf.liveLatencySec); sawTelemetry = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const final = (await status()).performance;
  await post('/api/stop');

  assert.ok(sawTelemetry && samples.length >= 20, 'нужно достаточно замеров задержки');
  const peak = Math.max(...samples);
  // Живой край не должен разъезжаться с часами ни вперёд, ни назад: коррекция
  // дрейфа теперь держит в узде обе стороны.
  assert.ok(peak < 4.0, `задержка живого края не должна расти (пик ${peak.toFixed(1)}с за 30с прокрутки по кругу)`);
  // Тренд: последняя пятёрка не намного выше первой — накопления нет.
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const trend = avg(samples.slice(-5)) - avg(samples.slice(0, 5));
  assert.ok(trend < 2.0, `задержка не должна ползти вверх (прирост ${trend.toFixed(1)}с за прокрутку)`);
  // Синтетический источник не должен давать фризов на выходе на режим.
  assert.ok(final.quality.freezes <= 1, `на чистом источнике не должно быть фризов (насчитано ${final.quality.freezes})`);
  console.log(`  [дрейф] пик задержки ${peak.toFixed(1)}с, тренд ${trend >= 0 ? '+' : ''}${trend.toFixed(1)}с, фризов ${final.quality.freezes}, коррекций дрейфа ${final.quality.driftCorrections}`);
});

// Режим «Друзья»: включение без компонентов туннеля не должно ронять сервер
// (раньше throw в таймере смены режима убивал процесс), а статус обязан нести
// новые поля проверки ссылки (serves/verifying).
test('режим «Друзья» не роняет сервер и сообщает состояние ссылки', async () => {
  const before = await post('/api/config', { outputMode: 'tunnel' });
  assert.equal(before.status, 200);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const alive = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(alive.status, 200, 'сервер должен остаться живым в режиме туннеля');
  const s = await alive.json();
  assert.ok('serves' in s.tunnel, 'статус туннеля должен нести serves');
  assert.ok('verifying' in s.tunnel, 'статус туннеля должен нести verifying');
  assert.ok(['idle', 'starting', 'ready', 'error'].includes(s.tunnel.state), `неизвестное состояние туннеля: ${s.tunnel.state}`);
  await post('/api/config', { outputMode: 'local' });
});

// Обновление: запрос установки не должен ронять сервер, статус несёт поля
// нового потока (installing). Загрузка теперь по кнопке, а не сама.
test('запрос установки обновления не роняет сервер', async () => {
  const s0 = await status();
  assert.ok('installing' in s0.update, 'update.installing должно быть в статусе');
  assert.equal(s0.update.installing, false, 'без нажатия установка не идёт');
  const r = await post('/api/update/apply');
  assert.equal(r.status, 202, 'запрос установки принимается');
  await new Promise(resolve => setTimeout(resolve, 400));
  const alive = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(alive.status, 200, 'сервер жив после запроса установки (нет VRCAST_EXE — просто ничего не ставится)');
});

// YouTube-cookies убраны целиком: в конфиге не должно остаться их следов.
test('настроек cookies для YouTube больше нет', async () => {
  const config = (await status()).config;
  assert.equal(config.cookiesBrowser, undefined, 'cookiesBrowser должен исчезнуть из конфига');
  assert.equal(config.cookiesFile, undefined, 'cookiesFile должен исчезнуть из конфига');
  // И сохранение конфига не должно их возвращать.
  const saved = await post('/api/config', { outputMode: 'local', cookiesBrowser: 'chrome', cookiesFile: 'C:/x.txt' });
  const back = (await saved.json()).config;
  assert.equal(back.cookiesBrowser, undefined, 'сервер не должен принимать cookiesBrowser');
  assert.equal(back.cookiesFile, undefined, 'сервер не должен принимать cookiesFile');
});
