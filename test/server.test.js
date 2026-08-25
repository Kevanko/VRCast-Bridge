import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 48717;
let server;
let dataDirectory;

function launchServer() {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, VRCAST_PORT: String(port), LOCALAPPDATA: dataDirectory },
    windowsHide: true, stdio: 'ignore',
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Тестовый сервер не запустился');
}

test.before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'vrcast-test-'));
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

test('возвращает состояние инструментов и адрес потока', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(typeof state.tools.ffmpeg, 'boolean');
  assert.equal(state.localPlaybackUrl, `http://127.0.0.1:${port}/stream/live.m3u8`);
  assert.match(state.playbackUrl, /^(rtsp:\/\/127\.0\.0\.1:\d+\/live|http:\/\/127\.0\.0\.1:\d+\/stream\/live\.m3u8)$/);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.templates, []);
  assert.deepEqual(state.playback, { paused: false, busy: false, buffering: false, revision: 0, speed: 1, loopMode: 'once', canSeek: false });
});

test('готовит рабочую ссылку до выбора источника', async () => {
  const deadline = Date.now() + 8000;
  let state;
  while (Date.now() < deadline) {
    state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
    if (state.stream?.ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(state.stream.ready, true, 'нейтральный HLS должен запускаться с первой попытки вместе с приложением');
  const playlist = await fetch(`http://127.0.0.1:${port}/stream/live.m3u8`);
  assert.equal(playlist.status, 200);
  assert.ok(((await playlist.text()).match(/#EXTINF/g) || []).length >= 3);
});

test('отдаёт интерфейс и отклоняет неправильную ссылку', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /VRCast Bridge/);
  assert.match(html, /id="seekBar"/);
  assert.match(html, /id="speedSelect"/);
  assert.match(html, /id="loopSelect"/);
  assert.match(html, /id="monitorSource"/);
  assert.match(html, /id="audioOutput"/);
  assert.match(html, /id="mediaVolume"/);
  assert.match(html, /id="captureVolume"/);
  assert.match(html, /id="previewDelay"/);
  assert.match(html, /id="applyCapture"/);
  assert.match(html, /id="templateSelect"/);
  assert.match(html, /data-output="tunnel"/);

  const response = await fetch(`http://127.0.0.1:${port}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'не ссылка' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /http/);
});

test('сохраняет отдельную громкость медиа и захвата', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captureVolume: 2.25, mediaVolume: 0.65 }),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.config.captureVolume, 2.25);
  assert.equal(state.config.mediaVolume, 0.65);
});

test('не включает управление плеером без запущенной очереди', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pause' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /не играет/);
});

test('публичный адрес не открывает панель управления', async () => {
  const statusCode = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/status', headers: { Host: 'demo.trycloudflare.com' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(statusCode, 404);
});

test('очередь и её шаблон переживают перезапуск', async () => {
  const mediaFile = join(dataDirectory, 'saved-queue.wav');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.5', '-y', mediaFile], { windowsHide: true });
  assert.equal(generated.status, 0);
  const added = await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [mediaFile] }) });
  assert.equal(added.status, 201);
  const saved = await fetch(`http://127.0.0.1:${port}/api/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Тестовый шаблон' }) });
  assert.equal(saved.status, 201);
  const templateId = (await saved.json()).id;

  server.kill(); await once(server, 'exit');
  server = launchServer(); await waitForServer();
  let state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(state.queue.length, 1);
  assert.equal(state.templates.length, 1);

  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const restored = await fetch(`http://127.0.0.1:${port}/api/templates/${templateId}/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(restored.status, 200);
  state = await restored.json();
  assert.equal(state.queue.length, 1);
  assert.notEqual(state.queue[0].id, (await added.json()).added?.[0]?.id);
});

test('аудиопоток и HLS-сегменты идут без многосекундных провалов', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const mediaFile = join(dataDirectory, 'audio-continuity.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '18', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', mediaFile],
  { windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0);
  await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [mediaFile] }) });
  await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline) {
    const state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
    if (!state.playback.busy && state.activeKind === 'queue') break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const playlistDeadline = Date.now() + 10000;
  while (Date.now() < playlistDeadline) {
    const playlist = await fetch(`http://127.0.0.1:${port}/stream/live.m3u8`);
    if (playlist.ok && /#EXTINF/.test(await playlist.text())) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const startedAt = Date.now();
  const audioClient = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `http://127.0.0.1:${port}/stream/live.m3u8`,
    '-map', '0:a:0', '-t', '8', '-f', 'null', '-'], { windowsHide: true, timeout: 16000, encoding: 'utf8' });
  const wallSeconds = (Date.now() - startedAt) / 1000;
  assert.equal(audioClient.status, 0, audioClient.stderr);
  assert.ok(wallSeconds < 12, `8 секунд звука не должны растягиваться из-за зависаний: ${wallSeconds.toFixed(2)} с`);
  const hlsDirectory = join(dataDirectory, 'VRCastBridge', 'hls');
  const segments = (await readdir(hlsDirectory)).filter(name => /^segment-\d+\.ts$/i.test(name));
  const recent = (await Promise.all(segments.map(async name => ({ name, modified: (await stat(join(hlsDirectory, name))).mtimeMs }))))
    .sort((left, right) => left.modified - right.modified).slice(-10);
  const gaps = recent.slice(1).map((entry, index) => (entry.modified - recent[index].modified) / 1000);
  assert.ok(recent.length >= 8, 'должно быть достаточно сегментов для проверки ритма');
  assert.ok(Math.max(...gaps) < 2.5, `между HLS-сегментами не должно быть пауз по 5 секунд: ${Math.max(...gaps).toFixed(2)} с`);
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
});

test('Unity готовит только выбранный трек и не конкурирует с эфиром', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const first = join(dataDirectory, 'unity-first.mp4'), second = join(dataDirectory, 'unity-second.mp4');
  for (const [file, duration, color] of [[first, '1', 'blue'], [second, '2', 'purple']]) {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=550:duration=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file],
    { windowsHide: true, timeout: 30000 });
    assert.equal(generated.status, 0);
  }
  const addedResponse = await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [first, second] }) });
  assert.equal(addedResponse.status, 201);
  const items = (await addedResponse.json()).added;
  await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  const rejected = await fetch(`http://127.0.0.1:${port}/api/unity/queue/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: items[1].id }) });
  assert.equal(rejected.status, 400, 'Unity-кодирование не должно запускаться параллельно эфиру');
  assert.match((await rejected.json()).error, /остановите|остановить/i);
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
  const accepted = await fetch(`http://127.0.0.1:${port}/api/unity/queue/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: items[1].id }) });
  assert.equal(accepted.status, 202);
  let state;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
    if (['ready', 'error'].includes(state.compatibility.unity.queue.state)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(state.compatibility.unity.queue.state, 'ready', state.compatibility.unity.queue.message);
  assert.equal(state.compatibility.unity.queue.itemId, items[1].id);
  assert.match(state.compatibility.unity.queue.message, /unity-second/i);
  const unityFile = join(dataDirectory, 'VRCastBridge', 'unity', 'queue.mp4');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', unityFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0);
  assert.ok(Number(probe.stdout.trim()) > 1.8 && Number(probe.stdout.trim()) < 2.3, 'Unity-файл должен содержать выбранный второй трек, а не всю очередь');
});

test('серия обратных перемоток не останавливает эфир и HLS', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const mediaFile = join(dataDirectory, 'seek-stress.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', mediaFile], { windowsHide: true, timeout: 30000 });
  assert.equal(generated.status, 0);
  const added = await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [mediaFile] }) });
  assert.equal(added.status, 201);
  const started = await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  assert.equal(started.status, 200);
  const playlistReadyDeadline = Date.now() + 10000;
  while (Date.now() < playlistReadyDeadline) {
    const candidate = await fetch(`http://127.0.0.1:${port}/stream/live.m3u8`);
    if (candidate.ok && /#EXTINF/.test(await candidate.text())) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  let clientProgress = '';
  const liveClient = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `http://127.0.0.1:${port}/stream/live.m3u8`, '-map', '0:v:0', '-f', 'null', '-', '-progress', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  liveClient.stdout.setEncoding('utf8');
  liveClient.stdout.on('data', chunk => { clientProgress = (clientProgress + chunk).slice(-12000); });
  const latestClientTime = () => Number([...clientProgress.matchAll(/out_time_us=(\d+)/g)].at(-1)?.[1] || 0);
  let visualOutput = '';
  const visualClient = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `http://127.0.0.1:${port}/stream/live.m3u8`, '-map', '0:v:0', '-vf', 'fps=2,scale=64:36', '-f', 'framemd5', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  visualClient.stdout.setEncoding('utf8'); visualClient.stdout.on('data', chunk => { visualOutput = (visualOutput + chunk).slice(-30000); });
  const frameHashes = () => [...visualOutput.matchAll(/,\s*([a-f0-9]{32})\s*$/gim)].map(match => match[1]);
  const clientReadyDeadline = Date.now() + 10000;
  while (latestClientTime() === 0 && Date.now() < clientReadyDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(latestClientTime() > 0, 'непрерывный клиент должен начать декодирование');
  const pauseResponse = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', position: 3.25 }) });
  assert.equal(pauseResponse.status, 200);
  const pausedState = await pauseResponse.json();
  assert.equal(pausedState.playback.paused, true);
  assert.equal(pausedState.progress.elapsed, 3.25, 'пауза должна фиксировать отображаемую, а не скрытую live-позицию');
  const beforePauseStreamTime = latestClientTime();
  const pauseProgressDeadline = Date.now() + 6000;
  while (latestClientTime() - beforePauseStreamTime <= 800000 && Date.now() < pauseProgressDeadline) await new Promise(resolve => setTimeout(resolve, 200));
  const duringPauseStreamTime = latestClientTime();
  assert.ok(duringPauseStreamTime - beforePauseStreamTime > 800000, 'HLS должен продолжать идти во время паузы');
  assert.equal(liveClient.exitCode, null, 'непрерывный клиент не должен завершаться на паузе');
  const resumeResponse = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(resumeResponse.status, 200);
  const frozenHash = frameHashes().at(-1);
  assert.ok(frozenHash, 'визуальный HLS-клиент должен получить кадр до продолжения');
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.ok(frameHashes().slice(-8).some(hash => hash !== frozenHash), 'непрерывный клиент должен снова получать меняющиеся кадры после продолжения');
  const rapidPause = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
  assert.equal(rapidPause.status, 200);
  const rapidResume = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(rapidResume.status, 200);
  const seekBeforePause = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'seek', position: 7 }) });
  assert.equal(seekBeforePause.status, 200);
  const pausePendingSeek = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', position: 7 }) });
  assert.equal(pausePendingSeek.status, 200);
  const combinedState = await pausePendingSeek.json();
  assert.equal(combinedState.playback.paused, true);
  assert.equal(combinedState.progress.elapsed, 7, 'пауза сразу после перемотки должна сохранить выбранную позицию');
  const beforeCombinedPause = latestClientTime();
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.ok(latestClientTime() - beforeCombinedPause > 1000000, 'эфир должен продолжаться на стоп-кадре после комбинации перемотка → пауза');
  const resumePendingSeek = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(resumePendingSeek.status, 200);
  for (const position of [8, 2, 6, 1]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'seek', position }) });
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  const deadline = Date.now() + 10000;
  let state;
  while (Date.now() < deadline) {
    state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
    if (state.running && !state.playback.busy && state.progress?.elapsed >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(state.running, true);
  assert.equal(state.activeKind, 'queue');
  assert.equal(state.playback.busy, false);
  assert.equal(liveClient.exitCode, null, 'клиент не должен отключаться после перемоток');
  const beforeSourceSwitch = latestClientTime();
  const captureConfig = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputMode: 'local', quality: '720p', fps: 30, captureMode: 'region', regionX: 0, regionY: 0, regionWidth: 320, regionHeight: 240, audioMode: 'none' }) });
  assert.equal(captureConfig.status, 200);
  const screenStarted = await fetch(`http://127.0.0.1:${port}/api/start/screen`, { method: 'POST' });
  assert.equal(screenStarted.status, 200);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const afterSourceSwitch = latestClientTime();
  state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(state.activeKind, 'screen');
  assert.equal(liveClient.exitCode, null, 'клиент не должен отключаться при смене медиа на захват');
  assert.ok(afterSourceSwitch - beforeSourceSwitch > 800000, 'HLS должен продолжаться после смены источника');
  const beforeLiveReconfigure = latestClientTime();
  const reconfigured = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputMode: 'local', quality: '720p', fps: 60, captureMode: 'region', regionX: 10, regionY: 10, regionWidth: 320, regionHeight: 240, audioMode: 'none', applyLive: true }) });
  assert.equal(reconfigured.status, 200);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const afterLiveReconfigure = latestClientTime();
  assert.equal(liveClient.exitCode, null, 'клиент не должен отключаться при живой смене области и FPS');
  assert.ok(afterLiveReconfigure - beforeLiveReconfigure > 800000, 'HLS должен продолжаться после живой перенастройки захвата');
  // Живая смена FPS осознанно перезапускает релей (новый формат сессии) — даём
  // новому плейлисту отрасти дальше live-окна перед проверкой предпросмотра.
  await new Promise(resolve => setTimeout(resolve, 4500));
  const playlist = await fetch(`http://127.0.0.1:${port}/stream/live.m3u8`);
  assert.equal(playlist.status, 200);
  const playlistText = await playlist.text();
  assert.match(playlistText, /#EXTINF/);
  assert.match(playlistText, /#EXT-X-START:TIME-OFFSET=-1.5/);
  const targetDuration = Number(playlistText.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]);
  assert.ok(targetDuration >= 1, 'HLS TARGETDURATION должен быть положительным для VRChat/AVPro');
  assert.ok((playlistText.match(/#EXTINF/g) || []).length <= 4, 'VRChat получает минимальное по задержке, но устойчивое live-окно');
  const previewPlaylist = await fetch(`http://127.0.0.1:${port}/stream/preview.m3u8`).then(response => response.text());
  // Предпросмотр по умолчанию идёт вживую (задержка 0), поэтому смещение
  // минимальное. Отдельное окно у него остаётся — оно длиннее эфирного.
  assert.match(previewPlaylist, /#EXT-X-START:TIME-OFFSET=-2/);
  assert.doesNotMatch(previewPlaylist, /#EXT-X-DISCONTINUITY/, 'таймлайн непрерывен: live-разрывы ломают AVPro в VRChat и требуют resync');
  assert.ok((previewPlaylist.match(/#EXTINF/g) || []).length > (playlistText.match(/#EXTINF/g) || []).length, 'предпросмотр сохраняет задержанное окно');
  state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.ok(state.performance.realtimeRatio >= 0.8, `эфир должен идти в реальном времени, получено ${state.performance.realtimeRatio}`);
  const localItem = state.queue.find(item => item.local && item.unityCompatible);
  assert.ok(localItem, 'локальный H.264/AAC MP4 должен определяться как совместимый с Unity');
  const unityHead = await fetch(`http://127.0.0.1:${port}/media/${localItem.id}.mp4`, { method: 'HEAD', headers: { Range: 'bytes=0-1023' } });
  assert.equal(unityHead.status, 206);
  assert.equal(unityHead.headers.get('accept-ranges'), 'bytes');
  // Мелкие поправки на микросекунды релей делает сам, и они не слышны.
  // Ломает AVPro другое — крупный разрыв шкалы (когда-то он достигал 95000 с),
  // поэтому проверяем величину скачка, а не сам факт предупреждения.
  const dtsJumps = [...state.logs.join(String.fromCharCode(10)).matchAll(/previous: (\d+), current: (\d+)/g)]
    .map(match => Math.abs(Number(match[1]) - Number(match[2])));
  const worstJump = dtsJumps.length ? Math.max(...dtsJumps) : 0;
  assert.ok(worstJump < 90000, `шкала эфира не должна рваться больше чем на секунду, получено ${(worstJump / 90000).toFixed(2)} с`);
  liveClient.kill('SIGTERM');
  visualClient.kill('SIGTERM');
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
});

test('сбор списка окон не блокирует event loop и статус-эндпоинт', async () => {
  const sourcesPromise = fetch(`http://127.0.0.1:${port}/api/capture-sources`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.ok(elapsed < 500, `статус должен отвечать мгновенно во время сбора источников, заняло ${elapsed} мс`);
  const sources = await (await sourcesPromise).json();
  assert.ok(Array.isArray(sources.windows));
  assert.ok(Array.isArray(sources.monitors));
});

test('удаление играющего трека переключает эфир на следующий', async () => {
  const first = join(dataDirectory, 'del-a.wav');
  const second = join(dataDirectory, 'del-b.wav');
  for (const file of [first, second]) {
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '30', '-y', file], { windowsHide: true });
    assert.equal(made.status, 0);
  }
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [first, second] }) });
  await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 2500));
  let state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  const playingId = state.currentId;
  assert.ok(playingId, 'трек должен играть');
  await fetch(`http://127.0.0.1:${port}/api/queue/${playingId}`, { method: 'DELETE' });
  await new Promise(resolve => setTimeout(resolve, 2500));
  state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(state.running, true, 'эфир не должен останавливаться');
  assert.ok(state.currentId && state.currentId !== playingId, 'должен играть следующий трек');
  assert.ok(state.queue.some(item => item.id === state.currentId), 'currentId обязан существовать в очереди');
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
});

test('ошибка старта не оставляет зомби-состояние эфира', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  const failed = await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  assert.equal(failed.status, 400);
  const state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(state.running, false, 'после ошибки старта эфир не должен числиться запущенным');
  await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [join(dataDirectory, 'seek-stress.mp4')] }) });
  const recovered = await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  assert.equal(recovered.status, 200, 'после возврата в local эфир должен запускаться');
  await new Promise(resolve => setTimeout(resolve, 2000));
  const live = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(live.running, true);
  assert.notEqual(live.stream.state, 'offline', 'релей обязан подняться заново');
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
});

test('формат TS-потока не меняется при смене источников (иначе AVPro требует resync)', async () => {
  const plain = join(dataDirectory, 'fmt-plain.mp4');
  const weird = join(dataDirectory, 'fmt-weird.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', plain], { windowsHide: true });
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=44100', '-t', '40', '-vf', 'setsar=16/11',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-ac', '6', '-c:a', 'aac', '-y', weird], { windowsHide: true });
  const hlsDirectory = join(dataDirectory, 'VRCastBridge', 'hls');
  const probeLatest = async () => {
    const names = (await readdir(hlsDirectory)).filter(name => /^segment-\d+\.ts$/.test(name));
    const dated = [];
    for (const name of names) dated.push({ name, modified: (await stat(join(hlsDirectory, name))).mtimeMs });
    dated.sort((left, right) => right.modified - left.modified);
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,sample_aspect_ratio,channels,sample_rate,r_frame_rate', '-of', 'json', join(hlsDirectory, dated[0].name)],
    { windowsHide: true, encoding: 'utf8' });
    const data = JSON.parse(result.stdout || '{}');
    const video = data.streams?.find(stream => stream.codec_type === 'video') || {};
    const audio = data.streams?.find(stream => stream.codec_type === 'audio') || {};
    return `${video.width}x${video.height} sar=${video.sample_aspect_ratio} ${video.r_frame_rate} | ${audio.codec_name} ${audio.channels}ch ${audio.sample_rate}`;
  };
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:${port}/api/queue/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [plain, weird] }) });
  await fetch(`http://127.0.0.1:${port}/api/start/queue`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 6000));
  const before = await probeLatest();
  const state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  await fetch(`http://127.0.0.1:${port}/api/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'jump', id: state.queue[1].id }) });
  await new Promise(resolve => setTimeout(resolve, 6000));
  const after = await probeLatest();
  assert.equal(after, before, `формат эфира изменился при смене трека: ${before} -> ${after}`);
  assert.match(before, /sar=1:1/, 'SAR обязан нормализоваться к 1:1');
  assert.match(before, /2ch/, 'звук обязан нормализоваться к стерео');
  await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST' });
});

test('мгновенный RTSP-канал публикуется и отдаётся как основная ссылка', async () => {
  const deadline = Date.now() + 15000;
  let state;
  while (Date.now() < deadline) {
    state = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
    if (state.rtsp?.available) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(state.tools.mediamtx, true, 'RTSP-сервер должен поставляться вместе с приложением');
  assert.equal(state.rtsp.available, true, 'RTSP-канал должен подниматься автоматически');
  assert.match(state.rtsp.url, /^rtsp:\/\/127\.0\.0\.1:\d+\/live$/);
  assert.equal(state.playbackUrl, state.rtsp.url, 'в локальном режиме основная ссылка — мгновенный RTSP');

  const probe = spawnSync('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0', state.rtsp.url], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(probe.status, 0, `RTSP-поток должен открываться плеером: ${probe.stderr}`);
  assert.match(probe.stdout, /h264/, 'RTSP обязан отдавать H.264 для AVPro');
  assert.match(probe.stdout, /aac/, 'RTSP обязан отдавать AAC-звук');
});

test('принимает прямые ссылки на медиа без разбора через yt-dlp', async () => {
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
  // Собственный HLS-поток приложения — удобная прямая ссылка без внешней сети
  const added = await fetch(`http://127.0.0.1:${port}/api/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${port}/stream/live.m3u8` }),
  });
  assert.equal(added.status, 201, 'прямая ссылка на плейлист должна приниматься');
  const state = (await added.json()).status;
  const item = state.queue.at(-1);
  assert.equal(item.direct, true, 'такая ссылка не должна идти через разбор страницы');
  assert.equal(item.live, true, 'плейлист .m3u8 считается потоком и не кешируется');

  const file = await fetch(`http://127.0.0.1:${port}/api/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.invalid/clip.mp4' }),
  });
  assert.equal(file.status, 201, 'прямая ссылка на файл принимается без обращения к сети');
  const fileItem = (await file.json()).status.queue.at(-1);
  assert.equal(fileItem.direct, true);
  assert.equal(fileItem.live, false, 'обычный файл кешируется, а не считается эфиром');
  await fetch(`http://127.0.0.1:${port}/api/queue`, { method: 'DELETE' });
});
