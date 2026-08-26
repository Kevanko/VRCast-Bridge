// Прогон сценариев внутри чистой Windows. Запускается тем Node, который
// программа скачала себе сама, поэтому лишних зависимостей не нужно.
import { appendFileSync, existsSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ОБЩАЯ = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\vrcast';
const ОТЧЁТ = join(ОБЩАЯ, 'sandbox-report.txt');
const БАЗА = 'http://127.0.0.1:4717';
const итоги = [];

function записать(текст) {
  const строка = `${new Date().toLocaleTimeString('ru-RU')}  ${текст}\n`;
  appendFileSync(ОТЧЁТ, строка, 'utf8');
  process.stdout.write(строка);
}

function шаг(имя, ок, детали = '') {
  итоги.push({ имя, ок });
  записать(`${ок ? 'OK  ' : 'СБОЙ'} ${имя}${детали ? ` — ${детали}` : ''}`);
}

async function состояние() {
  try {
    const ответ = await fetch(`${БАЗА}/api/status`, { signal: AbortSignal.timeout(15000) });
    return ответ.ok ? await ответ.json() : null;
  } catch { return null; }
}

async function послать(путь, тело) {
  const ответ = await fetch(БАЗА + путь, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(тело ?? {}), signal: AbortSignal.timeout(180000),
  });
  const текст = await ответ.text();
  if (!ответ.ok) throw new Error(текст.slice(0, 160));
  return текст ? JSON.parse(текст) : {};
}

async function ждать(условие, секунд = 60) {
  const предел = Date.now() + секунд * 1000;
  let последнее = null;
  while (Date.now() < предел) {
    последнее = await состояние();
    if (последнее && условие(последнее)) return [true, последнее];
    await new Promise(r => setTimeout(r, 2000));
  }
  return [false, последнее];
}

writeFileSync(ОТЧЁТ, `Прогон в чистой Windows ${new Date().toLocaleString('ru-RU')}\n`, 'utf8');

// 1. Сервер поднялся на чистой системе
let [ок, s] = await ждать(d => Boolean(d.appVersion), 600);
шаг('сервер отвечает на чистой системе', ок, s ? `версия ${s.appVersion}` : 'нет ответа');

// 2. Зависимости догрузились сами
[ок, s] = await ждать(d => d.tools.ffmpeg && d.tools.mediamtx && d.tools.ytdlp, 900);
шаг('зависимости догрузились сами', ок, s ? JSON.stringify(s.tools) : '');

// 3. Канал готов и ссылка выдана без действий
[ок, s] = await ждать(d => d.stream.state === 'ready', 300);
шаг('канал готов без действий', ок, s ? s.stream.state : '');
шаг('ссылка выдана сразу', Boolean(s && s.playbackUrl), s ? s.playbackUrl : '');
шаг('эфир сам не стартует', Boolean(s && !s.running));

// 4. Видео
const клип = join(ОБЩАЯ, 'clip.mp4');
try {
  const добавлено = await послать('/api/queue/local', { paths: [клип] });
  шаг('локальный файл добавляется', (добавлено.added || []).length === 1);
  await послать('/api/start/queue', {});
  [ок, s] = await ждать(d => d.running && d.stream.state === 'ready', 240);
  шаг('видео выходит в эфир', ок, s ? `темп ${s.performance?.realtimeRatio ?? '—'}` : '');
} catch (ошибка) { шаг('локальный файл добавляется', false, String(ошибка.message).slice(0, 120)); }

// 5. Управление
for (const действие of ['pause', 'resume', 'next', 'previous']) {
  try {
    await послать('/api/playback', { action: действие });
    await new Promise(r => setTimeout(r, 2500));
    шаг(`управление: ${действие}`, true);
  } catch (ошибка) { шаг(`управление: ${действие}`, false, String(ошибка.message).slice(0, 100)); }
}

// 6. Захват экрана
try {
  await послать('/api/config', { captureMode: 'monitor', audioMode: 'none', quality: '720p', fps: 30 });
  await послать('/api/start/screen', {});
  [ок, s] = await ждать(d => d.activeKind === 'screen' && d.stream.state === 'ready', 240);
  шаг('захват экрана работает', ок, s ? `кодировщик ${s.performance?.encoder}` : '');
} catch (ошибка) { шаг('захват экрана работает', false, String(ошибка.message).slice(0, 120)); }

// 7. Публичная ссылка
try {
  await послать('/api/config', { outputMode: 'tunnel' });
  [ок, s] = await ждать(d => d.tunnel?.ready, 240);
  шаг('публичная ссылка выдаётся', ок, s?.tunnel?.url || s?.tunnel?.error || '');
  await послать('/api/config', { outputMode: 'local' });
} catch (ошибка) { шаг('публичная ссылка выдаётся', false, String(ошибка.message).slice(0, 120)); }

// 8. Минута эфира без просадок
try {
  await послать('/api/start/queue', {});
  await ждать(d => d.running && d.stream.state === 'ready', 120);
  // Смотрим четыре минуты: программа должна сама дойти до посильного качества
  // и последнюю минуту держать эфир ровно.
  const замеры = [];
  for (let i = 0; i < 48; i++) {
    const d = await состояние();
    замеры.push({
      темп: d?.performance?.realtimeRatio || 0,
      возраст: d?.performance?.segmentAge || 0,
      качество: d?.config?.mediaQuality, кадры: d?.config?.mediaFps,
    });
    await new Promise(r => setTimeout(r, 5000));
  }
  const хвост = замеры.slice(-12);
  const плохо = хвост.filter(x => (x.темп && x.темп < 0.9) || x.возраст > 6);
  const итог = хвост.at(-1);
  шаг('эфир выравнивается сам на слабой машине', плохо.length === 0,
    `итог ${итог?.качество}/${итог?.кадры}, худший возраст ${Math.max(...хвост.map(x => x.возраст)).toFixed(1)} с, темп ${Math.min(...хвост.map(x => x.темп || 1)).toFixed(2)}`);
} catch (ошибка) { шаг('минута эфира без просадок', false, String(ошибка.message).slice(0, 120)); }

// 9. Журналы забираем на общую папку
const данные = join(process.env.LOCALAPPDATA, 'VRCastBridge');
for (const имя of ['vrcast.log', 'launcher.log', 'crash.log', 'vrcast-errors.log']) {
  try { if (existsSync(join(данные, имя))) copyFileSync(join(данные, имя), join(ОБЩАЯ, `sandbox-${имя}`)); } catch {}
}

const плохие = итоги.filter(t => !t.ок);
записать('');
записать(`ИТОГ: ${итоги.length - плохие.length} из ${итоги.length}`);
if (плохие.length) записать('не прошли: ' + плохие.map(t => t.имя).join('; '));
записать('ГОТОВО');
