// Пульт в браузере телефона: ничего ставить не нужно. Открывается по QR-коду из настроек программы на компьютере.
const $ = id => document.getElementById(id);
const KEY = 'vrcast-m-token';
let token = '';
try { token = localStorage.getItem(KEY) || ''; } catch {}
let state = null, receivedAt = 0, seeking = false, abort = null;

const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function toast(text, bad) { const t = $('toast'); t.textContent = text; t.style.display = 'block'; t.className = bad ? 'bad' : ''; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 3200); }

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-VRCast-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.code === 'pairing' || data.code === 'pin') showPair();
    throw new Error(data.error || `Ошибка ${response.status}`);
  }
  return data;
}
// Тема — та же, что в программе на ПК. Запоминаем, чтобы при следующем открытии не мигала чужая.
const THEME_COLORS = { midnight: '#03040a', minimal: '#000000', 'minimal-light': '#ffffff', stage: '#000000', terminal: '#101010', matrix: '#010a04', night: '#0e0c18', broadcast: '#0d0d0d', projector: '#262624' };
function applyTheme(theme) {
  if (!THEME_COLORS[theme]) return;
  const root = document.documentElement;
  if (theme === 'night') root.removeAttribute('data-theme'); else if (root.dataset.theme !== theme) root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_COLORS[theme]);
  try { localStorage.setItem('vrcast-m-theme', theme); } catch {}
}
// Заливка дорожки ползунка до бегунка (в WebKit своей нет).
const fill = el => el.style.setProperty('--fill', (el.value - el.min) / (el.max - el.min) * 100 + '%');
function setPill(text, cls) { $('pillText').textContent = text; $('pill').className = 'pill ' + (cls || ''); }
const act = (fn, ok) => async (...a) => { try { const r = await fn(...a); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); } };

// ── Привязка ──
function showPair() { $('pair').hidden = false; document.querySelectorAll('.tab').forEach(t => t.hidden = true); document.querySelector('nav').hidden = true; }
function hidePair() { $('pair').hidden = true; document.querySelector('nav').hidden = false; showTab(currentTab); }
async function pairWith(code) {
  const name = /Android/i.test(navigator.userAgent) ? 'Телефон (браузер)' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone (браузер)' : 'Браузер';
  const reply = await api('/api/pair', 'POST', { code: String(code).replace(/\D/g, ''), name, kind: 'web' });
  token = reply.token;
  try { localStorage.setItem(KEY, token); } catch {}
  history.replaceState(null, '', location.pathname);
  hidePair(); start();
}
$('pairForm').addEventListener('submit', async e => { e.preventDefault(); $('pairError').textContent = ''; try { await pairWith($('pairCode').value); } catch (err) { $('pairError').textContent = err.message; } });

// ── Вкладки ──
let currentTab = 'Now';
function showTab(name) { currentTab = name; document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 'tab' + name); document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name)); }
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ── Состояние ──
function position() {
  if (!state) return 0;
  const p = state.progress || {}, pb = state.playback || {};
  const live = state.running && state.activeKind === 'queue' && !pb.paused && !pb.buffering;
  const value = (p.elapsed || 0) + (live ? (Date.now() - receivedAt) / 1000 * (pb.speed || 1) : 0);
  return p.duration ? Math.min(value, p.duration) : value;
}

function render() {
  if (!state) return;
  const pb = state.playback || {}, p = state.progress || {}, cfg = state.config || {};
  const cur = (state.queue || []).find(q => q.id === state.currentId);
  applyTheme(cfg.theme);
  const font = cfg.uiFont || '';
  if ((document.documentElement.dataset.font || '') !== font) { if (font) document.documentElement.dataset.font = font; else delete document.documentElement.dataset.font; try { localStorage.setItem('vrcast-m-font', font); } catch {} }
  setPill(!state.running ? 'Не в эфире' : pb.buffering ? 'Загружаю…' : pb.paused ? 'Пауза' : 'В эфире', state.running ? 'live' : '');
  $('title').textContent = state.activeKind === 'screen' ? 'Экран компьютера' : cur?.title || (state.queue?.length ? 'Ничего не играет' : 'Очередь пуста');
  $('sub').textContent = cur?.owner ? `у «${cur.owner}»` : '';
  $('cover').style.backgroundImage = cur?.thumbnail ? `url("${cur.thumbnail}")` : '';
  $('cover').classList.toggle('art', Boolean(cur?.thumbnail));
  $('playIcon').setAttribute('href', state.running && !pb.paused ? '#i-pause' : '#i-play');
  $('bStart').hidden = state.running; $('bStop').hidden = !state.running;
  const seek = $('seek');
  seek.disabled = !(state.running && pb.canSeek && p.duration > 0);
  if (!seeking) seek.value = p.duration ? Math.round(position() / p.duration * 1000) : 0;
  $('tNow').textContent = fmt(position()); $('tAll').textContent = p.duration ? fmt(p.duration) : '';
  if (document.activeElement !== $('vol')) { $('vol').value = Math.round((cfg.mediaVolume ?? 1) * 100); }
  $('volText').textContent = $('vol').value + '%'; fill($('vol')); fill(seek);
  if (document.activeElement !== $('speed')) $('speed').value = String(pb.speed || 1);
  if (document.activeElement !== $('loop')) $('loop').value = pb.loopMode || 'once';
  if (document.activeElement !== $('quality')) $('quality').value = cfg.quality || '720p';
  if (document.activeElement !== $('fps')) $('fps').value = String(cfg.fps || 30);
  if (document.activeElement !== $('output')) $('output').value = cfg.outputMode || 'local';
  renderQueue(); renderLinks();
}

let queueSig = '';
function renderQueue() {
  const items = state.queue || [];
  const sig = JSON.stringify([items.map(q => [q.id, q.title, q.thumbnail, q.owner]), state.currentId, state.running]);
  if (sig === queueSig) return; queueSig = sig;
  const ul = $('queue'); ul.textContent = '';
  if (!items.length) { const li = document.createElement('li'); li.textContent = 'Очередь пуста. Добавьте ссылку или файлы выше.'; li.className = 'muted'; ul.append(li); return; }
  items.forEach((q, i) => {
    const li = document.createElement('li'); if (q.id === state.currentId && state.running) li.className = 'cur';
    const art = document.createElement('div'); art.className = 'art'; if (q.thumbnail) art.style.backgroundImage = `url("${q.thumbnail}")`;
    const t = document.createElement('div'); t.className = 't';
    const b = document.createElement('b'); b.textContent = q.title; const s = document.createElement('span'); s.className = 'muted small'; s.textContent = [q.duration ? fmt(q.duration) : '', q.owner ? `у «${q.owner}»` : '', q.unavailable ? 'недоступно' : ''].filter(Boolean).join(' · ');
    t.append(b, s); t.addEventListener('click', act(() => state.running ? api('/api/playback', 'POST', { action: 'jump', id: q.id }) : api('/api/start/queue', 'POST', { id: q.id })));
    const up = btn('↑', () => api('/api/queue/move', 'POST', { id: q.id, to: i - 1 }), i === 0 || q.member), down = btn('↓', () => api('/api/queue/move', 'POST', { id: q.id, to: i + 1 }), i === items.length - 1 || q.member);
    const del = btn('✕', () => api('/api/queue/' + encodeURIComponent(q.id), 'DELETE'));
    li.append(art, t, up, down, del); ul.append(li);
  });
}
function btn(text, fn, disabled) { const b = document.createElement('button'); b.textContent = text; b.disabled = Boolean(disabled); b.addEventListener('click', act(fn)); return b; }

function renderLinks() {
  const box = $('links'); const urls = [];
  // Адрес 127.0.0.1 имеет смысл только на самом компьютере: телефону (и плееру в сети) нужен адрес, по которому он сюда пришёл.
  const own = u => String(u).replace('127.0.0.1', location.hostname);
  const add = (name, u) => { const url = own(u); if (!urls.some(x => x[1] === url)) urls.push([name, url]); };
  for (const u of state.rtsp?.lanUrls || []) add('Быстрая ссылка (rtspt) для AVPro в этой сети', u);
  if (state.playbackUrl) add('Ссылка для плеера VRChat', state.playbackUrl);
  if (state.tunnel?.url) add('Публичная ссылка', state.tunnel.url);
  const sig = JSON.stringify(urls); if (box.dataset.sig === sig) return; box.dataset.sig = sig; box.textContent = '';
  if (!urls.length) { box.textContent = 'Ссылка появится, когда начнётся эфир.'; box.className = 'muted'; return; }
  box.className = '';
  for (const [name, url] of urls) {
    const h = document.createElement('div'); h.className = 'muted small'; h.textContent = name;
    const a = document.createElement('div'); a.className = 'link'; a.textContent = url;
    const c = document.createElement('button'); c.className = 'wide'; c.textContent = 'Скопировать';
    c.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); toast('Скопировано'); } catch { const r = document.createRange(); r.selectNodeContents(a); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Выделено: нажмите «Копировать» в меню', false); } });
    box.append(h, a, c);
  }
}

// ── Управление ──
const post = (action, extra) => api('/api/playback', 'POST', { action, ...extra });
$('bPlay').addEventListener('click', act(() => state?.running ? post(state.playback?.paused ? 'resume' : 'pause', { position: position() }) : api('/api/start/queue', 'POST', {})));
$('bNext').addEventListener('click', act(() => post('next')));
$('bPrev').addEventListener('click', act(() => post('previous')));
$('bStart').addEventListener('click', act(() => api('/api/start/queue', 'POST', {})));
$('bStop').addEventListener('click', act(() => api('/api/stop', 'POST', {})));
$('bScreen').addEventListener('click', act(() => api('/api/start/screen', 'POST', {}), 'Экран ПК в эфире'));
$('seek').addEventListener('input', () => { seeking = true; fill($('seek')); $('tNow').textContent = fmt($('seek').value / 1000 * (state?.progress?.duration || 0)); });
$('seek').addEventListener('change', act(async () => { const to = $('seek').value / 1000 * (state?.progress?.duration || 0); try { await post('seek', { position: to }); } finally { seeking = false; } }));
$('vol').addEventListener('change', act(() => post('volume', { volume: $('vol').value / 100 })));
$('vol').addEventListener('input', () => { $('volText').textContent = $('vol').value + '%'; fill($('vol')); });
$('speed').addEventListener('change', act(() => post('speed', { speed: Number($('speed').value) })));
$('loop').addEventListener('change', act(() => post('loop', { mode: $('loop').value })));
for (const id of ['quality', 'fps', 'output']) $(id).addEventListener('change', act(() => api('/api/config', 'POST', { quality: $('quality').value, fps: Number($('fps').value), outputMode: $('output').value }), 'Сохранено'));
$('bForget').addEventListener('click', () => { try { localStorage.removeItem(KEY); } catch {} token = ''; toast('Телефон забыт: сканируйте QR заново'); showPair(); });

// ── Очередь: ссылки и файлы ──
$('addForm').addEventListener('submit', async e => {
  e.preventDefault(); const url = $('addUrl').value.trim(); if (!url) return;
  try {
    let result = await api('/api/queue', 'POST', { url });
    if (result.ask && confirm(`Добавить все (${result.ask.count || 'много'})?`)) result = await api('/api/queue', 'POST', { url, confirm: 'all' });
    $('addUrl').value = ''; toast('Добавлено');
  } catch (err) { toast(err.message, true); }
});
$('addFiles').addEventListener('change', async () => {
  const files = [...$('addFiles').files]; $('addFiles').value = '';
  for (const [i, file] of files.entries()) {
    try {
      await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest(); x.open('POST', '/api/queue/upload?name=' + encodeURIComponent(file.name));
        if (token) x.setRequestHeader('X-VRCast-Token', token);
        x.upload.onprogress = ev => { $('upload').textContent = `Файл ${i + 1} из ${files.length}: ${file.name} — ${Math.round(ev.loaded / (ev.total || file.size) * 100)}%`; };
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve() : reject(new Error(d.error || 'Не удалось загрузить')); };
        x.onerror = () => reject(new Error('Связь прервалась')); x.send(file);
      });
    } catch (err) { toast(`${file.name}: ${err.message}`, true); }
  }
  $('upload').textContent = ''; toast('Файлы добавлены');
});

// ── Связь: поток событий, при обрыве — опрос ──
async function start() {
  abort?.abort(); abort = new AbortController();
  const signal = abort.signal;
  try {
    const info = await api('/api/lan-info'); $('devName').textContent = info.name || 'VRCast'; applyTheme(info.theme);
    const response = await fetch('/api/events', { headers: { ...(token ? { 'X-VRCast-Token': token } : {}), Accept: 'text/event-stream' }, signal });
    if (!response.ok) { const d = await response.json().catch(() => ({})); if (d.code === 'pairing' || d.code === 'pin') return showPair(); throw new Error('нет связи'); }
    $('pair').hidden = true;
    const reader = response.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, end).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''); buf = buf.slice(end + 2);
        if (data) { try { state = JSON.parse(data); receivedAt = Date.now(); render(); } catch {} }
      }
    }
  } catch (err) { if (signal.aborted) return; setPill('Нет связи', 'bad'); }
  if (!signal.aborted) setTimeout(start, 1500);
}
setInterval(() => { if (state && !seeking) render(); }, 1000);

(async () => {
  const code = location.hash.replace(/\D/g, '');
  if (code) { try { await pairWith(code); return; } catch (err) { $('pairError').textContent = err.message; showPair(); return; } }
  start();
})();
