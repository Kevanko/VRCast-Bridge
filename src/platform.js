// Платформенные различия Windows / Linux в одном месте.
import { accessSync, constants, readFileSync, readlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { arch, homedir } from 'node:os';

export const IS_WIN = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

// 'ffmpeg' -> 'ffmpeg.exe' в Windows, 'ffmpeg' в Linux.
export const exe = name => (IS_WIN ? `${name}.exe` : name);

export function dataBase() {
  if (IS_WIN) return process.env.LOCALAPPDATA || process.cwd();
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

// Первый исполняемый файл с таким именем в PATH или ''.
export function which(name, pathValue = process.env.PATH || '') {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return '';
}

const ARM = arch() === 'arm64';

// Откуда докачивать утилиты, если их нет ни рядом, ни в системе.
export function toolSources() {
  if (IS_WIN) return {
    'yt-dlp.exe': { label: 'загрузчик видео', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' },
    'cloudflared.exe': { label: 'публичные ссылки', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' },
    'mediamtx.exe': { label: 'мгновенный канал', github: 'bluenviron/mediamtx', asset: /windows_amd64\.zip$/i, unpack: ['mediamtx.exe'] },
    // ffmpeg тянем с GitHub, а не с gyan.dev: за VPN gyan отдаёт свои 100+ МБ по
    // 0.2 МБ/с (минуты и таймаут), а GitHub-зеркало — 8 МБ/с. Нужна сборка gpl:
    // в ней есть libx264, на который откатывается кодирование на процессоре.
    'ffmpeg.exe': { label: 'кодировщик', github: 'BtbN/FFmpeg-Builds', tag: 'latest', asset: /win64-gpl\.zip$/i, unpack: ['ffmpeg.exe', 'ffprobe.exe'] },
  };
  return {
    'yt-dlp': { label: 'загрузчик видео', url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux${ARM ? '_aarch64' : ''}` },
    'cloudflared': { label: 'публичные ссылки', url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARM ? 'arm64' : 'amd64'}` },
    'mediamtx': { label: 'мгновенный канал', github: 'bluenviron/mediamtx', asset: ARM ? /linux_arm64\.tar\.gz$/i : /linux_amd64\.tar\.gz$/i, unpack: ['mediamtx'] },
    'ffmpeg': { label: 'кодировщик', github: 'BtbN/FFmpeg-Builds', tag: 'latest', asset: ARM ? /linuxarm64-gpl\.tar\.xz$/i : /linux64-gpl\.tar\.xz$/i, unpack: ['ffmpeg', 'ffprobe'] },
  };
}

// ---- Захват экрана ----

export const displayName = () => process.env.DISPLAY || ':0';

// Входные аргументы ffmpeg для захвата экрана, области или окна.
// В Linux работает X11 (в Wayland — только то, что видно через XWayland).
export function screenInput({ rect = null, windowId = null, fps }) {
  if (IS_WIN) {
    const args = ['-f', 'gdigrab', '-draw_mouse', '1', '-framerate', String(fps)];
    if (rect) args.push('-offset_x', String(rect.x), '-offset_y', String(rect.y), '-video_size', `${rect.width}x${rect.height}`, '-i', 'desktop');
    else args.push('-i', 'desktop');
    return args;
  }
  const args = ['-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps)];
  if (windowId) return [...args, '-window_id', `0x${Number(windowId).toString(16)}`, '-i', displayName()];
  if (rect) return [...args, '-video_size', `${rect.width}x${rect.height}`, '-i', `${displayName()}+${rect.x},${rect.y}`];
  return [...args, '-i', displayName()];
}

export function parseXrandr(text) {
  const monitors = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(\S+) connected( primary)?\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (!m) continue;
    monitors.push({ id: m[1], name: m[2] ? 'Основной монитор' : m[1], x: Number(m[5]), y: Number(m[6]),
      width: Number(m[3]), height: Number(m[4]), primary: Boolean(m[2]) });
  }
  if (monitors.length && !monitors.some(item => item.primary)) monitors[0].primary = true;
  return monitors;
}

export function parseXprop(text) {
  const out = { title: '', pid: 0, hidden: false, className: '', service: false };
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^_NET_WM_NAME\(\w+\) = "(.*)"$/))) out.title = m[1].replace(/\\(["\\])/g, '$1');
    else if (!out.title && (m = line.match(/^WM_NAME\(\w+\) = "(.*)"$/))) out.title = m[1].replace(/\\(["\\])/g, '$1');
    else if ((m = line.match(/^_NET_WM_PID\(\w+\) = (\d+)/))) out.pid = Number(m[1]);
    else if (line.startsWith('_NET_WM_WINDOW_TYPE(')) out.service = /_NET_WM_WINDOW_TYPE_(DESKTOP|DOCK)/.test(line);
    else if (line.startsWith('_NET_WM_STATE(')) out.hidden = line.includes('_NET_WM_STATE_HIDDEN');
    else if ((m = line.match(/^WM_CLASS\(\w+\) = "[^"]*", "([^"]*)"/))) out.className = m[1];
  }
  return out;
}

export function parseXwininfo(text) {
  const num = label => Number(String(text).match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1]);
  const [x, y, width, height] = [num('Absolute upper-left X'), num('Absolute upper-left Y'), num('Width'), num('Height')];
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
}

export function parseClientList(text) {
  return [...String(text).matchAll(/0x[0-9a-f]+/gi)].map(m => Number(m[0]));
}

function processName(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; }
}

// Список окон X11 в том же виде, что отдаёт Windows-вариант (без значков).
// run(cmd, args, timeoutMs) -> { status, stdout }.
export async function listWindowsX11(run) {
  const root = await run('xprop', ['-root', '_NET_CLIENT_LIST'], 5000).catch(() => null);
  const ids = parseClientList(root?.stdout || '');
  const rows = await Promise.all(ids.map(async id => {
    const [props, geometry] = await Promise.all([
      run('xprop', ['-id', String(id), '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID', '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE', 'WM_CLASS'], 5000).catch(() => null),
      run('xwininfo', ['-id', String(id)], 5000).catch(() => null),
    ]);
    const info = parseXprop(props?.stdout || ''), box = parseXwininfo(geometry?.stdout || '');
    if (!info.title || !box || info.service) return null;
    if (!info.hidden && (box.width < 16 || box.height < 16)) return null;
    let path = '';
    try { path = readlinkSync(`/proc/${info.pid}/exe`); } catch {}
    return { id: info.pid, process: processName(info.pid) || info.className, title: info.title, handle: String(id),
      path, ...box, minimized: info.hidden };
  }));
  return rows.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
}

export async function listMonitorsX11(run) {
  const result = await run('xrandr', ['--query'], 5000).catch(() => null);
  return parseXrandr(result?.stdout || '');
}

// ---- Звук (PulseAudio / PipeWire) ----

// pw-dump -> { sinks: [{id, name, isDefault}], sources: [имя] }.
export function parsePwDump(json) {
  let objects;
  // Если граф меняется во время дампа, pw-dump дописывает второй массив: склеиваем.
  try { objects = JSON.parse(String(json).replace(/^\]\s*\n\[\s*$/gm, ',')); } catch { return { sinks: [], sources: [] }; }
  let defaultSink = '';
  const sinks = [], sources = [];
  for (const object of objects) {
    if (object.type === 'PipeWire:Interface:Metadata') {
      const entry = (object.metadata || []).find(item => item.key === 'default.audio.sink');
      defaultSink = entry?.value?.name || defaultSink;
    }
    const props = object.info?.props;
    if (object.type !== 'PipeWire:Interface:Node' || !props?.['node.name']) continue;
    const name = props['node.name'], label = props['node.description'] || props['node.nick'] || name;
    if (props['media.class'] === 'Audio/Sink') sinks.push({ id: name, name: label });
    else if (props['media.class'] === 'Audio/Source') sources.push(name);
  }
  return { sinks: sinks.map(item => ({ ...item, isDefault: item.id === defaultSink })), sources };
}

// pactl list short sinks|sources -> имена (второй столбец).
export function parsePactlShort(text) {
  return String(text).split(/\r?\n/).map(line => line.split('\t')[1]).filter(Boolean);
}

export async function listAudioLinux(run) {
  const dump = await run('pw-dump', [], 8000).catch(() => null);
  if (dump?.status === 0 && dump.stdout.trim()) return parsePwDump(dump.stdout);
  const [sinks, sources] = await Promise.all(['sinks', 'sources'].map(kind => run('pactl', ['list', 'short', kind], 5000).catch(() => null)));
  return {
    sinks: parsePactlShort(sinks?.stdout || '').map(name => ({ id: name, name, isDefault: false })),
    sources: parsePactlShort(sources?.stdout || '').filter(name => !name.endsWith('.monitor')),
  };
}

// Имя источника PulseAudio для ffmpeg по настройкам звука или null (тишина).
export function pulseSource(config) {
  if (config.audioMode === 'device') return config.captureAudioDevice || null;
  if (config.audioMode === 'output' && config.audioOutputId) return `${config.audioOutputId}.monitor`;
  // Звук отдельного приложения в Linux не вырезать — отдаём весь системный.
  if (config.audioMode === 'system' || config.audioMode === 'process' || config.audioMode === 'output') return '@DEFAULT_MONITOR@';
  return null;
}
