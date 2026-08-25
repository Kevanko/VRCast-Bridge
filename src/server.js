import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { statfs } from 'node:fs/promises';

const APP_VERSION = '0.39.0';

// Свободное место проверяем редко и в фоне: на полном диске ffmpeg не может
// дописывать сегменты, эфир встаёт рывками, а причина ниоткуда не видна.
let freeDiskMb = null;
function watchFreeSpace() {
  const measure = () => statfs(DATA_DIR)
    .then(info => { freeDiskMb = Math.round(info.bsize * info.bavail / 1048576); })
    .catch(() => {});
  measure();
  setInterval(measure, 30000).unref();
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const STANDBY_IMAGE = join(PUBLIC_DIR, 'standby.png');
const DATA_DIR = join(process.env.LOCALAPPDATA || process.cwd(), 'VRCastBridge');
const HLS_DIR = join(DATA_DIR, 'hls');
const THUMB_DIR = join(DATA_DIR, 'thumbs');
const DEFAULT_CACHE_DIR = join(DATA_DIR, 'media-cache');
const UNITY_DIR = join(DATA_DIR, 'unity');
const UNITY_ITEMS_DIR = join(UNITY_DIR, 'items');
const UNITY_QUEUE_FILE = join(UNITY_DIR, 'queue.mp4');
const UNITY_CAPTURE_FILE = join(UNITY_DIR, 'capture.mp4');
const UNITY_STATE_FILE = join(UNITY_DIR, 'state.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const QUEUE_FILE = join(DATA_DIR, 'queue.json');
const TEMPLATES_FILE = join(DATA_DIR, 'templates.json');
const CAPTURE_PREVIEW = join(DATA_DIR, 'capture-preview.jpg');
const LOG_FILE = join(DATA_DIR, 'vrcast.log');
const DETAIL_LOG_FILE = join(DATA_DIR, 'vrcast-errors.log');
const PORT = Number(process.env.VRCAST_PORT || 4717);
const RTSP_PORT = Number(process.env.VRCAST_RTSP_PORT || PORT + 1);
const HOST = '127.0.0.1';
// Прямая ссылка на файл или плейлист: разбирать её через yt-dlp незачем.
const DIRECT_LIVE = /[.](m3u8|mpd)([?#]|$)/i;
const DIRECT_FILE = /[.](mp4|mkv|webm|mov|avi|m4v|mp3|m4a|aac|flac|wav|ogg|opus|ts)([?#]|$)/i;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus']);

mkdirSync(HLS_DIR, { recursive: true });
mkdirSync(THUMB_DIR, { recursive: true });
mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
mkdirSync(UNITY_ITEMS_DIR, { recursive: true });
for (const file of [DETAIL_LOG_FILE]) {
  try {
    if (existsSync(file) && statSync(file).size > 4 * 1024 * 1024) {
      const contents = readFileSync(file);
      writeFileSync(file, contents.subarray(Math.max(0, contents.length - 1024 * 1024)));
    }
  } catch {}
}
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    const contents = readFileSync(LOG_FILE);
    writeFileSync(LOG_FILE, contents.subarray(Math.max(0, contents.length - 512 * 1024)));
  }
} catch {}

const defaults = {
  outputMode: 'local', servers: [], activeServerId: '', quality: '720p', fps: 60,
  captureMode: 'monitor', captureMonitorId: '', captureWindowHandle: '', regionX: 0, regionY: 0,
  regionWidth: 1280, regionHeight: 720, audioMode: 'system', captureAudioDevice: '',
  audioOutputId: '', audioProcessId: '', loopMode: 'once', playbackSpeed: 1,
  captureVolume: 1.5, mediaVolume: 1, mediaQuality: '720p', mediaFps: 60, previewDelay: 0, localAppVolume: 1, rtspTransport: 'tcp',
  cacheRoot: '',
};

function loadConfig() {
  try { return { ...defaults, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...defaults }; }
}

let config = loadConfig();
// Разовый перенос старой настройки: раньше по умолчанию стояли 5 секунд
// задержки предпросмотра под HLS, сейчас канал мгновенный и ждать нечего.
if (!config.previewDelayReset) {
  config = { ...config, previewDelay: 0, previewDelayReset: true };
  try { saveConfig({ previewDelay: 0, previewDelayReset: true }); } catch {}
}
let queue = loadQueue();
let templates = loadTemplates();
let activeProcess = null;
let activeAuxProcess = null;
let activeWindowProcess = null;
let relayProcess = null;
let standbyProcess = null;
let pauseFrameProcess = null;
let relayStartedAt = 0;
let relayProfile = null;
let mediaMtxProcess = null;
const rtspPushProcesses = new Map();
let lastRemotePushError = '';
const rtspPushTimers = new Map();
const rtspPublishPass = crypto.randomBytes(12).toString('hex');
let tunnelProcess = null;
let tunnelCandidates = new Set();
let tunnelUrl = '';
let tunnelState = 'idle';
let tunnelError = '';
let tunnelProvider = '';
let tunnelDeadlineTimer = null;
let tunnelFallbackTimer = null;
let pinggyStarted = false;
let activeKind = null;
let currentId = null;
let currentStartedAt = null;
let currentDuration = null;
let stopping = false;
let playGeneration = 0;
let preparingNext = false;
let queueIndex = -1;
let sourcePosition = 0;
let pausedPosition = 0;
let queuePaused = false;
let manualTransition = null;
let playbackRevision = 0;
let playbackBusy = false;
let hlsHealth = { ready: false, realtimeRatio: 0, segmentAge: null, segmentCount: 0, latest: '', updatedAt: 0 };
let hlsHealthTimer = null;
let windowWatchTimer = null;
let windowCaptureState = null;
let audioLevelDb = -96;
let audioSamples = 0;
let audioSquares = 0;
let logLines = [];
const resolvedMedia = new Map();
const mediaCacheJobs = new Map();
const mediaCacheProcesses = new Map();
let unityBuildProcess = null;
let unityBuildGeneration = 0;
let unityBuild = loadUnityBuildState();
let updateState = { checked: false, available: false, version: '', ready: false, notes: '', error: '' };
let unityCaptureProcess = null;
let unityCaptureStartedAt = 0;
let unityCapture = { state: existsSync(UNITY_CAPTURE_FILE) ? 'ready' : 'idle', message: existsSync(UNITY_CAPTURE_FILE) ? 'Клип готов' : 'Запись ещё не создана', updatedAt: 0 };

function loadUnityBuildState() {
  try {
    const saved = JSON.parse(readFileSync(UNITY_STATE_FILE, 'utf8'));
    if (saved?.signature && existsSync(UNITY_QUEUE_FILE)) return { state: 'ready', progress: 1,
      message: String(saved.message || 'Трек подготовлен'), signature: String(saved.signature), itemId: String(saved.itemId || ''),
      title: String(saved.title || ''), updatedAt: Number(saved.updatedAt) || 0 };
  } catch {}
  return { state: 'idle', progress: 0, message: 'Очередь ещё не подготовлена', signature: '', updatedAt: 0 };
}

function saveUnityBuildState() {
  try { writeFileSync(UNITY_STATE_FILE, JSON.stringify({ signature: unityBuild.signature, itemId: unityBuild.itemId, title: unityBuild.title,
    message: unityBuild.message, updatedAt: unityBuild.updatedAt }, null, 2), 'utf8'); } catch {}
}

// YouTube регулярно ломает старые версии yt-dlp: ошибка выглядит как
// «HTTP Error 403: Forbidden» на каждом треке. Поэтому носим свою копию и
// обновляем её сами, а системную используем только как запасной вариант.
function ytdlpPath() {
  if (existsSync(YTDLP_UPDATED)) return YTDLP_UPDATED;
  const own = join(DATA_DIR, 'tools', 'yt-dlp.exe');
  if (existsSync(own)) return own;
  if (existsSync(YTDLP_BUNDLED)) return YTDLP_BUNDLED;
  return 'yt-dlp';
}

function refreshYtdlp() {
  if (!existsSync(YTDLP_BUNDLED)) return;
  try {
    mkdirSync(join(DATA_DIR, 'tools'), { recursive: true });
    if (!existsSync(YTDLP_UPDATED)) copyFileSync(YTDLP_BUNDLED, YTDLP_UPDATED);
  } catch (error) { return log(`Обновление yt-dlp: ${error.message}`); }
  // Обновление фоновое и необязательное: не работает — играем текущей версией.
  spawnCollect(YTDLP_UPDATED, ['-U'], 120000).then(result => {
    const line = String(result.stdout || '').split(/\r?\n/).find(text => /updat|already|latest/i.test(text));
    if (line) log(`yt-dlp: ${line.trim().slice(0, 160)}`);
  });
}

function toolAvailable(name, versionArgs = ['--version']) {
  const probe = spawnSync(name, versionArgs, { windowsHide: true, encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

// Пока идёт эфир, медиапоток прокачивается через event loop Node, поэтому
// в рабочих путях запрещены spawnSync/долгие синхронные вызовы: каждая
// блокировка = заикание звука. Всё, что запускается во время стрима,
// использует этот асинхронный сборщик вывода.
function spawnCollect(command, args, timeout = 10000, options = {}) {
  return new Promise(resolvePromise => {
    let child;
    try { child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
    catch (error) { return resolvePromise({ status: -1, stdout: '', stderr: String(error.message || error) }); }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolvePromise({ status: -1, stdout, stderr: stderr || error.message }); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ status: code ?? -1, stdout, stderr }); });
  });
}

function encoderWorks(name) {
  if (!toolAvailable('ffmpeg', ['-version'])) return false;
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=640x360:d=0.1', '-frames:v', '1', '-c:v', name, '-f', 'null', '-'], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  return !result.error && result.status === 0;
}

// Тяжёлые сторонние утилиты больше не лежат внутри программы: EXE весил из-за
// них 200 МБ. Теперь они докачиваются при первом запуске в папку данных, и
// туда же кладётся ffmpeg, если его нет в системе.
const TOOL_DIR = join(DATA_DIR, 'tools');
const TOOL_SOURCES = {
  'yt-dlp.exe': { label: 'загрузчик видео', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' },
  'cloudflared.exe': { label: 'публичные ссылки', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' },
  'mediamtx.exe': { label: 'мгновенный канал', github: 'bluenviron/mediamtx', asset: /windows_amd64\.zip$/i, unpack: ['mediamtx.exe'] },
  'ffmpeg.exe': { label: 'кодировщик', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', unpack: ['ffmpeg.exe', 'ffprobe.exe'] },
};
let toolDownloads = {};

function toolPath(name) {
  const own = join(TOOL_DIR, name);
  if (existsSync(own)) return own;
  const bundled = join(ROOT, 'tools', name);
  if (existsSync(bundled)) return bundled;
  return '';
}

const CLOUDFLARED = () => toolPath('cloudflared.exe');
const PINGGY = () => toolPath('pinggy.exe');
const MEDIAMTX = () => toolPath('mediamtx.exe');
const PLINK = () => toolPath('plink.exe');
const YTDLP_BUNDLED = join(ROOT, 'tools', 'yt-dlp.exe');
// Обновлённая копия живёт в данных приложения: она переживает обновление
// программы и не затирается распаковкой встроенных компонентов.
const YTDLP_UPDATED = join(DATA_DIR, 'tools', 'yt-dlp.exe');
const SERVER_RTSP_PORT = 8554;
const PINGGY_DATA_DIR = join(DATA_DIR, 'pinggy-runtime');
let tools = {
  ffmpeg: toolAvailable('ffmpeg', ['-version']), ytdlp: toolAvailable(ytdlpPath()),
  cloudflared: Boolean(CLOUDFLARED()) && toolAvailable(CLOUDFLARED()),
  pinggy: Boolean(PINGGY()) && toolAvailable(PINGGY()),
  mediamtx: Boolean(MEDIAMTX()),
  plink: Boolean(PLINK()),
};
const encoder = encoderWorks('h264_nvenc')
  ? { name: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true }
  : { name: 'libx264', label: 'CPU x264', hardware: false };

function pinggyEnvironment() {
  const roaming = join(PINGGY_DATA_DIR, 'roaming'), local = join(PINGGY_DATA_DIR, 'local');
  mkdirSync(roaming, { recursive: true }); mkdirSync(local, { recursive: true });
  return { ...process.env, APPDATA: roaming, LOCALAPPDATA: local };
}

function stopPinggyDaemon() {
  if (!tools.pinggy || !pinggyStarted) return;
  pinggyStarted = false;
  const stopper = spawn(PINGGY(), ['daemon', 'stop'], { windowsHide: true, stdio: 'ignore', env: pinggyEnvironment() });
  stopper.on('error', () => {});
  const escaped = PINGGY.replace(/'/g, "''");
  spawnCollect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$target='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { $_.ProcessId }`], 8000)
    .then(result => {
      for (const value of String(result.stdout || '').split(/\s+/).filter(Boolean)) {
        if (/^\d+$/.test(value)) spawn('taskkill.exe', ['/PID', value, '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      }
    });
}

// Кеш можно унести на другой диск: на системном место кончается быстрее всего.
// Пустое значение — папка по умолчанию рядом с настройками.
function mediaCacheDir() {
  if (!config.cacheRoot) return DEFAULT_CACHE_DIR;
  return join(config.cacheRoot, 'VRCastBridge-cache');
}

function ensureCacheDir() {
  const directory = mediaCacheDir();
  mkdirSync(directory, { recursive: true });
  return directory;
}

// Буквы дисков перебираем проверкой существования: ни одного процесса и мгновенно.
function listDrives() {
  const letters = [];
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    try { if (existsSync(`${letter}:\\`)) letters.push(`${letter}:`); } catch {}
  }
  return letters;
}

function saveConfig(next) {
  config = { ...config, ...next };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function normalizeQueueItem(raw, freshId = false) {
  if (!raw || typeof raw !== 'object' || typeof raw.sourceUrl !== 'string' || !raw.sourceUrl.trim()) return null;
  const local = Boolean(raw.local);
  const sourceUrl = local ? resolve(raw.sourceUrl) : raw.sourceUrl.trim();
  if (local && (!existsSync(sourceUrl) || !statSync(sourceUrl).isFile())) return null;
  if (!local && !validWebUrl(sourceUrl)) return null;
  let technical = {};
  if (local && (!raw.videoCodec || raw.unityCompatible === undefined)) {
    try { technical = mediaInfo(sourceUrl); } catch {}
  }
  return {
    id: freshId ? crypto.randomUUID() : String(raw.id || crypto.randomUUID()),
    title: String(raw.title || (local ? basename(sourceUrl) : sourceUrl)).slice(0, 500), sourceUrl,
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : null,
    thumbnail: String(raw.thumbnail || '').slice(0, 2000), local,
    hasVideo: technical.hasVideo ?? raw.hasVideo !== false, hasAudio: technical.hasAudio ?? raw.hasAudio !== false,
    videoCodec: String(technical.videoCodec || raw.videoCodec || ''), audioCodec: String(technical.audioCodec || raw.audioCodec || ''),
    unityCompatible: Boolean(technical.unityCompatible ?? raw.unityCompatible),
    unavailable: Boolean(raw.unavailable),
    direct: Boolean(raw.direct), live: Boolean(raw.live),
  };
}

function loadQueue() {
  try {
    const saved = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
    return (Array.isArray(saved) ? saved : []).map(item => normalizeQueueItem(item)).filter(Boolean).slice(0, 500);
  } catch { return []; }
}

function saveQueue() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function loadTemplates() {
  try {
    const saved = JSON.parse(readFileSync(TEMPLATES_FILE, 'utf8'));
    return (Array.isArray(saved) ? saved : []).filter(item => item && typeof item === 'object' && Array.isArray(item.items)).map(item => ({
      id: String(item.id || crypto.randomUUID()), name: String(item.name || 'Без названия').slice(0, 80),
      createdAt: String(item.createdAt || new Date().toISOString()), updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString()),
      items: item.items.map(entry => normalizeQueueItem(entry)).filter(Boolean).slice(0, 500),
      settings: {
        loopMode: ['once', 'one', 'all'].includes(item.settings?.loopMode) ? item.settings.loopMode : 'once',
        playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(item.settings?.playbackSpeed)) ? Number(item.settings.playbackSpeed) : 1,
        mediaVolume: Math.max(0, Math.min(2, Number(item.settings?.mediaVolume ?? 1))),
      },
    })).slice(0, 100);
  } catch { return []; }
}

function saveTemplates() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
}

function templateSummaries() {
  return templates.map(item => ({ id: item.id, name: item.name, count: item.items.length, updatedAt: item.updatedAt }));
}

function saveQueueTemplate(body) {
  if (!queue.length) throw new Error('Сначала добавьте медиа в очередь.');
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Введите название шаблона.');
  const existing = templates.find(item => item.id === String(body.id || ''));
  const now = new Date().toISOString();
  const snapshot = queue.map(item => ({ ...item }));
  if (existing) {
    existing.name = name; existing.items = snapshot; existing.updatedAt = now;
    existing.settings = { loopMode: config.loopMode, playbackSpeed: config.playbackSpeed, mediaVolume: config.mediaVolume };
    saveTemplates(); log(`Шаблон обновлён: ${name}`); return existing.id;
  }
  const created = { id: crypto.randomUUID(), name, items: snapshot, createdAt: now, updatedAt: now,
    settings: { loopMode: config.loopMode, playbackSpeed: config.playbackSpeed, mediaVolume: config.mediaVolume } };
  templates.push(created); saveTemplates(); log(`Шаблон сохранён: ${name}`); return created.id;
}

function applyQueueTemplate(id, append = false) {
  const template = templates.find(item => item.id === String(id));
  if (!template) throw new Error('Шаблон не найден.');
  const restored = template.items.map(item => normalizeQueueItem(item, true)).filter(Boolean);
  if (!restored.length) throw new Error('В шаблоне не осталось доступных медиафайлов.');
  if (activeKind === 'queue') stopActive();
  queue = append ? [...queue, ...restored].slice(0, 500) : restored;
  saveQueue();
  saveConfig(template.settings);
  for (const item of restored) if (item.local && item.hasVideo && !item.thumbnail) generateThumbnail(item);
  log(`${append ? 'Добавлен' : 'Загружен'} шаблон: ${template.name}`);
}

// Полные тексты ошибок уходят в отдельный файл: в окне журнала они не
// помещаются, а для разбора нужны целиком.
function logDetail(message) {
  try { appendFileSync(DETAIL_LOG_FILE, `${new Date().toISOString()}  ${message}\n`, 'utf8'); } catch {}
}

function log(message) {
  const line = `${new Date().toLocaleTimeString('ru-RU')}  ${message}`;
  logLines = [...logLines.slice(-99), line];
  console.log(line);
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${message}\n`, 'utf8'); } catch {}
}

function stopPublicTunnel() {
  const children = new Set([...tunnelCandidates, tunnelProcess].filter(Boolean));
  if (tunnelDeadlineTimer) clearTimeout(tunnelDeadlineTimer);
  if (tunnelFallbackTimer) clearTimeout(tunnelFallbackTimer);
  tunnelDeadlineTimer = null;
  tunnelFallbackTimer = null;
  tunnelProcess = null; tunnelCandidates = new Set(); tunnelUrl = ''; tunnelState = 'idle'; tunnelError = ''; tunnelProvider = '';
  for (const child of children) child.kill('SIGTERM');
  stopPinggyDaemon();
}

function activatePublicTunnel(child, provider, url) {
  if (tunnelUrl || !tunnelCandidates.has(child)) return;
  if (tunnelFallbackTimer) clearTimeout(tunnelFallbackTimer);
  tunnelFallbackTimer = null;
  if (tunnelDeadlineTimer) clearTimeout(tunnelDeadlineTimer);
  tunnelDeadlineTimer = null;
  tunnelProcess = child; tunnelProvider = provider; tunnelUrl = url.replace(/\/$/, ''); tunnelState = 'ready'; tunnelError = '';
  for (const candidate of tunnelCandidates) if (candidate !== child) candidate.kill('SIGTERM');
  tunnelCandidates = new Set([child]);
  if (provider === 'Cloudflare') setTimeout(stopPinggyDaemon, 500);
  log(`Публичная ссылка готова · ${provider} — её можно отправить друзьям`);
}

function trackTunnelChild(child, provider) {
  tunnelCandidates.add(child);
  child.on('error', error => {
    tunnelCandidates.delete(child);
    if (!tunnelUrl && !tunnelCandidates.size) { tunnelState = 'error'; tunnelError = error.message; log(`Публичный туннель: ${error.message}`); }
  });
  child.on('close', code => {
    tunnelCandidates.delete(child);
    if (tunnelProcess !== child) {
      if (!tunnelUrl && !tunnelCandidates.size && !stopping && !tunnelFallbackTimer) { tunnelState = 'error'; tunnelError = 'Не удалось подключить ни один публичный канал.'; }
      return;
    }
    const stoppedProvider = tunnelProvider;
    tunnelProcess = null; tunnelUrl = ''; tunnelProvider = '';
    if (stoppedProvider === 'Pinggy') stopPinggyDaemon();
    if (stopping || config.outputMode !== 'tunnel') { tunnelState = 'idle'; return; }
    tunnelState = 'error'; tunnelError = `Публичный туннель остановился${code === null ? '' : ` (код ${code})`}.`;
    log(tunnelError);
    setTimeout(() => { if (!stopping && config.outputMode === 'tunnel') startPublicTunnel(); }, 1800);
  });
  return child;
}

function startCloudflareCandidate() {
  const child = trackTunnelChild(spawn(CLOUDFLARED(), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), 'Cloudflare');
  let pending = '', candidateUrl = '', announced = false;
  const inspect = chunk => {
    pending = (pending + String(chunk)).slice(-16000);
    candidateUrl ||= pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] || '';
    if (candidateUrl && !announced) { announced = true; log('Cloudflare выдал адрес, устанавливаю медиасоединение…'); }
    if (candidateUrl && /Registered tunnel connection/i.test(pending)) activatePublicTunnel(child, 'Cloudflare', candidateUrl);
    const errorLine = String(chunk).split(/\r?\n/).find(line => /\bERR\b/.test(line));
    if (errorLine) log(`Cloudflare: ${errorLine.trim().slice(0, 300)}`);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', inspect); child.stderr.on('data', inspect);
}

function startPinggyCandidate() {
  pinggyStarted = true;
  const child = trackTunnelChild(spawn(PINGGY(), ['--noTui', '-l', `http://127.0.0.1:${PORT}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pinggyEnvironment() }), 'Pinggy');
  let pending = '';
  const inspect = chunk => {
    pending = (pending + String(chunk)).slice(-16000);
    const match = pending.match(/https:\/\/[a-z0-9-]+\.run\.pinggy-free\.link/i);
    if (match) activatePublicTunnel(child, 'Pinggy', match[0]);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', inspect); child.stderr.on('data', inspect);
}

function startPublicTunnel() {
  if (config.outputMode !== 'tunnel' || tunnelProcess || tunnelCandidates.size) return;
  if (!tools.cloudflared && !tools.pinggy) throw new Error('Компоненты публичной ссылки не найдены.');
  tunnelUrl = ''; tunnelProvider = ''; tunnelState = 'starting'; tunnelError = '';
  // Оба туннеля поднимаются одновременно, побеждает тот, кто первым отдал адрес.
  // Раньше Pinggy ждал Cloudflare 12 секунд, а в сетях с фильтром Cloudflare
  // не подключается никогда — ссылка появлялась через минуту и с ошибкой посередине.
  if (tools.cloudflared) startCloudflareCandidate();
  if (tools.pinggy) startPinggyCandidate();
  tunnelDeadlineTimer = setTimeout(() => {
    if (tunnelUrl || tunnelState !== 'starting') return;
    for (const child of tunnelCandidates) child.kill('SIGTERM');
    stopPinggyDaemon();
    tunnelCandidates = new Set(); tunnelState = 'error';
    tunnelError = 'Сеть блокирует публичные туннели. Отключите VPN/фильтр или разрешите исходящие HTTPS-соединения.';
    log(tunnelError);
  }, 35000);
}

// Транспорт выбирается по адресу назначения, а не настройкой.
// Своя машина (127.0.0.1) — rtsp:// (UDP): на петле пакеты не теряются, а по TCP
// плеер упирается в backpressure и видео ползёт при живом звуке.
// Свой сервер и адреса в локальной сети — rtspt:// (TCP): UDP там режут
// фаерволы и Wi-Fi, а на Quest он не проходит вовсе.
function rtspAddress() {
  return mediaMtxProcess ? `rtsp://127.0.0.1:${RTSP_PORT}/live` : '';
}

// «Свой сервер»: тот же мгновенный RTSP, но на машине с белым IP — ссылка
// работает у друзей через интернет и не протухает, в отличие от туннеля.
// ─── Свои серверы трансляции ───────────────────────────────────────────────
// Разворачиваются по SSH (root + пароль). Пароль нужен только на время
// установки и никогда не сохраняется: для эфира достаточно адреса и ключа
// публикации. Отпечаток ключа хоста запоминается при первом подключении и
// проверяется дальше — подменённый сервер наш пароль уже не получит.

// Скрипт трогает ровно три вещи: каталог /opt/vrcast-relay, юнит
// vrcast-relay.service и одно правило ufw. Удаление снимает ровно их же.
const DEPLOY_SCRIPT = `
set -eu
PORT="\${VRCAST_PORT_ARG:-8554}"
DIR=/opt/vrcast-relay
KEY_FILE="$DIR/publish.key"
[ "$(id -u)" -eq 0 ] || { echo "VRCAST_ERR нужны права root"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "VRCAST_ERR на сервере нет curl"; exit 1; }
mkdir -p "$DIR"
if [ ! -x "$DIR/mediamtx" ]; then
  URL=$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest 2>/dev/null | grep -oE 'https://[^"]+linux_amd64[.]tar[.]gz' | head -1)
  [ -n "$URL" ] || { echo "VRCAST_ERR не удалось узнать адрес MediaMTX"; exit 1; }
  curl -fsSL "$URL" -o /tmp/vrcast-mtx.tar.gz || { echo "VRCAST_ERR не скачался MediaMTX"; exit 1; }
  tar xzf /tmp/vrcast-mtx.tar.gz -C "$DIR" mediamtx
  rm -f /tmp/vrcast-mtx.tar.gz
fi
[ -f "$KEY_FILE" ] || { head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$KEY_FILE"; chmod 600 "$KEY_FILE"; }
KEY=$(cat "$KEY_FILE")
RTP=$(( PORT + 1 + (PORT + 1) % 2 ))
HLSPORT=$(( PORT + 10 ))
{
  echo "logLevel: error"
  echo "rtspAddress: :$PORT"
  echo "rtpAddress: :$RTP"
  echo "rtcpAddress: :$((RTP + 1))"
  echo "multicastRTPPort: $((RTP + 2))"
  echo "multicastRTCPPort: $((RTP + 3))"
  echo "rtmp: no"
  echo "hls: yes"
  echo "hlsAddress: :$HLSPORT"
  echo "hlsVariant: mpegts"
  echo "hlsSegmentCount: 4"
  echo "hlsSegmentDuration: 1s"
  echo "hlsAlwaysRemux: no"
  echo "webrtc: no"
  echo "srt: no"
  echo "moq: no"
  echo "api: no"
  echo "metrics: no"
  echo "pprof: no"
  echo "playback: no"
  echo "authInternalUsers:"
  echo "- user: any"
  echo "  permissions:"
  echo "  - action: read"
  echo "- user: vrcast"
  echo "  pass: $KEY"
  echo "  permissions:"
  echo "  - action: publish"
  echo "paths:"
  echo "  all_others: {}"
} > "$DIR/mediamtx.yml"
chmod 600 "$DIR/mediamtx.yml"
{
  echo "[Unit]"
  echo "Description=VRCast Bridge media relay"
  echo "After=network.target"
  echo ""
  echo "[Service]"
  echo "ExecStart=$DIR/mediamtx $DIR/mediamtx.yml"
  echo "Restart=always"
  echo "RestartSec=3"
  echo ""
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} > /etc/systemd/system/vrcast-relay.service
systemctl daemon-reload
systemctl enable vrcast-relay >/dev/null 2>&1 || true
systemctl restart vrcast-relay
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw allow "$HLSPORT/tcp" >/dev/null 2>&1 || true
fi
sleep 2
systemctl is-active --quiet vrcast-relay || { echo "VRCAST_ERR служба не запустилась"; exit 1; }
IP=$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo "VRCAST_OK ip=$IP port=$PORT hls=$HLSPORT key=$KEY"
`;

const REMOVE_SCRIPT = `
set -u
PORT="\${VRCAST_PORT_ARG:-8554}"
systemctl stop vrcast-relay 2>/dev/null || true
systemctl disable vrcast-relay 2>/dev/null || true
rm -f /etc/systemd/system/vrcast-relay.service
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/vrcast-relay
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw delete allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw delete allow "$(( PORT + 10 ))/tcp" >/dev/null 2>&1 || true
fi
echo "VRCAST_OK removed"
`;

function sshArgs(server, passwordFile) {
  return ['-batch', '-ssh', '-P', String(server.sshPort || 22), '-l', String(server.user || 'root'),
    '-pwfile', passwordFile,
    ...(server.hostKey ? ['-hostkey', server.hostKey] : []),
    server.host, 'bash -s'];
}

// Первое подключение: узнаём отпечаток ключа хоста, ничего не выполняя.
function sshDiscoverHostKey(server) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PLINK(), ['-ssh', '-batch', '-P', String(server.sshPort || 22), '-l', String(server.user || 'root'),
      server.host, 'exit'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Сервер не отвечает по SSH.')); }, 25000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const collect = chunk => {
      out += chunk;
      const match = out.match(/SHA256:[A-Za-z0-9+/=]+/);
      if (match) { clearTimeout(timer); child.kill(); resolvePromise(match[0]); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.stdin.write('n\n');
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Не удалось запустить SSH: ${error.message}`)); });
    child.on('close', () => { clearTimeout(timer); reject(new Error(out.trim().split(/\r?\n/).pop() || 'Не удалось получить ключ сервера.')); });
  });
}

function sshRun(server, password, script, timeout = 180000) {
  return new Promise((resolvePromise, reject) => {
    // Пароль уходит файлом, а не аргументом: в списке процессов его не видно.
    const passwordFile = join(DATA_DIR, `.ssh-${crypto.randomUUID()}`);
    try { writeFileSync(passwordFile, `${password}\n`, { encoding: 'utf8', mode: 0o600 }); }
    catch (error) { return reject(error); }
    const cleanup = () => { try { rmSync(passwordFile, { force: true }); } catch {} };
    const child = spawn(PLINK(), sshArgs(server, passwordFile), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
    child.on('error', error => { clearTimeout(timer); cleanup(); reject(new Error(`Не удалось запустить SSH: ${error.message}`)); });
    child.on('close', () => {
      clearTimeout(timer); cleanup();
      const failure = /VRCAST_ERR ([^\n]*)/.exec(stdout);
      if (failure) return reject(new Error(failure[1].trim()));
      if (!/VRCAST_OK/.test(stdout)) {
        const reason = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean).pop() || 'сервер не ответил';
        return reject(new Error(/access denied|authentication|password/i.test(reason) ? 'Неверный пароль root.' : reason.slice(0, 300)));
      }
      resolvePromise(stdout);
    });
  });
}

// Проверка, отвечает ли сервер на нужном порту: без неё непонятно, почему
// эфир «подключается» бесконечно — сервер выключен, порт закрыт или адрес не тот.
function probeServer(host, port, timeout = 5000) {
  return new Promise(resolve => {
    const socket = netConnect({ host, port, timeout });
    const finish = ok => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

let remoteReachable = null;
let remoteChannelRejected = false;
function watchRemoteServer() {
  const проверить = async () => {
    const target = remoteRtspTarget();
    if (!target) { remoteReachable = null; return; }
    remoteReachable = await probeServer(target.host, target.port);
  };
  проверить();
  setInterval(проверить, 20000).unref();
}

async function deployServer(body) {
  if (!tools.plink) throw new Error('Компонент SSH не найден.');
  const raw = String(body.host || '').trim().replace(/^ssh:\/\//i, '');
  const [hostName, sshPortRaw] = raw.split(':');
  const password = String(body.password || '');
  if (!hostName) throw new Error('Укажите адрес сервера.');
  // Годится и домен, и IP — проверяем только форму записи.
  if (!/^[a-z0-9.-]+$/i.test(hostName)) throw new Error('Адрес сервера: только буквы, цифры, точки и дефис.');
  if (!password) throw new Error('Укажите пароль root.');
  const existing = savedServers().find(item => item.host === hostName);
  const server = { host: hostName, sshPort: Number(sshPortRaw) || existing?.sshPort || 22,
    user: String(body.user || existing?.user || 'root').trim() || 'root', hostKey: existing?.hostKey || '' };
  if (!server.hostKey) server.hostKey = await sshDiscoverHostKey(server);
  const rtspPort = Number(body.rtspPort) || Number(existing?.rtspPort) || SERVER_RTSP_PORT;
  log(`Свой сервер: разворачиваю на ${hostName}…`);
  const output = await sshRun(server, password, `VRCAST_PORT_ARG=${rtspPort}\n${DEPLOY_SCRIPT}`);
  const result = /VRCAST_OK ip=(\S+) port=(\d+) hls=(\d+) key=(\S+)/.exec(output);
  if (!result) throw new Error('Сервер не вернул данные подключения.');
  const entry = {
    id: existing?.id || crypto.randomUUID(),
    name: String(body.name || existing?.name || '').trim().slice(0, 60) || hostName,
    host: hostName, sshPort: server.sshPort, user: server.user, hostKey: server.hostKey,
    channel: String(body.channel || existing?.channel || 'live').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'live',
    publicIp: result[1], rtspPort: Number(result[2]), hlsPort: Number(result[3]), publishKey: result[4],
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  const servers = savedServers().filter(item => item.id !== entry.id);
  saveConfig({ servers: [...servers, entry].slice(0, 20), activeServerId: entry.id });
  stopRtspPush();
  if (relayProcess && config.outputMode === 'remote') startRtspPush();
  log(`Свой сервер готов: rtspt://${entry.host}:${entry.rtspPort}/live`);
  return entry;
}

async function removeServer(id, password = '') {
  const server = savedServers().find(item => item.id === String(id));
  if (!server) throw new Error('Сервер не найден.');
  let cleaned = false, reason = '';
  if (password && tools.plink) {
    try { await sshRun(server, password, `VRCAST_PORT_ARG=${server.rtspPort || SERVER_RTSP_PORT}\n${REMOVE_SCRIPT}`, 90000); cleaned = true; }
    catch (error) { reason = error.message; }
  }
  const servers = savedServers().filter(item => item.id !== server.id);
  const nextActive = config.activeServerId === server.id ? (servers[0]?.id || '') : config.activeServerId;
  const nextMode = !servers.length && config.outputMode === 'remote' ? 'local' : config.outputMode;
  saveConfig({ servers, activeServerId: nextActive, outputMode: nextMode });
  stopRtspPush();
  if (relayProcess) startRtspPush();
  log(cleaned ? `Сервер ${server.host} очищен и удалён из списка`
    : `Сервер ${server.host} удалён из списка${reason ? ` (на сервере не убрано: ${reason})` : ''}`);
  return { cleaned, reason };
}

function savedServers() {
  return Array.isArray(config.servers) ? config.servers : [];
}

function activeServer() {
  return savedServers().find(item => item.id === config.activeServerId) || null;
}

// «Свой сервер»: тот же мгновенный RTSP, но на машине с белым IP — ссылка
// работает у друзей через интернет и не протухает, в отличие от туннеля.
function remoteRtspTarget() {
  if (config.outputMode !== 'remote') return null;
  const server = activeServer();
  if (!server?.host) return null;
  const port = Number(server.rtspPort) || SERVER_RTSP_PORT;
  const hlsPort = Number(server.hlsPort) || 0;
  const channel = (server.channel || 'live').replace(/[^a-z0-9_-]/gi, '') || 'live';
  return { host: server.host, port, name: server.name, channel, playUrl: `rtspt://${server.host}:${port}/${channel}`,
    // Запасная ссылка: обычный HLS с того же сервера. Нужна там, где RTSP не
    // проходит — Quest, строгие сети, старые плееры. Задержка больше, зато берёт везде.
    // Запасной HLS с MediaMTX не отдаётся напрямую: сервер отвечает перенаправлением
    // с cookie, за которым плееры не идут. Для Quest работает режим «Друзья».
    hlsUrl: '',
    publishUrl: `rtsp://vrcast:${encodeURIComponent(server.publishKey || '')}@${server.host}:${port}/${channel}` };
}

function publicAddress() {
  if (config.outputMode === 'remote') return remoteRtspTarget()?.playUrl || rtspAddress();
  if (config.outputMode === 'tunnel' && tunnelUrl) return `${tunnelUrl}/stream/live.m3u8`;
  // Локально ссылка по умолчанию — RTSP: задержка ~0.5–1с вместо 3–15с у HLS.
  return rtspAddress() || `http://127.0.0.1:${PORT}/stream/live.m3u8`;
}

function unityBaseAddress() {
  if (config.outputMode === 'tunnel' && tunnelUrl && tunnelProvider === 'Cloudflare') return tunnelUrl;
  return `http://127.0.0.1:${PORT}`;
}

function unityQueueSignature(item) {
  const payload = {
    item: item ? { id: item.id, sourceUrl: item.sourceUrl, duration: item.duration } : null,
    quality: config.mediaQuality || '720p', fps: Number(config.mediaFps) === 60 ? 60 : 30,
    volume: Number(config.mediaVolume) || 0, speed: Number(config.playbackSpeed) || 1,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function unityCompatibility() {
  const selectedItem = queue.find(item => item.id === unityBuild.itemId) || queue.find(item => item.id === currentId) || queue[0];
  const signature = unityQueueSignature(selectedItem);
  const queueReady = Boolean(selectedItem) && unityBuild.state === 'ready' && unityBuild.itemId === selectedItem.id
    && unityBuild.signature === signature && existsSync(UNITY_QUEUE_FILE);
  const captureReady = unityCapture.state === 'ready' && existsSync(UNITY_CAPTURE_FILE);
  const unityPublic = config.outputMode === 'tunnel' && tunnelProvider === 'Cloudflare' && Boolean(tunnelUrl);
  const selected = captureReady && activeKind === 'screen' ? 'capture' : 'queue';
  const ready = selected === 'capture' ? captureReady : queueReady;
  const path = selected === 'capture' ? '/media/unity-capture.mp4' : '/media/unity-queue.mp4';
  let reason = selected === 'capture'
    ? (unityCapture.state === 'recording' ? 'Идёт запись. Остановите её, чтобы Unity получил завершённый MP4.' : 'Сначала запишите и завершите клип захвата.')
    : unityBuild.state === 'building' ? unityBuild.message : queue.length ? 'Выберите трек и подготовьте его для Unity.' : 'Добавьте видео в очередь.';
  if (ready) reason = selected === 'capture' ? 'Готовый клип захвата. Это запись, не прямая трансляция.' : `Трек «${selectedItem.title}» готов для Unity.`;
  if (ready && config.outputMode === 'tunnel' && tunnelProvider === 'Pinggy') reason += ' Ссылка локальная: бесплатный Pinggy подменяет запрос Unity страницей предупреждения.';
  return { available: ready, url: ready ? `${unityBaseAddress()}${path}` : '', reason,
    selected, queue: { ...unityBuild, stale: unityBuild.state === 'ready' && unityBuild.signature !== signature,
      available: queueReady, url: queueReady ? `${unityBaseAddress()}/media/unity-queue.mp4` : '', scope: unityPublic ? 'public' : 'local' },
    capture: { ...unityCapture, elapsed: unityCaptureStartedAt ? (Date.now() - unityCaptureStartedAt) / 1000 : 0,
      available: captureReady, url: captureReady ? `${unityBaseAddress()}/media/unity-capture.mp4` : '', scope: unityPublic ? 'public' : 'local' },
    liveUnsupported: true };
}

// ─── Автообновление ───────────────────────────────────────────────────────
// Новая версия берётся из релизов на GitHub. Сам EXE заменить на ходу нельзя
// (он занят), поэтому файл скачивается рядом, а подменяет его при выходе
// маленький сценарий: дожидается закрытия программы, копирует и запускает.
const UPDATE_REPO = 'Kevanko/VRCast-Bridge';
const UPDATE_DIR = join(DATA_DIR, 'update');
const UPDATE_FILE = join(UPDATE_DIR, 'VRCast Bridge.exe');

function versionIsNewer(candidate, current) {
  const parse = value => String(value).replace(/^v/i, '').split('.').map(part => Number(part) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}


// Докачка недостающих компонентов. Идёт в фоне и по одному, чтобы не забивать
// канал: программа тем временем уже открыта и показывает, чего ждёт.
async function downloadTool(name) {
  const source = TOOL_SOURCES[name];
  if (!source || toolDownloads[name]?.state === 'work') return;
  mkdirSync(TOOL_DIR, { recursive: true });
  toolDownloads = { ...toolDownloads, [name]: { state: 'work', percent: 0, label: source.label } };
  try {
    let url = source.url;
    if (source.github) {
      const release = await fetch(`https://api.github.com/repos/${source.github}/releases/latest`,
        { headers: { 'User-Agent': 'VRCast-Bridge' }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
      url = (release.assets || []).find(item => source.asset.test(item.name))?.browser_download_url;
      if (!url) throw new Error('нет подходящего файла в релизе');
    }
    log(`Догружаю компонент: ${source.label}`);
    const response = await fetch(url, { headers: { 'User-Agent': 'VRCast-Bridge' }, signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const temporary = join(TOOL_DIR, `${name}.part`);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      received += chunk.length;
      if (total) toolDownloads = { ...toolDownloads, [name]: { state: 'work', percent: Math.round(received / total * 100),
        label: source.label, doneMb: Math.round(received / 1048576), totalMb: Math.round(total / 1048576) } };
    }
    writeFileSync(temporary, Buffer.concat(chunks));
    if (source.unpack) {
      // В Windows есть встроенный tar, он же распаковывает zip — свои
      // распаковщики и лишние зависимости для этого не нужны.
      const unpackDir = join(TOOL_DIR, `${name}-unpack`);
      rmSync(unpackDir, { recursive: true, force: true });
      mkdirSync(unpackDir, { recursive: true });
      const systemTar = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
      const result = await spawnCollect(existsSync(systemTar) ? systemTar : 'tar', ['-xf', temporary, '-C', unpackDir], 180000);
      if (result.status !== 0) logDetail(`Распаковка ${name}: ${String(result.stderr || '').slice(0, 200)}`);
      if (result.status !== 0) throw new Error('не удалось распаковать архив');
      for (const wanted of source.unpack) {
        const found = findFile(unpackDir, wanted);
        if (!found) throw new Error(`в архиве нет ${wanted}`);
        copyFileSync(found, join(TOOL_DIR, wanted));
      }
      rmSync(unpackDir, { recursive: true, force: true });
      rmSync(temporary, { force: true });
    } else {
      renameSync(temporary, join(TOOL_DIR, name));
    }
    toolDownloads = { ...toolDownloads, [name]: { state: 'done', percent: 100, label: source.label } };
    log(`Компонент готов: ${source.label}`);
    refreshTools();
  } catch (error) {
    toolDownloads = { ...toolDownloads, [name]: { state: 'error', percent: 0, label: source.label, error: String(error.message || error) } };
    log(`Не удалось скачать «${source.label}»: ${error.message}`);
  }
}

function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) { const nested = findFile(full, name); if (nested) return nested; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}

function refreshTools() {
  // ffmpeg зовут по имени из десятка мест — проще добавить свою папку в PATH,
  // чем тащить путь через все вызовы.
  if (existsSync(join(TOOL_DIR, 'ffmpeg.exe')) && !process.env.PATH.includes(TOOL_DIR)) {
    process.env.PATH = `${TOOL_DIR};${process.env.PATH}`;
  }
  tools.ffmpeg = toolAvailable('ffmpeg', ['-version']);
  tools.ytdlp = toolAvailable(ytdlpPath());
  tools.cloudflared = Boolean(CLOUDFLARED()) && toolAvailable(CLOUDFLARED());
  tools.pinggy = Boolean(PINGGY()) && toolAvailable(PINGGY());
  tools.mediamtx = Boolean(MEDIAMTX());
  tools.plink = Boolean(PLINK());
}

// Если утилита лежит рядом с программой (папка tools возле EXE) — берём её
// оттуда и не качаем. Так же переезжает pinggy: публичной ссылки на него нет.
function importLocalTools() {
  const exe = process.env.VRCAST_EXE;
  if (!exe) return;
  const рядом = join(dirname(exe), 'tools');
  if (!existsSync(рядом)) return;
  mkdirSync(TOOL_DIR, { recursive: true });
  for (const name of ['pinggy.exe', 'yt-dlp.exe', 'mediamtx.exe', 'cloudflared.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    const источник = join(рядом, name);
    if (existsSync(источник) && !existsSync(join(TOOL_DIR, name))) {
      try { copyFileSync(источник, join(TOOL_DIR, name)); log(`Взял ${name} из папки рядом с программой`); } catch {}
    }
  }
}

async function ensureTools() {
  importLocalTools();
  refreshTools();
  const нужно = [];
  if (!existsSync(join(TOOL_DIR, 'yt-dlp.exe')) && !existsSync(YTDLP_UPDATED)) нужно.push('yt-dlp.exe');
  if (!tools.mediamtx) нужно.push('mediamtx.exe');
  if (!tools.ffmpeg) нужно.push('ffmpeg.exe');
  if (!tools.cloudflared) нужно.push('cloudflared.exe');
  for (const name of нужно) await downloadTool(name);
  if (нужно.length) {
    refreshTools();
    if (tools.mediamtx && !mediaMtxProcess) startMediaMtx();
    if (tools.ffmpeg && !relayProcess) { try { ensureRelay(streamProfile('queue')); } catch {} }
  }
}

async function checkForUpdate() {
  if (!process.env.VRCAST_EXE) return;
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'VRCast-Bridge', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/i, '');
    updateState = { ...updateState, checked: true, error: '' };
    if (!versionIsNewer(version, status().appVersion)) return;
    const asset = (release.assets || []).find(item => /\.exe$/i.test(item.name));
    if (!asset) return;
    updateState = { ...updateState, available: true, version, notes: String(release.body || '').slice(0, 400) };
    log(`Доступна новая версия ${version} — скачиваю в фоне`);
    await downloadUpdate(asset.browser_download_url, Number(asset.size) || 0);
  } catch (error) {
    updateState = { ...updateState, checked: true, error: error.message };
    logDetail(`Проверка обновления: ${error.message}`);
  }
}

async function downloadUpdate(url, expectedSize) {
  try {
    mkdirSync(UPDATE_DIR, { recursive: true });
    const temporary = `${UPDATE_FILE}.part`;
    const response = await fetch(url, { headers: { 'User-Agent': 'VRCast-Bridge' }, signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`скачивание вернуло ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (expectedSize && bytes.length !== expectedSize) throw new Error('файл скачался не полностью');
    writeFileSync(temporary, bytes);
    rmSync(UPDATE_FILE, { force: true });
    renameSync(temporary, UPDATE_FILE);
    updateState = { ...updateState, ready: true };
    log(`Обновление ${updateState.version} готово к установке`);
  } catch (error) {
    updateState = { ...updateState, error: error.message };
    log(`Не удалось скачать обновление: ${error.message}`);
    logDetail(`Загрузка обновления: ${error.message}`);
  }
}

// Сценарий подмены: ждёт закрытия программы, ставит новый файл и запускает его.
function applyUpdate() {
  const target = process.env.VRCAST_EXE;
  if (!target) throw new Error('Обновление доступно только в собранной программе.');
  if (!updateState.ready || !existsSync(UPDATE_FILE)) throw new Error('Обновление ещё не скачано.');
  const script = join(UPDATE_DIR, 'apply-update.cmd');
  writeFileSync(script, [
    '@echo off',
    'setlocal',
    ':wait',
    'timeout /t 1 /nobreak >nul',
    `tasklist /fi "imagename eq ${basename(target)}" | find /i "${basename(target)}" >nul && goto wait`,
    `copy /y "${UPDATE_FILE}" "${target}" >nul`,
    `start "" "${target}"`,
    `del "%~f0"`,
    '',
  ].join('\r\n'), 'utf8');
  spawn('cmd.exe', ['/c', script], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  log(`Устанавливаю версию ${updateState.version} и перезапускаюсь`);
}

function status() {
  const speed = Number(config.playbackSpeed) || 1;
  const runningElapsed = currentStartedAt ? Math.max(0, (Date.now() - currentStartedAt) / 1000) * speed : 0;
  const elapsed = queuePaused ? pausedPosition : sourcePosition + runningElapsed;
  return {
    appVersion: APP_VERSION, tools, toolDownloads, disk: { freeMb: freeDiskMb, low: freeDiskMb !== null && freeDiskMb < 3000 }, running: Boolean(activeKind), activeKind, currentId, queue, templates: templateSummaries(),
    progress: currentId ? { elapsed: currentDuration ? Math.min(elapsed, currentDuration) : elapsed, duration: currentDuration } : null,
    playback: { paused: queuePaused, busy: playbackBusy, buffering: Boolean(currentId && mediaCacheJobs.has(currentId)), revision: playbackRevision,
      speed, loopMode: config.loopMode || 'once', canSeek: activeKind === 'queue' && Boolean(currentDuration) },
    cache: { ready: cachedReadyCount(), total: queue.length, downloading: [...mediaCacheJobs.keys()],
      root: config.cacheRoot || '', path: mediaCacheDir(), drives: storageInfo.drives, sizeMb: storageInfo.sizeMb },
    audio: { levelDb: audioLevelDb, silent: audioLevelDb < -70 },
    performance: { encoder: encoder.label, hardware: encoder.hardware, continuousQueue: true, outputProfile: relayProfile,
      streamClock: Number(streamTimestamp().toFixed(3)),
      realtimeRatio: Number(hlsHealth.realtimeRatio.toFixed(2)), segmentAge: hlsHealth.segmentAge === null ? null : Number(hlsHealth.segmentAge.toFixed(1)) },
    stream: { ready: hlsHealth.ready, segmentCount: hlsHealth.segmentCount,
      state: !relayProcess ? 'offline' : hlsHealth.ready ? 'ready' : hlsHealth.segmentAge !== null && hlsHealth.segmentAge >= 4 ? 'stalled' : 'starting' },
    compatibility: { live: { player: 'AVPro', supported: true }, unity: unityCompatibility() },
    rtsp: { available: Boolean(mediaMtxProcess && rtspPushProcesses.has('local')), url: rtspAddress(),
      lanUrls: getLanAddresses().map(ip => `rtspt://${ip}:${RTSP_PORT}/live`),
      remote: config.outputMode === 'remote'
        ? { configured: Boolean(remoteRtspTarget()), live: rtspPushProcesses.has('remote'), reachable: remoteReachable,
            channel: remoteRtspTarget()?.channel || '', channelRejected: remoteChannelRejected,
            url: remoteRtspTarget()?.playUrl || '', hlsUrl: remoteRtspTarget()?.hlsUrl || '' }
        : null },
    tunnel: { state: tunnelState, ready: Boolean(tunnelUrl), provider: tunnelProvider, expiresInMinutes: tunnelProvider === 'Pinggy' ? 60 : null, url: tunnelUrl ? `${tunnelUrl}/stream/live.m3u8` : '', error: tunnelError },
    config: { ...config,
      servers: savedServers().map(item => ({ id: item.id, name: item.name, host: item.host,
        rtspPort: item.rtspPort, addedAt: item.addedAt, publishKey: undefined })) },
    playbackUrl: publicAddress(),
    localPlaybackUrl: `http://127.0.0.1:${PORT}/stream/live.m3u8`,
    lanAddresses: getLanAddresses().map(ip => `http://${ip}:${PORT}/stream/live.m3u8`),
    logs: logLines, logFolder: DATA_DIR, update: updateState,
  };
}

// ponytail: грубый счётчик для UI — наличие каталога кеша, без обхода файлов.
// Точную проверку содержимого делает cachedMediaPath в момент воспроизведения.
function cachedReadyCount() {
  let directories;
  try { directories = new Set(readdirSync(mediaCacheDir())); } catch { directories = new Set(); }
  return queue.filter(item => item.local || (directories.has(item.id) && !mediaCacheJobs.has(item.id))).length;
}

function maskSecret(value) {
  if (value.length < 18) return '••••••••';
  return `${value.slice(0, 14)}••••••••${value.slice(-4)}`;
}

function getLanAddresses() {
  return Object.values(networkInterfaces()).flat().filter(Boolean)
    .filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
}

function cleanHls() {
  hlsHealth = { ready: false, realtimeRatio: 0, segmentAge: null, segmentCount: 0, latest: '', updatedAt: 0 };
  rmSync(HLS_DIR, { recursive: true, force: true });
  mkdirSync(HLS_DIR, { recursive: true });
}

function inspectHlsHealth() {
  try {
    const playlist = readFileSync(join(HLS_DIR, 'live.m3u8'), 'utf8');
    const uris = playlist.split(/\r?\n/).filter(line => /^segment-\d+\.ts$/i.test(line.trim()));
    const latest = uris.at(-1) || '';
    if (!latest) throw new Error('нет сегментов');
    const modified = statSync(join(HLS_DIR, latest)).mtimeMs;
    const now = Date.now();
    if (latest !== hlsHealth.latest) {
      let ratio = hlsHealth.realtimeRatio;
      if (hlsHealth.latest && hlsHealth.updatedAt) {
        const previous = hlsHealth.latest.match(/segment-(\d+)\.ts/i);
        const current = latest.match(/segment-(\d+)\.ts/i);
        const advanced = previous && current ? Number(BigInt(current[1]) - BigInt(previous[1])) : 1;
        const wallSeconds = Math.max(0.05, (modified - hlsHealth.updatedAt) / 1000);
        const sample = Math.max(0, Math.min(2, advanced / wallSeconds));
        ratio = ratio ? ratio * 0.72 + sample * 0.28 : sample;
      }
      hlsHealth = { ...hlsHealth, latest, updatedAt: modified, realtimeRatio: ratio, segmentCount: uris.length };
    }
    const segmentAge = Math.max(0, (now - modified) / 1000);
    hlsHealth.segmentAge = segmentAge;
    hlsHealth.segmentCount = uris.length;
    hlsHealth.ready = uris.length >= 3 && segmentAge < 4 && (hlsHealth.realtimeRatio === 0 || hlsHealth.realtimeRatio >= 0.72);
  } catch {
    hlsHealth.ready = false;
    hlsHealth.segmentAge = null;
  }
}

function startHlsHealthMonitor() {
  if (hlsHealthTimer) clearInterval(hlsHealthTimer);
  hlsHealthTimer = setInterval(inspectHlsHealth, 500);
  hlsHealthTimer.unref?.();
}

function validWebUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function attachProcessLogs(child, label) {
  child.stderr?.setEncoding('utf8');
  let pending = '';
  child.stderr?.on('data', chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (/error|failed|invalid|exception|denied|403|429|non-monoton/i.test(line)) log(`${label}: ${line.trim().slice(0, 260)}`);
    }
  });
  child.on('error', error => log(`${label}: ${error.message}`));
}

// Насколько тише играет захватываемое приложение на этом компьютере.
// Ниже 2% не опускаем: там уже нечего усиливать без слышимого шума.
function localAppLevel() {
  if (config.audioMode !== 'process') return 1;
  const level = Number(config.localAppVolume);
  return Number.isFinite(level) ? Math.max(0.02, Math.min(1, level)) : 1;
}

function streamProfile(kind = activeKind) {
  if (kind === 'queue') return { quality: config.mediaQuality || '720p', fps: Number(config.mediaFps) === 60 ? 60 : 30 };
  return { quality: config.quality === '1080p' ? '1080p' : '720p', fps: Number(config.fps) === 60 ? 60 : 30 };
}

// Один сеанс релея = один формат кадра. Любая смена разрешения/fps/SAR/каналов
// внутри живого TS заставляет декодер AVPro переинициализироваться — плеер в
// VRChat ломается до resync. Пока релей жив, все производители обязаны выдавать
// его формат; желаемый профиль применяется только при перезапуске релея.
function sessionProfile(kind = activeKind) {
  return relayProcess && relayProfile ? { ...relayProfile } : streamProfile(kind);
}

function sameProfile(left, right) {
  return Boolean(left && right) && left.quality === right.quality;
}

// Осознанная смена качества: релей перезапускается, но relayStartedAt сохраняется,
// чтобы таймстемпы продолжились и плеер пережил стык без resync.
function restartRelaySession(profile) {
  stopStandby();
  stopRtspPush();
  const relay = relayProcess;
  relayProcess = null;
  relay?.kill('SIGTERM');
  startRelay(profile);
  startStandby(profile);
}

function bitrate(profile) {
  if (profile.quality === '1080p') return profile.fps === 60 ? '8000k' : '5500k';
  return profile.fps === 60 ? '4800k' : '3200k';
}

function videoEncodeArgs(profile = streamProfile()) {
  const rate = bitrate(profile);
  const keyframes = Math.max(8, Math.round(profile.fps * 0.5));
  if (encoder.name === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-rc', 'cbr', '-b:v', rate,
      '-maxrate', rate, '-bufsize', rate, '-g', String(keyframes), '-keyint_min', String(keyframes),
      '-bf', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-g', String(keyframes), '-keyint_min', String(keyframes), '-sc_threshold', '0', '-b:v', rate,
    '-maxrate', rate, '-bufsize', rate];
}

function producerEncodeArgs(profile = streamProfile()) {
  const keyframes = Math.max(8, Math.round(profile.fps * 0.5));
  if (encoder.name === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'll', '-rc', 'constqp', '-qp', '23',
    '-g', String(keyframes), '-keyint_min', String(keyframes), '-bf', '0', '-pix_fmt', 'yuv420p'];
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '25',
    '-g', String(keyframes), '-keyint_min', String(keyframes), '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p'];
}

function encodedOutputArgs(profile = streamProfile()) {
  const common = [...videoEncodeArgs(profile), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-flush_packets', '1'];
  return [...common, '-f', 'hls', '-hls_time', '1', '-hls_list_size', '40', '-hls_delete_threshold', '4',
    '-hls_start_number_source', 'epoch_us', '-hls_flags', 'delete_segments+omit_endlist+program_date_time+independent_segments+temp_file',
    '-hls_segment_filename', join(HLS_DIR, 'segment-%08d.ts'), join(HLS_DIR, 'live.m3u8')];
}

function relayOutputArgs(profile) {
  // Короткая история сегментов (~15с на диске): плеер, отставший сильнее,
  // получает 404 и сам возвращается к живому краю — задержка не может
  // накапливаться бесконечно, как раньше при минутной истории.
  return ['-c', 'copy', '-flush_packets', '1', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '12', '-hls_delete_threshold', '3',
    '-hls_start_number_source', 'epoch_us', '-hls_flags', 'delete_segments+omit_endlist+program_date_time+independent_segments+temp_file',
    '-hls_segment_filename', join(HLS_DIR, 'segment-%08d.ts'), join(HLS_DIR, 'live.m3u8')];
}

function streamTimestamp() {
  return relayStartedAt ? Math.max(0, (Date.now() - relayStartedAt) / 1000 + 0.12) : 0;
}

// Каждый новый производитель обязан начинаться позже, чем успел досчитать
// предыдущий. Иначе на стыке (заглушка → трек, трек → трек) таймстемпы уходят
// назад: ffmpeg ругается Non-monotonic DTS и правит их, а плеер получает рывок.
let producerClock = null;
function nextProducerTimestamp() {
  const base = streamTimestamp();
  const previousNow = producerClock
    ? producerClock.startTs + (Date.now() - producerClock.startWall) / 1000
    : 0;
  // Раньше точка стыка угадывалась по настенным часам с запасом 0,15 с. Уходящий
  // ffmpeg успевает выбросить в эфир до секунды вперёд, и следующий ролик
  // начинался ЗА уже отданными кадрами: плеер отматывался назад, показывал
  // старое и мигал. Теперь берём фактические часы потока — PCR последнего
  // отданного пакета — и продолжаем строго после них.
  return Math.max(base, previousNow, lastRelayPcr + 0.05);
}

// PCR — часы транспортного потока, лежат прямо в заголовке пакета. Читаем их
// на лету у всего, что уходит в релей: 188 байт на пакет, поиск по флагу.
let lastRelayPcr = 0;

function trackRelayClock(chunk) {
  for (let offset = 0; offset + 188 <= chunk.length; offset += 188) {
    if (chunk[offset] !== 0x47) continue;                    // не начало пакета
    if ((chunk[offset + 3] & 0x20) === 0) continue;          // нет поля адаптации
    if (chunk[offset + 4] === 0) continue;                   // поле пустое
    if ((chunk[offset + 5] & 0x10) === 0) continue;          // нет PCR
    const base = chunk[offset + 6] * 33554432 + chunk[offset + 7] * 131072
      + chunk[offset + 8] * 512 + chunk[offset + 9] * 2 + (chunk[offset + 10] >> 7);
    const seconds = base / 90000;
    if (seconds > lastRelayPcr) lastRelayPcr = seconds;
  }
}

function markProducerTimestamp(timestamp) {
  producerClock = { startTs: timestamp, startWall: Date.now() };
  return timestamp;
}

// Продюсер убираем мгновенно: сначала unpipe (релей не получит хвост), потом
// kill. Оборванный TS-пакет демуксер релея отбрасывает сам (+discardcorrupt),
// а мягкое завершение через «q» создавало наложение двух писателей в релей.
function stopProducer(child) {
  if (!child) return;
  // Хвост уходящего процесса не должен попасть в эфир после того, как начал
  // писать следующий: его пакеты со старым временем отматывали плеер назад.
  // Поэтому сначала полностью отцепляем вывод, и только потом гасим процесс.
  child.stdout?.unpipe();
  child.stdout?.removeAllListeners('data');
  child.stdout?.resume();
  try { child.kill('SIGTERM'); } catch {}
}

// Тег #EXT-X-DISCONTINUITY при смене трека не вставляем: таймстемпы у всех
// производителей непрерывны (offset от wall-clock, релей сглаживает стыки
// через dts_delta_threshold), муксер релея один, PID'ы и счётчики не рвутся.
// AVPro в VRChat на live-разрывах ломался и требовал resync — без тега смена
// источника проходит как обычный IDR-кадр, по аналогии с ТВ-вещанием.

function mpegTsOutputArgs(profile = sessionProfile(), timestamp = markProducerTimestamp(nextProducerTimestamp())) {
  return [...producerEncodeArgs(profile), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-output_ts_offset', timestamp.toFixed(3), '-mpegts_flags', 'resend_headers', '-muxdelay', '0', '-muxpreload', '0',
    '-flush_packets', '1', '-f', 'mpegts', 'pipe:1'];
}

function observeAudio(stream) {
  stream.on('data', chunk => {
    for (let offset = 0; offset + 1 < chunk.length; offset += 32) {
      const sample = chunk.readInt16LE(offset) / 32768;
      audioSquares += sample * sample; audioSamples++;
    }
    if (audioSamples >= 6000) {
      audioLevelDb = Math.max(-96, 20 * Math.log10(Math.sqrt(audioSquares / audioSamples) || 0.000015));
      audioSquares = 0; audioSamples = 0;
    }
  });
}

// Хелпер звука завершаем закрытием stdin: только так он успевает вернуть
// приложению прежнюю громкость. Убийство — страховка, если не отреагировал.
function stopAudioHelper(child) {
  if (!child) return;
  try { child.stdin?.end(); } catch {}
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 900);
  child.once('close', () => clearTimeout(timer));
}

function stopWindowWatch() {
  if (windowWatchTimer) clearInterval(windowWatchTimer);
  windowWatchTimer = null; windowCaptureState = null;
}

async function getCapturedWindowState(handle) {
  const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
  if (!existsSync(helper)) return { exists: false, minimized: false, width: 0, height: 0 };
  const result = await spawnCollect(helper, ['--state', '--hwnd', String(handle)], 1500);
  try { return result.status === 0 ? JSON.parse(result.stdout) : { exists: false, minimized: false, width: 0, height: 0 }; }
  catch { return { exists: false, minimized: false, width: 0, height: 0 }; }
}

function watchCapturedWindow(handle, initialState) {
  stopWindowWatch();
  windowCaptureState = initialState;
  let checking = false;
  windowWatchTimer = setInterval(async () => {
    if (checking) return;
    if (activeKind !== 'screen' || config.captureMode !== 'window' || String(config.captureWindowHandle) !== String(handle)) return stopWindowWatch();
    checking = true;
    try {
      const selected = await getCapturedWindowState(handle);
      if (windowCaptureState === null || activeKind !== 'screen' || String(config.captureWindowHandle) !== String(handle)) return;
      const nextState = !selected.exists ? 'missing' : selected.minimized ? 'minimized' : `visible:${selected.width}x${selected.height}`;
      if (windowCaptureState && nextState !== windowCaptureState) {
        log(nextState.startsWith('visible:') ? 'Окно восстановлено или изменило размер — захват продолжен' : 'Окно свернуто — показывается заглушка');
        windowCaptureState = nextState;
        await startScreen();
      } else windowCaptureState = nextState;
    } catch (error) { log(`Наблюдение за окном: ${error.message}`); }
    finally { checking = false; }
  }, 1400);
}

function runScreenProcess(args, audioHelperArgs = null, windowHelperArgs = null) {
  stopping = false;
  activeKind = 'screen';
  log(`Захват экрана · ${encoder.label} · ${config.quality}/${config.fps} FPS`);
  stopStandby();
  const stdio = ['ignore', 'pipe', 'pipe', audioHelperArgs ? 'pipe' : 'ignore', windowHelperArgs ? 'pipe' : 'ignore'];
  const child = spawn('ffmpeg', args, { windowsHide: true, stdio });
  let aux = null;
  let windowCapture = null;
  activeProcess = child;
  pipeToRelay(child);
  if (audioHelperArgs) {
    const helper = join(ROOT, 'tools', 'VRCast.AudioCapture.exe');
    if (!existsSync(helper)) {
      child.kill('SIGTERM'); activeProcess = null; activeKind = null;
      throw new Error('Компонент системного звука не найден.');
    }
    aux = spawn(helper, audioHelperArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    aux.stdin.on('error', () => {});
    activeAuxProcess = aux;
    aux.stdout.on('error', () => {});
    child.stdio[3].on('error', () => {});
    observeAudio(aux.stdout);
    aux.stdout.pipe(child.stdio[3]);
    attachProcessLogs(aux, 'System audio');
    aux.on('close', code => {
      // Эфир без звука хуже короткого перезапуска: если хелпер умер, а видео
      // ещё идёт — перезапускаем захват целиком один раз.
      if (activeAuxProcess !== aux || stopping || activeProcess !== child || !code) return;
      log(`Компонент звука неожиданно остановился (код ${code}) — перезапускаю захват`);
      startScreen().catch(error => log(`Перезапуск захвата: ${error.message}`));
    });
  }
  if (windowHelperArgs) {
    const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
    if (!existsSync(helper)) {
      child.kill('SIGTERM'); aux?.kill('SIGTERM'); activeProcess = null; activeAuxProcess = null; activeKind = null;
      throw new Error('Компонент изолированного захвата окна не найден.');
    }
    windowCapture = spawn(helper, windowHelperArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeWindowProcess = windowCapture;
    windowCapture.stdout.on('error', () => {}); child.stdio[4].on('error', () => {});
    windowCapture.stdout.pipe(child.stdio[4]);
    attachProcessLogs(windowCapture, 'Window capture');
  }
  attachProcessLogs(child, 'FFmpeg');
  child.on('close', code => {
    if (aux && activeAuxProcess === aux) { stopAudioHelper(aux); activeAuxProcess = null; }
    if (windowCapture && activeWindowProcess === windowCapture) { windowCapture.kill('SIGTERM'); activeWindowProcess = null; }
    const wasCurrent = activeProcess === child;
    if (wasCurrent) activeProcess = null;
    if (!stopping && code) log(`Захват остановился с кодом ${code}`);
    if (wasCurrent && relayProcess) startStandby(sessionProfile('screen'));
    if (wasCurrent && !relayProcess) activeKind = null;
  });
}

let screenStarting = false;
async function startScreen() {
  if (screenStarting) throw new Error('Захват уже запускается.');
  screenStarting = true;
  try { await startScreenInner(); }
  finally { screenStarting = false; }
}

async function startScreenInner() {
  const wasLive = Boolean(activeKind);
  stopActive(false, true, true);
  currentId = null; currentStartedAt = null; currentDuration = null;
  const desired = streamProfile('screen');
  if (relayProcess && !sameProfile(relayProfile, desired) && !wasLive) restartRelaySession(desired);
  ensureRelay(desired);
  const profile = sessionProfile('screen');
  const height = profile.quality === '1080p' ? 1080 : 720;
  const width = height === 1080 ? 1920 : 1280;
  const args = ['-hide_banner', '-loglevel', 'warning'];
  let windowHelperArgs = null;
  let captureRect = null;
  let selectedWindow = null;
  let ddagrabOutput = null;
  if (config.captureMode === 'window') {
    if (!/^\d+$/.test(String(config.captureWindowHandle))) throw new Error('Выберите окно для захвата.');
    selectedWindow = (await listWindows()).find(item => item.handle === String(config.captureWindowHandle)) || null;
    windowCaptureState = !selectedWindow ? 'missing' : selectedWindow.minimized ? 'minimized' : `visible:${selectedWindow.width}x${selectedWindow.height}`;
  } else if (config.captureMode === 'monitor') {
    const monitors = await listMonitors();
    captureRect = monitors.find(item => item.id === config.captureMonitorId) || monitors.find(item => item.primary) || monitors[0];
    if (!captureRect) throw new Error('Windows не вернула список мониторов.');
  } else if (config.captureMode === 'region') {
    captureRect = { x: Number(config.regionX) || 0, y: Number(config.regionY) || 0,
      width: Math.max(64, Number(config.regionWidth) || 1280), height: Math.max(64, Number(config.regionHeight) || 720) };
  }
  if (config.captureMode === 'window' && windowCaptureState.startsWith('visible:')) {
    const captureWidth = width;
    const captureHeight = height;
    windowHelperArgs = ['--hwnd', String(config.captureWindowHandle), '--width', String(captureWidth), '--height', String(captureHeight), '--fps', String(profile.fps)];
    args.push('-fflags', 'nobuffer', '-thread_queue_size', '8', '-use_wallclock_as_timestamps', '1', '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${captureWidth}x${captureHeight}`, '-framerate', String(profile.fps), '-i', 'pipe:4');
  } else if (config.captureMode === 'window') {
    args.push('-re', '-f', 'lavfi', '-i', `color=c=0x24202c:s=${width}x${height}:r=${profile.fps}`);
  } else if (config.captureMode === 'monitor' && (ddagrabOutput = await ddagrabIndexFor(captureRect)) !== null) {
    // Это не генератор вроде color или anullsrc, а живой источник со своим
    // темпом, поэтому «-re» здесь не нужен — так же, как и для gdigrab.
    args.push('-thread_queue_size', '16', '-f', 'lavfi', '-i', `ddagrab=output_idx=${ddagrabOutput}:framerate=${profile.fps}`);
  } else {
    args.push('-fflags', 'nobuffer', '-thread_queue_size', '16', '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', String(profile.fps));
    if (captureRect) args.push('-offset_x', String(captureRect.x), '-offset_y', String(captureRect.y), '-video_size', `${captureRect.width}x${captureRect.height}`, '-i', 'desktop');
    else args.push('-i', 'desktop');
  }

  let audioHelperArgs = null;
  if (config.audioMode === 'system' || config.audioMode === 'output' || config.audioMode === 'process') {
    audioHelperArgs = config.audioMode === 'output' && config.audioOutputId ? ['--device-id', config.audioOutputId]
      : config.audioMode === 'process' && /^\d+$/.test(String(config.audioProcessId)) ? ['--pid', String(config.audioProcessId)] : [];
    // «Слышать у себя тише»: понижаем громкость приложения в микшере Windows и
    // ровно на столько же усиливаем звук в эфире. Приглушить полностью нельзя —
    // захват идёт после регулятора, и вместе с колонками замолчал бы и стрим.
    if (config.audioMode === 'process') audioHelperArgs.push('--local-volume', localAppLevel().toFixed(3));
    if (config.audioMode === 'process' && !audioHelperArgs.length) throw new Error('Для звука приложения выберите окно с работающим процессом.');
    // Без use_wallclock_as_timestamps: штамп времени чтения из пайпа + aresample
    // async образуют петлю (всплеск → тишина → всплеск дальше), разгоняющую
    // аудио-таймлайн на сотни секунд. Хелпер сам держит темп 1.0x по Stopwatch,
    // поэтому счётчик семплов ffmpeg — точные и монотонные таймстемпы.
    args.push('-fflags', 'nobuffer', '-thread_queue_size', '16', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3', '-map', '0:v:0', '-map', '1:a:0');
  } else if (config.audioMode === 'device' && config.captureAudioDevice) {
    args.push('-thread_queue_size', '32', '-f', 'dshow', '-i', `audio=${config.captureAudioDevice}`, '-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0');
  }
  // Компенсацию приглушения делает сам хелпер, ещё во float: усиливать здесь
  // значило бы поднимать вместе с сигналом шум квантования 16 бит.
  const captureVolume = Math.max(0, Math.min(6, Number(config.captureVolume) || 0));
  // Кадр от Desktop Duplication лежит в памяти видеокарты — забираем его перед фильтрами.
  const fromGpu = ddagrabOutput === null ? '' : 'hwdownload,format=bgra,';
  args.push('-vf', `${fromGpu}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-af', `aresample=async=1:first_pts=0:min_hard_comp=0.100,volume=${captureVolume.toFixed(2)},alimiter=limit=0.97:level=disabled`,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile));
  runScreenProcess(args, audioHelperArgs, windowHelperArgs);
  startPublicTunnel();
  if (config.captureMode === 'window') watchCapturedWindow(config.captureWindowHandle, windowCaptureState);
}

// Локальный RTSP-сервер (MediaMTX): AVPro в VRChat играет rtspt:// с задержкой
// ~0.5–1с против 3–15с у HLS. Публикация — только с localhost по паролю,
// чтение открыто (этот ПК + локальная сеть). HLS остаётся для туннеля и Quest.
function startMediaMtx() {
  if (!tools.mediamtx || mediaMtxProcess) return;
  const configFile = join(DATA_DIR, 'mediamtx.yml');
  // RTP-порт обязан быть чётным (RTP чётный, RTCP следующий нечётный) —
  // иначе MediaMTX отказывается стартовать и мгновенный канал не поднимается.
  const rtpPort = RTSP_PORT + 1 + ((RTSP_PORT + 1) % 2);
  // Все порты прибиты к своему диапазону: MediaMTX по умолчанию занимает
  // UDP 8000/8001 (RTP/RTCP) и 8892/8893 (Media-over-QUIC). Любая программа на
  // этих портах — и сервер не поднимался бы вовсе, а два экземпляра VRCast
  // конфликтовали бы между собой.
  writeFileSync(configFile, [
    'logLevel: error', `rtspAddress: :${RTSP_PORT}`,
    `rtpAddress: :${rtpPort}`, `rtcpAddress: :${rtpPort + 1}`,
    `multicastRTPPort: ${rtpPort + 2}`, `multicastRTCPPort: ${rtpPort + 3}`,
    'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
    'authInternalUsers:',
    '- user: any', '  permissions:', '  - action: read',
    `- user: vrcast`, `  pass: ${rtspPublishPass}`, `  ips: ['127.0.0.1']`, '  permissions:', '  - action: publish',
    'paths:', '  live: {}', '',
  ].join('\n'), 'utf8');
  const child = spawn(MEDIAMTX(), [configFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  mediaMtxProcess = child;
  attachProcessLogs(child, 'RTSP server');
  child.on('close', code => {
    if (mediaMtxProcess === child) mediaMtxProcess = null;
    if (!stopping && code) { log(`RTSP-сервер остановился (код ${code}), перезапускаю`); setTimeout(startMediaMtx, 2000); }
  });
}

function stopMediaMtx() {
  stopRtspPush();
  mediaMtxProcess?.kill('SIGTERM');
  mediaMtxProcess = null;
}

function rtspTargets() {
  const targets = [{ id: 'local', url: `rtsp://vrcast:${rtspPublishPass}@127.0.0.1:${RTSP_PORT}/live` }];
  const remote = remoteRtspTarget();
  if (remote) targets.push({ id: 'remote', url: remote.publishUrl });
  return targets;
}

function startRtspPush() {
  if (!mediaMtxProcess) return;
  for (const target of rtspTargets()) {
    if (rtspPushProcesses.has(target.id)) continue;
    // Видео копируется как есть (нулевая нагрузка и нулевая потеря качества).
    // Звук переупаковывается энкодером: RTSP-муксеру нужен AAC с global headers,
    // а из MPEG-TS он приходит в ADTS — с «-c copy» публикация просто не стартует
    // («AAC with no global headers»), aac_adtstoasc тут не помогает, потому что
    // заголовок SDP пишется до первого пакета.
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt',
      '-probesize', '500000', '-analyzeduration', '500000', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', '-rw_timeout', '5000000', target.url], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    rtspPushProcesses.set(target.id, child);
    child.stdin.on('error', () => {});
    if (target.id === 'remote') {
      // Ошибки публикации на свой сервер пишем целиком: без этого причина
      // («неверный пароль», «порт закрыт») не видна ни в журнале, ни пользователю.
      child.stderr.setEncoding('utf8');
      let tail = '';
      child.stderr.on('data', chunk => {
        tail += chunk;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop() || '';
        for (const line of lines) {
          const text = line.trim();
          if (text && text !== lastRemotePushError) {
            lastRemotePushError = text;
            // 400 на публикацию означает, что сервер принимает только тот путь,
            // который прописан в его настройке — обычно старый «live».
            if (/400 Bad Request/i.test(text)) {
              if (!remoteChannelRejected) { remoteChannelRejected = true; log('Свой сервер отклонил канал: нажмите «Настроить сервер», чтобы разрешить несколько каналов'); }
            }
            else log(`Свой сервер: ${text.slice(0, 260)}`);
          }
        }
      });
      child.on('error', error => log(`Свой сервер: ${error.message}`));
    } else attachProcessLogs(child, 'RTSP push');
    child.on('close', () => {
      if (rtspPushProcesses.get(target.id) !== child) return;
      rtspPushProcesses.delete(target.id);
      // Обрыв одного получателя не трогает ни HLS, ни остальные каналы:
      // недоступный свой сервер не должен ронять локальную ссылку.
      if (stopping || !relayProcess || rtspPushTimers.has(target.id)) return;
      rtspPushTimers.set(target.id, setTimeout(() => { rtspPushTimers.delete(target.id); startRtspPush(); }, 700));
    });
  }
}

function stopRtspPush() {
  for (const timer of rtspPushTimers.values()) clearTimeout(timer);
  rtspPushTimers.clear();
  for (const child of rtspPushProcesses.values()) child.kill('SIGTERM');
  rtspPushProcesses.clear();
}

// Единая точка подключения продюсера: HLS-релей через pipe (с backpressure),
// RTSP-пушер — вторым потребителем тех же чанков (без него поток не тормозится).
function pipeToRelay(child) {
  child.stdout.on('error', () => {});
  relayProcess.stdin.on('error', () => {});
  child.stdout.pipe(relayProcess.stdin, { end: false });
  child.stdout.on('data', chunk => {
    trackRelayClock(chunk);
    for (const pusher of rtspPushProcesses.values()) {
      const sink = pusher.stdin;
      // Медленный получатель (свой сервер на слабом канале) не должен копить
      // память и тормозить остальных — его чанки просто отбрасываются.
      if (sink?.writable && sink.writableLength < 4 * 1024 * 1024) sink.write(chunk);
    }
  });
}

function startRelay(profile) {
  relayProfile = { ...profile };
  // Без низкого dts_delta_threshold: один мусорный PTS из оборванного пакета
  // «компенсировался» глобальным сдвигом в минус, таймстемпы заворачивались
  // через 2^33 и AVPro ломался до resync. Непрерывность обеспечивают
  // output_ts_offset продюсеров, а не коррекции демуксера.
  const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt',
    '-probesize', '1000000', '-analyzeduration', '1000000', '-thread_queue_size', '1024', '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0', ...relayOutputArgs(profile)];
  relayProcess = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  relayProcess.stdin.on('error', error => {
    if (!stopping) log(`Канал HLS: ${error.message}`);
  });
  attachProcessLogs(relayProcess, 'HLS relay');
  const relay = relayProcess;
  relay.on('close', code => {
    if (relayProcess === relay) { relayProcess = null; relayStartedAt = 0; relayProfile = null; }
    if (!stopping) log(`Релей эфира остановился с кодом ${code ?? 'нет'}`);
  });
  // RTSP-пушер перезапускается вместе с сессией: у него свой muxer, поэтому
  // смена формата сессии не оставляет его со старыми параметрами потока.
  stopRtspPush();
  startMediaMtx();
  startRtspPush();
}

function stopStandby() {
  pauseFrameProcess?.kill('SIGTERM');
  pauseFrameProcess = null;
  if (!standbyProcess) return;
  stopProducer(standbyProcess);
  standbyProcess = null;
}

function latestHlsSegment(delaySeconds = 0) {
  try {
    const segments = readdirSync(HLS_DIR).filter(name => /^segment-\d+\.ts$/i.test(name))
      .map(name => ({ path: join(HLS_DIR, name), modified: statSync(join(HLS_DIR, name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    return segments[Math.min(segments.length - 1, Math.max(0, Math.round(delaySeconds)))]?.path || null;
  } catch { return null; }
}

// Стоп-кадр готовится ЗАРАНЕЕ, пока трек ещё играет: раньше сначала гасился
// продюсер, поднималась заставка «ожидание медиа», и только потом отдельным
// запуском ffmpeg доставался кадр — из-за этого пауза срабатывала с задержкой
// и с чужой картинкой посередине.
function preparePausedFrame(media, position, preferredBroadcastFrame = null, preferOriginal = false) {
  return new Promise(resolvePromise => {
    const broadcastFrameSource = preferOriginal ? null : (preferredBroadcastFrame && existsSync(preferredBroadcastFrame) ? preferredBroadcastFrame : latestHlsSegment());
    const source = broadcastFrameSource || media?.combinedUrl || media?.videoUrl;
    if (!source || (media && !media.hasVideo)) return resolvePromise(null);
    const profile = sessionProfile('queue');
    const height = profile.quality === '1080p' ? 1080 : 720;
    const width = height === 1080 ? 1920 : 1280;
    const frameFile = join(DATA_DIR, 'pause-frame.png');
    rmSync(frameFile, { force: true });
    const seekArgs = broadcastFrameSource ? [] : ['-ss', Math.max(0, Number(position) || 0).toFixed(3)];
    const frameFilter = `${broadcastFrameSource ? 'reverse,' : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const extractor = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...seekArgs, '-i', source,
      '-frames:v', '1', '-vf', frameFilter,
      '-c:v', 'png', '-threads', '1', '-update', '1', '-y', frameFile],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    pauseFrameProcess = extractor;
    attachProcessLogs(extractor, 'Pause frame');
    const timer = setTimeout(() => { try { extractor.kill('SIGTERM'); } catch {} }, 4000);
    extractor.on('close', code => {
      clearTimeout(timer);
      if (pauseFrameProcess === extractor) pauseFrameProcess = null;
      resolvePromise(code === 0 && existsSync(frameFile) ? frameFile : null);
    });
  });
}

function startPausedFrameProducer(frameFile) {
  const profile = sessionProfile('queue');
  stopStandby();
  const args = ['-hide_banner', '-loglevel', 'warning', '-re', '-loop', '1', '-framerate', String(profile.fps), '-i', frameFile,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile)];
  const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  standbyProcess = child;
  pipeToRelay(child);
  attachProcessLogs(child, 'Paused frame');
  child.on('close', () => { if (standbyProcess === child) standbyProcess = null; });
}

// Пауза целиком: кадр готовим при живом продюсере, затем меняем источник одним
// движением. Зритель видит замирание там же, где обычная задержка канала.
async function pauseWithFrozenFrame(generation, frameSource, preferOriginal) {
  const item = queue[queueIndex];
  let media = null;
  // Кадр берём из уже готового куска эфира. Разбирать ссылку через yt-dlp
  // здесь нельзя: это секунды, и пауза из-за них срабатывала с опозданием.
  const готовыйКадр = frameSource || latestHlsSegment();
  if (!готовыйКадр && item) {
    try { media = await resolveItem(item); }
    catch (error) { log(`Стоп-кадр: ${error.message}`); }
    if (stopping || generation !== playGeneration || !queuePaused) return;
  }
  const frameFile = await preparePausedFrame(media, pausedPosition, frameSource, preferOriginal);
  if (stopping || generation !== playGeneration || !queuePaused) return;
  const producer = activeProcess;
  activeProcess = null;
  currentStartedAt = null;
  stopProducer(producer);
  if (frameFile) startPausedFrameProducer(frameFile);
  else startStandby(sessionProfile('queue'));
}

function startStandby(profile = sessionProfile()) {
  if (!relayProcess || standbyProcess || activeProcess) return;
  const height = profile.quality === '1080p' ? 1080 : 720;
  const width = height === 1080 ? 1920 : 1280;
  // «-re» обязателен на КАЖДОМ lavfi-входе: непейсируемый anullsrc генерирует
  // тишину со скоростью CPU, обгоняет видео на max_interleave_delta, и муксер
  // сливает аудио-таймлайн на сотни секунд вперёд — плеер ломается до resync.
  // Заставка «ожидание медиа» вместо пустого экрана: эфир не пропадает никогда,
  // пока открыта программа, поэтому зрителю не нужно переподключаться после
  // остановки или между треками — он просто видит экран ожидания.
  const hasImage = existsSync(STANDBY_IMAGE);
  const videoInput = hasImage
    ? ['-re', '-loop', '1', '-framerate', String(profile.fps), '-i', STANDBY_IMAGE]
    : ['-re', '-f', 'lavfi', '-i', `color=c=0x17121f:s=${width}x${height}:r=${profile.fps}`];
  const args = ['-hide_banner', '-loglevel', 'warning', ...videoInput,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile)];
  const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  standbyProcess = child;
  pipeToRelay(child);
  attachProcessLogs(child, 'Standby');
  child.on('close', () => { if (standbyProcess === child) standbyProcess = null; });
}

function ensureRelay(profile = streamProfile()) {
  if (!relayProcess) {
    cleanHls();
    producerClock = null;
    lastRelayPcr = 0;
    relayStartedAt = Date.now();
    try { startRelay(profile); }
    catch (error) { relayStartedAt = 0; relayProfile = null; throw error; }
  }
  startStandby(profile);
}

function startQueue(initialIndex = 0) {
  if (!queue.length) throw new Error('Очередь пуста. Добавьте ссылку или файл.');
  const wasLive = Boolean(activeKind);
  stopActive(false, true, true);
  stopping = false;
  activeKind = 'queue';
  currentId = null;
  currentStartedAt = null;
  queueIndex = -1;
  sourcePosition = 0;
  pausedPosition = 0;
  queuePaused = false;
  manualTransition = null;
  playbackBusy = true;
  playbackRevision++;
  playGeneration++;
  try {
    const desired = streamProfile('queue');
    // Смена источника посреди эфира перенимает формат сессии (ноль разрывов);
    // профиль применяется только при старте из простоя.
    if (relayProcess && !sameProfile(relayProfile, desired) && !wasLive) restartRelaySession(desired);
    ensureRelay(desired);
    startPublicTunnel();
  } catch (error) { activeKind = null; playbackBusy = false; throw error; }
  const generation = playGeneration;
  setTimeout(() => startQueueItem(Math.max(0, Math.min(queue.length - 1, initialIndex)), 0, generation), 180);
}

function spawnJson(command, args, timeout = 60000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Источник отвечает слишком долго.')); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((stderr || 'Не удалось открыть источник').trim().split(/\r?\n/).pop()));
      try { resolvePromise(JSON.parse(stdout)); }
      catch { reject(new Error('Источник вернул неправильные данные.')); }
    });
  });
}

async function resolveRemoteMedia(entryUrl) {
  const preferred = [
    'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]',
    'bestvideo[vcodec^=avc1][height<=1080]+bestaudio',
    'bestvideo[vcodec^=vp9][height<=1080]+bestaudio',
    'bestvideo[height<=1080]+bestaudio',
    'best[vcodec^=avc1][height<=1080]',
    'best[height<=1080]',
    'best',
  ].join('/');
  const data = await spawnJson(ytdlpPath(), ['--no-warnings', '--no-playlist', '--dump-single-json',
    '-f', preferred, entryUrl], 70000);
  const formats = Array.isArray(data.requested_formats) ? data.requested_formats : [];
  const video = formats.find(format => format.vcodec && format.vcodec !== 'none');
  const audio = formats.find(format => format.acodec && format.acodec !== 'none');
  // Часть площадок отдаёт видео только со своими заголовками (Referer и
  // User-Agent). Без них прямое проигрывание упирается в 403.
  const headers = video?.http_headers || audio?.http_headers || data.http_headers || null;
  return {
    headers, title: data.title || entryUrl, duration: data.duration || null,
    videoUrl: video?.url || (data.vcodec && data.vcodec !== 'none' ? data.url : null),
    audioUrl: audio?.url || (data.acodec && data.acodec !== 'none' ? data.url : null),
    combinedUrl: formats.length ? null : data.url,
    hasVideo: Boolean(video || (data.vcodec && data.vcodec !== 'none')),
    hasAudio: Boolean(audio || (data.acodec && data.acodec !== 'none')),
  };
}

function resolveItem(item) {
  if (item.direct) {
    return Promise.resolve({ title: item.title, duration: item.duration, combinedUrl: item.sourceUrl,
      videoUrl: null, audioUrl: null, hasVideo: true, hasAudio: true, live: Boolean(item.live) });
  }
  if (item.local) {
    return Promise.resolve({ title: item.title, duration: item.duration, combinedUrl: item.sourceUrl, videoUrl: null, audioUrl: null, hasVideo: item.hasVideo, hasAudio: item.hasAudio });
  }
  const cached = resolvedMedia.get(item.id);
  if (!cached || Date.now() - cached.createdAt > 12 * 60 * 1000) {
    const promise = resolveRemoteMedia(item.sourceUrl).catch(error => { resolvedMedia.delete(item.id); throw error; });
    resolvedMedia.set(item.id, { createdAt: Date.now(), promise });
  }
  return resolvedMedia.get(item.id).promise;
}

// Треки, которые не открылись. Без этой памяти очередь долбит один и тот же
// недоступный ролик по кругу: прогрев, прямой поток, снова прогрев — журнал
// забивается, а канал дёргается. Удалённые ролики отсекаются навсегда,
// временные сбои — на минуту.
const mediaFailures = new Map();
const PERMANENT_FAILURE = /video unavailable|private video|removed by the uploader|account associated|недоступ|has been terminated|copyright/i;

function rememberMediaFailure(itemId, reason) {
  const text = String(reason || '').slice(0, 400);
  const permanent = PERMANENT_FAILURE.test(text);
  mediaFailures.set(itemId, { permanent, until: Date.now() + (permanent ? 0 : 60000), reason: text });
  const item = queue.find(entry => entry.id === itemId);
  if (permanent && item && !item.unavailable) {
    item.unavailable = true;
    saveQueue();
    log(`Трек недоступен и пропускается: ${item.title}`);
  }
  logDetail(`Ошибка трека ${item?.title || itemId}: ${text}`);
}

function mediaFailure(itemId) {
  const failure = mediaFailures.get(itemId);
  if (!failure) return null;
  if (!failure.permanent && Date.now() > failure.until) { mediaFailures.delete(itemId); return null; }
  return failure;
}

function clearMediaFailure(itemId) {
  mediaFailures.delete(itemId);
  const item = queue.find(entry => entry.id === itemId);
  if (item?.unavailable) { item.unavailable = false; saveQueue(); }
}

function cachedMediaPath(itemId) {
  const directory = join(mediaCacheDir(), String(itemId));
  try {
    return readdirSync(directory).map(name => join(directory, name))
      .find(file => !/\.(part|ytdl|temp)$/i.test(file) && statSync(file).isFile() && statSync(file).size > 1024) || '';
  } catch { return ''; }
}

async function cachedMedia(item, filePath) {
  const info = await mediaInfoAsync(filePath);
  return { title: item.title, duration: info.duration || item.duration, combinedUrl: filePath, videoUrl: null, audioUrl: null,
    hasVideo: info.hasVideo, hasAudio: info.hasAudio, cached: true, unityCompatible: info.unityCompatible };
}

// На тесном диске кеш ужимается: иначе он доедает остаток места, а без места
// ffmpeg не может дописывать сегменты и эфир встаёт рывками.
function mediaCacheLimit() {
  return freeDiskMb !== null && freeDiskMb < 4000 ? 1024 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
}

// Регулярная уборка: кеш по лимиту, папки удалённых треков, ненужные превью
// и временные файлы Unity. Без неё мусор копился до конца свободного места.
function cleanupStorage() {
  trimMediaCache();
  storageInfo = { sizeMb: mediaCacheSizeMb(), drives: listDrives() };
  const alive = new Set(queue.map(item => item.id));
  try {
    for (const name of readdirSync(mediaCacheDir())) {
      if (alive.has(name) || mediaCacheJobs.has(name)) continue;
      rmSync(join(mediaCacheDir(), name), { recursive: true, force: true });
    }
  } catch {}
  try {
    for (const name of readdirSync(THUMB_DIR)) {
      if (!alive.has(name.replace(/\.[a-z0-9]+$/i, ''))) rmSync(join(THUMB_DIR, name), { force: true });
    }
  } catch {}
  try {
    for (const name of readdirSync(UNITY_DIR)) {
      if (name.endsWith('.tmp.mp4')) rmSync(join(UNITY_DIR, name), { force: true });
    }
  } catch {}
}

let storageInfo = { sizeMb: 0, drives: [] };

function mediaCacheSizeMb() {
  try {
    let total = 0;
    for (const name of readdirSync(mediaCacheDir())) {
      const directory = join(mediaCacheDir(), name);
      try { for (const file of readdirSync(directory)) total += statSync(join(directory, file)).size; } catch {}
    }
    return Math.round(total / 1048576);
  } catch { return 0; }
}

function trimMediaCache(maxBytes = mediaCacheLimit()) {
  try {
    const entries = readdirSync(mediaCacheDir()).flatMap(name => {
      const directory = join(mediaCacheDir(), name);
      try {
        const files = readdirSync(directory).map(file => join(directory, file)).filter(file => statSync(file).isFile());
        return [{ directory, size: files.reduce((sum, file) => sum + statSync(file).size, 0), modified: statSync(directory).mtimeMs }];
      } catch { return []; }
    }).sort((left, right) => left.modified - right.modified);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      if (mediaCacheJobs.has(basename(entry.directory))) continue;
      rmSync(entry.directory, { recursive: true, force: true }); total -= entry.size;
    }
  } catch {}
}

function downloadRemoteMedia(item) {
  const existing = cachedMediaPath(item.id);
  if (existing) {
    return cachedMedia(item, existing).catch(() => {
      try { rmSync(join(mediaCacheDir(), item.id), { recursive: true, force: true }); } catch {}
      return startCacheDownload(item);
    });
  }
  return startCacheDownload(item);
}

function startCacheDownload(item) {
  if (mediaCacheJobs.has(item.id)) return mediaCacheJobs.get(item.id);
  const directory = join(mediaCacheDir(), item.id);
  mkdirSync(directory, { recursive: true });
  let promise;
  promise = new Promise((resolvePromise, reject) => {
    log(`Буферизация трека: ${item.title}`);
    const args = ['--no-warnings', '--no-playlist', '--newline', '--retries', '8', '--fragment-retries', '8',
      '--concurrent-fragments', '4', '--socket-timeout', '20', '-f',
      'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/best[height<=1080]',
      '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', join(directory, 'source.%(ext)s'), item.sourceUrl];
    const child = spawn(ytdlpPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    mediaCacheProcesses.set(child, item.id);
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => {
      mediaCacheProcesses.delete(child);
      if (code !== 0) return reject(new Error((stderr || `yt-dlp завершился с кодом ${code}`).trim().split(/\r?\n/).pop()));
      const file = cachedMediaPath(item.id);
      if (!file) return reject(new Error('Загруженный файл не найден.'));
      cachedMedia(item, file).then(resolvePromise, reject);
    });
  }).then(media => {
    log(`Трек буферизирован: ${item.title}`); trimMediaCache(); return media;
  }).finally(() => { if (mediaCacheJobs.get(item.id) === promise) mediaCacheJobs.delete(item.id); });
  mediaCacheJobs.set(item.id, promise);
  return promise;
}

// Долгие ролики не буферизуем: фильм на два часа — это гигабайты, и эфир
// стоял в ожидании, пока yt-dlp тянет файл целиком. Такие играем прямо из сети.
const CACHE_MAX_SECONDS = 25 * 60;

function stableQueueMedia(item) {
  if (item.local) return resolveItem(item);
  // Живой поток скачать нельзя: он бесконечный. Играем напрямую.
  if (item.live) return resolveItem(item);
  if (!cachedMediaPath(item.id) && Number(item.duration) > CACHE_MAX_SECONDS) return resolveItem(item);
  return downloadRemoteMedia(item).then(media => { clearMediaFailure(item.id); return media; }).catch(error => {
    // Прямой поток YouTube живёт минуты и часто отдаёт 403 — на него
    // переключаемся молча, но причину пишем в файл для разбора.
    logDetail(`Буфер не собрался для «${item.title}»: ${error.message}`);
    if (/403|forbidden|unavailable|private/i.test(String(error.message))) rememberMediaFailure(item.id, error.message);
    return resolveItem(item);
  });
}

function stopMediaCacheDownloads() {
  for (const [child, itemId] of mediaCacheProcesses) {
    mediaCacheJobs.delete(itemId);
    try { child.kill('SIGTERM'); } catch {}
  }
  mediaCacheProcesses.clear();
}

function unityVideoEncodeArgs(profile) {
  const keyframes = Math.max(30, profile.fps * 2);
  if (encoder.name === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'baseline', '-level:v', '4.1',
    '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-g', String(keyframes), '-bf', '0', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'baseline', '-level:v', '4.1',
    '-g', String(keyframes), '-bf', '0', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
}

function runUnityFfmpeg(args, label, generation = unityBuildGeneration) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    unityBuildProcess = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => {
      if (unityBuildProcess === child) unityBuildProcess = null;
      if (generation !== unityBuildGeneration) return reject(new Error('Подготовка отменена.'));
      if (code !== 0) return reject(new Error((stderr || `${label}: FFmpeg завершился с кодом ${code}`).trim().split(/\r?\n/).pop()));
      resolvePromise();
    });
  });
}

function unityNormalizeArgs(media, output, profile) {
  const height = profile.quality === '1080p' ? 1080 : 720;
  const width = height === 1080 ? 1920 : 1280;
  const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts'];
  let inputIndex = 0, videoIndex = null, audioIndex = null;
  if (media.videoUrl && media.audioUrl && media.videoUrl !== media.audioUrl) {
    args.push('-i', media.videoUrl); videoIndex = inputIndex++;
    args.push('-i', media.audioUrl); audioIndex = inputIndex++;
  } else {
    args.push('-i', media.combinedUrl || media.videoUrl || media.audioUrl);
    if (media.hasVideo) videoIndex = inputIndex;
    if (media.hasAudio) audioIndex = inputIndex;
    inputIndex++;
  }
  if (videoIndex === null) { args.push('-f', 'lavfi', '-i', `color=c=0x080611:s=${width}x${height}:r=${profile.fps}`); videoIndex = inputIndex++; }
  if (audioIndex === null) { args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'); audioIndex = inputIndex++; }
  const speed = Math.max(0.5, Math.min(2, Number(config.playbackSpeed) || 1));
  const volume = Math.max(0, Math.min(2, Number(config.mediaVolume) || 0));
  args.push('-map', `${videoIndex}:v:0`, '-map', `${audioIndex}:a:0`, '-shortest',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS/${speed}`,
    '-af', `atempo=${speed},volume=${volume.toFixed(2)},aresample=async=1:first_pts=0`, '-r', String(profile.fps), '-fps_mode', 'cfr',
    ...unityVideoEncodeArgs(profile), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', output);
  return args;
}

function unityFastRemuxArgs(media, output) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-i', media.combinedUrl, '-map', '0:v:0'];
  if (media.hasAudio) args.push('-map', '0:a:0');
  args.push('-c', 'copy', '-movflags', '+faststart', '-y', output);
  return args;
}

async function buildUnityQueue(itemId = '') {
  if (!queue.length) throw new Error('Добавьте хотя бы один трек в очередь.');
  if (unityBuildProcess || unityBuild.state === 'building') throw new Error('Очередь уже подготавливается.');
  if (activeKind) throw new Error('Остановите эфир перед подготовкой Unity-файла. Так кодирование не вызовет зависания звука.');
  const selectedItem = queue.find(item => item.id === String(itemId)) || queue.find(item => item.id === currentId) || queue[0];
  const generation = ++unityBuildGeneration;
  const signature = unityQueueSignature(selectedItem);
  const snapshot = [{ ...selectedItem }];
  const profile = streamProfile('queue');
  const workDir = join(UNITY_ITEMS_DIR, `${signature}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  unityBuild = { state: 'building', progress: 0, message: `Загружаю: ${selectedItem.title}`, signature,
    itemId: selectedItem.id, title: selectedItem.title, updatedAt: Date.now() };
  log(`Unity: подготовка одного трека — ${selectedItem.title}`);
  try {
    const files = [];
    for (let index = 0; index < snapshot.length; index++) {
      if (generation !== unityBuildGeneration) throw new Error('Подготовка отменена.');
      const item = snapshot[index];
      unityBuild = { ...unityBuild, progress: index / snapshot.length, message: `Кодирование ${index + 1}/${snapshot.length}: ${item.title}`, updatedAt: Date.now() };
      const media = await stableQueueMedia(item);
      const output = join(workDir, `${String(index + 1).padStart(4, '0')}.mp4`);
      const canRemux = media.unityCompatible && (Number(config.playbackSpeed) || 1) === 1 && (Number(config.mediaVolume) || 0) === 1;
      await runUnityFfmpeg(canRemux ? unityFastRemuxArgs(media, output) : unityNormalizeArgs(media, output, profile), `Элемент ${index + 1}`, generation);
      files.push(output);
      unityBuild = { ...unityBuild, progress: (index + 0.85) / snapshot.length, updatedAt: Date.now() };
    }
    const temporary = join(UNITY_DIR, `queue-${signature}.tmp.mp4`);
    unityBuild = { ...unityBuild, progress: 0.97, message: 'Создаю индекс MP4…', updatedAt: Date.now() };
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    renameSync(files[0], temporary);
    if (existsSync(UNITY_QUEUE_FILE)) rmSync(UNITY_QUEUE_FILE, { force: true });
    renameSync(temporary, UNITY_QUEUE_FILE);
    unityBuild = { state: 'ready', progress: 1, message: `Готово: ${selectedItem.title}`, signature,
      itemId: selectedItem.id, title: selectedItem.title, updatedAt: Date.now() };
    saveUnityBuildState();
    log(`Unity: трек подготовлен — ${selectedItem.title}`);
  } catch (error) {
    if (generation === unityBuildGeneration) unityBuild = { state: 'error', progress: 0, message: error.message, signature,
      itemId: selectedItem.id, title: selectedItem.title, updatedAt: Date.now() };
    log(`Unity: ${error.message}`);
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function stopUnityBuild() {
  unityBuildGeneration++;
  unityBuildProcess?.kill('SIGTERM');
  unityBuildProcess = null;
  if (unityBuild.state === 'building') unityBuild = { ...unityBuild, state: 'idle', progress: 0, message: 'Подготовка отменена', updatedAt: Date.now() };
}

function startUnityCaptureRecording() {
  if (activeKind !== 'screen' || !relayProcess) throw new Error('Сначала запустите захват экрана в эфир.');
  if (unityCaptureProcess) throw new Error('Запись уже идёт.');
  const profile = streamProfile('screen');
  const temporary = join(UNITY_DIR, 'capture.tmp.mp4');
  rmSync(temporary, { force: true });
  const args = ['-hide_banner', '-loglevel', 'warning', '-live_start_index', '-2', '-i', `http://127.0.0.1:${PORT}/stream/live.m3u8`,
    '-map', '0:v:0', '-map', '0:a:0', '-vf', 'setpts=PTS-STARTPTS', '-af', 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',
    ...unityVideoEncodeArgs(profile), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', temporary];
  const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  unityCaptureProcess = child; unityCaptureStartedAt = Date.now();
  unityCapture = { state: 'recording', message: 'Идёт запись захвата…', updatedAt: Date.now() };
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.on('close', code => {
    if (unityCaptureProcess === child) unityCaptureProcess = null;
    unityCaptureStartedAt = 0;
    if (code === 0 && existsSync(temporary) && statSync(temporary).size > 1024) {
      if (existsSync(UNITY_CAPTURE_FILE)) rmSync(UNITY_CAPTURE_FILE, { force: true });
      renameSync(temporary, UNITY_CAPTURE_FILE);
      unityCapture = { state: 'ready', message: 'Клип готов для Unity', updatedAt: Date.now() };
      log('Unity: клип захвата готов');
    } else {
      unityCapture = { state: 'error', message: (stderr || 'Не удалось завершить запись').trim().split(/\r?\n/).pop(), updatedAt: Date.now() };
      rmSync(temporary, { force: true });
    }
  });
  log('Unity: началась запись клипа захвата');
}

function stopUnityCaptureRecording() {
  if (!unityCaptureProcess) throw new Error('Запись сейчас не идёт.');
  unityCapture = { ...unityCapture, state: 'finalizing', message: 'Завершаю MP4…', updatedAt: Date.now() };
  unityCaptureProcess.stdin.write('q\n');
}

function preloadNext(index) {
  if (!queue.length) return;
  const next = queue[(index + 1) % queue.length];
  stableQueueMedia(next).catch(error => log(`Предзагрузка «${next.title}»: ${error.message}`));
  prefetchQueue(index);
}

// Переключение на трек, который ещё не скачан, стоит секунд: yt-dlp сначала
// разбирает ссылку, потом качает. Поэтому фоном прогреваем всю очередь по
// одному треку за раз — начиная с ближайших к текущему. Тогда любой переход
// (клик по треку, «следующий», повтор) идёт из локального файла и мгновенно.
let prefetching = false;
async function prefetchQueue(fromIndex = queueIndex) {
  if (prefetching || !queue.length) return;
  prefetching = true;
  try {
    const order = queue.map((item, index) => ({ item, index }))
      .sort((left, right) => Math.abs(left.index - fromIndex) - Math.abs(right.index - fromIndex));
    for (const { item } of order) {
      if (stopping) return;
      if (item.local || item.id === currentId || cachedMediaPath(item.id)) continue;
      if (!queue.some(entry => entry.id === item.id)) continue;
      if (mediaFailure(item.id)) continue;
      try { await stableQueueMedia(item); }
      catch (error) {
        rememberMediaFailure(item.id, error.message);
        log(`Прогрев «${item.title}»: ${error.message}`);
      }
    }
  } finally { prefetching = false; }
}

// Декодирование отдаём видеокарте: при неудаче ffmpeg сам возвращается к
// программному пути, поэтому флаг безопасен для любых источников.
const HWACCEL = ['-hwaccel', 'auto'];

function queueProducerArgs(media, timestampOffset, seekPosition = 0) {
  const profile = sessionProfile('queue');
  const height = profile.quality === '1080p' ? 1080 : 720;
  const width = height === 1080 ? 1920 : 1280;
  const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts'];
  let inputIndex = 0, videoIndex = null, audioIndex = null;

  // Заголовки должны стоять перед каждым сетевым входом
  const headerArgs = [];
  if (media.headers && typeof media.headers === 'object') {
    const lines = Object.entries(media.headers)
      .filter(([name]) => /^(referer|user-agent|cookie|origin)$/i.test(name))
      .map(([name, value]) => `${name}: ${value}`);
    if (lines.length) headerArgs.push('-headers', `${lines.join('\r\n')}\r\n`);
  }
  if (media.videoUrl && media.audioUrl && media.videoUrl !== media.audioUrl) {
    if (seekPosition > 0) args.push('-ss', seekPosition.toFixed(3));
    args.push(...headerArgs, '-thread_queue_size', '1024', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', ...HWACCEL, '-re', '-i', media.videoUrl);
    videoIndex = inputIndex++;
    if (seekPosition > 0) args.push('-ss', seekPosition.toFixed(3));
    args.push(...headerArgs, '-thread_queue_size', '1024', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-re', '-i', media.audioUrl);
    audioIndex = inputIndex++;
  } else {
    const source = media.combinedUrl || media.videoUrl || media.audioUrl;
    if (seekPosition > 0) args.push('-ss', seekPosition.toFixed(3));
    args.push('-thread_queue_size', '1024');
    if (!media.cached && /^https?:/i.test(source)) args.push(...headerArgs, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3');
    // Плейлист .m3u8 бывает и живым эфиром, и обычным видео — снаружи не
    // различить. Поэтому начинаем с последнего куска (для эфира это край, для
    // видео просто игнорируется) и всегда держим темп реального времени:
    // без него готовый плейлист проглатывается вдвое быстрее и эфир уезжает.
    if (media.live) args.push('-live_start_index', '-1');
    args.push(...HWACCEL, '-re', '-i', source);
    if (media.hasVideo) videoIndex = inputIndex;
    if (media.hasAudio) audioIndex = inputIndex;
    inputIndex++;
  }

  if (videoIndex === null) {
    // -re обязателен: без него lavfi-подложка генерируется со скоростью CPU и
    // разносит таймлайн (аудио-треки без видео ломали плеер именно так).
    args.push('-re', '-f', 'lavfi', '-i', `color=c=0x080611:s=${width}x${height}:r=${profile.fps}`);
    videoIndex = inputIndex++;
  }
  if (audioIndex === null) {
    args.push('-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    audioIndex = inputIndex++;
  }

  const speed = Math.max(0.5, Math.min(2, Number(config.playbackSpeed) || 1));
  const mediaVolume = Math.max(0, Math.min(4, Number(config.mediaVolume) || 0));
  args.push('-map', `${videoIndex}:v:0`, '-map', `${audioIndex}:a:0`, '-shortest',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS/${speed}`,
    '-af', `atempo=${speed},volume=${mediaVolume.toFixed(2)},alimiter=limit=0.97:level=disabled,aresample=async=1000:first_pts=0`,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...producerEncodeArgs(profile), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '4096',
    '-output_ts_offset', timestampOffset.toFixed(3), '-mpegts_flags', 'resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1');
  return args;
}

async function startQueueItem(index, position = 0, generation = playGeneration, retry = 0) {
  if (stopping || generation !== playGeneration || preparingNext || activeProcess || queuePaused || !queue.length) return;
  preparingNext = true;
  queueIndex = Math.max(0, Math.min(queue.length - 1, index));
  let item = queue[queueIndex];
  // Недоступный ролик не пытаемся открыть: ищем ближайший рабочий дальше.
  if (item && mediaFailure(item.id)?.permanent) {
    const workable = queue.findIndex((entry, index) => index > queueIndex && !mediaFailure(entry.id)?.permanent);
    preparingNext = false;
    if (workable >= 0) return startQueueItem(workable, 0, generation);
    log('В очереди не осталось доступных треков');
    return stopActive();
  }
  currentId = item.id;
  currentStartedAt = null;
  currentDuration = item.duration || null;
  sourcePosition = Math.max(0, Number(position) || 0);
  pausedPosition = sourcePosition;
  queuePaused = false;
  log(`Подготовка: ${item.title}`);
  try {
    const media = await stableQueueMedia(item);
    if (stopping || generation !== playGeneration || queuePaused) return;
    // A seek/jump issued while yt-dlp was resolving supersedes this item.
    if (manualTransition) return;
    currentDuration = media.duration || item.duration || null;
    stopStandby();
    const child = spawn('ffmpeg', queueProducerArgs(media, markProducerTimestamp(nextProducerTimestamp()), sourcePosition), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = child;
    pipeToRelay(child);
    currentStartedAt = Date.now();
    playbackBusy = false;
    log(`Сейчас играет: ${item.title}`);
    attachProcessLogs(child, 'Track');
    preloadNext(queueIndex);
    child.on('close', code => {
      // A rapid seek/jump may already have replaced this producer.  In that
      // case its late close event must not advance or stop the new track.
      if (activeProcess !== child) return;
      const ranFor = currentStartedAt ? (Date.now() - currentStartedAt) / 1000 : 0;
      activeProcess = null;
      currentStartedAt = null;
      if (stopping || generation !== playGeneration) return;
      const transition = manualTransition;
      manualTransition = null;
      // На паузе показом занимается pauseWithFrozenFrame. Без этой проверки
      // закрытие продюсера принималось за «трек доиграл» и эфир мог встать.
      if (queuePaused) return;
      playbackBusy = Boolean(transition && transition.type !== 'pause');
      // При переходе на другой трек заставку не поднимаем: следующий
      // производитель стартует через десятки миллисекунд, а лишний запуск
      // ffmpeg только добавлял задержку на каждое переключение.
      if (transition?.type !== 'seek' && transition?.type !== 'jump') startStandby(sessionProfile('queue'));
      if (transition?.type === 'seek') return setTimeout(() => startQueueItem(queueIndex, transition.position, generation), 40);
      if (transition?.type === 'jump') return setTimeout(() => startQueueItem(transition.index, transition.position || 0, generation), 40);
      if (code && code !== 255 && !item.local && retry < 1 && ranFor < 8) {
        resolvedMedia.delete(item.id);
        playbackBusy = true;
        log(`Источник устарел — обновляю прямую ссылку: ${item.title}`);
        return setTimeout(() => startQueueItem(queueIndex, sourcePosition, generation, retry + 1), 120);
      }
      if (code && code !== 255) log(`Трек завершился с кодом ${code}`);
      if (config.loopMode === 'one') return setTimeout(() => startQueueItem(queueIndex, 0, generation), 40);
      const nextIndex = queueIndex + 1;
      if (nextIndex < queue.length) return setTimeout(() => startQueueItem(nextIndex, 0, generation), 40);
      if (config.loopMode === 'all') return setTimeout(() => startQueueItem(0, 0, generation), 40);
      log('Очередь проиграна один раз');
      stopActive();
    });
  } catch (error) {
    rememberMediaFailure(item.id, error.message);
    log(`Не удалось открыть «${item.title}»: ${error.message}`);
    if (!stopping && generation === playGeneration) {
      const next = queueIndex + 1;
      if (next < queue.length) setTimeout(() => startQueueItem(next, 0, generation), 150);
      else stopActive();
    }
  } finally {
    preparingNext = false;
    consumeManualTransition(generation);
  }
}

function consumeManualTransition(generation = playGeneration) {
  if (activeProcess || preparingNext || stopping || generation !== playGeneration || !manualTransition) return;
  const transition = manualTransition;
  manualTransition = null;

  if (transition.type === 'seek') setTimeout(() => startQueueItem(queueIndex, transition.position, generation), 25);
  if (transition.type === 'jump') setTimeout(() => startQueueItem(transition.index, transition.position || 0, generation), 25);
}

function stopActive(clearCurrent = true, keepTunnel = true, keepRelay = true) {
  stopping = true;
  stopMediaCacheDownloads();
  stopWindowWatch();
  playGeneration++;
  preparingNext = false;
  activeAuxProcess?.stdout?.unpipe();
  activeWindowProcess?.stdout?.unpipe();
  stopAudioHelper(activeAuxProcess);
  activeWindowProcess?.kill('SIGTERM');
  stopProducer(activeProcess);
  if (!keepRelay) { stopStandby(); stopRtspPush(); relayProcess?.kill('SIGTERM'); relayProcess = null; relayStartedAt = 0; relayProfile = null; }
  if (!keepTunnel) stopPublicTunnel();
  activeProcess = null; activeAuxProcess = null; activeWindowProcess = null; activeKind = null;
  audioLevelDb = -96; audioSamples = 0; audioSquares = 0;
  queuePaused = false; manualTransition = null; playbackBusy = false;
  if (clearCurrent) { currentId = null; currentStartedAt = null; currentDuration = null; }
  if (keepRelay) startStandby();
}

function currentSourcePosition() {
  if (queuePaused) return pausedPosition;
  return sourcePosition + (currentStartedAt ? (Date.now() - currentStartedAt) / 1000 * (Number(config.playbackSpeed) || 1) : 0);
}

function transitionQueue(type, value = null) {
  if (activeKind !== 'queue') throw new Error('Очередь сейчас не играет.');
  if (type === 'pause') {
    if (queuePaused) return;
    const pausingPendingSeek = manualTransition?.type === 'seek' || playbackBusy;
    const visiblePosition = Number(value);
    pausedPosition = Number.isFinite(visiblePosition) ? Math.max(0, Math.min(currentDuration || Number.MAX_SAFE_INTEGER, visiblePosition)) : currentSourcePosition();
    queuePaused = true;
    currentStartedAt = null;
    playbackBusy = false;
    manualTransition = null;
    pauseWithFrozenFrame(playGeneration, pausingPendingSeek ? null : latestHlsSegment(config.previewDelay || 0), pausingPendingSeek);
    return;
  } else if (type === 'resume') {
    if (!queuePaused) return;
    queuePaused = false;
    sourcePosition = pausedPosition;
    currentStartedAt = null;
    playbackBusy = true;
    playbackRevision++;
    manualTransition = { type: 'seek', position: pausedPosition };
  } else if (type === 'seek') {
    const position = Math.max(0, Math.min(currentDuration || Number.MAX_SAFE_INTEGER, Number(value) || 0));
    pausedPosition = position;
    sourcePosition = position;
    playbackRevision++;
    if (queuePaused) { playbackBusy = false; return; }
    currentStartedAt = null;
    playbackBusy = true;
    manualTransition = { type: 'seek', position };
  } else if (type === 'next' || type === 'previous') {
    stopMediaCacheDownloads();
    let target = queueIndex + (type === 'next' ? 1 : -1);
    if (target >= queue.length) target = config.loopMode === 'all' ? 0 : queue.length - 1;
    if (target < 0) target = config.loopMode === 'all' ? queue.length - 1 : 0;
    queuePaused = false;
    sourcePosition = 0; pausedPosition = 0; currentStartedAt = null;
    playbackBusy = true; playbackRevision++;
    manualTransition = { type: 'jump', index: target, position: 0 };
  }
  if (activeProcess) stopProducer(activeProcess);
  else consumeManualTransition();
}

function transitionQueueTo(index, position = 0) {
  if (activeKind !== 'queue') throw new Error('Очередь сейчас не играет.');
  stopMediaCacheDownloads();
  const target = Math.max(0, Math.min(queue.length - 1, Number(index) || 0));
  queuePaused = false;
  sourcePosition = Math.max(0, Number(position) || 0); pausedPosition = sourcePosition; currentStartedAt = null;
  playbackBusy = true; playbackRevision++;
  manualTransition = { type: 'jump', index: target, position: Math.max(0, Number(position) || 0) };
  if (activeProcess) stopProducer(activeProcess);
  else consumeManualTransition();
}

function playbackCommand(body) {
  const action = String(body.action || '');
  if (action === 'pause') transitionQueue('pause', body.position);
  else if (action === 'resume') transitionQueue('resume');
  else if (action === 'toggle') transitionQueue(queuePaused ? 'resume' : 'pause');
  else if (action === 'seek') transitionQueue('seek', body.position);
  else if (action === 'next') transitionQueue('next');
  else if (action === 'previous') transitionQueue('previous');
  else if (action === 'jump') {
    const index = queue.findIndex(item => item.id === String(body.id || ''));
    if (index < 0) throw new Error('Трек больше не найден в очереди.');
    if (activeKind !== 'queue') startQueue(index);
    else transitionQueueTo(index, 0);
  }
  else if (action === 'loop') saveConfig({ loopMode: ['once', 'one', 'all'].includes(body.mode) ? body.mode : 'once' });
  else if (action === 'speed') {
    const position = activeKind === 'queue' ? currentSourcePosition() : 0;
    const speed = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(body.speed)) ? Number(body.speed) : 1;
    saveConfig({ playbackSpeed: speed });
    if (activeKind === 'queue') {
      if (queuePaused) pausedPosition = position;
      else transitionQueue('seek', position);
    }
  } else if (action === 'volume') {
    const position = activeKind === 'queue' ? currentSourcePosition() : 0;
    const volume = Math.max(0, Math.min(2, Number(body.volume) || 0));
    saveConfig({ mediaVolume: volume });
    if (activeKind === 'queue') {
      if (queuePaused) pausedPosition = position;
      else transitionQueue('seek', position);
    }
  } else throw new Error('Неизвестная команда плеера.');
  return status();
}

async function addUrl(rawUrl) {
  if (!validWebUrl(rawUrl)) throw new Error('Вставьте полную ссылку с http:// или https://');
  const host = new URL(rawUrl).hostname.toLowerCase();
  if (host === 'open.spotify.com') throw new Error('Spotify не отдаёт полный трек. Для Spotify используйте захват окна и звук компьютера.');
  if (!tools.ytdlp) throw new Error('Компонент загрузки видео не найден.');
  const direct = DIRECT_LIVE.test(rawUrl) || DIRECT_FILE.test(rawUrl);
  if (direct) {
    const live = DIRECT_LIVE.test(rawUrl);
    const item = {
      id: crypto.randomUUID(), title: decodeURIComponent(new URL(rawUrl).pathname.split('/').filter(Boolean).pop() || host),
      sourceUrl: rawUrl, duration: null, thumbnail: '', local: false, hasVideo: true, hasAudio: true, direct: true, live,
    };
    queue.push(item);
    saveQueue();
    log(`Добавлена прямая ссылка${live ? ' (живой поток)' : ''}: ${item.title}`);
    if (!live) prefetchQueue(0);
    return [item];
  }
  // Сначала обычный разбор, затем «общий» — он вытаскивает плеер прямо со
  // страницы. Так добавляются аниме-сайты и прочие площадки, для которых
  // отдельного разборщика нет.
  let flat;
  try {
    flat = await spawnJson(ytdlpPath(), ['--no-warnings', '--flat-playlist', '--dump-single-json', rawUrl], 70000);
  } catch (error) {
    log(`Пробую разобрать страницу целиком: ${host}`);
    logDetail(`Обычный разбор не удался для ${rawUrl}: ${error.message}`);
    try {
      flat = await spawnJson(ytdlpPath(), ['--no-warnings', '--force-generic-extractor', '--dump-single-json', rawUrl], 90000);
    } catch (generic) {
      logDetail(`Общий разбор тоже не удался для ${rawUrl}: ${generic.message}`);
      throw new Error(`${error.message}. Попробуйте вставить прямую ссылку на видео (…mp4 или …m3u8) — её страница обычно отдаёт в плеере.`);
    }
  }
  const entries = Array.isArray(flat.entries) ? flat.entries.filter(Boolean) : [];
  const candidates = entries.length ? entries : [flat];
  if (candidates.length > 200) throw new Error('За один раз можно добавить до 200 элементов.');
  const added = candidates.map(entry => {
    let sourceUrl = entry.webpage_url || entry.url || rawUrl;
    if (!validWebUrl(sourceUrl) && entry.id && /youtube|youtu\.be/.test(host)) sourceUrl = `https://www.youtube.com/watch?v=${entry.id}`;
    return {
      id: crypto.randomUUID(), title: entry.title || flat.title || sourceUrl, sourceUrl,
      duration: entry.duration || null, thumbnail: entry.thumbnail || (entry.thumbnails?.at(-1)?.url ?? ''),
      local: false, hasVideo: true, hasAudio: true,
    };
  });
  queue.push(...added);
  saveQueue();
  log(`Добавлено по ссылке: ${added.length}`);
  // Качаем сразу, не дожидаясь эфира: тогда первый запуск и любой переход
  // между треками идут с диска и не ждут разбора ссылки.
  prefetchQueue(0);
  return added;
}

const FFPROBE_ARGS = ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json'];

function mediaInfo(filePath) {
  const result = spawnSync('ffprobe', [...FFPROBE_ARGS, filePath], {
    windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('FFprobe не смог прочитать файл.');
  return parseMediaInfo(result.stdout);
}

async function mediaInfoAsync(filePath) {
  const result = await spawnCollect('ffprobe', [...FFPROBE_ARGS, filePath], 20000);
  if (result.status !== 0) throw new Error('FFprobe не смог прочитать файл.');
  return parseMediaInfo(result.stdout);
}

function parseMediaInfo(stdout) {
  const data = JSON.parse(stdout);
  const videoCodec = data.streams?.find(stream => stream.codec_type === 'video')?.codec_name || '';
  const audioCodec = data.streams?.find(stream => stream.codec_type === 'audio')?.codec_name || '';
  const mp4Container = String(data.format?.format_name || '').split(',').some(name => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name));
  return {
    duration: Number(data.format?.duration) || null,
    hasVideo: data.streams?.some(stream => stream.codec_type === 'video') || false,
    hasAudio: data.streams?.some(stream => stream.codec_type === 'audio') || false,
    videoCodec, audioCodec,
    unityCompatible: mp4Container && videoCodec === 'h264' && (!audioCodec || audioCodec === 'aac'),
  };
}

function generateThumbnail(item) {
  if (!item.hasVideo) return;
  const destination = join(THUMB_DIR, `${item.id}.jpg`);
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', item.sourceUrl,
    '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', destination], { windowsHide: true, stdio: 'ignore' });
  child.on('close', code => { if (code === 0) { item.thumbnail = `/thumbs/${item.id}.jpg?v=${Date.now()}`; saveQueue(); } });
}

async function addLocalFiles(paths) {
  const added = [];
  for (const rawPath of paths.slice(0, 100)) {
    const filePath = resolve(String(rawPath));
    if (!existsSync(filePath) || !statSync(filePath).isFile() || !MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const info = await mediaInfoAsync(filePath);
    if (!info.hasVideo && !info.hasAudio) continue;
    const item = { id: crypto.randomUUID(), title: basename(filePath), sourceUrl: filePath, thumbnail: '', local: true, ...info };
    queue.push(item); added.push(item); generateThumbnail(item);
  }
  if (!added.length) throw new Error('Не найдено поддерживаемых видео или аудиофайлов.');
  saveQueue();
  log(`Добавлено с компьютера: ${added.length}`);
  return added;
}

async function listAudioDevices() {
  if (!tools.ffmpeg) return [];
  const result = await spawnCollect('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 10000);
  const devices = [];
  for (const line of String(result.stderr || '').split(/\r?\n/)) {
    const match = line.match(/\]\s+"(.+?)"\s+\(audio\)/);
    if (match && !devices.includes(match[1])) devices.push(match[1]);
  }
  return devices;
}

async function listAudioOutputs() {
  const helper = join(ROOT, 'tools', 'VRCast.AudioCapture.exe');
  if (!existsSync(helper)) return [];
  const result = await spawnCollect(helper, ['--list-devices'], 10000);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

async function runPowerShellJson(script) {
  const result = await spawnCollect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 10000);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try { const parsed = JSON.parse(result.stdout); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch { return []; }
}

// Захват монитора: GDI копирует каждый кадр силами процессора (замер на
// 2560x1440@60 — 1,38 ядра, из них 0,5 в ядре системы), Desktop Duplication
// отдаёт кадр видеокартой — 0,98 ядра и почти без системного времени, что
// заодно перестаёт мешать игре. Windows называет мониторы \\.\DISPLAYn, а
// ddagrab выбирает их по номеру выхода видеокарты; совпадает не всегда, поэтому
// номер подбираем пробным кадром и сверяем разрешение. Не сошлось — остаёмся на GDI.
const ddagrabIndexes = new Map();

async function ddagrabIndexFor(monitor) {
  if (!monitor || !tools.ffmpeg) return null;
  if (ddagrabIndexes.has(monitor.id)) return ddagrabIndexes.get(monitor.id);
  const guess = Math.max(0, (Number(String(monitor.id).match(/(\d+)$/)?.[1]) || 1) - 1);
  let found = null;
  for (const index of [...new Set([guess, 0, 1, 2, 3])]) {
    const probe = await spawnCollect('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-f', 'lavfi',
      '-i', `ddagrab=output_idx=${index}:framerate=10`, '-frames:v', '1', '-f', 'null', '-'], 9000).catch(() => null);
    const size = `${probe?.stderr || ''}`.match(/,\s(\d{3,5})x(\d{3,5})/);
    if (size && Number(size[1]) === monitor.width && Number(size[2]) === monitor.height) { found = index; break; }
  }
  ddagrabIndexes.set(monitor.id, found);
  log(found === null
    ? `Монитор ${monitor.id}: аппаратный захват недоступен, работаю через GDI`
    : `Монитор ${monitor.id}: аппаратный захват экрана (выход ${found})`);
  return found;
}

async function listMonitors() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ id=$_.DeviceName; name=if($_.Primary){'Основной монитор'}else{$_.DeviceName}; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; primary=$_.Primary } } | ConvertTo-Json -Compress`;
  return runPowerShellJson(script);
}

async function listWindows() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -TypeDefinition @'
using System; using System.Text; using System.Diagnostics; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class VRCastWindows {
  public sealed class Entry { public int id; public string process; public string title; public string handle; public int x,y,width,height; public bool minimized; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static Entry[] List() { var result=new List<Entry>(); EnumWindows((h,l)=>{ try { int len=GetWindowTextLength(h); int cloaked=0; bool iconic=IsIconic(h); DwmGetWindowAttribute(h,14,out cloaked,4); if((!IsWindowVisible(h)&&!iconic)||(cloaked!=0&&!iconic)||len<1)return true; var text=new StringBuilder(len+1); GetWindowText(h,text,text.Capacity); uint pid; RECT r; GetWindowThreadProcessId(h,out pid); if(!GetWindowRect(h,out r))return true; int width=Math.Max(1,r.Right-r.Left),height=Math.Max(1,r.Bottom-r.Top); if(!iconic&&(width<16||height<16))return true; var p=Process.GetProcessById((int)pid); result.Add(new Entry{id=(int)pid,process=p.ProcessName,title=text.ToString(),handle=h.ToInt64().ToString(),x=r.Left,y=r.Top,width=width,height=height,minimized=iconic}); } catch {} return true; },IntPtr.Zero); return result.ToArray(); }
}
'@; [VRCastWindows]::List() | Sort-Object title | ConvertTo-Json -Compress`;
  const junkProcesses = new Set(['dwm', 'csrss', 'winlogon', 'textinputhost', 'shellexperiencehost', 'searchhost']);
  return (await runPowerShellJson(script)).filter(item => item.handle && item.title && !junkProcesses.has(String(item.process || '').toLowerCase()));
}

async function selectedCaptureRect() {
  if (config.captureMode === 'window') return (await listWindows()).find(item => item.handle === String(config.captureWindowHandle)) || null;
  if (config.captureMode === 'monitor') {
    const monitors = await listMonitors();
    return monitors.find(item => item.id === config.captureMonitorId) || monitors.find(item => item.primary) || monitors[0] || null;
  }
  if (config.captureMode === 'region') return { x: Number(config.regionX) || 0, y: Number(config.regionY) || 0,
    width: Math.max(64, Number(config.regionWidth) || 1280), height: Math.max(64, Number(config.regionHeight) || 720) };
  return null;
}

async function generateCapturePreview() {
  // Во время эфира скриншоты не делаем: параллельный захват дерётся за GPU/CPU
  // с рабочим кодировщиком, а монитор в UI и так показывает сам поток.
  if (activeKind === 'screen') {
    if (existsSync(CAPTURE_PREVIEW)) return { url: `/api/capture-preview?time=${Date.now()}`, rect: null };
    throw new Error('Идёт эфир — предпросмотр показывает сам поток.');
  }
  const rect = await selectedCaptureRect();
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', '1'];
  if (config.captureMode === 'window') {
    if (!rect) return { unavailable: true, minimized: false, rect: null };
    if (rect.minimized) return { unavailable: false, minimized: true, rect };
    const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
    if (!existsSync(helper)) throw new Error('Компонент изолированного захвата окна не найден.');
    const capture = spawn(helper, ['--hwnd', rect.handle, '--width', '960', '--height', '540', '--fps', '5'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const converter = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '960x540', '-framerate', '5', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-y', CAPTURE_PREVIEW], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    capture.stdout.on('error', () => {}); converter.stdin.on('error', () => {});
    capture.stdout.pipe(converter.stdin);
    let errorText = '';
    capture.stderr.on('data', chunk => { errorText += chunk; }); converter.stderr.on('data', chunk => { errorText += chunk; });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { capture.kill('SIGTERM'); converter.kill('SIGTERM'); reject(new Error('Предпросмотр окна отвечает слишком долго.')); }, 8000);
      converter.on('close', code => { clearTimeout(timer); capture.kill('SIGTERM'); code === 0 ? resolvePromise() : reject(new Error(errorText.trim().split(/\r?\n/).pop() || 'Не удалось получить кадр окна.')); });
      converter.on('error', reject); capture.on('error', reject);
    });
    return { url: `/api/capture-preview?time=${Date.now()}`, rect };
  } else if (rect) args.push('-offset_x', String(rect.x), '-offset_y', String(rect.y), '-video_size', `${rect.width}x${rect.height}`, '-i', 'desktop');
  else args.push('-i', 'desktop');
  args.push('-frames:v', '1', '-vf', 'scale=960:-2:flags=fast_bilinear', '-q:v', '3', '-y', CAPTURE_PREVIEW);
  const result = await spawnCollect('ffmpeg', args, 12000);
  if (result.status !== 0 || !existsSync(CAPTURE_PREVIEW)) throw new Error((result.stderr || 'Не удалось получить изображение источника.').trim().split(/\r?\n/).pop());
  return { url: `/api/capture-preview?time=${Date.now()}`, rect };
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error('Слишком большой запрос'); }
  return body ? JSON.parse(body) : {};
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
};

function serveFile(res, base, relative, cache = false) {
  const safe = normalize(relative).replace(/^(\.\.(\\|\/|$))+/, '');
  const file = join(base, safe);
  if (!file.startsWith(base) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': cache ? 'public, max-age=3600' : 'no-store', 'Access-Control-Allow-Origin': '*' });
  createReadStream(file).pipe(res); return true;
}

function serveRangeMp4(req, res, filePath) {
  if (!existsSync(filePath)) return false;
  const size = statSync(filePath).size;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  const common = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache, no-store',
    'CDN-Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (!range) {
    res.writeHead(200, { ...common, 'Content-Length': size });
    if (req.method === 'HEAD') res.end(); else createReadStream(filePath).pipe(res);
    return true;
  }
  const start = range[1] ? Math.min(size - 1, Number(range[1])) : 0;
  const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start > end || !Number.isFinite(start) || !Number.isFinite(end)) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true;
  }
  res.writeHead(206, { ...common, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
  if (req.method === 'HEAD') res.end(); else createReadStream(filePath, { start, end }).pipe(res);
  return true;
}

function serveUnityMedia(req, res, id) {
  if (id === 'unity-queue') return serveRangeMp4(req, res, UNITY_QUEUE_FILE);
  if (id === 'unity-capture') return serveRangeMp4(req, res, UNITY_CAPTURE_FILE);
  const item = queue.find(entry => entry.id === id);
  if (!item?.local || !item.unityCompatible || !existsSync(item.sourceUrl)) return false;
  return serveRangeMp4(req, res, item.sourceUrl);
}

function prepareLivePlaylist(raw, segmentLimit, startOffset) {
  const lines = raw.trimEnd().split(/\r?\n/);
  const uriIndexes = lines.map((line, index) => line && !line.startsWith('#') ? index : -1).filter(index => index >= 0);
  if (!uriIndexes.length) return raw;
  const keepFrom = Math.max(0, uriIndexes.length - segmentLimit);
  const firstSegmentTag = lines.findIndex(line => line.startsWith('#EXT-X-PROGRAM-DATE-TIME') || line.startsWith('#EXTINF'));
  const bodyStart = keepFrom === 0 ? firstSegmentTag : uriIndexes[keepFrom - 1] + 1;
  const header = lines.slice(0, Math.max(1, firstSegmentTag));
  const sequenceIndex = header.findIndex(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  if (sequenceIndex >= 0) {
    const sequence = Number(header[sequenceIndex].split(':')[1]) || 0;
    header[sequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${sequence + keepFrom}`;
  }
  header.splice(1, 0, `#EXT-X-START:TIME-OFFSET=-${startOffset},PRECISE=YES`);
  return [...header, ...lines.slice(bodyStart), ''].join('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    const publicTunnelHost = requestHost.endsWith('.trycloudflare.com') || requestHost.endsWith('.pinggy-free.link') || requestHost.endsWith('.free.pinggy.net');
    if (publicTunnelHost && !url.pathname.startsWith('/stream/') && !url.pathname.startsWith('/media/')) {
      return json(res, 404, { error: 'Через публичную ссылку доступен только медиапоток.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && url.pathname === '/api/capture-preview') {
      if (existsSync(CAPTURE_PREVIEW)) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); createReadStream(CAPTURE_PREVIEW).pipe(res); return; }
      return json(res, 404, { error: 'Предпросмотр ещё не создан.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/capture-preview') return json(res, 200, await generateCapturePreview());
    if (req.method === 'GET' && url.pathname === '/api/capture-sources') {
      const [windows, monitors, audioDevices, audioOutputs] = await Promise.all([listWindows(), listMonitors(), listAudioDevices(), listAudioOutputs()]);
      return json(res, 200, { windows, monitors, audioDevices, audioOutputs });
    }
    if (req.method === 'GET' && url.pathname === '/api/windows') return json(res, 200, await listWindows());
    if (req.method === 'POST' && url.pathname === '/api/unity/queue/build') {
      if (!queue.length) throw new Error('Добавьте хотя бы один трек в очередь.');
      if (unityBuildProcess || unityBuild.state === 'building') throw new Error('Очередь уже подготавливается.');
      if (activeKind) throw new Error('Сначала остановите эфир. Unity-подготовка не запускается параллельно, чтобы звук не зависал.');
      const body = await readBody(req);
      void buildUnityQueue(String(body.id || '')).catch(error => log(`Unity: ${error.message}`)); return json(res, 202, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/unity/queue/cancel') {
      stopUnityBuild(); return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/unity/capture/start') {
      startUnityCaptureRecording(); return json(res, 202, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/unity/capture/stop') {
      stopUnityCaptureRecording(); return json(res, 202, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/logs/open') {
      // Открыть папку через проводник: копировать путь руками неудобно.
      spawn('explorer.exe', [DATA_DIR], { windowsHide: true, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/cache/clear') {
      // Играющий и качающийся треки не трогаем: файл занят, и эфир оборвётся.
      try {
        for (const name of readdirSync(mediaCacheDir())) {
          if (mediaCacheJobs.has(name) || name === currentId) continue;
          rmSync(join(mediaCacheDir(), name), { recursive: true, force: true });
        }
      } catch {}
      cleanupStorage();
      return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/update/apply') {
      applyUpdate();
      json(res, 200, { ok: true });
      setTimeout(() => { stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); server.close(() => process.exit(0)); }, 300);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/servers') {
      const body = await readBody(req);
      const server = await deployServer(body);
      return json(res, 201, { server: { id: server.id, name: server.name, host: server.host, rtspPort: server.rtspPort }, status: status() });
    }
    if (req.method === 'POST' && /^\/api\/servers\/[^/]+\/channel$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const channel = String(body.channel || 'live').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'live';
      const list = savedServers().map(item => item.id === id ? { ...item, channel } : item);
      saveConfig({ servers: list });
      remoteChannelRejected = false;
      if (config.outputMode === 'remote') { stopRtspPush(); if (relayProcess) startRtspPush(); }
      log(`Свой сервер: канал ${channel}`);
      return json(res, 200, status());
    }
    if (req.method === 'POST' && /^\/api\/servers\/[^/]+\/remove$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const result = await removeServer(id, String(body.password || ''));
      return json(res, 200, { ...result, status: status() });
    }
    if (req.method === 'POST' && /^\/api\/servers\/[^/]+\/activate$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      if (!savedServers().some(item => item.id === id)) throw new Error('Сервер не найден.');
      saveConfig({ activeServerId: id, outputMode: 'remote' });
      stopPublicTunnel();
      stopRtspPush();
      if (relayProcess) startRtspPush();
      log(`Эфир переключён на свой сервер: ${activeServer()?.name || id}`);
      return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/queue') {
      const body = await readBody(req); const added = await addUrl(String(body.url || '').trim());
      return json(res, 201, { added, status: status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/queue/local') {
      const body = await readBody(req); const added = await addLocalFiles(Array.isArray(body.paths) ? body.paths : []);
      return json(res, 201, { added, status: status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/templates') {
      const body = await readBody(req); const id = saveQueueTemplate(body);
      return json(res, 201, { id, status: status() });
    }
    if (req.method === 'POST' && /^\/api\/templates\/[^/]+\/load$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]); const body = await readBody(req);
      applyQueueTemplate(id, Boolean(body.append)); return json(res, 200, status());
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/templates/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const before = templates.length; templates = templates.filter(item => item.id !== id);
      if (templates.length === before) throw new Error('Шаблон не найден.');
      saveTemplates(); return json(res, 200, status());
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/queue/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const removedIndex = queue.findIndex(item => item.id === id);
      queue = queue.filter(item => item.id !== id); resolvedMedia.delete(id); saveQueue();
      // Удаление играющего трека раньше оставляло висячий currentId и сбитый
      // queueIndex: UI показывал «эфир не запущен», а очередь после трека вставала.
      if (activeKind === 'queue' && removedIndex >= 0) {
        if (id === currentId) {
          if (!queue.length) stopActive();
          else transitionQueueTo(Math.min(removedIndex, queue.length - 1), 0);
        } else if (removedIndex < queueIndex) queueIndex--;
      }
      return json(res, 200, status());
    }
    if (req.method === 'DELETE' && url.pathname === '/api/queue') {
      if (activeKind === 'queue') stopActive(); queue = []; resolvedMedia.clear(); saveQueue(); return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const next = {
        outputMode: ['local', 'tunnel', 'remote'].includes(body.outputMode) ? body.outputMode : 'local',
        cacheRoot: typeof body.cacheRoot === 'string' ? body.cacheRoot.trim().slice(0, 300) : config.cacheRoot,
        activeServerId: savedServers().some(item => item.id === String(body.activeServerId || ''))
          ? String(body.activeServerId) : (activeServer() ? config.activeServerId : (savedServers()[0]?.id || '')), quality: body.quality === '1080p' ? '1080p' : '720p', fps: body.fps === 60 ? 60 : 30,
        captureMode: ['desktop', 'monitor', 'window', 'region'].includes(body.captureMode) ? body.captureMode : 'monitor',
        captureMonitorId: String(body.captureMonitorId || '').slice(0, 180),
        captureWindowHandle: String(body.captureWindowHandle || '').replace(/\D/g, '').slice(0, 24),
        regionX: Math.max(-16384, Math.min(16384, Number(body.regionX) || 0)), regionY: Math.max(-16384, Math.min(16384, Number(body.regionY) || 0)),
        regionWidth: Math.max(64, Math.min(7680, Number(body.regionWidth) || 1280)), regionHeight: Math.max(64, Math.min(4320, Number(body.regionHeight) || 720)),
        audioMode: ['none', 'system', 'output', 'process', 'device'].includes(body.audioMode) ? body.audioMode : 'system', captureAudioDevice: String(body.captureAudioDevice || '').slice(0, 180),
        audioOutputId: String(body.audioOutputId || '').slice(0, 500), audioProcessId: String(body.audioProcessId || '').replace(/\D/g, '').slice(0, 16),
        loopMode: ['once', 'one', 'all'].includes(body.loopMode) ? body.loopMode : (config.loopMode || 'once'),
        playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(body.playbackSpeed)) ? Number(body.playbackSpeed) : (config.playbackSpeed || 1),
        captureVolume: Math.max(0, Math.min(6, Number(body.captureVolume ?? config.captureVolume ?? 1.5))),
        localAppVolume: Math.max(0.02, Math.min(1, Number(body.localAppVolume ?? config.localAppVolume ?? 1))),
        rtspTransport: ['tcp', 'udp'].includes(body.rtspTransport) ? body.rtspTransport : (config.rtspTransport || 'tcp'),
        mediaVolume: Math.max(0, Math.min(4, Number(body.mediaVolume ?? config.mediaVolume ?? 1))),
        mediaQuality: body.mediaQuality === '1080p' ? '1080p' : (body.mediaQuality === '720p' ? '720p' : (config.mediaQuality || '720p')),
        mediaFps: body.mediaFps === 60 ? 60 : (body.mediaFps === 30 ? 30 : (config.mediaFps || 30)),
        previewDelay: [0, 3, 5, 7, 10].includes(Number(body.previewDelay)) ? Number(body.previewDelay) : Math.min(10, Number(config.previewDelay) || 0),
        previewDelayReset: true,
      };
      const previousOutput = config.outputMode;
      const previousRemoteTarget = remoteRtspTarget();
      const applyLive = Boolean(body.applyLive);
      // Смена диска для кеша: проверяем, что папка создаётся и туда можно писать,
      // и только потом сохраняем — иначе загрузки молча перестанут работать.
      const previousCacheDir = mediaCacheDir();
      if (next.cacheRoot !== config.cacheRoot) {
        const target = next.cacheRoot ? join(next.cacheRoot, 'VRCastBridge-cache') : DEFAULT_CACHE_DIR;
        try {
          mkdirSync(target, { recursive: true });
          const probe = join(target, '.write-test');
          writeFileSync(probe, 'ok'); rmSync(probe, { force: true });
        } catch { return json(res, 400, { error: `Не удаётся писать в ${target}. Выберите другой диск.` }); }
      }
      saveConfig(next);
      if (mediaCacheDir() !== previousCacheDir) {
        // Старую папку убираем: треки перекачаются на новое место сами.
        try { rmSync(previousCacheDir, { recursive: true, force: true }); } catch {}
        ensureCacheDir();
        log(`Кеш видео теперь в ${mediaCacheDir()}`);
      }
      const previousRemote = previousRemoteTarget?.publishUrl || '';
      if (previousOutput !== config.outputMode) {
        if (config.outputMode === 'tunnel') startPublicTunnel();
        else stopPublicTunnel();
      }
      // Смена адреса своего сервера подхватывается на лету: пушеры
      // пересоздаются, HLS и локальный RTSP при этом не прерываются.
      if (previousOutput !== config.outputMode || previousRemote !== (remoteRtspTarget()?.publishUrl || '')) {
        stopRtspPush();
        if (relayProcess) startRtspPush();
      }
      if (applyLive && activeKind) {
        const desired = streamProfile(activeKind);
        if (relayProcess && !sameProfile(relayProfile, desired)) restartRelaySession(desired);
      }
      if (applyLive && activeKind === 'screen') await startScreen();
      else if (applyLive && activeKind === 'queue' && currentId) transitionQueue('seek', currentSourcePosition());
      return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/start/screen') { await startScreen(); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/start/queue') { startQueue(); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/skip') { transitionQueue('next'); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/playback') { const body = await readBody(req); return json(res, 200, playbackCommand(body)); }
    if (req.method === 'POST' && url.pathname === '/api/stop') { stopActive(); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (hlsHealthTimer) clearInterval(hlsHealthTimer);
      stopUnityBuild();
      if (unityCaptureProcess) { try { unityCaptureProcess.stdin.write('q\n'); } catch {} }
      stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); json(res, 200, { ok: true }); setTimeout(() => server.close(() => process.exit(0)), 100); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/stream/')) {
      if ((url.pathname === '/stream/live.m3u8' || url.pathname === '/stream/preview.m3u8') && existsSync(join(HLS_DIR, 'live.m3u8'))) {
        const preview = url.pathname === '/stream/preview.m3u8';
        const delay = Math.max(0, Math.min(10, Number(config.previewDelay) || 0));
        // ponytail: локальное окно 4×1с — минимальная задержка для AVPro на этом
        // же ПК; публичное окно шире, потому что туннель добавляет джиттер.
        const liveWindow = publicTunnelHost ? 10 : 4;
        const liveOffset = publicTunnelHost ? 3 : 1.5;
        const playlist = prepareLivePlaylist(readFileSync(join(HLS_DIR, 'live.m3u8'), 'utf8'), preview ? 60 : liveWindow, preview ? Math.max(2, delay) : liveOffset);
        res.writeHead(200, { 'Content-Type': mime['.m3u8'], 'Cache-Control': 'no-cache, no-store, must-revalidate',
          'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store',
          'Pragma': 'no-cache', 'Expires': '0', 'Access-Control-Allow-Origin': '*' });
        res.end(playlist); return;
      }
      if (serveFile(res, HLS_DIR, url.pathname.slice(8))) return; return json(res, 404, { error: 'Поток ещё запускается.' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/media\/[^/]+\.mp4$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.slice('/media/'.length, -'.mp4'.length));
      if (serveUnityMedia(req, res, id)) return;
      return json(res, 404, { error: 'Для Unity доступен только локальный MP4-файл с H.264/AAC.' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/thumbs/')) {
      if (serveFile(res, THUMB_DIR, url.pathname.slice(8), true)) return; return json(res, 404, { error: 'Превью ещё создаётся.' });
    }
    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // Версию в адресах стилей и скриптов подставляем на лету: иначе WebView2
      // отдаёт файлы прошлой версии из кеша и обновлённый интерфейс не виден.
      if (relative === 'index.html') {
        const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8').replace(/\?v=[0-9.]+/g, `?v=${APP_VERSION}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (serveFile(res, PUBLIC_DIR, relative, false)) return;
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (error) {
    // Пока кодировщик качается, каждая попытка кадра давала «spawn ffmpeg ENOENT»
    // и журнал забивался сотней одинаковых строк.
    const скачивается = /spawn ffmpeg ENOENT/i.test(String(error.message)) && !tools.ffmpeg;
    if (!скачивается) log(`Ошибка: ${error.message}`);
    json(res, 400, { error: скачивается ? 'Кодировщик ещё скачивается, подождите' : error.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`VRCast Bridge открыт: http://${HOST}:${PORT}`);
  log(`Кодировщик: ${encoder.label} · FFmpeg: ${tools.ffmpeg ? 'готов' : 'не найден'} · yt-dlp: ${tools.ytdlp ? 'готов' : 'не найден'}`);
  logDetail(`=== запуск VRCast Bridge ${APP_VERSION} · ffmpeg: ${tools.ffmpeg ? 'есть' : 'нет'} · yt-dlp: ${ytdlpPath()} · кодировщик: ${encoder.label} ===`);
  startHlsHealthMonitor();
  watchFreeSpace();
  watchRemoteServer();
  ensureCacheDir();
  cleanupStorage();
  setInterval(cleanupStorage, 10 * 60 * 1000).unref();
  // Скачанный установщик после перезапуска уже не нужен — это 200 МБ на диске.
  try { rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch {}
  refreshYtdlp();
  ensureTools();
  // Проверяем не сразу: пусть эфир поднимется первым, обновление подождёт.
  setTimeout(() => { checkForUpdate(); }, 8000);
  if (tools.mediamtx) { startMediaMtx(); log(`Мгновенный канал RTSP: rtspt://127.0.0.1:${RTSP_PORT}/live`); }
  if (tools.ffmpeg) ensureRelay(streamProfile('queue'));
  if (config.outputMode === 'tunnel') setTimeout(startPublicTunnel, 250);
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') { console.error(`Порт ${PORT} уже занят.`); process.exit(1); }
  throw error;
});
process.on('SIGINT', () => { if (hlsHealthTimer) clearInterval(hlsHealthTimer); stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { if (hlsHealthTimer) clearInterval(hlsHealthTimer); stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); server.close(() => process.exit(0)); });
