import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Конфиг сервера на VPS (server/install.sh) проверяем настоящим MediaMTX на локальных портах.
const PORT = 49600, KEY = 'test-key-123', IP = '203.0.113.5';
const candidates = [process.env.VRCAST_TEST_MEDIAMTX, join(homedir(), '.local/share/VRCastBridge/tools/mediamtx'), '/usr/local/bin/mediamtx', '/usr/bin/mediamtx'].filter(Boolean);
const mediamtx = candidates.find(path => existsSync(path));

const printed = spawnSync('bash', ['server/install.sh'], { encoding: 'utf8', env: { ...process.env, VRCAST_PRINT_CONFIG: '1', VRCAST_PORT: String(PORT), VRCAST_KEY: KEY, VRCAST_IP: IP } });

test('установщик печатает конфиг: порты рядом с RTSP, WebRTC для телефона, заставка на live', () => {
  assert.equal(printed.status, 0, printed.stderr);
  const yml = printed.stdout;
  assert.match(yml, new RegExp(`rtspAddress: :${PORT}\\b`));
  assert.match(yml, new RegExp(`webrtcAddress: :${PORT + 11}\\b`));
  assert.match(yml, new RegExp(`webrtcLocalUDPAddress: :${PORT + 12}\\b`));
  assert.match(yml, /webrtcAdditionalHosts: \[203\.0\.113\.5\]/);
  assert.match(yml, /alwaysAvailable: yes/, 'заставка на live для ПК сохранена');
  assert.match(yml, /\n  phone: \{\}/, 'для экрана телефона есть отдельный путь без требований к кодекам');
  assert.match(yml, new RegExp(`pass: ${KEY}`));
  assert.equal(spawnSync('bash', ['-n', 'server/install.sh']).status, 0, 'скрипт без синтаксических ошибок');
});

test('сервер с этим конфигом: публикация по ключу, чтение без ключа, WHIP с экрана телефона', { skip: !mediamtx && 'нет бинарника MediaMTX (VRCAST_TEST_MEDIAMTX)', timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vrcast-vps-'));
  const config = join(directory, 'mediamtx.yml');
  writeFileSync(config, printed.stdout);
  const server = spawn(mediamtx, [config], { stdio: 'ignore' });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const publish = (auth, path = 'phone', seconds = 6) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-t', String(seconds), '-f', 'rtsp', '-rtsp_transport', 'tcp',
    `rtsp://${auth}127.0.0.1:${PORT}/${path}`], { stdio: 'ignore' });
  try {
    await sleep(1500);
    const bad = publish('vrcast:wrong@');
    assert.notEqual((await new Promise(resolve => bad.on('exit', resolve))), 0, 'с чужим ключом публиковать нельзя');

    const good = publish(`vrcast:${KEY}@`);
    await sleep(2500);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', `rtsp://127.0.0.1:${PORT}/phone`], { encoding: 'utf8', timeout: 15000 });
    assert.match(probe.stdout, /h264/, 'смотреть можно без ключа');
    good.kill('SIGKILL');

    const whip = (headers, body = 'не sdp') => fetch(`http://127.0.0.1:${PORT + 11}/phone/whip`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', ...headers }, body });
    assert.equal((await whip({})).status, 401, 'WHIP без ключа закрыт');
    assert.equal((await whip({ Authorization: `Basic ${Buffer.from('vrcast:wrong').toString('base64')}` })).status, 401, 'WHIP с чужим ключом закрыт');
    const withKey = await whip({ Authorization: `Basic ${Buffer.from(`vrcast:${KEY}`).toString('base64')}` });
    assert.ok([400, 422].includes(withKey.status), `с верным ключом запрос доходит до разбора SDP (получили ${withKey.status})`);
  } finally { server.kill('SIGKILL'); }
});
