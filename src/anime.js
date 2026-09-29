// Аниме-сайты, которые yt-dlp не понимает: AnimeLib (animelib.org и зеркала)
// и плеер Kodik, который встраивают почти все русские аниме-сайты.
//
// AnimeLib — одностраничное приложение: страница пустая, серии и плееры отдаёт
// открытый API api.cdnlibs.org. Сами серии почти всегда в плеере Kodik.
// Kodik отдаёт прямые HLS-ссылки своим же запросом POST /ftor; ссылки в ответе
// закрыты простым шифром (буквы сдвинуты на 18, затем base64) и живут около
// часа — поэтому в очереди хранится ссылка на серию, а прямая добывается
// заново перед воспроизведением.
//
// Выбранное качество хранится в самой ссылке серии, в «#q=720»: fetch хвост
// после # не отправляет, а серия с ним остаётся самодостаточной записью.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const API = 'https://api.cdnlibs.org/api';
const ANIMELIB = /(^|\.)(animelib\.(org|me)|anilib\.me)$/i;
const KODIK = /(^|\.)(kodik(player)?\.(com|info|cc|biz)|aniqit\.com)$/i;

async function запрос(url, options = {}) {
  const ответ = await fetch(url, { ...options, signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, Accept: 'application/json, text/html, */*', ...(options.headers || {}) } });
  if (!ответ.ok) throw new Error(`${new URL(url).hostname} ответил ${ответ.status}`);
  return ответ;
}
const api = async path => (await (await запрос(`${API}${path}`, { headers: { 'Site-Id': '5', Referer: 'https://animelib.org/' } })).json()).data;

export function isAnimeUrl(rawUrl) {
  const host = new URL(rawUrl).hostname;
  return ANIMELIB.test(host) || KODIK.test(host);
}

const желаемоеКачество = rawUrl => Number(new URL(rawUrl).hash.match(/q=(\d+)/)?.[1]) || 1080;
function сКачеством(rawUrl, quality) {
  const url = new URL(rawUrl);
  url.hash = quality && quality < 1080 ? `q=${quality}` : '';
  return url.toString();
}

// Длительность из самого плейлиста потока: сумма #EXTINF. Так серия показывает
// свои 23:40 сразу, а не растущий счётчик, пока её не скачали.
async function длительностьHls(url) {
  try {
    let text = await (await запрос(url)).text();
    const вариант = text.match(/#EXT-X-STREAM-INF[^\n]*\n([^\n#]+)/);
    if (вариант) text = await (await запрос(new URL(вариант[1].trim(), url).toString())).text();
    const всего = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    return всего > 0 ? Math.round(всего) : null;
  } catch { return null; }
}

// ── Kodik ────────────────────────────────────────────────────────────────────
const расшифровать = s => Buffer.from(s.replace(/[a-zA-Z]/g, c => {
  const code = c.charCodeAt(0) + 18;
  return String.fromCharCode((c <= 'Z' ? 90 : 122) >= code ? code : code - 26);
}), 'base64').toString();

function kodikUrl(src) {
  return src.startsWith('//') ? `https:${src}` : src;
}

// Прямая HLS-ссылка: лучшее качество не выше выбранного.
export async function resolveKodik(pageUrl, maxQuality = 1080, referer = 'https://animelib.org/') {
  const page = kodikUrl(pageUrl).replace(/#.*$/, '');
  const html = await (await запрос(page, { headers: { Referer: referer } })).text();
  const params = JSON.parse(html.match(/urlParams\s*=\s*'([^']+)'/)?.[1] || 'null');
  const info = key => html.match(new RegExp(`vInfo\\.${key}\\s*=\\s*'([^']+)'`))?.[1];
  if (!params || !info('hash')) throw new Error('Kodik не отдал данные плеера — серия удалена или ссылка устарела.');
  const body = new URLSearchParams({ d: params.d, d_sign: params.d_sign, pd: params.pd, pd_sign: params.pd_sign,
    ref: decodeURIComponent(params.ref || ''), ref_sign: params.ref_sign, bad_user: 'true', cdn_is_working: 'true',
    type: info('type'), hash: info('hash'), id: info('id'), info: '{}' });
  const ответ = await (await запрос(new URL('/ftor', page), { method: 'POST', body,
    headers: { Referer: page, Origin: new URL(page).origin, 'X-Requested-With': 'XMLHttpRequest' } })).json();
  const все = Object.entries(ответ.links || {}).map(([q, list]) => [Number(q), list?.[0]?.src]).filter(([, src]) => src)
    .sort((a, b) => b[0] - a[0]);
  if (!все.length) throw new Error('Kodik не отдал ссылок на видео.');
  const [height, src] = все.find(([q]) => q <= maxQuality) || все.at(-1);
  const url = kodikUrl(расшифровать(src));
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() || '';
  return { url, height, title: /^kodik/i.test(title) ? '' : title, qualities: все.map(([q]) => q) };
}

// ── AnimeLib ─────────────────────────────────────────────────────────────────
// /ru/anime/246--bleach-anime/watch?episode=8669&team=32457&translation_type=2
function animelibParts(rawUrl) {
  const url = new URL(rawUrl);
  const slug = url.pathname.match(/\/anime\/([^/]+)/)?.[1];
  if (!slug) throw new Error('Не вижу аниме в ссылке AnimeLib — откройте страницу аниме или серии и скопируйте адрес.');
  return { slug, episode: url.searchParams.get('episode'), team: url.searchParams.get('team'),
    translation: url.searchParams.get('translation_type') };
}

const названиеАниме = anime => anime?.rus_name || anime?.name || anime?.eng_name || 'Аниме';
const названиеСерии = (аниме, серия) => `${аниме} — ${серия.number} серия${серия.name ? `. ${серия.name}` : ''}`.slice(0, 200);

function ссылкаСерии(slug, episodeId, team, translation, quality) {
  const url = new URL(`https://animelib.org/ru/anime/${slug}/watch`);
  url.searchParams.set('episode', String(episodeId));
  if (team) url.searchParams.set('team', team);
  if (translation) url.searchParams.set('translation_type', translation);
  return сКачеством(url.toString(), quality);
}

// Озвучка из ссылки есть не у каждой серии: команда меняется по ходу сериала.
// Тогда — та же команда, потом тот же тип перевода, потом любая.
function выбратьПлеер(players, team, translation) {
  const годные = (players || []).filter(p => p.player === 'Kodik' ? p.src : p.video?.quality?.length);
  return годные.find(p => String(p.team?.id) === String(team) && String(p.translation_type?.id) === String(translation))
    || годные.find(p => String(p.team?.id) === String(team))
    || годные.find(p => String(p.translation_type?.id) === String(translation))
    || годные[0] || null;
}

let серверыВидео = null;
async function animelibVideoUrl(player, maxQuality) {
  серверыВидео ||= (await api('/constants?fields[]=videoServers').catch(() => null))?.videoServers || [];
  const все = [...player.video.quality].sort((a, b) => b.quality - a.quality);
  const лучшее = все.find(q => q.quality <= maxQuality) || все.at(-1);
  const сервер = серверыВидео.find(s => s.id === 'main') || серверыВидео[0];
  if (!лучшее || !сервер) throw new Error('AnimeLib не отдал адрес видео.');
  return { url: new URL(лучшее.href.replace(/^\//, ''), сервер.url).toString(), height: лучшее.quality };
}

async function resolveAnimelib(rawUrl) {
  const { episode, team, translation } = animelibParts(rawUrl);
  if (!episode) throw new Error('В ссылке нет серии.');
  const серия = await api(`/episodes/${encodeURIComponent(episode)}`);
  const player = выбратьПлеер(серия.players, team, translation);
  if (!player) throw new Error('У этой серии нет доступного плеера.');
  const качество = желаемоеКачество(rawUrl);
  return player.player === 'Kodik' ? resolveKodik(player.src, качество) : animelibVideoUrl(player, качество);
}

// Для окна добавления: какие есть серии и озвучки. Озвучки берём у выбранной
// серии (или первой): у разных серий набор команд бывает разный.
export async function inspectAnime(rawUrl) {
  const host = new URL(rawUrl).hostname;
  if (KODIK.test(host)) {
    const { title, qualities } = await resolveKodik(rawUrl);
    return { site: 'Kodik', title: title || 'Серия с Kodik', cover: '', episodes: [{ id: 'kodik', number: '1', name: '' }],
      episode: 'kodik', teams: [], team: '', translation: '', qualities };
  }
  const { slug, episode, team, translation } = animelibParts(rawUrl);
  const [аниме, серии] = await Promise.all([
    api(`/anime/${encodeURIComponent(slug)}`).catch(() => null),
    api(`/episodes?anime_id=${encodeURIComponent(slug)}`),
  ]);
  if (!серии?.length) throw new Error('У этого аниме на AnimeLib пока нет серий.');
  const выбрана = серии.find(серия => String(серия.id) === String(episode)) || серии[0];
  const подробно = await api(`/episodes/${выбрана.id}`);
  const команды = [];
  for (const p of подробно.players || []) {
    if (!(p.player === 'Kodik' ? p.src : p.video?.quality?.length)) continue;
    const id = String(p.team?.id || ''), тип = String(p.translation_type?.id || '');
    if (команды.some(k => k.id === id && k.translation === тип)) continue;
    команды.push({ id, name: p.team?.name || 'Без названия', translation: тип, kind: p.translation_type?.label || '' });
  }
  const текущая = выбратьПлеер(подробно.players, team, translation);
  return { site: 'AnimeLib', title: названиеАниме(аниме), cover: аниме?.cover?.default || '',
    episodes: серии.map(серия => ({ id: String(серия.id), number: String(серия.number), name: серия.name || '' })),
    episode: String(выбрана.id), teams: команды,
    team: String(текущая?.team?.id || ''), translation: String(текущая?.translation_type?.id || ''),
    qualities: [1080, 720, 480, 360] };
}

// Что добавить в очередь. scope: 'one' — выбранная серия, 'from' — с неё до
// конца, 'all' — весь сериал.
export async function listAnime(rawUrl, choice = {}) {
  const host = new URL(rawUrl).hostname;
  if (KODIK.test(host)) {
    const { title } = await resolveKodik(rawUrl);
    return [{ title: title || 'Серия с Kodik', sourceUrl: сКачеством(kodikUrl(rawUrl), choice.quality), thumbnail: '' }];
  }
  const parts = animelibParts(rawUrl);
  const team = choice.team ?? parts.team, translation = choice.translation ?? parts.translation;
  const episode = choice.episode ?? parts.episode;
  const scope = choice.scope || (episode ? 'one' : 'all');
  const [аниме, серии] = await Promise.all([
    api(`/anime/${encodeURIComponent(parts.slug)}`).catch(() => null),
    api(`/episodes?anime_id=${encodeURIComponent(parts.slug)}`),
  ]);
  if (!серии?.length) throw new Error('У этого аниме на AnimeLib пока нет серий.');
  const имя = названиеАниме(аниме), обложка = аниме?.cover?.default || '';
  const начало = Math.max(0, серии.findIndex(серия => String(серия.id) === String(episode)));
  const нужные = scope === 'all' ? серии : scope === 'from' ? серии.slice(начало) : [серии[начало]];
  return нужные.map(серия => ({ title: названиеСерии(имя, серия), thumbnail: обложка,
    sourceUrl: ссылкаСерии(parts.slug, серия.id, team, translation, choice.quality) }));
}

// Прямая ссылка на поток серии и её длительность — перед воспроизведением,
// загрузкой и для подписи длительности в очереди.
export async function resolveAnime(sourceUrl) {
  const host = new URL(sourceUrl).hostname;
  const media = KODIK.test(host) ? await resolveKodik(sourceUrl, желаемоеКачество(sourceUrl)) : await resolveAnimelib(sourceUrl);
  return { ...media, duration: await длительностьHls(media.url) };
}

// Любая другая страница: ищем встроенный плеер Kodik (так устроено
// большинство русских аниме-сайтов, которых нет в yt-dlp).
export async function findKodikOnPage(rawUrl) {
  const html = await (await запрос(rawUrl, { headers: { Referer: rawUrl } })).text();
  const найдено = html.match(/(?:https?:)?\/\/(?:kodik(?:player)?\.(?:com|info|cc|biz)|aniqit\.com)\/(?:seria|video|serial|season)\/\d+\/[0-9a-f]+\/\d+p/i);
  return найдено ? kodikUrl(найдено[0]) : null;
}
