// Это устройство как участник чужой группы: подключается к другому устройству (ПК или телефону) по коду привязки,
// отдаёт ему свои файлы и серверы, пока на связи, и может им управлять. Отключились — всё у админа пропадает.
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

export function normalizeBase(address) {
  let text = String(address || '').trim();
  if (!text) throw new Error('Введите адрес устройства.');
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('Адрес не похож на адрес устройства.'); }
  if (url.protocol !== 'http:') throw new Error('Нужен адрес вида 192.168.0.5:4717.');
  return `http://${url.hostname}:${url.port || 4717}`;
}

// С какого своего адреса видно устройство: именно его оно будет использовать, чтобы забрать наши файлы.
export function localAddressTo(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 4000 });
    socket.once('connect', () => { const address = socket.localAddress; socket.destroy(); resolve(String(address).replace(/^::ffff:/, '')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Устройство не отвечает.')); });
    socket.once('error', reject);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ask = (base, path, { token, method = 'GET', body, ms = 6000 } = {}) => fetch(`${base}${path}`, {
  method, signal: AbortSignal.timeout(ms),
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-VRCast-Token': token } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function answer(response) {
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(data.error || `Устройство ответило ${response.status}`), { status: response.status });
  return data;
}

/**
 * deps: getJoined(), setJoined(value|null), items() -> [{id,title,duration}], servers() -> [{id,name,host,rtspPort,publishKey,channel}],
 * deviceName(), port(), dropItems(ids), log(text).
 */
export function createJoin(deps) {
  let abort = null;
  let timer = null;
  const link = { online: false, error: '', hostState: null, shared: 0 };

  const stateOf = () => {
    const joined = deps.getJoined();
    if (!joined) return null;
    const host = link.hostState;
    const current = host?.queue?.find(item => item.id === host.currentId);
    return { name: joined.hostName, address: joined.base, online: link.online, error: link.error, shared: link.shared,
      running: host?.running === true, paused: host?.playback?.paused === true, title: current?.title || '',
      controller: host?.group?.controller?.name || '', queue: host?.queue?.length || 0 };
  };

  async function contribute() {
    const joined = deps.getJoined();
    if (!joined || !link.online) return;
    try {
      const own = await localAddressTo(new URL(joined.base).hostname, Number(new URL(joined.base).port));
      const items = deps.items();
      const reply = await answer(await ask(joined.base, '/api/group/contribute', { token: joined.token, method: 'POST', body: {
        media: { base: `http://${own}:${deps.port()}`, key: joined.mediaKey },
        queue: items.map(item => ({ id: item.id, title: item.title, duration: item.duration })),
        servers: deps.servers() } }));
      link.shared = items.length;
      link.error = '';
      if (Array.isArray(reply.removed) && reply.removed.length) deps.dropItems(reply.removed.map(String));
    } catch (error) {
      if (error.status === 401) { deps.log('Устройство отвязало этот компьютер: подключение снято'); deps.setJoined(null); stop(); return; }
      link.error = error.message;
    }
  }

  // Поток событий держит нас «в сети» у админа и приносит его состояние для показа.
  async function listen(signal) {
    const joined = deps.getJoined();
    const response = await fetch(`${joined.base}/api/events`, { headers: { 'X-VRCast-Token': joined.token, Accept: 'text/event-stream' }, signal });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Устройство не узнало этот компьютер.'), { status: 401 });
    if (!response.ok) throw new Error(`Устройство ответило ${response.status}`);
    link.online = true;
    link.error = '';
    deps.log(`Подключено к «${joined.hostName}»: файлы и серверы стали общими`);
    contribute();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (data) { try { link.hostState = JSON.parse(data); } catch {} }
      }
    }
  }

  async function loop(signal) {
    while (!signal.aborted && deps.getJoined()) {
      try { await listen(signal); } catch (error) {
        if (signal.aborted) return;
        if (error.status === 401) { deps.log('Устройство отвязало этот компьютер: подключение снято'); deps.setJoined(null); return; }
        link.error = error.message;
      }
      link.online = false;
      await sleep(2000);
    }
  }

  function begin() {
    stop();
    if (!deps.getJoined()) return;
    abort = new AbortController();
    loop(abort.signal);
    timer = setInterval(() => { contribute(); }, 5000);
    timer.unref?.();
  }

  function stop() {
    abort?.abort(); abort = null;
    clearInterval(timer); timer = null;
    link.online = false; link.hostState = null; link.shared = 0;
  }

  let soon = null;
  return {
    state: stateOf,
    resume: begin,
    changed() { if (!link.online || soon) return; soon = setTimeout(() => { soon = null; contribute(); }, 400); soon.unref?.(); },
    async join(address, code, { name }) {
      const base = normalizeBase(address);
      const info = await answer(await ask(base, '/api/lan-info'));
      const paired = await answer(await ask(base, '/api/pair', { method: 'POST', body: { code: String(code || '').replace(/\D/g, ''), name, kind: 'pc' } }));
      deps.setJoined({ base, token: paired.token, hostId: info.id || '', hostName: String(info.name || base).slice(0, 60), mediaKey: randomBytes(18).toString('base64url') });
      begin();
      return stateOf();
    },
    async leave() {
      const joined = deps.getJoined();
      if (joined) { try { await ask(joined.base, '/api/group/leave', { token: joined.token, method: 'POST', body: {} }); } catch {} }
      stop();
      deps.setJoined(null);
    },
    // Управление эфиром устройства-админа с этого компьютера.
    async control(action) {
      const joined = deps.getJoined();
      if (!joined) throw new Error('Нет подключения к другому устройству.');
      const call = async (path, body = {}) => answer(await ask(joined.base, path, { token: joined.token, method: 'POST', body }));
      if (action === 'stop') await call('/api/stop');
      else if (action === 'take') await call('/api/group/take');
      else if (['toggle', 'next', 'previous'].includes(action)) await call('/api/playback', { action });
      else throw new Error('Неизвестное действие.');
      return stateOf();
    },
    stop,
  };
}
