// Треки из Spotify. Звук Spotify защищён, поэтому берём только список
// (исполнитель, название, длительность) со встраиваемой страницы — она открыта
// без входа и ключей, — а играет каждый трек найденный на YouTube ролик.

// ID в Spotify — ровно 22 символа base62: так ссылки разделяются, даже если
// поле ввода склеило несколько строк из буфера (Ctrl+C на треках в Spotify).
const LINK = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]{22})/g;

export function spotifyLinks(text) {
  const seen = new Set(), links = [];
  for (const [, type, id] of String(text || '').matchAll(LINK)) {
    if (seen.has(type + id)) continue;
    seen.add(type + id); links.push({ type, id });
  }
  return links;
}

export function parseSpotifyEmbed(html) {
  const json = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  const entity = json && JSON.parse(json)?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('Spotify не отдал список треков — ссылка закрыта или неверна.');
  const cover = entity.coverArt?.sources?.at(-1)?.url || entity.visualIdentity?.image?.at(-1)?.url || '';
  const one = { uri: entity.uri, title: entity.name || entity.title, subtitle: (entity.artists || []).map(a => a.name).join(', '), duration: entity.duration };
  const list = entity.type === 'track' ? [one] : entity.trackList || [];
  return {
    title: entity.name || entity.title || '',
    tracks: list.filter(t => t.title && t.isPlayable !== false).map(t => ({
      id: String(t.uri || '').split(':').pop(),
      title: String(t.title),
      artist: String(t.subtitle || '').replace(/\s+/g, ' ').trim(),
      duration: Number(t.duration) > 0 ? Math.round(Number(t.duration) / 1000) : null,
      cover,
    })),
  };
}

// Все треки из текста по порядку, без повторов.
export async function spotifyTracks(text, fetchPage = url => fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }).then(r => {
  if (!r.ok) throw new Error(`Spotify ответил ${r.status}`); return r.text();
})) {
  const links = spotifyLinks(text);
  const pages = await Promise.all(links.map(link => fetchPage(`https://open.spotify.com/embed/${link.type}/${link.id}`).then(parseSpotifyEmbed)));
  const seen = new Set(), tracks = [];
  for (const page of pages) for (const track of page.tracks) if (!seen.has(track.id)) { seen.add(track.id); tracks.push(track); }
  return { title: links.length === 1 ? pages[0].title : '', tracks };
}
