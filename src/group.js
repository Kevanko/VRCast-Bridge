// Группа устройств: админ (к кому подключаются) держит общую очередь и серверы.
// Участники присылают свои файлы и серверы, пока подключены; отключились — всё убирается.
// Файлы остаются у владельца: админ играет их по ссылке на само устройство.

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const ID = /^[\w.-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
export const MAX_SHARED_ITEMS = 200;
export const MAX_SHARED_SERVERS = 10;

const bareAddress = address => String(address || '').replace(/^::ffff:/, '');

// Откуда админ заберёт файлы. Адрес обязан совпасть с адресом самого участника:
// иначе участник мог бы направить админа на любой чужой адрес в сети.
export function parseMediaBase(media, remoteAddress) {
  if (!media || typeof media !== 'object') return null;
  let base;
  try { base = new URL(String(media.base || '')); } catch { return null; }
  if (base.protocol !== 'http:' || !base.port || base.hostname !== bareAddress(remoteAddress)) return null;
  const key = String(media.key || '');
  if (!KEY.test(key)) return null;
  return { base: `http://${base.hostname}:${base.port}`, key };
}

// Что участник прислал: проверяем и обрезаем, доверять присланному нельзя.
export function sanitizeContribution(body, remoteAddress) {
  const media = parseMediaBase(body?.media, remoteAddress);
  const seen = new Set();
  const queue = [];
  for (const raw of Array.isArray(body?.queue) ? body.queue : []) {
    const id = String(raw?.id ?? '');
    if (!media || !ID.test(id) || seen.has(id) || queue.length >= MAX_SHARED_ITEMS) continue;
    seen.add(id);
    queue.push({ id, title: clean(raw.title, 200) || id, duration: Number(raw.duration) > 0 ? Number(raw.duration) : null,
      hasVideo: raw.hasVideo !== false, hasAudio: raw.hasAudio !== false });
  }
  const servers = [];
  for (const raw of Array.isArray(body?.servers) ? body.servers : []) {
    const host = clean(raw?.host, 253), key = clean(raw?.publishKey || raw?.key, 200);
    if (!host || !key || !/^[a-z0-9.-]+$/i.test(host) || servers.length >= MAX_SHARED_SERVERS) continue;
    const port = Number(raw.rtspPort);
    servers.push({ id: clean(raw.id, 64) || `${host}:${port || 8554}`, name: clean(raw.name, 60) || host, host,
      rtspPort: port >= 1 && port <= 65535 ? port : 8554, channel: clean(raw.channel, 40).replace(/[^a-z0-9_-]/gi, '') || 'live', publishKey: key });
  }
  return { media, queue, servers };
}

// Элемент очереди админа для файла участника: играется по сети, на диск админа не сохраняется.
export function sharedQueueItem(member, shared, media) {
  return { id: `${member.id}.${shared.id}`, title: shared.title, sourceUrl: `${media.base}/api/media/${encodeURIComponent(shared.id)}?k=${media.key}`,
    duration: shared.duration, thumbnail: '', local: false, hasVideo: shared.hasVideo, hasAudio: shared.hasAudio,
    videoCodec: '', audioCodec: '', unityCompatible: false, unavailable: false, probed: true, missing: false,
    direct: true, live: false, anime: false, member: member.id, owner: member.name, ownerItemId: shared.id };
}

export function sharedServer(member, shared) {
  return { id: `${member.id}.${shared.id}`, name: shared.name, host: shared.host, sshPort: 22, user: 'root', hostKey: '', channel: shared.channel,
    publicIp: shared.host, rtspPort: shared.rtspPort, hlsPort: 0, publishKey: shared.publishKey, permanentLink: true,
    addedAt: new Date().toISOString(), member: member.id, owner: member.name };
}

// Ссылка на файл не должна уходить в сеть: в ней ключ доступа к устройству-владельцу.
export function hideMemberSource(item) {
  return item.member ? { ...item, sourceUrl: '' } : item;
}

// Кто ведёт эфир: тот, кто начал последним.
export function takeInitiative(current, actor, now = Date.now()) {
  return actor ? { id: actor.id, name: actor.name, kind: actor.kind || 'pc', at: now } : current;
}
