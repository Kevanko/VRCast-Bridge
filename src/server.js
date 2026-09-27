import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, networkInterfaces, setPriority } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { access, readFile, stat, statfs } from 'node:fs/promises';

const APP_VERSION = '0.54.11';

// Свободное место проверяем редко и в фоне: на полном диске ffmpeg не может
// дописывать сегменты, эфир встаёт рывками, а причина ниоткуда не видна.
let freeDiskMb = null;
let totalDiskMb = null;
function watchFreeSpace() {
  const measure = () => statfs(mediaCacheDir())
    .then(info => {
      freeDiskMb = Math.round(info.bsize * info.bavail / 1048576);
      totalDiskMb = Math.round(info.bsize * info.blocks / 1048576);
    })
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
// Порт WebRTC для предпросмотра: рядом с RTSP, чтобы два экземпляра не спорили.
const WEBRTC_PORT = RTSP_PORT + 100;
const HOST = '127.0.0.1';
// Прямая ссылка на файл или плейлист: разбирать её через yt-dlp незачем.
const DIRECT_LIVE = /[.](m3u8|mpd)([?#]|$)/i;
// Один список на оба случая: раньше по ссылке .ts принимался, а тот же файл
// с диска — нет.
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts',
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus']);
const DIRECT_FILE = new RegExp(`[.](${[...MEDIA_EXTENSIONS].map(e => e.slice(1)).join('|')})([?#]|$)`, 'i');

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
  captureVolume: 1.5, mediaVolume: 1, mediaQuality: '720p', mediaFps: 60, localAppVolume: 1,
  cacheRoot: '',
  videoBitrate: 0,
  autoQuality: true,
  cacheLimitGb: 0,
  encoderMode: 'auto',
  whiteIp: '',
  tunnelProvider: 'auto',
};

function loadConfig() {
  try { return { ...defaults, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...defaults }; }
}

let config = loadConfig();
// Разовый перенос старой настройки: раньше по умолчанию стояли 5 секунд
// задержки предпросмотра под HLS, сейчас канал мгновенный и ждать нечего.
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
let mediaMtxFailures = 0;
let mediaMtxLastError = '';
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
// Реально ли публичная ссылка отдаёт поток. null — ещё проверяем, false —
// отдаёт заглушку/ошибку (бесплатный Pinggy подменяет поток страницей, сеть
// блокирует туннель), true — играет. Раньше «готово» ставилось по факту
// получения адреса, и Pinggy рапортовал «работает», а в VRChat было пусто.
let tunnelServes = null;
let tunnelVerifyTimer = null;
let lhrKnownKey = '';
let activeKind = null;
let currentId = null;
let currentStartedAt = null;
let currentDuration = null;
let stopping = false;
// stopping означает «сейчас разбираем конвейер», и после остановки эфира он
// так и остаётся поднятым. Фоновой подготовке роликов это мешать не должно —
// её останавливает только выход из программы.
let shuttingDown = false;
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
// Телеметрия качества эфира. liveLatency — насколько живой край потока убежал
// вперёд от настенных часов: это и есть та задержка, что накапливалась до 22с.
// streamEvents — журнал фризов и просадок с местом (какой трек, секунда).
let liveLatency = 0;
let maxLiveLatency = 0;
let streamEvents = [];
let freezeState = null;      // текущий фриз: { startedAt, itemId, position, latency }
let driftCorrectedAt = 0;
let streamSessionStart = 0;
let streamWasReady = false;  // канал хоть раз вышел на режим — только тогда ловим фризы
const qualityStats = { freezes: 0, freezeSeconds: 0, driftCorrections: 0, slowSpells: 0, worstRatio: 1 };
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
let updateState = { checked: false, available: false, version: '', ready: false, notes: '', error: '',
  percent: 0, doneMb: 0, totalMb: 0, assetUrl: '', assetSize: 0, installing: false };
let installingUpdate = false;
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

// ── Приоритеты процессов ────────────────────────────────────────────────────
// Эфир идёт на той же машине, что и VRChat, браузер и антивирус. Стоит кому-то
// из них занять все ядра — продюсер не успевает к реальному времени, и зритель
// видит фриз. Поэтому всё, через что проходит поток (сам сервер: он
// прокачивает поток через свой event loop; продюсеры, релей, RTSP-пушеры,
// MediaMTX, туннель, помощники звука и окна), идёт на ступень выше обычного.
// Именно ABOVE_NORMAL, а не HIGH: работа эфира ограничена темпом реального
// времени (-re), лишнего он не берёт, и ступени выше NORMAL хватает, чтобы
// игра, браузер и сканер его не вытесняли. HIGH же обгоняет и системные
// обычные потоки, и при кодировании на процессоре (libx264 занимает все ядра)
// душил бы саму игру — у человека проседал бы VRChat ради стрима из VRChat.
// REALTIME не трогаем вовсе: он способен заморозить ввод и драйверы.
// Фон (загрузки yt-dlp, превью, ffprobe, сборка для Unity, опросы PowerShell,
// распаковка компонентов) — ступенью ниже обычного: он не срочный и не должен
// отнимать процессор у эфира и игры. Не LOW: под полной нагрузкой игры он бы
// почти не получал времени, и следующий трек не успевал бы скачаться.
// Windows не наследует ABOVE_NORMAL дочерним процессам, поэтому приоритет
// ставится каждому процессу сразу после запуска (BELOW_NORMAL наследуется —
// ffmpeg, которого yt-dlp зовёт для склейки, тоже окажется в фоне).
const ПРИОРИТЕТ_ЭФИРА = osConstants.priority.PRIORITY_ABOVE_NORMAL;
const ПРИОРИТЕТ_ФОНА = osConstants.priority.PRIORITY_BELOW_NORMAL;

function setChildPriority(child, priority) {
  // pid нет, если процесс не запустился (ENOENT) — об этом скажет его 'error'.
  if (child?.pid) { try { setPriority(child.pid, priority); } catch {} }
  return child;
}
const onAir = child => setChildPriority(child, ПРИОРИТЕТ_ЭФИРА);
const inBackground = child => setChildPriority(child, ПРИОРИТЕТ_ФОНА);

try { setPriority(process.pid, ПРИОРИТЕТ_ЭФИРА); } catch {}

// Пока идёт эфир, медиапоток прокачивается через event loop Node, поэтому
// в рабочих путях запрещены spawnSync/долгие синхронные вызовы: каждая
// блокировка = заикание звука. Всё, что запускается во время стрима,
// использует этот асинхронный сборщик вывода.
function spawnCollect(command, args, timeout = 10000, options = {}) {
  return new Promise(resolvePromise => {
    let child;
    // Все, кто идёт через сборщик, — разовые пробы и опросы (ffprobe, списки
    // окон и устройств, PowerShell, распаковка): это фон, а не эфир.
    try { child = inBackground(spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })); }
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
  // Наличие ffmpeg уже известно из tools: раньше на каждый вариант кодировщика
  // запускался ещё и «ffmpeg -version» — три лишних синхронных запуска на старте.
  if (!tools.ffmpeg) return false;
  // format=nv12 обязателен для Intel QuickSync и не мешает остальным: без
  // него проба QSV падает даже там, где кодировщик есть.
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=640x360:d=0.1', '-frames:v', '1', '-vf', 'format=nv12', '-c:v', name, '-f', 'null', '-'], {
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
  // ffmpeg тянем с GitHub, а не с gyan.dev: за VPN gyan отдаёт свои 100+ МБ по
  // 0.2 МБ/с (минуты и таймаут), а GitHub-зеркало — 8 МБ/с. Нужна сборка gpl:
  // в ней есть libx264, на который откатывается кодирование на процессоре.
  'ffmpeg.exe': { label: 'кодировщик', github: 'BtbN/FFmpeg-Builds', tag: 'latest', asset: /win64-gpl\.zip$/i, unpack: ['ffmpeg.exe', 'ffprobe.exe'] },
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
// Версии на старте не спрашиваем запуском самих утилит: yt-dlp (PyInstaller)
// распаковывается ~1 с на каждый запуск, cloudflared и pinggy добавляют ещё
// столько же — это секунды простоя при каждом открытии программы. Достаточно,
// что файл на месте; действительно ли он рабочий, без спешки уточнит фоновая
// проверка. ffmpeg оставляем — его запуск дёшев (~30 мс) и точность тут важна.
let tools = {
  ffmpeg: toolAvailable('ffmpeg', ['-version']),
  ytdlp: existsSync(YTDLP_UPDATED) || existsSync(join(DATA_DIR, 'tools', 'yt-dlp.exe')) || existsSync(YTDLP_BUNDLED),
  cloudflared: Boolean(CLOUDFLARED()),
  pinggy: Boolean(PINGGY()),
  mediamtx: Boolean(MEDIAMTX()),
  plink: Boolean(PLINK()),
};
// Пробуем аппаратные кодировщики по очереди: NVIDIA, потом AMD, потом
// встроенная графика Intel. Что первым отзовётся на пробном кадре — тем и
// кодируем. Проба тяжёлая (запуск ffmpeg), поэтому результат кешируем.
const CPU_ENCODER = { name: 'libx264', label: 'Процессор', family: 'x264', hardware: false };
let hardwareEncoder; // undefined — ещё не проверяли; объект или null — проверили
function detectHardwareEncoder() {
  if (hardwareEncoder !== undefined) return hardwareEncoder;
  const варианты = [
    { name: 'h264_nvenc', label: 'Видеокарта NVIDIA', family: 'nvenc' },
    { name: 'h264_amf', label: 'Видеокарта AMD', family: 'amf' },
    { name: 'h264_qsv', label: 'Видеокарта Intel', family: 'qsv' },
  ];
  hardwareEncoder = null;
  for (const вариант of варианты) {
    if (encoderWorks(вариант.name)) { hardwareEncoder = { ...вариант, hardware: true }; break; }
  }
  return hardwareEncoder;
}
// Режим выбора: auto — видеокарта, если есть, иначе процессор; gpu — только
// видеокарта (нет — откат на процессор); cpu — всегда процессор.
function pickEncoder(mode) {
  if (mode === 'cpu') return CPU_ENCODER;
  return detectHardwareEncoder() || CPU_ENCODER;
}
let encoder = pickEncoder(config.encoderMode);
detectHardwareEncoder(); // узнаём про видеокарту сразу, чтобы настройки её показывали

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
  const escaped = PINGGY().replace(/'/g, "''");
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

// Буквы дисков перебираем проверкой существования: ни одного процесса. Но не
// синхронно: уборка зовёт это раз в 10 минут посреди эфира, а отключённый
// сетевой диск отвечает на проверку секундами — всё это время event loop, а
// с ним и поток, стоял бы. Асинхронные проверки идут параллельно в фоне.
async function listDrives() {
  const буквы = [];
  for (let code = 67; code <= 90; code++) буквы.push(String.fromCharCode(code));
  const есть = await Promise.all(буквы.map(letter => access(`${letter}:\\`).then(() => `${letter}:`, () => null)));
  return есть.filter(Boolean);
}

function saveConfig(next) {
  config = { ...config, ...next };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// Дочитывает то, чего не хватает, не блокируя работу: длительность, кодеки,
// пригодность для Unity. Идёт по одному файлу за раз, чтобы не устраивать
// толпу ffprobe на большом списке.
// Превью хранится как /thumbs/<id>.jpg. Файл мог пропасть: сборщик мусора
// удаляет картинки, чей id больше не совпадает ни с одним треком (так бывало
// после смены id при загрузке шаблона). Тогда в списке висел битый значок.
function thumbFileMissing(item) {
  const m = /^\/thumbs\/([^/?]+)/.exec(item.thumbnail || '');
  return m ? !existsSync(join(THUMB_DIR, decodeURIComponent(m[1]))) : false;
}

// После перезапуска приводим библиотеку в порядок: пропавшие превью создаём
// заново, а битые локальные файлы перепроверяем — fillMissingInfo пометит их
// недоступными. Здоровые треки (есть длительность и превью) не трогаем.
async function repairLibrary() {
  let changed = false;
  for (const item of queue) {
    if (item.local && thumbFileMissing(item)) { item.thumbnail = ''; changed = true; }
  }
  const надоПроверить = queue.filter(item =>
    item.local && (item.unavailable || !item.duration || !item.thumbnail));
  for (const item of надоПроверить) item.probed = false;
  if (changed) saveQueue();
  if (надоПроверить.length) await fillMissingInfo(надоПроверить);
}

async function fillMissingInfo(items) {
  for (const item of items) {
    if (!item.local || item.probed) continue;
    try {
      const сведения = await mediaInfoAsync(item.sourceUrl);
      Object.assign(item, {
        duration: item.duration || сведения.duration || null,
        hasVideo: сведения.hasVideo, hasAudio: сведения.hasAudio,
        videoCodec: сведения.videoCodec, audioCodec: сведения.audioCodec,
        unityCompatible: Boolean(сведения.unityCompatible), probed: true, unavailable: false,
      });
      if ((сведения.hasVideo || сведения.hasAudio) && !item.thumbnail) generateThumbnail(item);
    } catch {
      // ffprobe не прочитал файл — он битый или в неподдерживаемом формате.
      // Помечаем недоступным, чтобы трек краснел в списке и пропускался, а не
      // срывал эфир, когда очередь до него дойдёт.
      item.probed = true; item.unavailable = true;
    }
  }
  saveQueue();
}

function normalizeQueueItem(raw, freshId = false) {
  if (!raw || typeof raw !== 'object' || typeof raw.sourceUrl !== 'string' || !raw.sourceUrl.trim()) return null;
  const local = Boolean(raw.local);
  const sourceUrl = local ? resolve(raw.sourceUrl) : raw.sourceUrl.trim();
  if (local && (!existsSync(sourceUrl) || !statSync(sourceUrl).isFile())) return null;
  if (!local && !validWebUrl(sourceUrl)) return null;
  // Разбор файла тут больше не делается. Условие «нет кодека» истинно для
  // любого mp3, и шаблон из шестидесяти песен превращался в шестьдесят
  // блокирующих запусков ffprobe подряд — процесс замирал на минуты. Файлы
  // разбираются отдельно и без блокировки, сразу после добавления.
  const technical = {};
  return {
    id: freshId ? crypto.randomUUID() : String(raw.id || crypto.randomUUID()),
    title: String(raw.title || (local ? basename(sourceUrl) : sourceUrl)).slice(0, 500), sourceUrl,
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : null,
    thumbnail: String(raw.thumbnail || '').slice(0, 2000), local,
    hasVideo: technical.hasVideo ?? raw.hasVideo !== false, hasAudio: technical.hasAudio ?? raw.hasAudio !== false,
    videoCodec: String(technical.videoCodec || raw.videoCodec || ''), audioCodec: String(technical.audioCodec || raw.audioCodec || ''),
    unityCompatible: Boolean(technical.unityCompatible ?? raw.unityCompatible),
    unavailable: Boolean(raw.unavailable), probed: Boolean(raw.probed),
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
  warmQueueSoon();
}

// Ближайшие ролики готовим заранее, не дожидаясь запуска эфира: тогда переход
// с экрана на видео и первый запуск списка идут из готового файла и происходят
// сразу, а не через ожидание yt-dlp. Пауза нужна, чтобы добавление десятка
// ссылок подряд не запускало прогрев на каждой.
let warmTimer = null;
function warmQueueSoon() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    prefetchQueue(Math.max(0, queueIndex)).catch(() => {});
  }, 1500);
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
        mediaVolume: Math.max(0, Math.min(4, Number(item.settings?.mediaVolume ?? 1))),
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
  fillMissingInfo(restored).catch(() => {});
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
// Журнал подрезается не только при старте: сеанс на неделю раздувал файл
// без всякого предела.
let последняяПодрезка = 0;

function trimDetailLog() {
  if (Date.now() - последняяПодрезка < 600000) return;
  последняяПодрезка = Date.now();
  try {
    if (statSync(DETAIL_LOG_FILE).size < 4 * 1024 * 1024) return;
    const перенос = String.fromCharCode(10);
    const строки = readFileSync(DETAIL_LOG_FILE, 'utf8').split(перенос);
    writeFileSync(DETAIL_LOG_FILE, строки.slice(-4000).join(перенос), 'utf8');
  } catch {}
}

function logDetail(message) {
  trimDetailLog();
  try { appendFileSync(DETAIL_LOG_FILE, `${new Date().toISOString()}  ${message}\n`, 'utf8'); } catch {}
}

function log(message) {
  const line = `${new Date().toLocaleTimeString('ru-RU')}  ${message}`;
  logLines = [...logLines.slice(-99), line];
  console.log(line);
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${message}\n`, 'utf8'); } catch {}
}

// Что сейчас в эфире и на какой секунде — чтобы у фриза было «место».
function streamContext() {
  const item = queue.find(entry => entry.id === currentId);
  return {
    kind: activeKind || 'idle',
    itemId: currentId || '',
    title: item ? item.title : (activeKind === 'screen' ? 'Захват экрана' : ''),
    position: activeKind === 'queue' ? Number(currentSourcePosition().toFixed(1)) : null,
  };
}

// Событие качества эфира (фриз, просадка, коррекция задержки): кладём в
// кольцевой журнал для интерфейса и подробно пишем в файл ошибок с местом.
function recordStreamEvent(kind, detail, extra = {}, contextOverride = null) {
  const context = contextOverride || streamContext();
  const event = { at: Date.now(), kind, detail, ...context, ...extra };
  streamEvents = [...streamEvents.slice(-59), event];
  const место = context.position !== null ? ` · ${context.title || 'трек'} на ${context.position}с` : context.title ? ` · ${context.title}` : '';
  const хвост = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ');
  logDetail(`[эфир] ${kind}: ${detail}${место}${хвост ? ` · ${хвост}` : ''}`);
}

let tunnelGeneration = 0;

function stopPublicTunnel() {
  tunnelGeneration++;
  const children = new Set([...tunnelCandidates, tunnelProcess].filter(Boolean));
  if (tunnelDeadlineTimer) clearTimeout(tunnelDeadlineTimer);
  if (tunnelFallbackTimer) clearTimeout(tunnelFallbackTimer);
  tunnelDeadlineTimer = null;
  tunnelFallbackTimer = null;
  if (tunnelVerifyTimer) clearInterval(tunnelVerifyTimer);
  tunnelVerifyTimer = null; tunnelServes = null;
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
  log(`Публичная ссылка · ${provider} — проверяю, что она реально отдаёт поток…`);
  // Адрес получен, но это ещё не значит, что по нему играет: проверяем сами,
  // как это делает плеер, и перепроверяем — заглушка может появиться и позже.
  tunnelServes = null;
  if (tunnelVerifyTimer) clearInterval(tunnelVerifyTimer);
  setTimeout(verifyTunnelServes, 2500);
  tunnelVerifyTimer = setInterval(verifyTunnelServes, 30000);
  tunnelVerifyTimer.unref?.();
}

// Проверяем публичную ссылку так же, как её увидит плеер: тянем плейлист через
// сам туннель. Настоящий поток начинается с #EXTM3U; страница-предупреждение
// Pinggy или ошибка сети — это HTML или не-200, и тогда честно говорим, что
// ссылка для VRChat не годится, вместо ложного «готово».
async function verifyTunnelServes() {
  const url = tunnelUrl, провайдер = tunnelProvider;
  if (!url || config.outputMode !== 'tunnel') return;
  try {
    const ответ = await fetch(`${url}/stream/live.m3u8`, { redirect: 'follow',
      signal: AbortSignal.timeout(9000), headers: { 'User-Agent': 'LibVLC/3.0 VRCast' } });
    const текст = (await ответ.text()).slice(0, 400);
    if (tunnelUrl !== url) return;
    if (ответ.ok && /#EXTM3U/.test(текст)) {
      if (tunnelServes !== true) log(`Публичная ссылка готова · ${провайдер} — реально отдаёт поток, можно отправлять друзьям`);
      tunnelServes = true; tunnelError = '';
      return;
    }
    const html = /<!doctype|<html/i.test(текст);
    tunnelServes = false;
    tunnelError = провайдер === 'Pinggy'
      ? 'Pinggy показывает страницу-предупреждение вместо потока — в VRChat не заиграет. Выберите Cloudflare или свой сервер (его ссылка постоянная и без заглушек).'
      : html ? `${провайдер} отдаёт страницу, а не поток — для VRChat не годится. Смените туннель или возьмите свой сервер.`
      : `${провайдер}: ссылка не отдаёт поток (ответ ${ответ.status}). Смените туннель или возьмите свой сервер.`;
    log(`Публичная ссылка не отдаёт поток · ${tunnelError}`);
  } catch (error) {
    if (tunnelUrl !== url) return;
    tunnelServes = false;
    tunnelError = `${провайдер}: публичная ссылка не открывается (${String(error.message || error).slice(0, 80)}). Сеть блокирует туннель — смените его или возьмите свой сервер.`;
    log(`Публичная ссылка не открывается · ${tunnelError}`);
  }
}

// Сообщение о неудаче с учётом выбора: если человек сам указал провайдера,
// честно называем его — «в вашей сети он недоступен», а не общая фраза.
function tunnelFailMessage() {
  const имя = { cloudflare: 'Cloudflare', pinggy: 'Pinggy', localhostrun: 'localhost.run' }[config.tunnelProvider];
  return имя
    ? `«${имя}» не отвечает — в вашей сети он, похоже, недоступен. Выберите «Авто» или другой туннель.`
    : 'Не удалось подключить ни один публичный канал. Отключите VPN/фильтр или выберите другой туннель.';
}

function trackTunnelChild(child, provider) {
  // Туннель отдаёт поток зрителям через интернет — он часть эфира.
  onAir(child);
  tunnelCandidates.add(child);
  child.on('error', error => {
    tunnelCandidates.delete(child);
    if (!tunnelUrl && !tunnelCandidates.size) { tunnelState = 'error'; tunnelError = error.message; log(`Публичный туннель: ${error.message}`); }
  });
  child.on('close', code => {
    tunnelCandidates.delete(child);
    if (tunnelProcess !== child) {
      if (!tunnelUrl && !tunnelCandidates.size && !stopping && !tunnelFallbackTimer) { tunnelState = 'error'; tunnelError = tunnelFailMessage(); }
      return;
    }
    const stoppedProvider = tunnelProvider;
    tunnelProcess = null; tunnelUrl = ''; tunnelProvider = '';
    if (stoppedProvider === 'Pinggy') stopPinggyDaemon();
    if (stopping || shuttingDown || config.outputMode !== 'tunnel') { tunnelState = 'idle'; return; }
    tunnelState = 'error'; tunnelError = `Публичный туннель остановился${code === null ? '' : ` (код ${code})`}.`;
    log(tunnelError);
    setTimeout(() => { if (!stopping && !shuttingDown && config.outputMode === 'tunnel') startPublicTunnel(); }, 1800);
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

// Туннель по SSH через localhost.run. Ему не нужен свой бинарник — хватает
// plink, который у нас уже есть для своих серверов. Главное: он проходит там,
// где cloudflared глухо блокируется (замер на сети с VPN: cloudflared не
// поднимает канал ни по http2, ни по quic, а этот отдаёт адрес за 5 секунд).
const LHR_HOST = 'localhost.run';

async function lhrHostKey() {
  if (lhrKnownKey) return lhrKnownKey;
  const проба = await spawnCollect(PLINK(), ['-ssh', '-batch', '-P', '22', 'nokey@' + LHR_HOST, 'exit'], 20000);
  const ключ = `${проба.stdout || ''}${проба.stderr || ''}`.match(/SHA256:[A-Za-z0-9+/=]+/);
  lhrKnownKey = ключ ? ключ[0] : '';
  return lhrKnownKey;
}

async function startSshTunnelCandidate() {
  if (!PLINK()) return;
  const поколение = tunnelGeneration;
  const ключ = await lhrHostKey();
  // Ключ ждём до 20 секунд. Если за это время туннель выключили (ушли в «Этот
  // ПК» или сменили провайдера), подключаться уже нельзя: раньше plink всё
  // равно поднимался, и публичная ссылка открывалась в режиме, где её не просили.
  if (поколение !== tunnelGeneration || config.outputMode !== 'tunnel') return;
  if (!ключ) { log('SSH-туннель: сервер не отдал ключ, пропускаю'); return; }
  if (stopping || tunnelUrl) return;
  log('SSH-туннель: подключаюсь');
  const child = trackTunnelChild(spawn(PLINK(), ['-ssh', '-batch', '-no-antispoof', '-hostkey', ключ,
    '-R', `80:127.0.0.1:${PORT}`, 'nokey@' + LHR_HOST], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), 'localhost.run');
  let буфер = '';
  const смотреть = chunk => {
    буфер = (буфер + chunk).slice(-8000);
    const адрес = буфер.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i);
    if (адрес) activatePublicTunnel(child, 'localhost.run', адрес[0]);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', смотреть); child.stderr.on('data', смотреть);
}

function startPublicTunnel() {
  if (config.outputMode !== 'tunnel' || tunnelProcess || tunnelCandidates.size) return;
  // Не бросаем: функцию зовут и из таймеров (переподключение, смена режима),
  // а необработанный throw в setTimeout ронял бы весь сервер. Просто честно
  // ставим состояние ошибки.
  if (!tools.cloudflared && !tools.pinggy && !PLINK()) {
    tunnelState = 'error'; tunnelError = 'Компоненты публичной ссылки не найдены.';
    return;
  }
  tunnelUrl = ''; tunnelProvider = ''; tunnelState = 'starting'; tunnelError = '';
  // Провайдер можно выбрать; «Авто» поднимает всех сразу — побеждает тот, кто
  // первым отдал адрес. Раньше Pinggy ждал Cloudflare 12 секунд, а в сетях с
  // фильтром Cloudflare не подключается никогда — ссылка появлялась через
  // минуту и с ошибкой. Если выбранного провайдера нет — откатываемся к авто.
  let провайдер = config.tunnelProvider || 'auto';
  if (провайдер === 'cloudflare' && !tools.cloudflared) провайдер = 'auto';
  if (провайдер === 'pinggy' && !tools.pinggy) провайдер = 'auto';
  if (провайдер === 'localhostrun' && !PLINK()) провайдер = 'auto';
  if (tools.cloudflared && (провайдер === 'auto' || провайдер === 'cloudflare')) startCloudflareCandidate();
  if (провайдер === 'auto' || провайдер === 'localhostrun') startSshTunnelCandidate().catch(error => logDetail(`SSH-туннель: ${error.message}`));
  // Pinggy — крайний случай, а не гонщик наравне: бесплатный подменяет поток
  // страницей-предупреждением, и в VRChat такая ссылка не играет (у друга
  // Cloudflare был заблокирован, Pinggy выигрывал гонку — и «якобы работает,
  // а в игре пусто»). Поэтому в «Авто» даём Cloudflare и localhost.run фору,
  // а Pinggy поднимаем только если за 6 секунд никто не отозвался.
  if (провайдер === 'pinggy' && tools.pinggy) startPinggyCandidate();
  else if (провайдер === 'auto' && tools.pinggy) {
    tunnelFallbackTimer = setTimeout(() => { if (!tunnelUrl && !stopping && config.outputMode === 'tunnel') startPinggyCandidate(); }, 6000);
  }
  // Один выбранный туннель ждём меньше: если он не отозвался за 18 секунд, он в
  // этой сети недоступен. «Авто» гоняет несколько сразу, ему даём больше.
  const дедлайн = провайдер === 'auto' ? 35000 : 18000;
  tunnelDeadlineTimer = setTimeout(() => {
    if (tunnelUrl || tunnelState !== 'starting') return;
    for (const child of tunnelCandidates) child.kill('SIGTERM');
    stopPinggyDaemon();
    tunnelCandidates = new Set(); tunnelState = 'error';
    tunnelError = tunnelFailMessage();
    log(tunnelError);
  }, дедлайн);
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
    const child = inBackground(spawn(PLINK(), ['-ssh', '-batch', '-P', String(server.sshPort || 22), '-l', String(server.user || 'root'),
      server.host, 'exit'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
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
    const child = inBackground(spawn(PLINK(), sshArgs(server, passwordFile), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
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
let outputSwitchTimer = null;
let tunnelSwitchTimer = null;
// Доступность каждого сохранённого сервера: {id: true|false}. Проверяем все, а
// не только активный — тогда в списке недоступный сервер сразу краснеет, а не
// висит с вечным «подключаюсь».
let serverReach = {};
let serverProbeBusy = false;
async function probeAllServers() {
  if (serverProbeBusy) return;
  serverProbeBusy = true;
  try {
    const servers = savedServers();
    const результат = {};
    await Promise.all(servers.map(async s => {
      const порт = Number(s.rtspPort) || SERVER_RTSP_PORT;
      // Спрашиваем именно RTSP (OPTIONS), а не голый TCP: за VPN коннект
      // проходит даже к выключенному серверу, и тот ложно горел зелёным.
      результат[s.id] = await probeRtspServer(s.host, порт);
    }));
    serverReach = результат; // пересборка заодно выкидывает удалённые
    remoteReachable = config.outputMode === 'remote' ? (результат[config.activeServerId] ?? null) : null;
  } finally { serverProbeBusy = false; }
}
function watchRemoteServer() {
  probeAllServers();
  setInterval(probeAllServers, 15000).unref();
}

// Безымянный сервер раньше подписывался собственным адресом — и в списке
// выходило «31.59.102.186», а строкой ниже тот же адрес в ссылке. Теперь ему
// достаётся кошачье имя: короткое, запоминается с первого взгляда и сразу
// отличает «Барсика» от «Рыжика» лучше, чем два похожих IP.
const ИМЕНА_СЕРВЕРОВ = ['Барсик', 'Мурзик', 'Рыжик', 'Васька', 'Тишка', 'Пушок', 'Дымок', 'Персик',
  'Бублик', 'Тимофей', 'Маркиз', 'Захар', 'Тихон', 'Филя', 'Сёма', 'Кузя', 'Матвей', 'Борис',
  'Степан', 'Гоша', 'Яша', 'Тюбик', 'Батон', 'Компот'];

function randomServerName() {
  const занято = new Set(savedServers().map(item => String(item.name || '').toLowerCase()));
  const свободные = ИМЕНА_СЕРВЕРОВ.filter(имя => !занято.has(имя.toLowerCase()));
  if (свободные.length) return свободные[Math.floor(Math.random() * свободные.length)];
  return `Сервер ${savedServers().length + 1}`;
}

// Правка уже добавленного сервера: имя и адрес. Пароль здесь не нужен — ключ
// публикации уже лежит у нас, и переезд с голого IP на домен ничего не ломает.
function editServer(id, body) {
  const server = savedServers().find(item => item.id === String(id));
  if (!server) throw new Error('Сервер не найден.');
  const next = { ...server };
  if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 60) || server.name;
  if (body.host !== undefined) {
    const адрес = String(body.host).trim().replace(/^\w+:\/\//, '').split(/[/:]/)[0];
    if (!адрес) throw new Error('Укажите адрес сервера.');
    if (!/^[a-z0-9.-]+$/i.test(адрес)) throw new Error('Адрес сервера: только буквы, цифры, точки и дефис.');
    next.host = адрес;
  }
  if (body.permanentLink !== undefined) {
    next.permanentLink = Boolean(body.permanentLink);
    if (next.permanentLink) next.channel = 'live';
    else if (!next.channel || next.channel === 'live') next.channel = randomChannel();
  }
  saveConfig({ servers: savedServers().map(item => item.id === next.id ? next : item) });
  if (config.outputMode === 'remote' && config.activeServerId === next.id) {
    // Сбрасываем и старую пометку об отказе канала: после смены адреса или
    // режима ссылки подключаемся заново с чистого листа, без залежавшегося
    // «сервер настроен по-старому».
    remoteReachable = null; remoteChannelRejected = false;
    probeAllServers();
    stopRtspPush();
    if (relayProcess) startRtspPush();
  }
  log(`Сервер «${next.name}»: адрес ${next.host}`);
  return next;
}

// Подключение сервера, который уже настроен. Пароль root тут не нужен и не
// уместен: при установке сервер выдал ключ публикации, он лежит у него в
// /opt/vrcast-relay/publish.key — этим ключом хозяин делится с друзьями, и
// каждый из них вещает через ту же машину, ничего на ней не трогая.
async function attachServer(body) {
  const адрес = String(body.host || '').trim().replace(/^\w+:\/\//, '').split(/[/:]/)[0];
  const ключ = String(body.key || '').trim();
  if (!адрес) throw new Error('Укажите адрес сервера.');
  if (!/^[a-z0-9.-]+$/i.test(адрес)) throw new Error('Адрес сервера: только буквы, цифры, точки и дефис.');
  if (!ключ) throw new Error('Укажите ключ публикации — его выдаёт сервер при установке.');
  const порт = Number(body.rtspPort) || SERVER_RTSP_PORT;
  const канал = String(body.channel || 'live').replace(/[^a-z0-9_-]/gi, '') || 'live';
  // Проверяем, что там вообще кто-то отвечает: адрес с опечаткой не должен
  // молча ложиться в список и всплывать только при запуске эфира.
  const отвечает = await probeServer(адрес, порт);
  if (!отвечает) throw new Error(`${адрес}:${порт} не отвечает. Проверьте адрес или настройте сервер заново.`);
  const прежний = savedServers().find(item => item.host === адрес);
  const entry = {
    id: прежний?.id || crypto.randomUUID(),
    name: String(body.name || прежний?.name || '').trim().slice(0, 60) || randomServerName(),
    host: адрес, sshPort: прежний?.sshPort || 22, user: прежний?.user || 'root', hostKey: прежний?.hostKey || '',
    channel: канал, publicIp: адрес, rtspPort: порт, hlsPort: прежний?.hlsPort || 0, publishKey: ключ,
    permanentLink: прежний?.permanentLink ?? true,
    addedAt: прежний?.addedAt || new Date().toISOString(),
  };
  saveConfig({ servers: [...savedServers().filter(item => item.id !== entry.id), entry].slice(0, 20), activeServerId: entry.id });
  stopRtspPush();
  if (relayProcess && config.outputMode === 'remote') startRtspPush();
  log(`Сервер подключён: ${entry.name} · ${entry.host}`);
  return entry;
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
    name: String(body.name || existing?.name || '').trim().slice(0, 60) || randomServerName(),
    host: hostName, sshPort: server.sshPort, user: server.user, hostKey: server.hostKey,
    channel: String(body.channel || existing?.channel || 'live').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'live',
    publicIp: result[1], rtspPort: Number(result[2]), hlsPort: Number(result[3]), publishKey: result[4],
    permanentLink: existing?.permanentLink ?? true,
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

// Случайный путь для «временной» ссылки: буква впереди, чтобы путь RTSP был
// заведомо корректным. Такой адрес не угадать, и его можно сменить в любой миг.
function randomChannel() {
  return 's' + crypto.randomBytes(5).toString('hex');
}

// Меняем режим ссылки у сервера. Постоянная — путь всегда «live», раздал один
// раз и забыл. Временная — случайный путь, который хозяин может сбросить кнопкой.
function setServerLinkMode(id, { permanent, regenerate = false } = {}) {
  const server = savedServers().find(item => item.id === String(id));
  if (!server) throw new Error('Сервер не найден.');
  const next = { ...server };
  if (permanent !== undefined) next.permanentLink = Boolean(permanent);
  if (next.permanentLink === false) {
    if (regenerate || !next.channel || next.channel === 'live') next.channel = randomChannel();
  } else {
    next.channel = 'live';
  }
  saveConfig({ servers: savedServers().map(item => item.id === next.id ? next : item) });
  if (config.outputMode === 'remote' && config.activeServerId === next.id) {
    remoteReachable = null; remoteChannelRejected = false;
    stopRtspPush();
    if (relayProcess) startRtspPush();
  }
  log(`Сервер «${next.name}»: ссылка ${next.permanentLink === false ? 'временная' : 'постоянная'}`);
  return next;
}

// «Белым» считаем только адрес, по которому машину реально видно из интернета.
// Кроме RFC1918 отсекаем и то, что наружу не выходит: CGNAT провайдера,
// тестовые диапазоны (в них часто сидят адаптеры VPN — тот же Koala Clash),
// multicast и прочее зарезервированное. Иначе адрес VPN выдавался бы за белый.
function isPrivateIp(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT провайдера
  if (a === 198 && (b === 18 || b === 19)) return true; // тестовый диапазон / VPN
  if (a >= 224) return true; // multicast и зарезервированное
  return false;
}

// Прямые ссылки на локальный канал. Достаточно одной ссылки для своей сети —
// берём домашний адрес (192.168/10), а не виртуальные адаптеры WSL/Hyper-V.
// Белый IP (задан вручную или реальный публичный на карте) даёт ссылку через
// интернет — она нужна не всем, поэтому появляется только когда есть.
function directLinks() {
  const ips = [...new Set(getLanAddresses())].filter(ip => /^[a-z0-9.:-]+$/i.test(ip));
  const ручной = String(config.whiteIp || '').trim();
  const локальные = ips.filter(ip => isPrivateIp(ip) && ip !== ручной);
  const домашний = локальные.find(ip => /^(192\.168\.|10\.)/.test(ip)) || локальные[0] || '';
  const белыйIp = ручной || ips.find(ip => !isPrivateIp(ip)) || '';
  return {
    local: домашний ? `rtspt://${домашний}:${RTSP_PORT}/live` : '',
    white: белыйIp ? `rtspt://${белыйIp}:${RTSP_PORT}/live` : '',
  };
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
    };
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


// Загрузка с докачкой. Оборванная связь на середине больше не означает
// «качать заново»: недокачанный кусок остаётся на диске, и следующая попытка
// просит у сервера продолжение с этого места. Пишем сразу в файл, а не
// копим в памяти — иначе на десятках мегабайт программа раздувалась.
async function downloadWithResume(url, target, onProgress, попыток = 4) {
  let последняя = '';
  for (let попытка = 1; попытка <= попыток; попытка++) {
    let уже = 0;
    try { уже = statSync(target).size; } catch {}
    const headers = { 'User-Agent': 'VRCast-Bridge' };
    if (уже > 0) headers.Range = `bytes=${уже}-`;
    try {
      const ответ = await fetch(url, { headers, signal: AbortSignal.timeout(600000) });
      // 206 — сервер отдаёт продолжение, 200 — не умеет и шлёт файл целиком.
      // 416: на диске уже лежит весь файл (или больше), продолжать нечего —
      // начинаем заново, иначе все попытки упираются в один и тот же отказ.
      if (ответ.status === 416) { rmSync(target, { force: true }); continue; }
      const продолжение = ответ.status === 206 && уже > 0;
      if (!ответ.ok) throw new Error(`сервер ответил ${ответ.status}`);
      if (!продолжение) уже = 0;
      const остаток = Number(ответ.headers.get('content-length')) || 0;
      const всего = продолжение ? уже + остаток : остаток;
      const файл = createWriteStream(target, продолжение ? { flags: 'a' } : { flags: 'w' });
      let принято = уже;
      let последнийПроцент = -1;
      for await (const кусок of ответ.body) {
        // Ждём и ошибку тоже: на переполненном диске drain не придёт никогда,
        // и загрузка висела бы вечно.
        if (!файл.write(кусок)) await new Promise((ok, bad) => { файл.once('drain', ok); файл.once('error', bad); });
        принято += кусок.length;
        const процент = всего ? Math.round(принято / всего * 100) : 0;
        if (процент !== последнийПроцент) { последнийПроцент = процент; onProgress?.(принято, всего); }
      }
      await new Promise((resolvePromise, reject) => файл.end(error => error ? reject(error) : resolvePromise()));
      if (всего && принято < всего) throw new Error('связь оборвалась');
      return;
    } catch (ошибка) {
      последняя = ошибка.message;
      if (попытка < попыток) {
        logDetail(`Загрузка ${url.slice(0, 80)}: ${последняя}, продолжу с места обрыва (попытка ${попытка + 1})`);
        await new Promise(r => setTimeout(r, 1500 * попытка));
      }
    }
  }
  throw new Error(последняя || 'не удалось скачать');
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
      // tag задаёт конкретный релиз (у BtbN сборки лежат в катящемся теге
      // «latest»); без него берём тот, что помечен последним.
      const relApi = source.tag
        ? `https://api.github.com/repos/${source.github}/releases/tags/${source.tag}`
        : `https://api.github.com/repos/${source.github}/releases/latest`;
      const release = await fetch(relApi,
        { headers: { 'User-Agent': 'VRCast-Bridge' }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
      url = (release.assets || []).find(item => source.asset.test(item.name))?.browser_download_url;
      if (!url) throw new Error('нет подходящего файла в релизе');
    }
    log(`Догружаю компонент: ${source.label}`);
    const temporary = join(TOOL_DIR, `${name}.part`);
    await downloadWithResume(url, temporary, (received, total) => {
      toolDownloads = { ...toolDownloads, [name]: { state: 'work',
        percent: total ? Math.round(received / total * 100) : 0, label: source.label,
        doneMb: Math.round(received / 1048576), totalMb: Math.round(total / 1048576) } };
    });
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
    await refreshToolsAsync();
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

async function refreshToolsAsync() {
  const проба = async (name, args) => (await spawnCollect(name, args, 5000).catch(() => null))?.status === 0;
  tools.ffmpeg = await проба('ffmpeg', ['-version']);
  // ytdlpPath() в конце возвращает 'yt-dlp' — оно всегда истинно, поэтому
  // проверяем именно наличие файла, а не путь.
  tools.ytdlp = existsSync(YTDLP_UPDATED) || existsSync(join(DATA_DIR, 'tools', 'yt-dlp.exe')) || existsSync(YTDLP_BUNDLED);
  tools.cloudflared = Boolean(CLOUDFLARED());
  tools.pinggy = Boolean(PINGGY());
  tools.mediamtx = Boolean(MEDIAMTX());
  tools.plink = Boolean(PLINK());
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
  // Свою папку с ffmpeg добавляем в PATH сразу — это не требует запуска утилит.
  // А сами проверки версий делаем без блокировки event loop: sync-вариант
  // тормозил старт на секунду (yt-dlp распаковывается ~1 с на запуск).
  if (existsSync(join(TOOL_DIR, 'ffmpeg.exe')) && !process.env.PATH.includes(TOOL_DIR)) {
    process.env.PATH = `${TOOL_DIR};${process.env.PATH}`;
  }
  await refreshToolsAsync();
  const нужно = [];
  if (!existsSync(join(TOOL_DIR, 'yt-dlp.exe')) && !existsSync(YTDLP_UPDATED)) нужно.push('yt-dlp.exe');
  if (!tools.mediamtx) нужно.push('mediamtx.exe');
  if (!tools.ffmpeg) нужно.push('ffmpeg.exe');
  if (!tools.cloudflared) нужно.push('cloudflared.exe');
  for (const name of нужно) await downloadTool(name);
  if (нужно.length) {
    await refreshToolsAsync();
    if (tools.mediamtx && !mediaMtxProcess) startMediaMtx();
    if (tools.ffmpeg && !relayProcess) { try { ensureRelay(streamProfile('queue')); } catch {} }
  }
}

let updateRetryTimer = null;

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
    // Не качаем сразу: раньше загрузка стартовала сама, ещё до того как человек
    // нажал «Обновить», — выглядело криво. Теперь запоминаем ссылку, а качаем
    // и ставим по кнопке (см. startUpdateInstall).
    updateState = { ...updateState, available: true, version, notes: String(release.body || '').slice(0, 400),
      assetUrl: asset.browser_download_url, assetSize: Number(asset.size) || 0 };
    log(`Доступна новая версия ${version} — нажмите «Обновить», чтобы скачать и поставить`);
  } catch (error) {
    updateState = { ...updateState, checked: true, error: error.message };
    logDetail(`Проверка обновления: ${error.message}`);
    // Интернет мог просто моргнуть. Пробуем ещё раз через десять минут,
    // иначе до перезапуска программы обновление так и останется недоступным.
    if (!updateRetryTimer) {
      updateRetryTimer = setTimeout(() => { updateRetryTimer = null; checkForUpdate(); }, 600000);
      updateRetryTimer.unref();
    }
  }
}

// Читаем ответ кусками и считаем мегабайты: раньше файл забирался целиком
// одним вызовом, и полсотни мегабайт тянулись при полностью немом окне —
// «скачиваю…» без единой цифры и без понятия, сколько ещё ждать.
async function downloadUpdate(url, expectedSize) {
  try {
    mkdirSync(UPDATE_DIR, { recursive: true });
    const temporary = `${UPDATE_FILE}.part`;
    const totalMb = Math.round((expectedSize || 0) / 1048576);
    await downloadWithResume(url, temporary, (принято, всего) => {
      updateState = { ...updateState, percent: всего ? Math.round(принято / всего * 100) : 0,
        doneMb: Math.round(принято / 1048576), totalMb: Math.round((всего || expectedSize || 0) / 1048576) };
    });
    if (expectedSize && statSync(temporary).size !== expectedSize) {
      rmSync(temporary, { force: true });
      throw new Error('файл скачался не полностью');
    }
    const подпись = await проверитьПодпись(temporary);
    if (!подпись.ok) {
      rmSync(temporary, { force: true });
      throw new Error(`подпись не совпала (${подпись.причина})`);
    }
    rmSync(UPDATE_FILE, { force: true });
    renameSync(temporary, UPDATE_FILE);
    updateState = { ...updateState, ready: true, percent: 100, doneMb: totalMb, totalMb };
    log(`Обновление ${updateState.version} готово к установке`);
  } catch (error) {
    updateState = { ...updateState, error: error.message, percent: 0 };
    log(`Не удалось скачать обновление: ${error.message}`);
    logDetail(`Загрузка обновления: ${error.message}`);
  }
}

// Совпадения размера мало: он ничего не говорит о том, чей это файл. Смотрим,
// что скачанное подписано тем же издателем, что и сама программа. Полного
// доверия к цепочке сертификатов здесь нет (сертификат свой), но подменить
// файл на чужой или неподписанный уже не выйдет.
const ИЗДАТЕЛЬ = 'CN=VRCast Bridge, O=VRCast Bridge';

async function проверитьПодпись(файл) {
  const скрипт = `(Get-AuthenticodeSignature -LiteralPath '${файл.replace(/'/g, "''")}') | `
    + 'ForEach-Object { $_.Status.ToString() + [char]124 + $_.SignerCertificate.Subject }';
  // Powershell запускаем с чистым PSModulePath: у собранной программы он в
  // унаследованном окружении бывал пустым/битым, и модуль Microsoft.PowerShell
  // .Security не подгружался — Get-AuthenticodeSignature падал «команда найдена
  // в модуле, но не может загрузиться», подпись «не проверялась», обновление
  // срывалось. Системный путь к модулям всегда рабочий.
  const модули = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
  const опции = { env: { ...process.env, PSModulePath: модули } };
  // Свежескачанный 50-МБ exe Windows Defender сразу берёт на проверку и держит
  // файл открытым — Get-AuthenticodeSignature в этот момент не может его
  // прочитать и молча отдаёт пустоту («не удалось проверить»), из-за чего
  // обновление срывалось. Поэтому повторяем несколько раз с паузой: как только
  // антивирус отпускает файл, подпись читается.
  let строка = '';
  for (let попытка = 0; попытка < 6; попытка++) {
    const результат = await spawnCollect('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', скрипт], 25000, опции).catch(() => null);
    строка = String(результат?.stdout || '').trim();
    if (строка) break;
    logDetail(`Проверка подписи (попытка ${попытка + 1}): status=${результат?.status} stderr=${String(результат?.stderr || '').slice(0, 200)}`);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  if (!строка) return { ok: false, причина: 'не удалось проверить (файл занят антивирусом)' };
  const [состояние, издатель] = строка.split(String.fromCharCode(124));
  if (состояние === 'NotSigned') return { ok: false, причина: 'файл не подписан' };
  if (!String(издатель || '').includes('VRCast Bridge')) return { ok: false, причина: 'чужой издатель' };
  return { ok: true, причина: состояние };
}

// Сценарий подмены: ждёт закрытия программы, ставит новый файл и запускает его.
function applyUpdate() {
  const target = process.env.VRCAST_EXE;
  if (!target) throw new Error('Обновление доступно только в собранной программе.');
  if (!updateState.ready || !existsSync(UPDATE_FILE)) throw new Error('Обновление ещё не скачано.');
  const script = join(UPDATE_DIR, 'apply-update.cmd');
  const logFile = join(UPDATE_DIR, 'apply-update.log');
  const имя = basename(target);
  // Раньше скрипт ЖДАЛ, пока «VRCast Bridge.exe» закроется сам. Но при обновлении
  // сервер (node) завершался, а окно-оболочка оставалось открытым — скрипт ждал
  // его вечно и подмена не происходила («кнопка зависает»). А если оболочка
  // всё же закрывалась, exe ещё был занят долю секунды, copy без повтора молча
  // падал — программа перезапускалась старой («не обновилось»). Теперь: сами
  // закрываем оболочку, копируем с повтором, пока файл не освободится, и всё
  // пишем в лог — чтобы неудача больше не была немой.
  writeFileSync(script, [
    '@echo off',
    'setlocal EnableExtensions',
    `set "LOG=${logFile}"`,
    '> "%LOG%" echo [%date% %time%] запуск установки',
    'timeout /t 1 /nobreak >nul',
    `taskkill /f /im "${имя}" >nul 2>&1`,
    '>> "%LOG%" echo закрыл оболочку (код %errorlevel%)',
    'set /a n=0',
    ':copy',
    'timeout /t 1 /nobreak >nul',
    `copy /y "${UPDATE_FILE}" "${target}" >nul 2>&1`,
    'if not errorlevel 1 goto done',
    'set /a n+=1',
    '>> "%LOG%" echo попытка %n%: файл занят, жду',
    'if %n% lss 25 goto copy',
    '>> "%LOG%" echo НЕ УДАЛОСЬ: файл так и не освободился',
    'goto end',
    ':done',
    '>> "%LOG%" echo скопировано, запускаю новую версию',
    `start "" "${target}"`,
    ':end',
    `del "%~f0"`,
    '',
  ].join('\r\n'), 'utf8');
  // Запускаем не как дочерний процесс, а через WMI: обычный spawn попадает в
  // группу процессов приложения (она гасит всех при закрытии оболочки), и
  // скрипт умирал ровно в момент подмены exe. Процесс от WmiPrvSE в группу не
  // входит и переживает закрытие.
  const командная = `cmd /c "${script}"`.replace(/'/g, "''");
  const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${командная}'} | Out-Null`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, stdio: 'ignore' }).unref();
  log(`Устанавливаю версию ${updateState.version} и перезапускаюсь`);
}

// Скачать (если ещё не скачано) и поставить — по кнопке «Обновить». Скачивание
// идёт в фоне, прогресс виден в статусе; когда файл готов и подпись сошлась,
// подменяем exe и перезапускаемся.
async function startUpdateInstall() {
  if (installingUpdate) return;
  if (!process.env.VRCAST_EXE) throw new Error('Обновление доступно только в собранной программе.');
  if (!updateState.available) throw new Error('Обновлений нет.');
  installingUpdate = true;
  updateState = { ...updateState, installing: true, error: '' };
  try {
    if (!updateState.ready) {
      if (!updateState.assetUrl) throw new Error('Ссылка на обновление потерялась — проверьте обновления заново.');
      await downloadUpdate(updateState.assetUrl, updateState.assetSize || 0);
    }
    if (!updateState.ready) { installingUpdate = false; updateState = { ...updateState, installing: false }; return; }
    applyUpdate();
    setTimeout(() => { stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); server.close(() => process.exit(0)); }, 400);
  } catch (error) {
    installingUpdate = false;
    updateState = { ...updateState, installing: false, error: error.message };
    log(`Установка обновления: ${error.message}`);
  }
}

function status() {
  const speed = Number(config.playbackSpeed) || 1;
  const runningElapsed = currentStartedAt ? Math.max(0, (Date.now() - currentStartedAt) / 1000) * speed : 0;
  const elapsed = queuePaused ? pausedPosition : sourcePosition + runningElapsed;
  return {
    appVersion: APP_VERSION, tools, toolDownloads, disk: { freeMb: freeDiskMb, totalMb: totalDiskMb, low: freeDiskMb !== null && freeDiskMb < 3000 }, running: Boolean(activeKind), activeKind, currentId, queue, templates: templateSummaries(),
    progress: currentId ? { elapsed: currentDuration ? Math.min(elapsed, currentDuration) : elapsed, duration: currentDuration } : null,
    playback: { paused: queuePaused, busy: playbackBusy, buffering: Boolean(currentId && mediaCacheJobs.has(currentId)), revision: playbackRevision,
      speed, loopMode: config.loopMode || 'once', canSeek: activeKind === 'queue' && Boolean(currentDuration) },
    cache: { ready: cachedReadyCount(), total: queue.length, downloading: [...mediaCacheJobs.keys()],
      root: config.cacheRoot || '', path: mediaCacheDir(), drives: storageInfo.drives, sizeMb: storageInfo.sizeMb,
      limitGb: Number(config.cacheLimitGb) || 0 },
    audio: { levelDb: audioLevelDb, silent: audioLevelDb < -70 },
    performance: { encoder: encoder.label, hardware: encoder.hardware, continuousQueue: true, outputProfile: relayProfile,
      encoderMode: config.encoderMode || 'auto', gpuLabel: hardwareEncoder ? hardwareEncoder.label : '',
      streamClock: Number(streamTimestamp().toFixed(3)),
      realtimeRatio: Number(hlsHealth.realtimeRatio.toFixed(2)), segmentAge: hlsHealth.segmentAge === null ? null : Number(hlsHealth.segmentAge.toFixed(1)),
      // Задержка живого края (та, что раньше росла до 22с) и журнал качества:
      // фризы с местом, просадки, автоматические сбросы задержки.
      // Наружу отдаём величину, а не знак: отставание потока — такая же
      // задержка, как убежавший вперёд край, а окно показывало её только со
      // знаком «+» и молчало про самый частый случай — захват экрана.
      liveLatencySec: Number(Math.abs(liveLatency || 0).toFixed(1)),
      maxLiveLatencySec: Number((maxLiveLatency || 0).toFixed(1)),
      quality: { ...qualityStats, currentFreezeSec: freezeState ? Number(((Date.now() - freezeState.startedAt) / 1000).toFixed(1)) : 0 },
      events: streamEvents.slice(-12) },
    stream: { ready: hlsHealth.ready, segmentCount: hlsHealth.segmentCount,
      state: !relayProcess ? 'offline' : hlsHealth.ready ? 'ready' : hlsHealth.segmentAge !== null && hlsHealth.segmentAge >= 4 ? 'stalled' : 'starting' },
    compatibility: { unity: unityCompatibility() },
    // linkReady — единственный честный признак «ссылку уже можно вставлять».
    linkReady: config.outputMode === 'remote' ? remoteChannelLive : channelLive,
    rtsp: { available: Boolean(mediaMtxProcess && rtspPushProcesses.has('local')), live: channelLive, url: rtspAddress(),
      lanUrls: getLanAddresses().map(ip => `rtspt://${ip}:${RTSP_PORT}/live`),
      direct: directLinks(), whiteIp: config.whiteIp || '',
      remote: config.outputMode === 'remote'
        ? { configured: Boolean(remoteRtspTarget()), live: remoteChannelLive, pushing: rtspPushProcesses.has('remote'), reachable: remoteReachable,
            channel: remoteRtspTarget()?.channel || '', channelRejected: remoteChannelRejected,
            url: remoteRtspTarget()?.playUrl || '' }
        : null },
    tunnel: { state: tunnelState, ready: Boolean(tunnelUrl) && tunnelServes !== false, provider: tunnelProvider,
      serves: tunnelServes, verifying: Boolean(tunnelUrl) && tunnelServes === null,
      expiresInMinutes: tunnelProvider === 'Pinggy' ? 60 : null, url: tunnelUrl ? `${tunnelUrl}/stream/live.m3u8` : '', error: tunnelError },
    config: { ...config,
      servers: savedServers().map(item => ({ id: item.id, name: item.name, host: item.host,
        rtspPort: item.rtspPort, addedAt: item.addedAt, reachable: serverReach[item.id] ?? null,
        permanentLink: item.permanentLink !== false, channel: item.channel || 'live', publishKey: undefined })) },
    playbackUrl: publicAddress(),
    webrtcUrl: mediaMtxProcess ? `http://127.0.0.1:${WEBRTC_PORT}/live/whep` : '',
    localPlaybackUrl: `http://127.0.0.1:${PORT}/stream/live.m3u8`,
    logs: logLines, logFolder: DATA_DIR, update: updateState,
  };
}

// ponytail: грубый счётчик для UI — наличие каталога кеша, без обхода файлов.
// Точную проверку содержимого делает cachedMediaPath в момент воспроизведения.
// Что уже лежит в кеше. Раньше на каждый запрос состояния (а их 1,25 в
// секунду, круглосуточно) шёл обход каталога кеша синхронным readdirSync —
// прямо во время эфира. Теперь набор обновляется по событиям: при уборке,
// после удачной загрузки и при удалении трека.
let готовыеВКеше = new Set();

function обновитьГотовые() {
  try { готовыеВКеше = new Set(readdirSync(mediaCacheDir())); } catch { готовыеВКеше = new Set(); }
}

function cachedReadyCount() {
  return queue.filter(item => item.local || (готовыеВКеше.has(item.id) && !mediaCacheJobs.has(item.id))).length;
}

// Адреса сетевых карт помним 15 секунд. networkInterfaces() на Windows —
// синхронный опрос всех адаптеров (~4 мс, а с VPN-адаптерами и дольше), и
// окно звало его дважды на каждый запрос состояния, то есть дважды в 0,8 с,
// круглосуточно — прямо в event loop, через который идёт эфир. Адреса
// меняются редко, а 15 секунд запаздывания в списке ссылок никто не заметит.
let lanAddresses = null;
let lanAddressesAt = 0;

function getLanAddresses() {
  if (lanAddresses && Date.now() - lanAddressesAt < 15000) return lanAddresses;
  lanAddresses = Object.values(networkInterfaces()).flat().filter(Boolean)
    .filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
  lanAddressesAt = Date.now();
  return lanAddresses;
}

function cleanHls() {
  hlsHealth = { ready: false, realtimeRatio: 0, segmentAge: null, segmentCount: 0, latest: '', updatedAt: 0 };
  // Канал начинается заново — фризы не ловим, пока он не выйдет на режим, иначе
  // сам разгон в начале засчитывался как фриз.
  streamWasReady = false;
  freezeState = null;
  rmSync(HLS_DIR, { recursive: true, force: true });
  mkdirSync(HLS_DIR, { recursive: true });
}

// Проверка идёт дважды в секунду всё время работы программы. Раньше она
// читала плейлист и сегмент синхронно — каждое такое чтение, которое
// антивирус растягивает на свежем файле, останавливало event loop вместе с
// потоком. Теперь чтение асинхронное, а флаг не даёт тикам наложиться.
let hlsHealthBusy = false;

async function inspectHlsHealth() {
  if (hlsHealthBusy) return;
  hlsHealthBusy = true;
  // Пока шло чтение, канал могли пересобрать (cleanHls заводит новое
  // состояние) — тогда прочитанное относится к старому каналу и выбрасывается.
  const снимок = hlsHealth;
  try {
    const playlist = await readFile(join(HLS_DIR, 'live.m3u8'), 'utf8');
    const uris = playlist.split(/\r?\n/).filter(line => /^segment-\d+\.ts$/i.test(line.trim()));
    const latest = uris.at(-1) || '';
    if (!latest) throw new Error('нет сегментов');
    const modified = (await stat(join(HLS_DIR, latest))).mtimeMs;
    if (снимок !== hlsHealth) return;
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
    if (hlsHealth.ready) streamWasReady = true;
    trackStreamQuality(segmentAge);
    autoReduceQuality(hlsHealth);
    watchStalledStream(hlsHealth);
  } catch {
    if (снимок !== hlsHealth) return;
    hlsHealth.ready = false;
    hlsHealth.segmentAge = null;
    // Плейлиста нет, а эфир идёт — это тоже фриз (край мёртв).
    if (activeKind) trackStreamQuality(null);
  } finally { hlsHealthBusy = false; }
}

// ── Телеметрия качества и синхронизация задержки ────────────────────────────
const FREEZE_START = 2.5;   // сегмент не обновлялся столько секунд — считаем фризом
const FREEZE_CLEAR = 1.5;   // край снова живой — фриз закончился
const DRIFT_LIMIT = 5;      // накопленная задержка, после которой пересобираем канал

function trackStreamQuality(segmentAge) {
  const now = Date.now();
  // Задержка живого края: PTS последнего отданного кадра минус настенные часы.
  // Именно она незаметно росла до 22с — теперь мы её видим и правим.
  if (relayProcess && relayStartedAt && lastRelayPts > 0) {
    const измерено = lastRelayPts - streamTimestamp();
    liveLatency = Number.isFinite(liveLatency) && liveLatency ? liveLatency * 0.7 + измерено * 0.3 : измерено;
    if (activeKind && Math.abs(liveLatency) > maxLiveLatency) maxLiveLatency = Math.abs(liveLatency);
  } else {
    liveLatency = 0;
  }
  if (!activeKind) { freezeState = null; return; }

  const ratio = Number(hlsHealth.realtimeRatio) || 1;
  if (ratio && ratio < qualityStats.worstRatio) qualityStats.worstRatio = Number(ratio.toFixed(2));

  // Фриз: живой край перестал обновляться. Запоминаем начало с местом (какой
  // трек, секунда, задержка), в конце — длительность.
  const мёртв = segmentAge === null || segmentAge >= FREEZE_START;
  if (мёртв && streamWasReady && !freezeState && !queuePaused && !playbackBusy) {
    freezeState = { startedAt: now, context: streamContext(), latency: Number(Math.abs(liveLatency).toFixed(1)) };
  } else if (freezeState && segmentAge !== null && segmentAge < FREEZE_CLEAR) {
    const durationSec = Number(((now - freezeState.startedAt) / 1000).toFixed(1));
    if (durationSec >= 0.4) {
      qualityStats.freezes++;
      qualityStats.freezeSeconds = Number((qualityStats.freezeSeconds + durationSec).toFixed(1));
      recordStreamEvent('freeze', `фриз ${durationSec}с`, { durationSec, latencySec: freezeState.latency }, freezeState.context);
    }
    freezeState = null;
  }

  correctDrift();
}

// Синхронизация: когда живой край разъехался с настенными часами, возвращаем
// задержку к нулю, пересобрав канал с привязкой к «сейчас». Редкая пересборка
// (порог 5с, не чаще раза в 45с) вместо бесконечного роста до десятков секунд.
// Разъехаться он может в обе стороны, и обе — это задержка у зрителя:
//  · вперёд (+) — кадры несут будущее время, плеер их придерживает;
//  · назад (−) — кадры застревают в кодировщике и уходят позже, чем сняты.
// Раньше проверялся только знак «+», и минус — тот самый случай захвата экрана,
// где отставание копится час за часом, — не ловился вовсе: за всю историю
// журнала коррекция не сработала ни разу, пока задержка росла до 20 секунд.
function correctDrift() {
  if (!activeKind || queuePaused || playbackBusy) return;
  const отклонение = Math.abs(liveLatency);
  if (!Number.isFinite(liveLatency) || отклонение < DRIFT_LIMIT) return;
  // Минус ловим только у живого захвата экрана. У трека очереди отставание —
  // это время открытия сетевого источника (-re держит его постоянным до конца
  // трека), и пересборка лишь заново открывала бы его с тем же отставанием —
  // по кругу раз в 45с. А во время фриза минус растёт просто потому, что кадров
  // нет: это работа watchStalledStream, а не полная пересборка канала с resync.
  if (liveLatency < 0) {
    const живой = hlsHealth.segmentAge !== null && hlsHealth.segmentAge < FREEZE_START;
    if (activeKind !== 'screen' || freezeState || !живой) return;
  }
  if (Date.now() - driftCorrectedAt < 45000) return;
  const куда = liveLatency > 0 ? 'край убежал вперёд' : 'поток отстаёт';
  driftCorrectedAt = Date.now();
  qualityStats.driftCorrections++;
  recordStreamEvent('drift', `задержка выросла до ${отклонение.toFixed(1)}с (${куда}) — пересобираю канал и возвращаю к нулю`,
    { latencySec: Number(отклонение.toFixed(1)) });
  liveLatency = 0; maxLiveLatency = 0;
  try { reanchorRelay(); } catch (error) { log(`Сброс задержки: ${error.message}`); }
}

function resetQualityTelemetry() {
  liveLatency = 0; maxLiveLatency = 0; freezeState = null; streamEvents = [];
  driftCorrectedAt = 0; streamSessionStart = Date.now();
  qualityStats.freezes = 0; qualityStats.freezeSeconds = 0; qualityStats.driftCorrections = 0;
  qualityStats.slowSpells = 0; qualityStats.worstRatio = 1;
}

// Когда машина не тянет заданное качество (нет аппаратного кодировщика или
// просто слабый процессор), поток отстаёт и сегменты стареют — зритель видит
// фризы. Вместо молчаливой деградации понижаем нагрузку сами: сначала кадры,
// потом разрешение, и говорим об этом в журнале.
let отставаний = 0;
let lightMode = false;
let последнееСнижение = 0;

function autoReduceQuality(state) {
  if (config.autoQuality === false || !activeKind) return;
  const темп = Number(state.realtimeRatio) || 1;
  const возраст = Number(state.segmentAge) || 0;
  const плохо = темп < 0.9 || возраст > 5;
  отставаний = плохо ? отставаний + 1 : 0;
  if (отставаний < 5 || Date.now() - последнееСнижение < 60000) return;

  // Снижение живёт в памяти сеанса, а не в настройках. Раньше оно писалось в
  // config.json: один провал из-за проснувшегося антивируса — и выбранные
  // 1080p60 не возвращались никогда, пока человек сам не догадается.
  const текущий = streamProfile(activeKind);
  let подпись = '';
  if (текущий.fps > 30) { degrade = { ...degrade, fps: 30 }; подпись = '30 кадров'; }
  else if (текущий.quality === '1080p') { degrade = { ...degrade, quality: '720p' }; подпись = '720p'; }
  else if (!lightMode && !encoder.hardware) { lightMode = true; подпись = 'лёгкое кодирование'; }
  else if (текущий.quality === '720p') { degrade = { ...degrade, quality: '480p' }; подпись = '480p'; }
  if (!подпись) return;

  отставаний = 0;
  последнееСнижение = Date.now();
  log(`Поток не успевает — снижаю нагрузку: ${подпись} (до конца эфира, настройки не меняются)`);
  try { restartRelaySession(streamProfile(activeKind)); } catch (error) { log(`Снижение качества: ${error.message}`); }
}

// Если сегменты перестали появляться совсем, никакое снижение качества уже не
// поможет: перезапускаем то, что сейчас в эфире, вместо бесконечной паузы у зрителя.
let последнийПерезапуск = 0;

function watchStalledStream(state) {
  if (!activeKind || queuePaused) return;
  const возраст = Number(state.segmentAge) || 0;
  // Восемь секунд вместо двенадцати: столько зритель ещё готов ждать, а
  // ложных срабатываний на этом пороге в замерах не появилось — обычный
  // возраст куска держится около секунды даже на слабой машине.
  if (возраст < 8 || Date.now() - последнийПерезапуск < 45000) return;
  последнийПерезапуск = Date.now();
  log(`Поток встал (${возраст.toFixed(1)} с без новых кадров) — перезапускаю`);
  try {
    if (activeKind === 'screen') startScreen().catch(error => log(`Перезапуск захвата: ${error.message}`));
    // sourcePosition стоит на месте последней перемотки, само воспроизведение
    // его не двигает: фильм, зависший на 47-й минуте, откатывался в начало.
    else transitionQueue('seek', currentSourcePosition() + 0.1);
  } catch (error) { log(`Перезапуск потока: ${error.message}`); }
}

function startHlsHealthMonitor() {
  if (hlsHealthTimer) clearInterval(hlsHealthTimer);
  hlsHealthTimer = setInterval(inspectHlsHealth, 500);
  hlsHealthTimer.unref?.();
  // Пока канал не поднялся, спрашиваем часто: человек ждёт именно этого.
  // Пауза выбирается на каждом тике, а не один раз при запуске: раньше
  // channelLive был ложным в момент создания таймера, и опрос навсегда
  // оставался ежесекундным — в режиме «свой сервер» это 86 тысяч запросов
  // в сутки на чужую машину.
  // Пока канал поднимается — спрашиваем каждые полсекунды, чтобы «готово»
  // загоралось сразу, как сервер принял поток. Поднялся — раз в 5 секунд,
  // иначе это тысячи лишних запросов в сутки на чужую машину. Следующая
  // проверка планируется по итогу текущей: раньше таймер будил процесс каждые
  // 250 мс круглосуточно только затем, чтобы узнать, что ещё рано.
  const следующая = () => {
    if (shuttingDown) return;
    setTimeout(() => { watchChannel().catch(() => {}).finally(следующая); }, channelLive ? 5000 : 500).unref?.();
  };
  следующая();
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

// Что программа снизила сама, чтобы вытянуть эфир. Живёт до остановки.
let degrade = null;

function streamProfile(kind = activeKind) {
  const качества = ['480p', '720p', '1080p'];
  const основа = kind === 'queue'
    ? { quality: качества.includes(config.mediaQuality) ? config.mediaQuality : '720p', fps: Number(config.mediaFps) === 60 ? 60 : 30 }
    : { quality: качества.includes(config.quality) ? config.quality : '720p', fps: Number(config.fps) === 60 ? 60 : 30 };
  return degrade ? { ...основа, ...degrade } : основа;
}

// Один сеанс релея = один формат кадра. Любая смена разрешения/fps/SAR/каналов
// внутри живого TS заставляет декодер AVPro переинициализироваться — плеер в
// VRChat ломается до resync. Пока релей жив, все производители обязаны выдавать
// его формат; желаемый профиль применяется только при перезапуске релея.
function sessionProfile(kind = activeKind) {
  return relayProcess && relayProfile ? { ...relayProfile } : streamProfile(kind);
}

// Кадровая частота — такая же часть формата сессии, как и разрешение: пока
// сравнивалось одно разрешение, переключатель 30/60 в живом эфире не делал
// ничего, потому что продюсер получал прежний профиль релея.
function sameProfile(left, right) {
  return Boolean(left && right) && left.quality === right.quality && left.fps === right.fps;
}

// Осознанная смена качества: релей перезапускается, но relayStartedAt сохраняется,
// чтобы таймстемпы продолжились и плеер пережил стык без resync.
function restartRelaySession(profile) {
  // Источник обязан перезапуститься вместе с сессией. Его вывод запайплен в
  // stdin убиваемого релея: после смены сессии он писал в никуда, а его
  // обработчик data продолжал лить пакеты в RTSP-пушеров одновременно с
  // заставкой — два муксера в один поток, у зрителя каша. Автопонижение
  // качества, которое должно было спасать эфир, ломало его гарантированно.
  const вид = activeKind;
  const позиция = вид === 'queue' ? currentSourcePosition() : 0;
  stopStandby();
  stopRtspPush();
  const relay = relayProcess;
  relayProcess = null;
  stopProducer(activeProcess);
  activeProcess = null;
  relay?.kill('SIGTERM');
  startRelay(profile);
  startStandby(profile);
  if (вид === 'screen') startScreen().catch(error => log(`Перезапуск захвата: ${error.message}`));
  else if (вид === 'queue' && currentId) transitionQueue('seek', позиция);
}

// Пересборка канала с полным сбросом часов потока: живой край снова привязан к
// «сейчас», накопленная задержка возвращается к нулю. В отличие от
// restartRelaySession, здесь relayStartedAt и lastRelayPts обнуляются — ценой
// одного resync у плеера, но зато задержка не растёт бесконечно.
function reanchorRelay() {
  const вид = activeKind;
  const позиция = вид === 'queue' ? currentSourcePosition() : 0;
  const profile = streamProfile(вид);
  stopStandby();
  stopRtspPush();
  const relay = relayProcess;
  relayProcess = null;
  stopProducer(activeProcess);
  activeProcess = null;
  relay?.kill('SIGTERM');
  cleanHls();
  producerClock = null;
  lastRelayPts = 0;
  relayStartedAt = Date.now();
  startRelay(profile);
  startStandby(profile);
  if (вид === 'screen') startScreen().catch(error => log(`Пересборка канала: ${error.message}`));
  else if (вид === 'queue' && currentId) transitionQueue('seek', позиция);
}

// Битрейт задаёт человек, а «авто» подбирается по качеству. Через интернет
// (свой сервер или туннель) поток ужимается: домашний канал отдачи редко тянет
// больше 6 Мбит/с, а на переполнении канала появляются те самые фризы.
function autoBitrateKbps(profile) {
  if (profile.quality === '1080p') return profile.fps === 60 ? 8000 : 5500;
  if (profile.quality === '480p') return profile.fps === 60 ? 2200 : 1500;
  return profile.fps === 60 ? 4800 : 3200;
}

function bitrateKbps(profile) {
  const выбран = Number(config.videoBitrate) || 0;
  let rate = выбран > 0 ? выбран : autoBitrateKbps(profile);
  const наружу = config.outputMode === 'remote' || config.outputMode === 'tunnel';
  if (наружу && !выбран) rate = Math.min(rate, 6000);
  return Math.max(600, Math.min(20000, Math.round(rate)));
}

// Ступень 480p нужна слабым машинам без аппаратного кодировщика: лучше
// показывать ровное видео поменьше, чем рваное побольше.
function profileHeight(profile) {
  if (profile.quality === '1080p') return 1080;
  if (profile.quality === '480p') return 480;
  return 720;
}

function bitrate(profile) {
  return `${bitrateKbps(profile)}k`;
}

function videoEncodeArgs(profile = streamProfile()) {
  const rate = bitrate(profile);
  const keyframes = Math.max(8, Math.round(profile.fps * 0.5));
  const gop = ['-g', String(keyframes), '-keyint_min', String(keyframes)];
  if (encoder.family === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-rc', 'cbr',
    '-b:v', rate, '-maxrate', rate, '-bufsize', rate, ...gop, '-bf', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'];
  if (encoder.family === 'amf') return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr',
    '-b:v', rate, '-maxrate', rate, ...gop, '-bf', '0', '-pix_fmt', 'yuv420p'];
  if (encoder.family === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', rate,
    '-maxrate', rate, '-bufsize', rate, ...gop, '-bf', '0', '-async_depth', '1', '-pix_fmt', 'nv12'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    ...gop, '-sc_threshold', '0', '-b:v', rate, '-maxrate', rate, '-bufsize', rate];
}

// Раньше здесь стоял constqp: качество постоянное, а битрейт какой получится.
// На игре это выстреливало до десятков мегабит, канал захлёбывался, и зритель
// видел фризы. Теперь поток ровный: сколько задано, столько и уходит.
// Через интернет поток должен быть ровным: там любой всплеск упирается в
// канал и оборачивается фризом у зрителя. А когда смотрят с этого же
// компьютера, полоса бесплатна — и жёсткий CBR только вредит: на статичной
// картинке биты уходят в пустоту, а на резком движении их не хватает.
// Поэтому локально даём кодировщику дышать, ограничивая пик полуторакратно.
function rateControlArgs(rate) {
  const наружу = config.outputMode === 'remote' || config.outputMode === 'tunnel';
  if (наружу) return ['-rc', 'cbr', '-b:v', rate, '-maxrate', rate, '-bufsize', rate];
  const число = parseInt(rate, 10) || 3200;
  return ['-rc', 'vbr', '-b:v', rate, '-maxrate', `${Math.round(число * 1.5)}k`, '-bufsize', `${Math.round(число * 2)}k`];
}

function producerEncodeArgs(profile = streamProfile()) {
  const keyframes = Math.max(8, Math.round(profile.fps * 0.5));
  const rate = bitrate(profile);
  // Профиль main и уровень 4.1: так поток понимают все плееры, включая Quest,
  // где high-профиль берётся не всегда. Цена — несколько процентов лишнего
  // размера при том же качестве, и это дешевле, чем «у друга не открылось».
  const gop = ['-g', String(keyframes), '-keyint_min', String(keyframes)];
  // 4.1 не тянет 1080p60: его потолок — ровно 1080p30 (245760 макроблоков в
  // секунду). nvenc на это отвечает «InitializeEncoder failed: Invalid Level»,
  // захват падает сразу после старта, заставка падает следом — и так по кругу,
  // пока автоснижение не уронит кадры до 30. Для 1080p60 берём 4.2.
  const level = profileHeight(profile) > 720 && profile.fps > 30 ? '4.2' : '4.1';
  const proff = ['-profile:v', 'main', '-level:v', level];
  if (encoder.family === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'll',
    ...proff, ...rateControlArgs(rate), '-rc-lookahead', '0', ...gop, '-bf', '0', '-pix_fmt', 'yuv420p'];
  if (encoder.family === 'amf') return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed',
    ...proff, '-rc', 'cbr', '-b:v', rate, '-maxrate', rate, ...gop, '-bf', '0', '-pix_fmt', 'yuv420p'];
  if (encoder.family === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast',
    ...proff, '-b:v', rate, '-maxrate', rate, '-bufsize', rate, ...gop, '-bf', '0', '-async_depth', '1', '-pix_fmt', 'nv12'];
  // На слабой машине даже veryfast не успевает: тогда переходим на ultrafast,
  // это заметно дешевле по процессору ценой чуть большего размера потока.
  return ['-c:v', 'libx264', '-preset', lightMode ? 'ultrafast' : 'veryfast', '-tune', 'zerolatency',
    ...proff, '-b:v', rate, '-maxrate', rate, '-bufsize', rate,
    ...gop, '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p'];
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
  // Точка стыка = настенные часы. lastRelayPts — только нижняя граница
  // монотонности (нельзя начать ЗА уже отданными кадрами, иначе AVPro ловит
  // non-monotonic DTS и рвётся). Запас — один кадр, минимально возможный.
  // Раньше здесь была ещё проекция previousNow и запас 0,04с: её «излишек»
  // копился на КАЖДОМ стыке (loop, смена трека), и за час живой край убегал
  // от настенных часов на те самые десятки секунд задержки. Теперь стык
  // добавляет ровно один кадр, а накопление добивает коррекция дрейфа.
  const frame = 1 / (sessionProfile().fps || 30);
  return Math.max(base, lastRelayPts + frame);
}

// Время последнего кадра, ушедшего в эфир. Сначала читалось из PCR — служебных
// часов потока, но они отстают от самих кадров примерно на треть секунды, и
// следующий ролик начинался ЗА уже показанным: в VRChat это выглядело как
// возврат старых кадров. Теперь берём метку самого кадра (PTS) из заголовка PES.
let lastRelayPts = 0;

function trackRelayClock(chunk) {
  for (let offset = 0; offset + 188 <= chunk.length; offset += 188) {
    if (chunk[offset] !== 0x47) continue;                     // не начало пакета
    if ((chunk[offset + 1] & 0x40) === 0) continue;           // не начало PES
    const adaptation = (chunk[offset + 3] & 0x30) >> 4;
    if (adaptation === 0 || adaptation === 2) continue;       // полезной нагрузки нет
    let payload = offset + 4;
    if (adaptation === 3) payload += 1 + chunk[offset + 4];   // пропускаем поле адаптации
    if (payload + 14 > offset + 188) continue;
    if (chunk[payload] !== 0 || chunk[payload + 1] !== 0 || chunk[payload + 2] !== 1) continue;
    if ((chunk[payload + 7] & 0x80) === 0) continue;          // метки времени нет
    const b = payload + 9;
    const pts = (chunk[b] & 0x0e) * 536870912
      + chunk[b + 1] * 4194304 + (chunk[b + 2] & 0xfe) * 16384
      + chunk[b + 3] * 128 + ((chunk[b + 4] & 0xfe) >> 1);
    const seconds = pts / 90000;
    // Скачок больше часа — это чужая метка или переполнение, её не берём.
    if (seconds > lastRelayPts && seconds - lastRelayPts < 3600) lastRelayPts = seconds;
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
// Помощника захвата окна сначала просим выйти сам (закрываем ввод) и только
// потом добиваем: убитый на месте, он не успевает закрыть сессию захвата,
// и жёлтая рамка остаётся висеть на чужом окне.
function stopWindowHelper(child) {
  if (!child) return;
  try { child.stdin?.end(); } catch {}
  const добить = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 400);
  добить.unref?.();
  child.once('close', () => clearTimeout(добить));
}

function stopAudioHelper(child) {
  if (!child) return;
  try { child.stdin?.end(); } catch {}
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 900);
  child.once('close', () => clearTimeout(timer));
}

function stopWindowWatch() {
  stopWindowWatcher();
  if (windowWatchTimer) clearInterval(windowWatchTimer);
  windowWatchTimer = null; windowCaptureState = null;
}

// Свёрнуто окно или закрыто — сообщает сам захватчик: он держит окно и знает
// об этом первым. Раньше об этом спрашивал отдельный процесс каждые три
// секунды, притом что помощник уже работал рядом.
// Пока окно свёрнуто, захвата нет — и о его возвращении сообщить некому.
// На это время запускаем тот же помощник в режиме наблюдения: он ничего не
// снимает и только сообщает, когда окно вернулось или закрылось.
let windowWatcher = null;

function stopWindowWatcher() {
  if (!windowWatcher) return;
  try { windowWatcher.kill('SIGTERM'); } catch {}
  windowWatcher = null;
}

function startWindowWatcher(handle) {
  stopWindowWatcher();
  const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
  if (!existsSync(helper)) return;
  const child = onAir(spawn(helper, ['--watch', '--hwnd', String(handle)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  windowWatcher = child;
  child.stderr.setEncoding('utf8');
  let остаток = '';
  child.stderr.on('data', chunk => {
    остаток = (остаток + chunk).slice(-400);
    const строки = остаток.split(String.fromCharCode(10));
    остаток = строки.pop() || '';
    for (const строка of строки) {
      const метка = строка.match(/^state=(\w+)$/);
      if (метка) applyWindowState(метка[1]);
    }
  });
  child.on('close', () => { if (windowWatcher === child) windowWatcher = null; });
}

function applyWindowState(state) {
  if (activeKind !== 'screen' || config.captureMode !== 'window') return;
  const следующее = state === 'gone' ? 'missing' : state;
  if (!windowCaptureState || следующее === windowCaptureState) { windowCaptureState = следующее; return; }
  windowCaptureState = следующее;
  log(следующее === 'visible' ? 'Окно снова на экране — захват продолжен' : 'Окно свернуто — показывается заглушка');
  startScreen().catch(error => log(`Наблюдение за окном: ${error.message}`));
}

function runScreenProcess(args, audioHelperArgs = null, windowHelperArgs = null) {
  stopLivePreview();
  stopping = false;
  activeKind = 'screen';
  log(`Захват экрана · ${encoder.label} · ${config.quality}/${config.fps} FPS`);
  stopStandby();
  const stdio = ['ignore', 'pipe', 'pipe', audioHelperArgs ? 'pipe' : 'ignore', windowHelperArgs ? 'pipe' : 'ignore'];
  const child = onAir(spawn('ffmpeg', args, { windowsHide: true, stdio }));
  let aux = null;
  let windowCapture = null;
  activeProcess = child;
  pipeToRelay(child);
  if (audioHelperArgs) {
    const helper = join(ROOT, 'tools', 'VRCast.AudioCapture.exe');
    if (!existsSync(helper)) {
      child.kill('SIGTERM'); activeProcess = null; activeKind = null;
      startStandby(sessionProfile('screen'));
      throw new Error('Компонент системного звука не найден.');
    }
    child.stdio[3].on('error', () => {});
    if (keepAudioHelper && activeAuxProcess) {
      // Тот же помощник, новый кодировщик: просто перецепляем вывод.
      aux = activeAuxProcess;
      aux.stdout.pipe(child.stdio[3]);
    } else {
      aux = onAir(spawn(helper, audioHelperArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      aux.stdin.on('error', () => {});
      activeAuxProcess = aux;
      aux.stdout.on('error', () => {});
      observeAudio(aux.stdout);
      aux.stdout.pipe(child.stdio[3]);
      attachProcessLogs(aux, 'System audio');
      aux.on('close', code => {
        // Эфир без звука хуже короткого перезапуска: если хелпер умер, а видео
        // ещё идёт — перезапускаем захват целиком один раз.
        if (activeAuxProcess !== aux || stopping || !activeProcess || !code) return;
        activeAuxProcess = null; audioHelperKey = '';
        log(`Компонент звука неожиданно остановился (код ${code}) — перезапускаю захват`);
        startScreen().catch(error => log(`Перезапуск захвата: ${error.message}`));
      });
    }
    audioHelperKey = audioHelperSignature();
    helperOwner.set(aux, child);
  }
  if (windowHelperArgs) {
    const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
    if (!existsSync(helper)) {
      child.kill('SIGTERM'); aux?.kill('SIGTERM'); activeProcess = null; activeAuxProcess = null; activeKind = null;
      // Без этого ссылка отдавала замороженный кадр: заставку сняли, новый
      // источник не поднялся, и никакой сторож это уже не чинил.
      startStandby(sessionProfile('screen'));
      throw new Error('Компонент изолированного захвата окна не найден.');
    }
    // Ввод открываем каналом: закрыть его — вежливый способ попросить помощника
    // выйти. Тогда он сам закрывает сессию захвата, и Windows снимает жёлтую
    // рамку вокруг окна сразу, а не спустя минуту после выхода из программы.
    child.stdio[4].on('error', () => {});
    if (keepWindowHelper && activeWindowProcess) {
      windowCapture = activeWindowProcess;
      windowCapture.stdout.pipe(child.stdio[4]);
    } else {
      windowCapture = onAir(spawn(helper, windowHelperArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      windowCapture.stdin.on('error', () => {});
      activeWindowProcess = windowCapture;
      windowCapture.stdout.on('error', () => {});
      windowCapture.stdout.pipe(child.stdio[4]);
      windowCapture.stderr.setEncoding('utf8');
      let остатокСостояния = '';
      windowCapture.stderr.on('data', chunk => {
        остатокСостояния = (остатокСостояния + chunk).slice(-400);
        const строки = остатокСостояния.split(String.fromCharCode(10));
        остатокСостояния = строки.pop() || '';
        for (const строка of строки) {
          const метка = строка.match(/^state=(\w+)$/);
          if (метка) applyWindowState(метка[1]);
          else if (строка.trim()) logDetail(`Window capture: ${строка.trim()}`);
        }
      });
      windowCapture.on('close', code => {
        // Смерть захватчика раньше проходила молча: эфир превращался в
        // заставку, и никто этого не замечал. У звукового помощника такой
        // перезапуск есть — теперь он есть и здесь.
        if (activeWindowProcess !== windowCapture || stopping || shuttingDown || !activeProcess || !code) return;
        activeWindowProcess = null; windowHelperKey = '';
        log(`Захват окна неожиданно остановился (код ${code}) — перезапускаю`);
        startScreen().catch(error => log(`Перезапуск захвата: ${error.message}`));
      });
    }
    windowHelperKey = [config.captureWindowHandle, windowHelperArgs[3], windowHelperArgs[5], windowHelperArgs[7]].join('|');
    helperOwner.set(windowCapture, child);
  }
  attachProcessLogs(child, 'FFmpeg');
  child.on('close', code => {
    // Помощников гасим только если это конец захвата, а не пересборка
    // кодировщика: при пересборке их вывод сейчас перецепят на новый ffmpeg.
    // Флагов keep* мало: там, где запуск не ждёт PowerShell (весь экран,
    // область, окно из свежего списка), новый ffmpeg успевает стартовать и
    // флаги сбрасываются раньше, чем приходит close старого, — и он убивал
    // помощника, уже перецепленного на новый. Эфир оставался без звука (или
    // без картинки окна) до следующего запуска. Гасим только своих.
    if (!keepAudioHelper && aux && activeAuxProcess === aux && helperOwner.get(aux) === child) { stopAudioHelper(aux); activeAuxProcess = null; audioHelperKey = ''; }
    if (!keepWindowHelper && windowCapture && activeWindowProcess === windowCapture && helperOwner.get(windowCapture) === child) { stopWindowHelper(windowCapture); activeWindowProcess = null; windowHelperKey = ''; }
    const wasCurrent = activeProcess === child;
    if (wasCurrent) activeProcess = null;
    if (!stopping && code) log(`Захват остановился с кодом ${code}`);
    if (wasCurrent && relayProcess) startStandby(sessionProfile('screen'));
    if (wasCurrent && !relayProcess) activeKind = null;
  });
}

// Помощники звука и захвата окна переживают смену настроек кодировщика.
// Раньше любая правка битрейта гасила весь захват целиком: помощник звука
// перезапускался, звук пропадал на полсекунды, а громкость приложения в
// микшере Windows выставлялась заново. Если настройки самих помощников не
// изменились, их вывод просто перецепляется на новый ffmpeg.
let audioHelperKey = '';
// Какому ffmpeg сейчас отдаёт поток каждый помощник.
const helperOwner = new WeakMap();
let windowHelperKey = '';
let keepAudioHelper = false;
let keepWindowHelper = false;

function audioHelperSignature() {
  if (!['system', 'output', 'process'].includes(config.audioMode)) return '';
  return [config.audioMode, config.audioOutputId, config.audioProcessId, localAppLevel().toFixed(3)].join('|');
}

function windowHelperSignature(profile) {
  if (config.captureMode !== 'window') return '';
  const height = profileHeight(profile);
  return [config.captureWindowHandle, Math.round(height * 16 / 9 / 2) * 2, height, profile.fps].join('|');
}

let screenStarting = false;
async function startScreen() {
  if (screenStarting) throw new Error('Захват уже запускается.');
  screenStarting = true;
  try { await startScreenInner(); }
  catch (ошибка) {
    // Сорвались на полпути — оставленные помощники никому не нужны, иначе
    // подсветка захваченного окна так и висит, а звук приложения остаётся тише.
    if (keepAudioHelper || keepWindowHelper) {
      keepAudioHelper = false; keepWindowHelper = false;
      stopAudioHelper(activeAuxProcess); stopWindowHelper(activeWindowProcess);
      activeAuxProcess = null; activeWindowProcess = null; audioHelperKey = ''; windowHelperKey = '';
    }
    // Запуск перебили «Стоп» или другой источник — это не ошибка, молча выходим.
    if (ошибка.cancelled) return;
    throw ошибка;
  }
  finally { screenStarting = false; keepAudioHelper = false; keepWindowHelper = false; }
}

async function startScreenInner() {
  const wasLive = Boolean(activeKind);
  // Решаем до остановки: если настройки помощников те же, оставляем их жить.
  const текущийПрофиль = sessionProfile('screen');
  const тотЖеЗахват = wasLive && activeKind === 'screen';
  // Каждого помощника решаем отдельно: смена качества меняет размер кадра и
  // требует нового захвата окна, но звук при этом трогать незачем.
  keepAudioHelper = тотЖеЗахват && Boolean(activeAuxProcess) && audioHelperSignature() === audioHelperKey;
  keepWindowHelper = тотЖеЗахват && Boolean(activeWindowProcess) && windowHelperSignature(текущийПрофиль) === windowHelperKey;
  stopActive(false, true, true);
  // Список мониторов и окон спрашивается у PowerShell — это секунда и больше.
  // Нажатый за это время «Стоп» или запуск очереди раньше ничего не отменял:
  // захват всё равно поднимался поверх, и эфир показывал экран после «Стоп»
  // или вместо только что запущенной очереди. Любой из них меняет поколение.
  const поколение = playGeneration;
  const проверитьОтмену = () => {
    if (поколение !== playGeneration || shuttingDown) throw Object.assign(new Error('Запуск захвата отменён.'), { cancelled: true });
  };
  currentId = null; currentStartedAt = null; currentDuration = null;
  const desired = streamProfile('screen');
  if (relayProcess && !sameProfile(relayProfile, desired) && !wasLive) restartRelaySession(desired);
  ensureRelay(desired);
  const profile = sessionProfile('screen');
  const height = profileHeight(profile);
  const width = Math.round(height * 16 / 9 / 2) * 2;
  const args = ['-hide_banner', '-loglevel', 'warning'];
  let windowHelperArgs = null;
  let captureRect = null;
  let selectedWindow = null;
  let ddagrabOutput = null;
  if (config.captureMode === 'window') {
    if (!/^\d+$/.test(String(config.captureWindowHandle))) throw new Error('Выберите окно для захвата.');
    selectedWindow = (await listWindows()).find(item => item.handle === String(config.captureWindowHandle)) || null;
    проверитьОтмену();
      windowCaptureState = !selectedWindow ? 'missing' : selectedWindow.minimized ? 'minimized' : 'visible';
  } else if (config.captureMode === 'monitor') {
    const monitors = await listMonitors();
    проверитьОтмену();
    captureRect = monitors.find(item => item.id === config.captureMonitorId) || monitors.find(item => item.primary) || monitors[0];
    if (!captureRect) throw new Error('Windows не вернула список мониторов.');
  } else if (config.captureMode === 'region') {
    captureRect = { x: Number(config.regionX) || 0, y: Number(config.regionY) || 0,
      width: Math.max(64, Number(config.regionWidth) || 1280), height: Math.max(64, Number(config.regionHeight) || 720) };
  }
  if (config.captureMode === 'window' && windowCaptureState === 'visible') {
    const captureWidth = width;
    const captureHeight = height;
    stopWindowWatcher();
    windowHelperArgs = ['--hwnd', String(config.captureWindowHandle), '--width', String(captureWidth), '--height', String(captureHeight), '--fps', String(profile.fps)];
    args.push('-fflags', 'nobuffer', '-thread_queue_size', '8', '-use_wallclock_as_timestamps', '1', '-f', 'rawvideo', '-pixel_format', 'nv12', '-video_size', `${captureWidth}x${captureHeight}`, '-framerate', String(profile.fps), '-i', 'pipe:4');
  } else if (config.captureMode === 'window') {
    // Окна на экране нет: показываем подложку и ждём его возвращения.
    startWindowWatcher(config.captureWindowHandle);
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
  args.push('-vf', `${fromGpu}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-af', `aresample=async=1:first_pts=0:min_hard_comp=0.100,volume=${captureVolume.toFixed(2)},alimiter=limit=0.97:level=disabled`,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile));
  проверитьОтмену();
  runScreenProcess(args, audioHelperArgs, windowHelperArgs);
  startPublicTunnel();
}

// Локальный RTSP-сервер (MediaMTX): AVPro в VRChat играет rtspt:// с задержкой
// ~0.5–1с против 3–15с у HLS. Публикация — только с localhost по паролю,
// чтение открыто (этот ПК + локальная сеть). HLS остаётся для туннеля и Quest.
function startMediaMtx() {
  if (!tools.mediamtx || mediaMtxProcess) return;
  // Имя файла настроек привязано к порту. Раньше он был один на всех, и две
  // запущенные копии программы (например, обычная и запасная на другом порту)
  // переписывали его друг за другом: вторая поднимала RTSP-сервер с чужими
  // портами, тот упирался в занятый адрес и падал — раз в две секунды по кругу.
  const configFile = join(DATA_DIR, `mediamtx-${RTSP_PORT}.yml`);
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
    'rtmp: no', 'hls: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
    // Предпросмотр берётся отсюда: WebRTC отдаёт кадр за доли секунды,
    // тогда как HLS собирает секундные куски и всегда отстаёт.
    'webrtc: yes', `webrtcAddress: :${WEBRTC_PORT}`, `webrtcLocalUDPAddress: :${WEBRTC_PORT + 1}`,
    'webrtcIPsFromInterfaces: no', "webrtcAdditionalHosts: ['127.0.0.1']",
    'authInternalUsers:',
    '- user: any', '  permissions:', '  - action: read',
    `- user: vrcast`, `  pass: ${rtspPublishPass}`, `  ips: ['127.0.0.1']`, '  permissions:', '  - action: publish',
    'paths:', '  live: {}', '',
  ].join('\n'), 'utf8');
  const child = onAir(spawn(MEDIAMTX(), [configFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  mediaMtxProcess = child;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => {
    const строка = String(chunk).trim().split(String.fromCharCode(10)).pop();
    if (строка) { mediaMtxLastError = строка.slice(0, 200); logDetail(`RTSP-сервер: ${строка.slice(0, 300)}`); }
  });
  // Поднялись после падения — публикацию надо восстановить самим. Без этого
  // сервер работал, а канал оставался пустым: пушер умер вместе с ним, а его
  // собственная попытка перезапуска пришлась на те секунды, когда сервера ещё
  // не было, и больше никто не пробовал.
  setTimeout(() => { if (relayProcess && !stopping && !shuttingDown) startRtspPush(); }, 900).unref?.();
  attachProcessLogs(child, 'RTSP server');
  child.on('close', code => {
    if (mediaMtxProcess === child) mediaMtxProcess = null;
    if (stopping || shuttingDown || !code) return;
    // Бесконечный перезапуск раз в две секунды заваливал журнал и ничего не
    // чинил. Пробуем несколько раз с нарастающей паузой и говорим, почему.
    mediaMtxFailures += 1;
    if (mediaMtxFailures > 5) {
      log(`RTSP-сервер не запускается (код ${code}). Причина: ${mediaMtxLastError || 'не сообщил'}`);
      return;
    }
    const пауза = Math.min(15000, 1500 * mediaMtxFailures);
    log(`RTSP-сервер остановился (код ${code}), перезапускаю через ${Math.round(пауза / 1000)} с${mediaMtxLastError ? ` · ${mediaMtxLastError}` : ''}`);
    setTimeout(startMediaMtx, пауза);
  });
  // Продержался десять секунд — считаем, что поднялся.
  setTimeout(() => { if (mediaMtxProcess === child) mediaMtxFailures = 0; }, 10000).unref?.();
}

// Готовность ссылки проверяем ровно так, как это делает плеер: спрашиваем у
// RTSP-сервера описание потока. Пока публикующего нет, он отвечает 404 — и
// VRChat на такой ответ показывает ошибку и больше сам не пробует. Раньше
// «канал готов» считалось по числу кусков HLS, то есть по другому пути, и
// человек вставлял ссылку в те несколько секунд, когда она ещё не играла.
let channelLive = false;
let channelProbeBusy = false;

// Живой ли RTSP-сервер вообще. Голый TCP-коннект тут врёт: за VPN (Koala Clash)
// хендшейк проходит даже к мёртвому серверу. OPTIONS честнее — на него отвечает
// только настоящий RTSP, и выключенный сервер перестаёт гореть зелёным.
function probeRtspServer(host, port) {
  return new Promise(resolve => {
    let ответ = '';
    const socket = netConnect({ host, port });
    const конец = ок => { try { socket.destroy(); } catch {} resolve(ок); };
    // 3 секунды: выключенный сервер (TCP за VPN проходит, а RTSP молчит)
    // краснеет быстрее, но живому серверу подальше хватает времени ответить.
    socket.setTimeout(3000);
    socket.on('timeout', () => конец(false));
    socket.on('error', () => конец(false));
    const разрыв = String.fromCharCode(13, 10);
    const запрос = ['OPTIONS rtsp://' + host + ':' + port + '/ RTSP/1.0', 'CSeq: 1', '', ''].join(разрыв);
    socket.on('connect', () => socket.write(запрос));
    socket.on('data', chunk => {
      ответ += chunk;
      if (ответ.includes(разрыв + разрыв)) конец(/^RTSP\/1\.0/.test(ответ));
    });
  });
}

function probeRtsp(host, port, channel) {
  return new Promise(resolve => {
    let ответ = '';
    const socket = netConnect({ host, port });
    const конец = ок => { try { socket.destroy(); } catch {} resolve(ок); };
    socket.setTimeout(2500);
    socket.on('timeout', () => конец(false));
    socket.on('error', () => конец(false));
    const разрыв = String.fromCharCode(13, 10);
    const запрос = ['DESCRIBE rtsp://' + host + ':' + port + '/' + channel + ' RTSP/1.0', 'CSeq: 1',
      'Accept: application/sdp', '', ''].join(разрыв);
    socket.on('connect', () => socket.write(запрос));
    socket.on('data', chunk => {
      ответ += chunk;
      if (ответ.includes(разрыв + разрыв)) конец(ответ.startsWith('RTSP/1.0 200'));
    });
  });
}

let remoteChannelLive = false;

async function watchChannel() {
  if (channelProbeBusy) return;
  channelProbeBusy = true;
  try {
    channelLive = mediaMtxProcess ? await probeRtsp('127.0.0.1', RTSP_PORT, 'live') : false;
    // Свой сервер спрашиваем тем же способом: человек вставляет в VRChat
    // именно его адрес, и «готово» должно означать «оттуда уже играет».
    const цель = config.outputMode === 'remote' ? remoteRtspTarget() : null;
    remoteChannelLive = цель ? await probeRtsp(цель.host, цель.port, цель.channel || 'live') : false;
  } finally { channelProbeBusy = false; }
}

function stopMediaMtx() {
  channelLive = false;
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

const rtspPushFailures = new Map();
const rtspPushUrls = new Map();

// Переключение получателя без лишнего простоя: локальный пушер, который уже
// работает, не трогаем — рвётся только то, что реально изменилось (новый свой
// сервер, другой канал, уход в «этот ПК»). Раньше при каждой смене глушились
// все пушеры разом, и локальный канал с предпросмотром моргал на пару секунд.
function syncRtspPush() {
  if (!mediaMtxProcess || !relayProcess) { stopRtspPush(); return; }
  const нужные = new Map(rtspTargets().map(t => [t.id, t.url]));
  for (const [id, child] of [...rtspPushProcesses]) {
    if (нужные.get(id) === rtspPushUrls.get(id)) continue; // адрес не менялся — оставляем
    const timer = rtspPushTimers.get(id); if (timer) { clearTimeout(timer); rtspPushTimers.delete(id); }
    child.kill('SIGTERM'); rtspPushProcesses.delete(id); rtspPushUrls.delete(id);
  }
  startRtspPush();
  // Сразу спрашиваем канал, не дожидаясь тика опроса: «готово» загорается,
  // как только сервер реально принял поток, а не спустя лишнюю секунду.
  watchChannel().catch(() => {});
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
    const child = onAir(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt',
      // Без nobuffer и с запасом на разбор: публикация стартует раньше, чем
      // relay выдаст первый кадр, и с урезанным probesize ffmpeg сдавался —
      // «dimensions not set», падение, перезапуск по кругу. Теперь он спокойно
      // ждёт появления видео и звука. RTSP-муксеру нужны оба параметра до
      // первого пакета, иначе header не пишется вовсе.
      '-probesize', '2000000', '-analyzeduration', '700000', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      // Пакеты уходят сразу, без придержки в муксере: каждая такая задержка
      // складывается с буфером плеера и в VRChat видна как отставание.
      '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-max_delay', '0',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', '-rw_timeout', '5000000', target.url], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
    rtspPushProcesses.set(target.id, child);
    rtspPushUrls.set(target.id, target.url);
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
          if (/non-existing PPS|no frame!|Last message repeated/i.test(text)) continue;
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
    const startedAt = Date.now();
    // Продержался несколько секунд — публикация пошла, счётчик быстрых падений
    // обнуляем, чтобы следующий разрыв снова начинал с короткой паузы.
    setTimeout(() => { if (rtspPushProcesses.get(target.id) === child) rtspPushFailures.set(target.id, 0); }, 5000).unref?.();
    child.on('close', () => {
      if (rtspPushProcesses.get(target.id) !== child) return;
      rtspPushProcesses.delete(target.id);
      // Обрыв одного получателя не трогает ни HLS, ни остальные каналы:
      // недоступный свой сервер не должен ронять локальную ссылку.
      if (stopping || shuttingDown || !relayProcess || rtspPushTimers.has(target.id)) return;
      // Пушер, упавший через доли секунды, — это публикация до первого
      // видеокадра («dimensions not set»): в потоке пока одна аудио-заглушка.
      // Раньше он перезапускался каждые 0,7 с без конца и заваливал журнал
      // сотнями строк. Теперь пауза растёт с числом быстрых падений.
      const быстро = Date.now() - startedAt < 4000;
      const счёт = быстро ? (rtspPushFailures.get(target.id) || 0) + 1 : 0;
      rtspPushFailures.set(target.id, счёт);
      const пауза = счёт > 3 ? Math.min(15000, 1500 * (счёт - 2)) : 700;
      rtspPushTimers.set(target.id, setTimeout(() => { rtspPushTimers.delete(target.id); startRtspPush(); }, пауза));
    });
  }
}

function stopRtspPush() {
  for (const timer of rtspPushTimers.values()) clearTimeout(timer);
  rtspPushTimers.clear();
  for (const child of rtspPushProcesses.values()) child.kill('SIGTERM');
  rtspPushProcesses.clear();
  rtspPushUrls.clear();
}

// Единая точка подключения продюсера: HLS-релей через pipe (с backpressure),
// RTSP-пушер — вторым потребителем тех же чанков (без него поток не тормозится).
// Свой сервер не успевает принимать поток = аплинк не тянет текущий битрейт.
// Раньше лишние чанки просто молча отбрасывались, и у зрителя «прерывалась
// картинка» без единого слова в журнале. Теперь считаем сброшенные подряд
// пакеты и, если их много, пишем понятное событие с советом снизить битрейт.
let remoteDropStreak = 0;
let remoteCongestionAt = 0;
function noteRemoteCongestion() {
  remoteDropStreak++;
  if (remoteDropStreak < 40 || Date.now() - remoteCongestionAt < 20000) return;
  remoteCongestionAt = Date.now();
  remoteDropStreak = 0;
  qualityStats.slowSpells++;
  recordStreamEvent('remote-congestion',
    'свой сервер не успевает принимать поток — аплинк не тянет битрейт; снизьте качество или битрейт в настройках',
    { bitrateKbps: bitrateKbps(sessionProfile()) });
}

function pipeToRelay(child) {
  // Сколько потока разрешено копить получателю, пока он не успевает. Раньше
  // здесь стояли 4 МБ — на реальном битрейте это 5–10 секунд, и медленный свой
  // сервер набирал их один раз при первой же просадке аплинка, а обратно они не
  // рассасывались: до конца эфира зритель смотрел с этой форой. Держим примерно
  // секунду потока: лишнее лучше отбросить (об этом скажет noteRemoteCongestion),
  // чем возить его до вечера.
  const допуск = Math.max(256 * 1024, bitrateKbps(sessionProfile()) * 125);
  child.stdout.on('error', () => {});
  // Обработчик ошибок релея вешается один раз при его запуске: раньше он
  // добавлялся на каждый новый ролик, и за длинный эфир их набирались десятки
  // на одном сокете — Node предупреждал об утечке.
  // Релея может не быть те доли секунды, пока он поднимается после падения:
  // раньше здесь летел TypeError, и трек помечался «не удалось открыть».
  if (relayProcess) child.stdout.pipe(relayProcess.stdin, { end: false });
  child.stdout.on('data', chunk => {
    trackRelayClock(chunk);
    for (const [id, pusher] of rtspPushProcesses) {
      const sink = pusher.stdin;
      if (!sink?.writable) continue;
      // Медленный получатель (свой сервер на слабом канале) не должен копить
      // память, задержку и тормозить остальных — его чанки отбрасываются, но
      // не молча.
      if (sink.writableLength < допуск) {
        sink.write(chunk);
        if (id === 'remote') remoteDropStreak = 0;
      } else if (id === 'remote') noteRemoteCongestion();
    }
  });
}

let relayFailures = 0;
let relayRecoveryTimer = null;

function scheduleRelayRecovery() {
  if (relayRecoveryTimer) return;
  relayFailures += 1;
  if (relayFailures > 5) {
    log('Релей эфира падает раз за разом — перестаю поднимать сам. Запустите эфир заново.');
    return;
  }
  relayRecoveryTimer = setTimeout(() => {
    relayRecoveryTimer = null;
    if (relayProcess || stopping || shuttingDown || !tools.ffmpeg) return;
    try {
      // Часы потока начинаются заново: прежний релей унёс их с собой.
      if (activeKind) reanchorRelay();
      else ensureRelay(streamProfile('queue'));
    } catch (error) { log(`Восстановление канала: ${error.message}`); }
  }, Math.min(10000, 800 * relayFailures));
  relayRecoveryTimer.unref?.();
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
  relayProcess = onAir(spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
  relayProcess.stdin.on('error', error => {
    if (!stopping) log(`Канал HLS: ${error.message}`);
  });
  attachProcessLogs(relayProcess, 'HLS relay');
  const relay = relayProcess;
  relay.on('close', code => {
    // Остановили сами (смена сессии, пересборка, выход) — к этому моменту
    // relayProcess уже другой или пуст. Раньше и на это писалось «релей
    // остановился», пугая человека на каждой смене качества.
    if (relayProcess !== relay) return;
    relayProcess = null; relayStartedAt = 0; relayProfile = null;
    if (stopping || shuttingDown) return;
    // Релей умер сам. Раньше его не поднимал никто: HLS и RTSP вставали
    // насовсем, сторож перезапускал трек в пустоту («Cannot read properties of
    // null»), и эфир останавливался. Спасало разве что автоснижение качества,
    // заодно без нужды урезавшее кадры до конца эфира.
    log(`Релей эфира неожиданно остановился (код ${code ?? 'нет'}) — поднимаю канал заново`);
    scheduleRelayRecovery();
  });
  setTimeout(() => { if (relayProcess === relay) relayFailures = 0; }, 20000).unref?.();
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
    const height = profileHeight(profile);
    const width = Math.round(height * 16 / 9 / 2) * 2;
    const frameFile = join(DATA_DIR, 'pause-frame.png');
    rmSync(frameFile, { force: true });
    const seekArgs = broadcastFrameSource ? [] : ['-ss', Math.max(0, Number(position) || 0).toFixed(3)];
    const frameFilter = `${broadcastFrameSource ? 'reverse,' : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const extractor = onAir(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...seekArgs, '-i', source,
      '-frames:v', '1', '-vf', frameFilter,
      '-c:v', 'png', '-threads', '1', '-update', '1', '-y', frameFile],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
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

// Неподвижная картинка (заставка, стоп-кадр паузы) раньше подавалась как
// «-re -loop 1 -framerate N -i файл»: демуксер image2 на каждом кадре заново
// читал PNG с диска, декодер его распаковывал, scale масштабировал — 60 раз в
// секунду ради одной и той же картинки. Заставка идёт всегда, пока открыта
// программа, и на простое это съедало полъядра — больше, чем сам эфир трека
// (замер: 7,7 с процессора за 15 с против 0,3 с). Теперь картинка читается и
// готовится один раз, loop повторяет уже готовый кадр (сразу в формате
// кодировщика — без перевода цвета на каждом кадре), setpts ставит ровные
// метки, а realtime держит темп настенных часов вместо «-re», которому больше
// нечего читать. Проверено на выдаче в трубу: шаг меток ровно 1/fps, без рывков.
function stillFrameFilter(fps) {
  const формат = encoder.family === 'qsv' ? 'nv12' : 'yuv420p';
  return `format=${формат},loop=loop=-1:size=1:start=0,setpts=N/(${fps}*TB),realtime`;
}

function startPausedFrameProducer(frameFile) {
  const profile = sessionProfile('queue');
  stopStandby();
  const args = ['-hide_banner', '-loglevel', 'warning', '-i', frameFile,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', stillFrameFilter(profile.fps), '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile)];
  const child = onAir(spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
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
  const height = profileHeight(profile);
  const width = Math.round(height * 16 / 9 / 2) * 2;
  // «-re» обязателен на КАЖДОМ lavfi-входе: непейсируемый anullsrc генерирует
  // тишину со скоростью CPU, обгоняет видео на max_interleave_delta, и муксер
  // сливает аудио-таймлайн на сотни секунд вперёд — плеер ломается до resync.
  // Заставка «ожидание медиа» вместо разрывго экрана: эфир не пропадает никогда,
  // пока открыта программа, поэтому зрителю не нужно переподключаться после
  // остановки или между треками — он просто видит экран ожидания.
  const hasImage = existsSync(STANDBY_IMAGE);
  const videoInput = hasImage
    ? ['-i', STANDBY_IMAGE]
    : ['-re', '-f', 'lavfi', '-i', `color=c=0x17121f:s=${width}x${height}:r=${profile.fps}`];
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const args = ['-hide_banner', '-loglevel', 'warning', ...videoInput,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', hasImage ? `${fit},${stillFrameFilter(profile.fps)}` : fit,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...mpegTsOutputArgs(profile)];
  const child = onAir(spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  standbyProcess = child;
  pipeToRelay(child);
  attachProcessLogs(child, 'Standby');
  child.on('close', () => { if (standbyProcess === child) standbyProcess = null; });
}

function ensureRelay(profile = streamProfile()) {
  if (!relayProcess) {
    cleanHls();
    producerClock = null;
    lastRelayPts = 0;
    relayStartedAt = Date.now();
    resetQualityTelemetry();
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
  мгновенныхПадений = 0;
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
    // Приоритет обычный, не фоновый: через spawnJson yt-dlp разбирает ссылку
    // трека, который сейчас пойдёт в эфир, и человек ждёт его прямо сейчас —
    // в фоне под нагрузкой игры это растягивалось бы на лишние секунды заставки.
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

// Не всякий ролик получается положить в кеш: прямая ссылка на файл, который
// yt-dlp не понимает, отдаёт 404 при каждой попытке. Раньше это значило новый
// запуск yt-dlp на каждую смену трека — процессор дёргался каждые 13 секунд, и
// видео в эфире шло рывками при идеальном звуке. Теперь после неудачи трек
// откладывается: сначала на пять минут, потом на полчаса, потом до перезапуска.
const cacheDeclined = new Map();
const CACHE_BACKOFF = [5 * 60000, 30 * 60000, Infinity];

// Убрали трек из очереди — стираем и всё, что о нём помнили. Эти карты
// чистились лениво, только при обращении: за долгий сеанс с кучей
// добавлений-удалений в них копились записи по ушедшим трекам.
function forgetItemState(id) {
  resolvedMedia.delete(id);
  mediaFailures.delete(id);
  cacheDeclined.delete(id);
}

function declineCache(itemId, reason) {
  const было = cacheDeclined.get(itemId)?.tries || 0;
  const tries = было + 1;
  cacheDeclined.set(itemId, { tries, until: Date.now() + CACHE_BACKOFF[Math.min(tries - 1, CACHE_BACKOFF.length - 1)] });
  logDetail(`Кеш недоступен для ${itemId} (попытка ${tries}): ${String(reason).slice(0, 200)}`);
}

function cacheDeclinedNow(itemId) {
  const запись = cacheDeclined.get(itemId);
  if (!запись) return false;
  if (Date.now() > запись.until) { cacheDeclined.delete(itemId); return false; }
  return true;
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
  const заданный = Number(config.cacheLimitGb) || 0;
  if (заданный > 0) return заданный * 1024 * 1024 * 1024;
  // На тесном диске кеш ужимается сам, иначе он доедает остаток места.
  return freeDiskMb !== null && freeDiskMb < 4000 ? 1024 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
}

// Регулярная уборка: кеш по лимиту, папки удалённых треков, ненужные превью
// и временные файлы Unity. Без неё мусор копился до конца свободного места.
function cleanupStorage() {
  trimMediaCache();
  обновитьГотовые();
  storageInfo = { ...storageInfo, sizeMb: mediaCacheSizeMb() };
  listDrives().then(drives => { storageInfo = { ...storageInfo, drives }; }).catch(() => {});
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
    // Во время эфира качаем бережно: четыре потока на полной скорости забивают
    // канал, и картинка у зрителя начинает отставать, хотя сам поток исправен.
    const эфирИдёт = Boolean(activeKind);
    const args = ['--no-warnings', '--no-playlist', '--newline', '--retries', '8', '--fragment-retries', '8',
      '--concurrent-fragments', эфирИдёт ? '1' : '4', ...(эфирИдёт ? ['--limit-rate', '4M'] : []),
      // «<=?» пропускает и форматы без известной высоты: у прямых файлов и
      // страниц, разобранных общим разборщиком, её нет, и строгое «<=» давало
      // «Requested format is not available» — такие ролики не кешировались никогда.
      '--socket-timeout', '20', '-f',
      'bv*[vcodec^=avc1][height<=?1080]+ba[ext=m4a]/b[ext=mp4][height<=?1080]/best[height<=?1080]',
      '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', join(directory, 'source.%(ext)s'), item.sourceUrl];
    const child = inBackground(spawn(ytdlpPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
    mediaCacheProcesses.set(child, item.id);
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => {
      mediaCacheProcesses.delete(child);
      // Загрузку оборвали мы сами (старт эфира, переход по треку) — это не
      // отказ источника. Раньше такой обрыв записывался в неудачи кеша, и
      // ролик, прогревавшийся к эфиру, от нажатия «Старт» переставал качаться
      // на 5 минут, потом на полчаса, потом до перезапуска — и шёл напрямую из сети.
      if (cancelledCacheDownloads.has(child)) {
        cancelledCacheDownloads.delete(child);
        return reject(Object.assign(new Error('Загрузка остановлена.'), { cancelled: true }));
      }
      if (code !== 0) return reject(new Error((stderr || `yt-dlp завершился с кодом ${code}`).trim().split(/\r?\n/).pop()));
      const file = cachedMediaPath(item.id);
      if (!file) return reject(new Error('Загруженный файл не найден.'));
      cachedMedia(item, file).then(resolvePromise, reject);
    });
  }).then(media => {
    log(`Трек буферизирован: ${item.title}`); готовыеВКеше.add(item.id); trimMediaCache(); return media;
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
  const готовый = cachedMediaPath(item.id);
  // Прямая ссылка на файл — это уже готовый mp4. Гонять его через yt-dlp
  // бессмысленно: тот разбирает страницы, а не файлы, и на таких ссылках
  // просто падает с 404. Играем прямо из сети.
  if (!готовый && item.direct) return resolveItem(item);
  if (!готовый && cacheDeclinedNow(item.id)) return resolveItem(item);
  if (!готовый && Number(item.duration) > CACHE_MAX_SECONDS) return resolveItem(item);
  return downloadRemoteMedia(item).then(media => { clearMediaFailure(item.id); return media; }).catch(error => {
    if (error.cancelled) return resolveItem(item);
    // Прямой поток YouTube живёт минуты и часто отдаёт 403 — на него
    // переключаемся молча, но причину пишем в файл для разбора.
    logDetail(`Буфер не собрался для «${item.title}»: ${error.message}`);
    declineCache(item.id, error.message);
    if (/403|forbidden|unavailable|private/i.test(String(error.message))) rememberMediaFailure(item.id, error.message);
    return resolveItem(item);
  });
}

const cancelledCacheDownloads = new WeakSet();

function stopMediaCacheDownloads() {
  for (const [child, itemId] of mediaCacheProcesses) {
    mediaCacheJobs.delete(itemId);
    cancelledCacheDownloads.add(child);
    try { child.kill('SIGTERM'); } catch {}
  }
  mediaCacheProcesses.clear();
}

function unityVideoEncodeArgs(profile) {
  const keyframes = Math.max(30, profile.fps * 2);
  const col = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const base = ['-profile:v', 'baseline', '-level:v', '4.1', '-g', String(keyframes), '-bf', '0'];
  if (encoder.family === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', ...base,
    '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-pix_fmt', 'yuv420p', ...col];
  if (encoder.family === 'amf') return ['-c:v', 'h264_amf', '-quality', 'quality', ...base,
    '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24', '-pix_fmt', 'yuv420p', ...col];
  if (encoder.family === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'slow', ...base,
    '-global_quality', '24', '-pix_fmt', 'nv12', ...col];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', ...base,
    '-pix_fmt', 'yuv420p', ...col];
}

function runUnityFfmpeg(args, label, generation = unityBuildGeneration) {
  return new Promise((resolvePromise, reject) => {
    const child = inBackground(spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
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
  const height = profileHeight(profile);
  const width = Math.round(height * 16 / 9 / 2) * 2;
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
  const volume = Math.max(0, Math.min(4, Number(config.mediaVolume) || 0));
  args.push('-map', `${videoIndex}:v:0`, '-map', `${audioIndex}:a:0`, '-shortest',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS/${speed}`,
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
  // Готовится ровно один трек. Раньше здесь был цикл по списку файлов — от
  // версии, склеивавшей всю очередь; от неё же остались рабочая папка и доли
  // прогресса, считавшиеся от длины списка из одного элемента.
  const profile = streamProfile('queue');
  const workDir = join(UNITY_ITEMS_DIR, `${signature}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  unityBuild = { state: 'building', progress: 0, message: `Загружаю: ${selectedItem.title}`, signature,
    itemId: selectedItem.id, title: selectedItem.title, updatedAt: Date.now() };
  log(`Unity: подготовка одного трека — ${selectedItem.title}`);
  try {
    if (generation !== unityBuildGeneration) throw new Error('Подготовка отменена.');
    unityBuild = { ...unityBuild, progress: 0.05, message: `Кодирование: ${selectedItem.title}`, updatedAt: Date.now() };
    const media = await stableQueueMedia(selectedItem);
    // Отмену могли нажать, пока ролик качался. Без этой проверки после
    // «Отменить» всё равно запускалось полное кодирование на минуты, а новая
    // подготовка упиралась в «Очередь уже подготавливается».
    if (generation !== unityBuildGeneration) throw new Error('Подготовка отменена.');
    const output = join(workDir, 'track.mp4');
    const canRemux = media.unityCompatible && (Number(config.playbackSpeed) || 1) === 1 && (Number(config.mediaVolume) || 0) === 1;
    await runUnityFfmpeg(canRemux ? unityFastRemuxArgs(media, output) : unityNormalizeArgs(media, output, profile), 'Трек', generation);
    const temporary = join(UNITY_DIR, `queue-${signature}.tmp.mp4`);
    unityBuild = { ...unityBuild, progress: 0.97, message: 'Создаю индекс MP4…', updatedAt: Date.now() };
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    renameSync(output, temporary);
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
  const child = inBackground(spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
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
  // prefetchQueue уже берёт следующие треки — отдельный вызов на соседний
  // ролик только дублировал работу.
  if (queue.length) prefetchQueue(index);
}

// Переключение на трек, который ещё не скачан, стоит секунд: yt-dlp сначала
// разбирает ссылку, потом качает. Поэтому фоном держим наготове ближайшие
// треки — тогда «следующий», клик по списку и повтор идут из локального файла
// и переключаются мгновенно. Всю очередь качать нельзя: на плейлисте в полсотни
// роликов это часы работы yt-dlp фоном, и эфир от такой нагрузки дёргается.
const PREFETCH_AHEAD = 2;
// Паузы между остановкой прежнего источника и запуском следующего. Числа
// подобраны замерами: меньше — ffmpeg не успевает освободить устройство
// захвата, больше — переход становится заметен глазу.
const ПАУЗА_ПЕРЕХОДА = 40;
const ПАУЗА_ОЧЕРЕДИ = 25;
const ПАУЗА_ПОВТОРА = 120;

let prefetching = false;
let prefetchPending = null;
async function prefetchQueue(fromIndex = queueIndex) {
  if (!queue.length) return;
  // Просьбу прогреть, пришедшую посреди прогрева, не теряем: её шлёт старт
  // трека, а старт эфира как раз обрывает текущие загрузки — и без повтора
  // ближайшие ролики оставались некешированными до следующей смены трека.
  if (prefetching) { prefetchPending = fromIndex; return; }
  prefetching = true;
  try {
    const ближайшие = [];
    for (let шаг = 0; шаг <= PREFETCH_AHEAD; шаг++) ближайшие.push(queue[(Math.max(0, fromIndex) + шаг) % queue.length]);
    for (const item of ближайшие) {
      if (shuttingDown) return;
      if (!item || item.local || item.direct || item.live || item.id === currentId) continue;
      if (cachedMediaPath(item.id) || cacheDeclinedNow(item.id) || mediaFailure(item.id)) continue;
      if (!queue.some(entry => entry.id === item.id)) continue;
      try { await stableQueueMedia(item); }
      catch (error) {
        declineCache(item.id, error.message);
        log(`Прогрев «${item.title}»: ${error.message}`);
      }
    }
  } finally {
    prefetching = false;
    if (prefetchPending !== null && !shuttingDown) {
      const следующий = prefetchPending;
      prefetchPending = null;
      prefetchQueue(следующий).catch(() => {});
    }
  }
}

// Декодирование отдаём видеокарте: при неудаче ffmpeg сам возвращается к
// программному пути, поэтому флаг безопасен для любых источников.
const HWACCEL = ['-hwaccel', 'auto'];

function queueProducerArgs(media, timestampOffset, seekPosition = 0) {
  const profile = sessionProfile('queue');
  const height = profileHeight(profile);
  const width = Math.round(height * 16 / 9 / 2) * 2;
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
  // Заглавная V берёт только настоящее видео и пропускает обложку альбома.
  // Субтитры и служебные дорожки VRChat не понимает вовсе — отрезаем их явно,
  // вместе с главами и метаданными файла.
  args.push('-map', `${videoIndex}:V:0`, '-map', `${audioIndex}:a:0`,
    '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1', '-shortest',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS/${speed}`,
    '-af', `atempo=${speed},volume=${mediaVolume.toFixed(2)},alimiter=limit=0.97:level=disabled,aresample=async=1000:first_pts=0`,
    '-r', String(profile.fps), '-fps_mode', 'cfr', ...producerEncodeArgs(profile), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '4096',
    '-output_ts_offset', timestampOffset.toFixed(3), '-mpegts_flags', 'resend_headers', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1');
  return args;
}

let мгновенныхПадений = 0;

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
  // Перемотка и переход заставку не поднимают — рассчитано на то, что источник
  // откроется за доли секунды. Но разбор ссылки или докачка идут секундами, и
  // всё это время релею нечего слать: край замирал, сторож принимал это за
  // фриз — снижал качество до конца эфира и пересобирал канал. Если источник
  // не готов быстро, на это время показываем заставку.
  const заставка = setTimeout(() => {
    if (generation === playGeneration && !activeProcess && !queuePaused && !stopping) startStandby(sessionProfile('queue'));
  }, 500);
  try {
    // Ждать источник бесконечно нельзя: пока висит preparingNext, любое
    // переключение молча игнорируется — именно так эфир и «зависал намертво».
    // Не уложились — играем прямо из сети, а докачка идёт своим чередом.
    // Таймер обязательно снимается: без этого он срабатывал даже после
    // удачного старта — на каждом треке лишний разбор ссылки через yt-dlp,
    // строка в журнале и рывок в эфире ровно через двадцать секунд.
    // Перемотка или продолжение трека, который уже играет напрямую, пока его
    // докачка ещё идёт, не должны снова ждать эту докачку по 20 секунд: он
    // уже доказал, что готовится долго, и прямая ссылка на него уже разобрана.
    const ждать = sourcePosition > 0 && mediaCacheJobs.has(item.id) ? 1500 : 20000;
    let запасной = null;
    const media = await Promise.race([
      stableQueueMedia(item).then(результат => { clearTimeout(запасной); запасной = null; return результат; }),
      new Promise((resolvePromise, rejectPromise) => {
        запасной = setTimeout(() => {
          запасной = null;
          log(`Источник «${item.title}» готовится дольше обычного — включаю напрямую`);
          resolveItem(item).then(resolvePromise, rejectPromise);
        }, ждать);
      }),
    ]).finally(() => { if (запасной) { clearTimeout(запасной); запасной = null; } });
    if (stopping || generation !== playGeneration || queuePaused) return;
    // A seek/jump issued while yt-dlp was resolving supersedes this item.
    if (manualTransition) return;
    currentDuration = media.duration || item.duration || null;
    stopStandby();
    const child = onAir(spawn('ffmpeg', queueProducerArgs(media, markProducerTimestamp(nextProducerTimestamp()), sourcePosition), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
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
      if (transition?.type === 'seek') return setTimeout(() => startQueueItem(queueIndex, transition.position, generation), ПАУЗА_ПЕРЕХОДА);
      if (transition?.type === 'jump') return setTimeout(() => startQueueItem(transition.index, transition.position || 0, generation), ПАУЗА_ПЕРЕХОДА);
      if (code && code !== 255 && !item.local && retry < 1 && ranFor < 8) {
        resolvedMedia.delete(item.id);
        playbackBusy = true;
        log(`Источник устарел — обновляю прямую ссылку: ${item.title}`);
        return setTimeout(() => startQueueItem(queueIndex, sourcePosition, generation, retry + 1), ПАУЗА_ПОВТОРА);
      }
      if (code && code !== 255) log(`Трек завершился с кодом ${code}`);
      // Трек, который падает сразу (файл испорчен или пропал после добавления),
      // при повторе «один трек» или в зацикленной очереди из таких файлов
      // перезапускался без конца — несколько ffmpeg в секунду и журнал,
      // забитый ошибками. Три мгновенных падения подряд — останавливаем эфир.
      мгновенныхПадений = code && code !== 255 && ranFor < 2 ? мгновенныхПадений + 1 : 0;
      if (мгновенныхПадений >= 3) {
        мгновенныхПадений = 0;
        log('Треки не открываются один за другим — эфир остановлен. Проверьте файлы в очереди.');
        return stopActive();
      }
      if (config.loopMode === 'one') return setTimeout(() => startQueueItem(queueIndex, 0, generation), ПАУЗА_ПЕРЕХОДА);
      const nextIndex = queueIndex + 1;
      if (nextIndex < queue.length) return setTimeout(() => startQueueItem(nextIndex, 0, generation), ПАУЗА_ПЕРЕХОДА);
      if (config.loopMode === 'all') return setTimeout(() => startQueueItem(0, 0, generation), ПАУЗА_ПЕРЕХОДА);
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
    clearTimeout(заставка);
    preparingNext = false;
    consumeManualTransition(generation);
  }
}

function consumeManualTransition(generation = playGeneration) {
  if (activeProcess || preparingNext || stopping || generation !== playGeneration || !manualTransition) return;
  const transition = manualTransition;
  manualTransition = null;

  if (transition.type === 'seek') setTimeout(() => startQueueItem(queueIndex, transition.position, generation), ПАУЗА_ОЧЕРЕДИ);
  if (transition.type === 'jump') setTimeout(() => startQueueItem(transition.index, transition.position || 0, generation), ПАУЗА_ОЧЕРЕДИ);
}

function stopActive(clearCurrent = true, keepTunnel = true, keepRelay = true) {
  stopping = true;
  stopMediaCacheDownloads();
  stopWindowWatch();
  playGeneration++;
  preparingNext = false;
  activeAuxProcess?.stdout?.unpipe();
  activeWindowProcess?.stdout?.unpipe();
  if (!keepAudioHelper) stopAudioHelper(activeAuxProcess);
  if (!keepWindowHelper) stopWindowHelper(activeWindowProcess);
  stopProducer(activeProcess);
  // На паузе в эфире стоит стоп-кадр трека — он живёт на месте заставки, и
  // startStandby его не трогал: после «Стоп» зрители так и видели замерший
  // кадр фильма вместо экрана ожидания.
  if (queuePaused) stopStandby();
  if (!keepRelay) { stopStandby(); stopRtspPush(); relayProcess?.kill('SIGTERM'); relayProcess = null; relayStartedAt = 0; relayProfile = null; }
  if (!keepTunnel) stopPublicTunnel();
  activeProcess = null; activeKind = null;
  if (!keepAudioHelper) { activeAuxProcess = null; audioHelperKey = ''; }
  if (!keepWindowHelper) { activeWindowProcess = null; windowHelperKey = ''; }
  audioLevelDb = -96; audioSamples = 0; audioSquares = 0;
  queuePaused = false; manualTransition = null; playbackBusy = false;
  if (clearCurrent) { currentId = null; currentStartedAt = null; currentDuration = null; }
  // Новый эфир начинается с того качества, которое выбрал человек.
  degrade = null; lightMode = false;
  if (keepRelay) startStandby();
  // Разбор закончен. Дальше флаг обязан быть снят: на него завязаны все
  // самовосстановления — упавший пушер, упавший RTSP-сервер, оборванный туннель.
  // Пока он висел до следующего запуска, после «Остановить» программа теряла
  // способность чинить себя: окно открыто, «Готово» горит, а поток мёртв.
  stopping = false;
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
    pauseWithFrozenFrame(playGeneration, pausingPendingSeek ? null : latestHlsSegment(0), pausingPendingSeek);
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
    // До 4× — как и ползунок в настройках (400%). Раньше здесь стоял предел 2,
    // и усиление выше 200% при живом эфире молча срезалось: ползунок ехал, а
    // громче не становилось.
    const volume = Math.max(0, Math.min(4, Number(body.volume) || 0));
    saveConfig({ mediaVolume: volume });
    if (activeKind === 'queue') {
      if (queuePaused) pausedPosition = position;
      else transitionQueue('seek', position);
    }
  } else throw new Error('Неизвестная команда плеера.');
  return status();
}

// Имя файла в прямой ссылке часто ничего не значит: у кинохостингов это
// «720.mp4» или «index.m3u8» — по такой подписи в списке не найдёшь ничего.
// Берём название из самого файла, а если его нет — имя сайта и качество.
const БЕЗЛИКИЕ_ИМЕНА = /^(\d{3,4}p?|video|movie|index|master|playlist|stream|out|file|media)$/i;

function directTitle(rawUrl, сведения) {
  const адрес = new URL(rawUrl);
  const файл = decodeURIComponent(адрес.pathname.split('/').filter(Boolean).pop() || '');
  const основа = файл.replace(/\.[a-z0-9]{2,5}$/i, '');
  const изФайла = String(сведения?.title || '').trim();
  if (изФайла && !БЕЗЛИКИЕ_ИМЕНА.test(изФайла)) return изФайла.slice(0, 200);
  if (основа && !БЕЗЛИКИЕ_ИМЕНА.test(основа)) return файл.slice(0, 200);
  const сайт = адрес.hostname.replace(/^www\./i, '').split('.').slice(0, -1).join('.') || адрес.hostname;
  const качество = сведения?.height ? ` ${сведения.height}p` : (основа ? ` ${основа}` : '');
  return `Видео с ${сайт}${качество}`.slice(0, 200);
}

// Разбор прямой ссылки: ffprobe идёт по сети и читает только заголовок файла,
// поэтому двухчасовой фильм разбирается за те же секунды, что и клип.
async function directMediaInfo(rawUrl) {
  const результат = await spawnCollect('ffprobe', ['-v', 'error', '-rw_timeout', '15000000',
    '-show_entries', 'format=duration,format_name,tags=title:stream=codec_type,codec_name,height:stream_disposition=attached_pic',
    '-of', 'json', rawUrl], 40000).catch(() => null);
  if (!результат || результат.status !== 0) {
    const причина = String(результат?.stderr || '').trim().split(String.fromCharCode(10)).pop().trim() || 'сервер не ответил';
    logDetail(`Прямая ссылка не открылась: ${rawUrl.slice(0, 160)} — ${причина}`);
    throw new Error(`Ссылка не открывается: ${причина.replace(/^.*?: /, '').slice(0, 160)}. У ссылок с кинохостингов обычно есть срок годности — возьмите свежую.`);
  }
  try {
    const данные = JSON.parse(результат.stdout);
    const видео = (данные.streams || []).find(настоящееВидео);
    return {
      duration: Number(данные.format?.duration) || null,
      title: данные.format?.tags?.title || '',
      height: Number(видео?.height) || 0,
      hasVideo: Boolean(видео),
      hasAudio: (данные.streams || []).some(поток => поток.codec_type === 'audio'),
    };
  } catch { return null; }
}

async function addUrl(rawUrl) {
  if (!validWebUrl(rawUrl)) throw new Error('Вставьте полную ссылку с http:// или https://');
  const host = new URL(rawUrl).hostname.toLowerCase();
  if (host === 'open.spotify.com') throw new Error('Spotify не отдаёт полный трек. Для Spotify используйте захват окна и звук компьютера.');
  if (!tools.ytdlp) throw new Error('Компонент загрузки видео не найден.');
  const direct = DIRECT_LIVE.test(rawUrl) || DIRECT_FILE.test(rawUrl);
  if (direct) {
    const live = DIRECT_LIVE.test(rawUrl);
    // Прямую ссылку сразу открываем и смотрим, что там: длительность, есть ли
    // картинка, есть ли звук. Раньше она добавлялась вслепую — и мёртвая
    // ссылка молча ложилась в список без длительности, а человек узнавал об
    // этом только когда очередь до неё доходила и ничего не запускалось.
    const сведения = live ? null : await directMediaInfo(rawUrl);
    const item = {
      id: crypto.randomUUID(), title: directTitle(rawUrl, сведения),
      sourceUrl: rawUrl, duration: сведения?.duration || null, thumbnail: '', local: false,
      hasVideo: сведения ? сведения.hasVideo : true, hasAudio: сведения ? сведения.hasAudio : true,
      direct: true, live,
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
      if (/confirm you.?re not a bot|Sign in to confirm|not a bot/i.test(error.message + generic.message)) {
        throw new Error('YouTube не отдаёт это видео (за VPN его общий IP часто в чёрном списке проверки «вы не бот»). Попробуйте другой ролик, отключите VPN или вставьте прямую ссылку на файл.');
      }
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

const FFPROBE_ARGS = ['-v', 'error', '-show_entries',
  'format=duration,format_name:stream=codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json'];

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

// Обложка альбома лежит в файле как «видео» из одного кадра. Считать её видео
// нельзя: у музыкального файла тогда выбиралась картинка вместо звуковой
// дорожки, эфир получал один кадр и обрывался, а у фильма с постером первым
// потоком в эфир уходил постер вместо самого фильма.
function настоящееВидео(stream) {
  return stream.codec_type === 'video' && !stream.disposition?.attached_pic;
}

function parseMediaInfo(stdout) {
  const data = JSON.parse(stdout);
  const videoCodec = data.streams?.find(настоящееВидео)?.codec_name || '';
  const audioCodec = data.streams?.find(stream => stream.codec_type === 'audio')?.codec_name || '';
  const mp4Container = String(data.format?.format_name || '').split(',').some(name => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name));
  return {
    duration: Number(data.format?.duration) || null,
    hasVideo: data.streams?.some(настоящееВидео) || false,
    hasAudio: data.streams?.some(stream => stream.codec_type === 'audio') || false,
    videoCodec, audioCodec,
    unityCompatible: mp4Container && videoCodec === 'h264' && (!audioCodec || audioCodec === 'aac'),
  };
}

// Превью делаются по два за раз. Раньше на каждый добавленный файл сразу
// запускался свой ffmpeg: папка из восьмидесяти роликов — восемьдесят
// процессов одновременно, и идущий эфир от этого рвался гарантированно.
const очередьПревью = [];
const previewChildren = new Set();
let занятоПревью = 0;

function generateThumbnail(item) {
  // Раньше превью делалось только для видео. Но у музыки внутри часто лежит
  // обложка альбома — берём её. Так у трека в списке появляется картинка, а
  // не серый квадрат.
  очередьПревью.push(item);
  качатьПревью();
}

function качатьПревью() {
  while (занятоПревью < 2 && очередьПревью.length) {
    const item = очередьПревью.shift();
    занятоПревью++;
    const destination = join(THUMB_DIR, `${item.id}.jpg`);
    // Для видео — кадр на первой секунде; для музыки — встроенная обложка.
    const args = item.hasVideo
      ? ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', item.sourceUrl,
         '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', destination]
      : ['-hide_banner', '-loglevel', 'error', '-i', item.sourceUrl,
         '-an', '-map', 'disp:attached_pic', '-vf', 'scale=320:-2', '-q:v', '4', '-y', destination];
    const child = inBackground(spawn('ffmpeg', args, { windowsHide: true, stdio: 'ignore' }));
    previewChildren.add(child);
    const дальше = () => { previewChildren.delete(child); занятоПревью--; качатьПревью(); };
    child.on('close', code => {
      if (code === 0 && queue.some(entry => entry.id === item.id)) {
        item.thumbnail = `/thumbs/${item.id}.jpg?v=${Date.now()}`;
        saveQueue();
      }
      дальше();
    });
    child.on('error', дальше);
  }
}

async function addLocalFiles(paths) {
  const added = [];
  for (const rawPath of paths.slice(0, 100)) {
    const filePath = resolve(String(rawPath));
    if (!existsSync(filePath) || !statSync(filePath).isFile() || !MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    let info;
    try { info = await mediaInfoAsync(filePath); }
    catch {
      // ffprobe не прочитал файл — он битый или в неподдерживаемом формате.
      // Кладём в список помеченным недоступным, чтобы он краснел и его было
      // видно, а не молча срывал добавление всей пачки из-за одного файла.
      const item = { id: crypto.randomUUID(), title: basename(filePath), sourceUrl: filePath,
        thumbnail: '', local: true, probed: true, unavailable: true, hasVideo: false, hasAudio: false };
      queue.push(item); added.push(item);
      continue;
    }
    if (!info.hasVideo && !info.hasAudio) continue;
    const item = { id: crypto.randomUUID(), title: basename(filePath), sourceUrl: filePath, thumbnail: '', local: true, probed: true, unavailable: false, ...info };
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
      // Успешная проба укладывается примерно в треть секунды, девять секунд —
      // это только ожидание отказа. На машине без Desktop Duplication перебор
      // четырёх выходов замораживал запуск захвата на полминуты.
      '-i', `ddagrab=output_idx=${index}:framerate=10`, '-frames:v', '1', '-f', 'null', '-'], 2500).catch(() => null);
    const size = `${probe?.stderr || ''}`.match(/,\s(\d{3,5})x(\d{3,5})/);
    if (size && Number(size[1]) === monitor.width && Number(size[2]) === monitor.height) { found = index; break; }
  }
  ddagrabIndexes.set(monitor.id, found);
  log(found === null
    ? `Монитор ${monitor.id}: аппаратный захват недоступен, работаю через GDI`
    : `Монитор ${monitor.id}: аппаратный захват экрана (выход ${found})`);
  return found;
}

// Запасной путь: если PowerShell недоступен или урезан (в песочнице Windows он
// просто не запускается), спрашиваем размер рабочего стола у самого ffmpeg —
// иначе захват экрана становится недоступен вовсе.
async function desktopAsMonitor() {
  const проба = await spawnCollect('ffmpeg', ['-hide_banner', '-f', 'gdigrab', '-i', 'desktop',
    '-frames:v', '1', '-f', 'null', '-'], 12000);
  const размер = `${проба.stderr || ''}`.match(/,\s(\d{3,5})x(\d{3,5})[,\s]/);
  if (!размер) return [];
  return [{ id: 'desktop', name: 'Весь экран', x: 0, y: 0,
    width: Number(размер[1]), height: Number(размер[2]), primary: true }];
}

async function listMonitors() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ id=$_.DeviceName; name=if($_.Primary){'Основной монитор'}else{$_.DeviceName}; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; primary=$_.Primary } } | ConvertTo-Json -Compress`;
  const список = await runPowerShellJson(script).catch(() => []);
  if (список.length) return список;
  log('Список мониторов не получен, беру рабочий стол целиком');
  return desktopAsMonitor();
}

// Список окон стоит дорого: PowerShell компилирует служебный класс заново на
// каждый вызов, а вызывают его при открытии списка, смене режима звука и на
// каждом старте захвата. Держим ответ пару секунд.
let окнаКеш = { время: 0, список: [] };

async function listWindows() {
  if (Date.now() - окнаКеш.время < 2000) return окнаКеш.список;
  const свежие = await listWindowsRaw();
  окнаКеш = { время: Date.now(), список: свежие };
  return свежие;
}

async function listWindowsRaw() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -TypeDefinition @'
using System; using System.Text; using System.Diagnostics; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class VRCastWindows {
  public sealed class Entry { public int id; public string process; public string title; public string handle; public string path; public int x,y,width,height; public bool minimized; }
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
  public static Entry[] List() { var result=new List<Entry>(); EnumWindows((h,l)=>{ try { int len=GetWindowTextLength(h); int cloaked=0; bool iconic=IsIconic(h); DwmGetWindowAttribute(h,14,out cloaked,4); if((!IsWindowVisible(h)&&!iconic)||(cloaked!=0&&!iconic)||len<1)return true; var text=new StringBuilder(len+1); GetWindowText(h,text,text.Capacity); uint pid; RECT r; GetWindowThreadProcessId(h,out pid); if(!GetWindowRect(h,out r))return true; int width=Math.Max(1,r.Right-r.Left),height=Math.Max(1,r.Bottom-r.Top); if(!iconic&&(width<16||height<16))return true; var p=Process.GetProcessById((int)pid); string exe=""; try{ exe=p.MainModule.FileName; }catch{} result.Add(new Entry{id=(int)pid,process=p.ProcessName,title=text.ToString(),handle=h.ToInt64().ToString(),path=exe,x=r.Left,y=r.Top,width=width,height=height,minimized=iconic}); } catch {} return true; },IntPtr.Zero); return result.ToArray(); }
}
'@; [VRCastWindows]::List() | Sort-Object title | ConvertTo-Json -Compress`;
  const junkProcesses = new Set(['dwm', 'csrss', 'winlogon', 'textinputhost', 'shellexperiencehost', 'searchhost']);
  const окна = (await runPowerShellJson(script)).filter(item => item.handle && item.title && !junkProcesses.has(String(item.process || '').toLowerCase()));
  await ensureAppIcons(окна.map(item => item.path));
  for (const окно of окна) {
    const ключ = окно.path ? iconKey(окно.path) : '';
    окно.icon = ключ && existsSync(join(ICON_DIR, `${ключ}.png`)) ? `/api/app-icon?key=${ключ}` : '';
    delete окно.path;
  }
  return окна;
}

// Значок приложения рядом с названием окна: в списке из двадцати одинаковых
// заголовков глазом ищется именно иконка. Вытаскиваем её один раз на каждый
// exe и кладём в файл — дальше список строится без единого запуска PowerShell.
const ICON_DIR = join(DATA_DIR, 'app-icons');

function iconKey(path) {
  return crypto.createHash('sha1').update(String(path).toLowerCase()).digest('hex');
}

async function ensureAppIcons(paths) {
  const нужны = [...new Set(paths.filter(Boolean))].filter(path => !existsSync(join(ICON_DIR, `${iconKey(path)}.png`)));
  if (!нужны.length) return;
  mkdirSync(ICON_DIR, { recursive: true });
  const пары = нужны.map(path => `@{s='${path.replace(/'/g, "''")}';d='${join(ICON_DIR, `${iconKey(path)}.png`).replace(/'/g, "''")}'}`).join(',');
  const script = `Add-Type -AssemblyName System.Drawing; foreach($i in @(${пары})){ try{ $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($i.s); $bitmap=$icon.ToBitmap(); $bitmap.Save($i.d,[System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose(); $icon.Dispose() }catch{} }`;
  await spawnCollect('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15000).catch(() => {});
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

// Живой предпросмотр источника: один ffmpeg переписывает картинку пятнадцать
// раз в секунду, пока человек смотрит вкладку «Экран». Раньше на каждый кадр
// запускался отдельный ffmpeg — отсюда и «будто два кадра в секунду», и стена
// процессов на простое. Через пять секунд без запросов поток гаснет сам.
let previewProcess = null;
let previewKind = '';
let previewLastAsked = 0;
let previewIdleTimer = null;

function stopLivePreview() {
  if (previewIdleTimer) { clearInterval(previewIdleTimer); previewIdleTimer = null; }
  if (!previewProcess) return;
  try { previewProcess.kill('SIGTERM'); } catch {}
  previewProcess = null; previewKind = '';
}

async function ensureLivePreview() {
  previewLastAsked = Date.now();
  if (activeKind) { stopLivePreview(); return false; }
  const rect = await selectedCaptureRect();
  if (config.captureMode === 'window' && (!rect || rect.minimized)) { stopLivePreview(); return false; }
  const вид = [config.captureMode, config.captureMonitorId, config.captureWindowHandle,
    config.regionX, config.regionY, config.regionWidth, config.regionHeight].join('|');
  if (previewProcess && previewKind === вид) return true;
  stopLivePreview();

  const кадры = '15';
  if (config.captureMode === 'window') {
    const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
    if (!existsSync(helper)) return false;
    const захват = inBackground(spawn(helper, ['--hwnd', String(rect.handle), '--width', '960', '--height', '540', '--fps', кадры],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }));
    const перевод = inBackground(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'nv12',
      '-video_size', '960x540', '-framerate', кадры, '-i', 'pipe:0',
      '-vf', `fps=${кадры}`, '-q:v', '5', '-update', '1', '-y', CAPTURE_PREVIEW],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }));
    захват.stdout.on('error', () => {}); перевод.stdin.on('error', () => {});
    захват.stdout.pipe(перевод.stdin);
    перевод.on('close', () => { try { захват.stdin.end(); } catch {} });
    previewProcess = { kill: () => { try { захват.stdin.end(); } catch {} try { перевод.kill('SIGTERM'); } catch {} } };
  } else {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', кадры];
    if (rect) args.push('-offset_x', String(rect.x), '-offset_y', String(rect.y), '-video_size', `${rect.width}x${rect.height}`, '-i', 'desktop');
    else args.push('-i', 'desktop');
    args.push('-vf', 'scale=960:-2:flags=fast_bilinear', '-q:v', '5', '-update', '1', '-y', CAPTURE_PREVIEW);
    previewProcess = inBackground(spawn('ffmpeg', args, { windowsHide: true, stdio: 'ignore' }));
  }
  previewKind = вид;
  previewIdleTimer = setInterval(() => {
    if (Date.now() - previewLastAsked > 5000 || activeKind) stopLivePreview();
  }, 2000);
  previewIdleTimer.unref?.();
  return true;
}

async function generateCapturePreview() {
  // Во время эфира скриншоты не делаем: параллельный захват дерётся за GPU/CPU
  // с рабочим кодировщиком, а монитор в UI и так показывает сам поток.
  if (activeKind === 'screen') {
    if (existsSync(CAPTURE_PREVIEW)) return { url: `/api/capture-preview?time=${Date.now()}`, rect: null };
    throw new Error('Идёт эфир — предпросмотр показывает сам поток.');
  }
  // Живой поток уже пишет картинку — снимать отдельный кадр незачем.
  if (await ensureLivePreview()) {
    const rect = await selectedCaptureRect();
    if (!existsSync(CAPTURE_PREVIEW)) return { unavailable: true, minimized: false, rect, reason: 'Кадр ещё готовится.' };
    return { url: `/api/capture-preview?time=${Date.now()}`, rect, live: true };
  }
  const rect = await selectedCaptureRect();
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', '1'];
  if (config.captureMode === 'window') {
    if (!rect) return { unavailable: true, minimized: false, rect: null };
    if (rect.minimized) return { unavailable: false, minimized: true, rect };
    const helper = join(ROOT, 'tools', 'VRCast.WindowCapture.exe');
    if (!existsSync(helper)) throw new Error('Компонент изолированного захвата окна не найден.');
    const capture = inBackground(spawn(helper, ['--hwnd', rect.handle, '--width', '960', '--height', '540', '--fps', '5'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const converter = inBackground(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'nv12', '-video_size', '960x540', '-framerate', '5', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-y', CAPTURE_PREVIEW], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
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

// Разрешение читать из чужой вкладки даём только публичной ссылке. На своём
// адресе оно позволяло любому сайту вычитывать плейлист эфира — то есть
// смотреть чужой экран, пока идёт трансляция.
function общийДоступ(public_) { return public_ ? { 'Access-Control-Allow-Origin': '*' } : {}; }

function serveFile(res, base, relative, cache = false, public_ = false, head = false) {
  const safe = normalize(relative).replace(/^(\.\.(\\|\/|$))+/, '');
  const file = join(base, safe);
  if ((!file.startsWith(base + sep) && file !== base) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Cache-Control': cache ? 'public, max-age=3600' : 'no-store', ...общийДоступ(public_) });
  // HEAD: только заголовки, без тела. Плееры (AVPro в VRChat) проверяют ссылку
  // запросом HEAD перед проигрыванием — без ответа на него ссылка «ломалась».
  if (head) { res.end(); return true; }
  createReadStream(file).pipe(res); return true;
}

function serveRangeMp4(req, res, filePath, public_ = false) {
  if (!existsSync(filePath)) return false;
  const size = statSync(filePath).size;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  const типы = { '.webm': 'video/webm', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
  const common = { 'Content-Type': типы[extname(filePath).toLowerCase()] || 'video/mp4', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache, no-store', 'CDN-Cache-Control': 'no-store', ...общийДоступ(public_) };
  if (!range) {
    res.writeHead(200, { ...common, 'Content-Length': size });
    if (req.method === 'HEAD') res.end(); else createReadStream(filePath).pipe(res);
    return true;
  }
  // «bytes=-N» — это последние N байт, а не первые: так плееры дочитывают
  // индекс MP4 с конца файла, и раньше они получали вместо него начало.
  const suffix = !range[1] && range[2];
  const start = suffix ? Math.max(0, size - Number(range[2])) : range[1] ? Math.min(size - 1, Number(range[1])) : 0;
  const end = !suffix && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start > end || !Number.isFinite(start) || !Number.isFinite(end)) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true;
  }
  res.writeHead(206, { ...common, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
  if (req.method === 'HEAD') res.end(); else createReadStream(filePath, { start, end }).pipe(res);
  return true;
}

function serveUnityMedia(req, res, id, public_ = false) {
  if (id === 'unity-queue') return serveRangeMp4(req, res, UNITY_QUEUE_FILE, public_);
  if (id === 'unity-capture') return serveRangeMp4(req, res, UNITY_CAPTURE_FILE, public_);
  const item = queue.find(entry => entry.id === id);
  if (!item?.local || !item.unityCompatible || !existsSync(item.sourceUrl)) return false;
  return serveRangeMp4(req, res, item.sourceUrl, public_);
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

// Свои адреса: только они имеют право на пульт управления.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const OWN_ORIGIN = `http://127.0.0.1:${PORT}`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    // Раньше список адресов был записан руками и туннель localhost.run в него
    // не попал. По такой ссылке отдавалось окно плейлиста, рассчитанное на этот
    // же компьютер: четыре секунды истории и старт в полутора секундах от края.
    // Через интернет игроку этого не хватало никогда — «ссылка для друзей не
    // грузит». Заодно через неё открывался весь пульт управления, а не только
    // поток. Теперь адрес берётся у самого туннеля.
    const tunnelHost = (() => { try { return tunnelUrl ? new URL(tunnelUrl).hostname.toLowerCase() : ''; } catch { return ''; } })();
    const publicTunnelHost = (tunnelHost && requestHost === tunnelHost)
      || /\.(trycloudflare\.com|pinggy-free\.link|free\.pinggy\.net|lhr\.life|serveo\.net)$/.test(requestHost);
    if (publicTunnelHost && !url.pathname.startsWith('/stream/') && !url.pathname.startsWith('/media/')) {
      return json(res, 404, { error: 'Через публичную ссылку доступен только медиапоток.' });
    }
    // Пульт управления открыт только со своего же адреса. Без этой проверки
    // любая открытая вкладка в браузере могла послать сюда простой POST без
    // предварительного запроса — включить захват экрана, поднять публичную
    // ссылку, снести сервер по SSH — и подменой DNS выдать себя за 127.0.0.1.
    if (!publicTunnelHost && !LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
      return json(res, 403, { error: 'Обращение с чужого адреса.' });
    }
    const origin = String(req.headers.origin || '');
    if (origin && origin !== OWN_ORIGIN && !publicTunnelHost) {
      return json(res, 403, { error: 'Запрос со стороннего сайта.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && url.pathname === '/api/capture-preview') {
      if (existsSync(CAPTURE_PREVIEW)) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); createReadStream(CAPTURE_PREVIEW).pipe(res); return; }
      return json(res, 404, { error: 'Предпросмотр ещё не создан.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/app-icon') {
      const ключ = String(url.searchParams.get('key') || '');
      const файл = join(ICON_DIR, `${ключ}.png`);
      if (!/^[0-9a-f]{40}$/.test(ключ) || !existsSync(файл)) return json(res, 404, { error: 'Значок не найден.' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      createReadStream(файл).pipe(res); return;
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
      // Качаем и ставим по кнопке. Отвечаем сразу (202), прогресс — в статусе;
      // когда файл готов, сервер сам подменит exe и перезапустится.
      void startUpdateInstall().catch(error => log(`Установка обновления: ${error.message}`));
      return json(res, 202, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/servers') {
      const body = await readBody(req);
      const server = await deployServer(body);
      return json(res, 201, { server: { id: server.id, name: server.name, host: server.host, rtspPort: server.rtspPort }, status: status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/servers/attach') {
      const body = await readBody(req);
      const server = await attachServer(body);
      return json(res, 201, { server: { id: server.id, name: server.name, host: server.host }, status: status() });
    }
    // Ключ публикации отдаём только своему интерфейсу — чтобы человек мог его
    // скопировать и передать другу. Наружу он не уходит: пульт закрыт по Host.
    if (req.method === 'GET' && /^\/api\/servers\/[^/]+\/key$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const server = savedServers().find(item => item.id === id);
      if (!server) return json(res, 404, { error: 'Сервер не найден.' });
      return json(res, 200, { key: server.publishKey || '', host: server.host, rtspPort: server.rtspPort || SERVER_RTSP_PORT });
    }
    if (req.method === 'POST' && /^\/api\/servers\/[^/]+\/edit$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const server = editServer(id, body);
      return json(res, 200, { server: { id: server.id, name: server.name, host: server.host }, status: status() });
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
    if (req.method === 'POST' && /^\/api\/servers\/[^/]+\/linkmode$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      setServerLinkMode(id, { permanent: body.permanent, regenerate: Boolean(body.regenerate) });
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
      // Уже вещаем через этот же сервер — не дёргаем пушер заново. Раньше
      // быстрые повторные тычки по карточке рвали и поднимали RTSP по кругу,
      // и переключение будто зависало.
      if (config.outputMode === 'remote' && config.activeServerId === id) return json(res, 200, status());
      saveConfig({ activeServerId: id, outputMode: 'remote' });
      remoteReachable = null; remoteChannelRejected = false;
      probeAllServers();
      stopPublicTunnel();
      syncRtspPush();
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
      queue = queue.filter(item => item.id !== id); forgetItemState(id); saveQueue();
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
      if (activeKind === 'queue') stopActive(); queue = []; resolvedMedia.clear(); mediaFailures.clear(); cacheDeclined.clear(); saveQueue(); return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const next = {
        outputMode: ['local', 'tunnel', 'remote'].includes(body.outputMode) ? body.outputMode : 'local',
        cacheRoot: typeof body.cacheRoot === 'string' ? body.cacheRoot.trim().slice(0, 300) : config.cacheRoot,
        videoBitrate: Math.max(0, Math.min(20000, Number(body.videoBitrate ?? config.videoBitrate ?? 0) || 0)),
        autoQuality: body.autoQuality === undefined ? config.autoQuality !== false : Boolean(body.autoQuality),
        encoderMode: ['auto', 'gpu', 'cpu'].includes(body.encoderMode) ? body.encoderMode : (config.encoderMode || 'auto'),
        whiteIp: body.whiteIp === undefined ? (config.whiteIp || '') : String(body.whiteIp).trim().replace(/^\w+:\/\//, '').split(/[/:]/)[0].slice(0, 60).replace(/[^a-z0-9.:-]/gi, ''),
        tunnelProvider: ['auto', 'cloudflare', 'pinggy', 'localhostrun'].includes(body.tunnelProvider) ? body.tunnelProvider : (config.tunnelProvider || 'auto'),
        cacheLimitGb: Math.max(0, Math.min(200, Number(body.cacheLimitGb ?? config.cacheLimitGb ?? 0) || 0)),
        activeServerId: savedServers().some(item => item.id === String(body.activeServerId || ''))
          ? String(body.activeServerId) : (activeServer() ? config.activeServerId : (savedServers()[0]?.id || '')),
        // Каждое поле откатывается к прежнему значению, если его не прислали.
        // Раньше половина полей падала в значение по умолчанию, и любой
        // частичный запрос молча сбрасывал выбранный монитор, окно и звук.
        quality: ['480p', '720p', '1080p'].includes(body.quality) ? body.quality : (config.quality || '720p'),
        fps: body.fps === 60 ? 60 : (body.fps === 30 ? 30 : (config.fps || 30)),
        captureMode: ['desktop', 'monitor', 'window', 'region'].includes(body.captureMode) ? body.captureMode : (config.captureMode || 'monitor'),
        captureMonitorId: String(body.captureMonitorId ?? config.captureMonitorId ?? '').slice(0, 180),
        captureWindowHandle: String(body.captureWindowHandle ?? config.captureWindowHandle ?? '').replace(/\D/g, '').slice(0, 24),
        regionX: Math.max(-16384, Math.min(16384, Number(body.regionX ?? config.regionX) || 0)), regionY: Math.max(-16384, Math.min(16384, Number(body.regionY ?? config.regionY) || 0)),
        regionWidth: Math.max(64, Math.min(7680, Number(body.regionWidth ?? config.regionWidth) || 1280)), regionHeight: Math.max(64, Math.min(4320, Number(body.regionHeight ?? config.regionHeight) || 720)),
        audioMode: ['none', 'system', 'output', 'process', 'device'].includes(body.audioMode) ? body.audioMode : (config.audioMode || 'system'),
        captureAudioDevice: String(body.captureAudioDevice ?? config.captureAudioDevice ?? '').slice(0, 180),
        audioOutputId: String(body.audioOutputId ?? config.audioOutputId ?? '').slice(0, 500),
        audioProcessId: String(body.audioProcessId ?? config.audioProcessId ?? '').replace(/\D/g, '').slice(0, 16),
        loopMode: ['once', 'one', 'all'].includes(body.loopMode) ? body.loopMode : (config.loopMode || 'once'),
        playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(body.playbackSpeed)) ? Number(body.playbackSpeed) : (config.playbackSpeed || 1),
        captureVolume: Math.max(0, Math.min(6, Number(body.captureVolume ?? config.captureVolume ?? 1.5))),
        localAppVolume: Math.max(0.02, Math.min(1, Number(body.localAppVolume ?? config.localAppVolume ?? 1))),
        mediaVolume: Math.max(0, Math.min(4, Number(body.mediaVolume ?? config.mediaVolume ?? 1))),
        mediaQuality: ['480p', '720p', '1080p'].includes(body.mediaQuality) ? body.mediaQuality : (config.mediaQuality || '720p'),
        mediaFps: body.mediaFps === 60 ? 60 : (body.mediaFps === 30 ? 30 : (config.mediaFps || 30)),
      };
      const previousOutput = config.outputMode;
      const previousRemoteTarget = remoteRtspTarget();
      const previousEncoderMode = config.encoderMode;
      const previousTunnelProvider = config.tunnelProvider;
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
      const encoderChanged = previousEncoderMode !== config.encoderMode;
      if (encoderChanged) {
        encoder = pickEncoder(config.encoderMode);
        log(`Кодировщик: ${encoder.label}`);
      }
      if (mediaCacheDir() !== previousCacheDir) {
        // Старую папку убираем: треки перекачаются на новое место сами.
        // Удаляем только свою папку кеша: cacheRoot приходит извне, и рекурсивное
        // удаление по произвольному пути — слишком дорогая ошибка.
        try {
          if (basename(previousCacheDir) === 'VRCastBridge-cache' || previousCacheDir === DEFAULT_CACHE_DIR) {
            rmSync(previousCacheDir, { recursive: true, force: true });
          }
        } catch {}
        ensureCacheDir();
        log(`Кеш видео теперь в ${mediaCacheDir()}`);
      }
      const previousRemote = previousRemoteTarget?.publishUrl || '';
      // Состояние сервера проверяем сразу при смене, а не ждём общий цикл:
      // иначе первые двадцать секунд в интерфейсе висит неизвестность.
      if (previousOutput !== config.outputMode || previousRemote !== (remoteRtspTarget()?.publishUrl || '')) {
        remoteReachable = null;
        probeAllServers();
      }
      // Сменили провайдера прямо в режиме «Быстрая ссылка» — поднимаем туннель
      // заново уже через выбранного, старый гасим.
      const провайдерСменился = previousTunnelProvider !== config.tunnelProvider && config.outputMode === 'tunnel';
      if (previousOutput !== config.outputMode || провайдерСменился) {
        clearTimeout(tunnelSwitchTimer);
        tunnelSwitchTimer = setTimeout(() => {
          if (config.outputMode === 'tunnel') { stopPublicTunnel(); startPublicTunnel(); }
          else { stopPublicTunnel(); tunnelError = ''; tunnelState = 'idle'; }
        }, 600);
      }
      // Смена адреса своего сервера подхватывается на лету: пересоздаётся
      // только изменившийся пушер, локальный канал и предпросмотр не рвутся.
      if (previousOutput !== config.outputMode || previousRemote !== (remoteRtspTarget()?.publishUrl || '')) {
        clearTimeout(outputSwitchTimer);
        outputSwitchTimer = setTimeout(syncRtspPush, 250);
      }
      if (applyLive && activeKind) {
        const desired = streamProfile(activeKind);
        // Пересборка сессии сама поднимает источник заново — второй раз не надо.
        // Смена кодировщика профиль не меняет, поэтому пересобираем явно.
        if (relayProcess && (encoderChanged || !sameProfile(relayProfile, desired))) restartRelaySession(desired);
        else if (activeKind === 'screen') await startScreen();
        else if (activeKind === 'queue' && currentId) transitionQueue('seek', currentSourcePosition());
      } else if (encoderChanged && relayProcess && activeKind) {
        // Настройки применили без «применить на лету», но эфир идёт — всё равно
        // перезапускаем сессию, иначе новый кодировщик подхватится только со следующим треком.
        restartRelaySession(streamProfile(activeKind));
      }
      return json(res, 200, status());
    }
    if (req.method === 'POST' && url.pathname === '/api/start/screen') { await startScreen(); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/start/queue') {
      const body = await readBody(req).catch(() => ({}));
      const индекс = body.id ? queue.findIndex(item => item.id === String(body.id)) : 0;
      startQueue(индекс < 0 ? 0 : индекс);
      return json(res, 200, status());
    }
    // Локальный предпросмотр: отдаём файл трека прямо браузеру, без эфира.
    // Так видео можно посмотреть и проиграть до запуска трансляции.
    if (req.method === 'GET' && url.pathname.startsWith('/api/local-media/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/local-media/'.length));
      const item = queue.find(entry => entry.id === id);
      if (!item?.local || !existsSync(item.sourceUrl)) return json(res, 404, { error: 'Файл не найден.' });
      // Браузер играет mp4/webm/m4v и звук напрямую; mkv и прочее — только через эфир.
      if (!/\.(mp4|webm|m4v|m4a|mp3|aac|ogg|opus|wav)$/i.test(item.sourceUrl)) return json(res, 415, { error: 'Этот формат смотрится только в эфире.' });
      return void serveRangeMp4(req, res, item.sourceUrl);
    }
    if (req.method === 'POST' && url.pathname === '/api/skip') { transitionQueue('next'); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/playback') { const body = await readBody(req); return json(res, 200, playbackCommand(body)); }
    if (req.method === 'POST' && url.pathname === '/api/stop') { stopActive(); return json(res, 200, status()); }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      shuttingDown = true;
      if (hlsHealthTimer) clearInterval(hlsHealthTimer);
      stopUnityBuild();
      if (unityCaptureProcess) { try { unityCaptureProcess.stdin.write('q\n'); } catch {} }
      stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); json(res, 200, { ok: true }); setTimeout(() => server.close(() => process.exit(0)), 100); return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/stream/')) {
      const head = req.method === 'HEAD';
      // Плейлист читаем асинхронно: его спрашивает каждый зритель и окно
      // предпросмотра примерно раз в секунду, и синхронное чтение (которое
      // антивирус, проверяющий свежий файл, растягивает до десятков мс) каждый
      // раз останавливало event loop, через который идёт поток.
      const живой = url.pathname === '/stream/live.m3u8' || url.pathname === '/stream/preview.m3u8'
        ? await readFile(join(HLS_DIR, 'live.m3u8'), 'utf8').catch(() => null) : null;
      if (живой !== null) {
        const preview = url.pathname === '/stream/preview.m3u8';
        // ponytail: локальное окно 4×1с — минимальная задержка для AVPro на этом
        // же ПК; публичное окно шире, потому что туннель добавляет джиттер.
        const liveWindow = publicTunnelHost ? 10 : 4;
        const liveOffset = publicTunnelHost ? 3 : 1.5;
        const playlist = prepareLivePlaylist(живой, preview ? 60 : liveWindow, preview ? 2 : liveOffset);
        res.writeHead(200, { 'Content-Type': mime['.m3u8'], 'Cache-Control': 'no-cache, no-store, must-revalidate',
          'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store',
          'Pragma': 'no-cache', 'Expires': '0', ...общийДоступ(publicTunnelHost) });
        res.end(head ? undefined : playlist); return;
      }
      if (serveFile(res, HLS_DIR, url.pathname.slice(8), false, publicTunnelHost, head)) return; return json(res, 404, { error: 'Поток ещё запускается.' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/media\/[^/]+\.mp4$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.slice('/media/'.length, -'.mp4'.length));
      if (serveUnityMedia(req, res, id, publicTunnelHost)) return;
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
  // Первые ролики списка держим наготове с самого запуска: переход «экран →
  // видео» и первый запуск тогда идут из готового файла, без ожидания сети.
  setTimeout(() => { prefetchQueue(0).catch(() => {}); }, 5000);
  // Чиним библиотеку в фоне: пропавшие превью и пометки битых файлов.
  setTimeout(() => { repairLibrary().catch(() => {}); }, 1500);
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
// Необработанная ошибка не должна уносить весь сервер: окно остаётся живым,
// а страница молча теряет связь с ним — это и был тот самый «Failed to fetch».
// Записываем причину и продолжаем работать; действительно смертельное всё
// равно свалит процесс, но одиночный сбой пушера или таймера — нет.
process.on('uncaughtException', error => {
  logDetail(`Непойманная ошибка: ${error?.stack || error}`);
  log(`Внутренняя ошибка обработана: ${String(error?.message || error).slice(0, 160)}`);
});
process.on('unhandledRejection', reason => {
  logDetail(`Необработанный промис: ${reason?.stack || reason}`);
});

// Последний рубеж: перед выходом синхронно валим все дочерние процессы, кого
// ещё видим. Оболочка держит их в группе процессов Windows и добьёт даже при
// снятии через диспетчер, но при обычном выходе node гасим сами и сразу — без
// этого relay/ffmpeg успевали пережить закрытие на секунды и жрали процессор.
function killAllChildren() {
  const дети = [activeProcess, activeAuxProcess, activeWindowProcess, relayProcess, standbyProcess,
    pauseFrameProcess, mediaMtxProcess, tunnelProcess, unityBuildProcess, previewProcess, windowWatcher,
    // mediaCacheProcesses хранит процесс в ключе (значение — id трека): раньше
    // здесь брались значения, и загрузки yt-dlp переживали выход программы.
    ...rtspPushProcesses.values(), ...mediaCacheProcesses.keys(), ...tunnelCandidates, ...previewChildren];
  for (const child of дети) { try { child?.kill('SIGKILL'); } catch {} }
}
process.on('exit', killAllChildren);
process.on('SIGINT', () => { shuttingDown = true; if (hlsHealthTimer) clearInterval(hlsHealthTimer); stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); killAllChildren(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { shuttingDown = true; if (hlsHealthTimer) clearInterval(hlsHealthTimer); stopActive(true, true, false); stopPublicTunnel(); stopMediaMtx(); killAllChildren(); server.close(() => process.exit(0)); });
