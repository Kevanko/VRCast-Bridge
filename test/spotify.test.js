import test from 'node:test';
import assert from 'node:assert/strict';
import { closestByDuration, spotifyCover, spotifyLinks, spotifyTracks } from '../src/spotify.js';

const A = '3zOYmiNOuyDL0ClxJcEJ0T', B = '70cHKK8bHAfJrOGVnfRG9J', P = '37i9dQZF1DXcBWIGoYBM5M';
const page = entity => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

test('Spotify: ссылки из буфера — по строкам, склеенные, с intl и spotify:, без повторов', () => {
  const copied = `https://open.spotify.com/track/${A}?si=x\nhttps://open.spotify.com/intl-de/track/${B}`;
  assert.deepEqual(spotifyLinks(copied), [{ type: 'track', id: A }, { type: 'track', id: B }]);
  assert.deepEqual(spotifyLinks(copied.replace('\n', '')), [{ type: 'track', id: A }, { type: 'track', id: B }], 'поле ввода склеило строки');
  assert.deepEqual(spotifyLinks(`spotify:playlist:${P} https://open.spotify.com/playlist/${P}`), [{ type: 'playlist', id: P }]);
  assert.deepEqual(spotifyLinks('https://www.youtube.com/watch?v=abc'), []);
});

test('Spotify: треки плейлиста и отдельного трека, недоступные пропускаются', async () => {
  const pages = {
    [`playlist/${P}`]: page({ type: 'playlist', name: 'Хиты', coverArt: { sources: [{ url: 'https://i.scdn.co/cover' }] }, trackList: [
      { uri: `spotify:track:${A}`, title: 'Stop The Wedding!', subtitle: 'Ashe', duration: 198840 },
      { uri: 'spotify:track:XXXXXXXXXXXXXXXXXXXXXX', title: 'Закрытый', subtitle: 'Кто-то', isPlayable: false },
    ] }),
    [`track/${A}`]: page({ type: 'track', uri: `spotify:track:${A}`, name: 'Stop The Wedding!', artists: [{ name: 'Ashe' }], duration: 198840 }),
    [`track/${B}`]: page({ type: 'track', uri: `spotify:track:${B}`, name: 'Nicole Kidman', artists: [{ name: 'ADÉLA' }], duration: 181270 }),
  };
  const fake = async url => pages[url.split('/embed/')[1]];
  const one = await spotifyTracks(`https://open.spotify.com/playlist/${P}`, fake);
  assert.equal(one.title, 'Хиты');
  assert.deepEqual(one.tracks, [{ id: A, title: 'Stop The Wedding!', artist: 'Ashe', duration: 199, cover: '' }]);
  const both = await spotifyTracks(`https://open.spotify.com/playlist/${P} https://open.spotify.com/track/${B} https://open.spotify.com/track/${A}`, fake);
  assert.deepEqual(both.tracks.map(t => `${t.artist} - ${t.title}`), ['Ashe - Stop The Wedding!', 'ADÉLA - Nicole Kidman']);
  await assert.rejects(spotifyTracks(`https://open.spotify.com/track/${A}`, async () => '<html></html>'), /не отдал список/);
});

test('Spotify: своя обложка трека через oEmbed, мусор не принимается', async () => {
  assert.equal(await spotifyCover('A', async url => (assert.match(url, /oembed\?url=https:\/\/open\.spotify\.com\/track\/A$/), { thumbnail_url: 'https://i.scdn.co/a' })), 'https://i.scdn.co/a');
  assert.equal(await spotifyCover('A', async () => ({ thumbnail_url: 'javascript:alert(1)' })), '');
});

test('Spotify → YouTube: из пяти результатов — ближайший по длине к треку', () => {
  const found = [{ id: 'clip', duration: 366 }, { id: 'audio', duration: 201 }, { id: 'live', duration: 230 }];
  assert.equal(closestByDuration(found, 199).id, 'audio');
  assert.equal(closestByDuration([{ id: 'only', duration: 900 }], 199).id, 'only', 'ничего близкого — первый');
  assert.equal(closestByDuration(found, null).id, 'clip', 'длина неизвестна — первый');
});
