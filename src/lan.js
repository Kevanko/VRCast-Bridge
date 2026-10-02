// Доступ из локальной сети (пульт для телефона): кто и куда может обращаться.
import crypto from 'node:crypto';
import { hostname } from 'node:os';

// ::ffff:192.168.1.5 -> 192.168.1.5
const plain = address => String(address || '').replace(/^::ffff:/i, '');

export function isLoopbackAddress(address) {
  const value = plain(address);
  return value === '::1' || value.startsWith('127.');
}

export function isPrivateAddress(address) {
  const value = plain(address).toLowerCase();
  const v4 = value.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(value) || /^fe80:/.test(value);
}

// Host запроса из сети: IP-адрес или имя .local с нашим портом. Любые другие
// имена отбрасываем — так подмена DNS не выдаст чужой сайт за пульт.
export function lanHostAllowed(host, port) {
  const value = String(host || '').toLowerCase();
  const m = value.match(/^(\[[0-9a-f:.]+\]|[0-9.]+|[a-z0-9-]+\.local):(\d+)$/);
  return Boolean(m) && Number(m[2]) === port;
}

const ALLOWED = [
  ['GET', /^\/api\/(status|events|lan-info|capture-preview)$/],
  ['GET', /^\/(thumbs|stream|api\/local-media)\//],
  ['POST', /^\/api\/(playback|stop|skip|queue|queue\/inspect|queue\/move|queue\/upload|pair)$/],
  ['POST', /^\/api\/start\/(queue|phone)$/],
  ['DELETE', /^\/api\/queue(\/[^/]+)?$/],
];

// Настройки эфира: только привязанному телефону (знает код с ПК). Серверы и ключи сюда не входят.
const PAIRED = [
  ['GET', /^\/api\/pair\/check$/],
  ['POST', /^\/api\/(config|tunnels\/test|servers\/speedtest)$/],
];
export const lanRoutePaired = (method, pathname) => PAIRED.some(([m, pattern]) => m === method && pattern.test(pathname));

// Из настроек телефон может менять только это.
const NETWORK_CONFIG = ['outputMode', 'activeServerId', 'tunnelProvider', 'whiteIp', 'quality', 'fps', 'mediaQuality', 'mediaFps', 'videoBitrate', 'encoderMode'];
export const pickNetworkConfig = body => Object.fromEntries(NETWORK_CONFIG.filter(key => body && key in body).map(key => [key, body[key]]));

export const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
export function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Что разрешено тем, кто пришёл не с самого компьютера. Остальное — только свой ПК.
export function lanRouteAllowed(method, pathname) {
  const verb = method === 'HEAD' ? 'GET' : method;
  return ALLOWED.some(([m, pattern]) => m === verb && pattern.test(pathname));
}

let published = null;

// Объявляем _vrcast._tcp, чтобы приложение на телефоне нашло ПК само.
export async function publishService({ port, version, log }) {
  await unpublishService();
  try {
    const { Bonjour } = await import('bonjour-service');
    const bonjour = new Bonjour();
    const service = bonjour.publish({ name: `VRCast Bridge (${hostname()})`, type: 'vrcast', protocol: 'tcp', port,
      txt: { name: hostname(), ver: String(version) } });
    published = { bonjour, service };
    log?.(`Пульт для телефона: ПК виден в сети как «${hostname()}»`);
  } catch (error) { log?.(`Не удалось объявить ПК в сети (mDNS): ${error.message}`); }
}

export function unpublishService() {
  const current = published;
  published = null;
  if (!current) return Promise.resolve();
  return new Promise(resolve => {
    try { current.bonjour.unpublishAll(() => { current.bonjour.destroy(); resolve(); }); }
    catch { resolve(); }
  });
}
