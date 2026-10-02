import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IS_LINUX, exe, listAudioLinux, listWindowsX11, parseClientList, parsePactlShort, parsePwDump, parseXprop,
  parseXrandr, parseXwininfo, pulseSource, screenInput, toolSources, which,
} from '../src/platform.js';

test('parseXrandr: мониторы со смещением, основной и отключённые', () => {
  const text = [
    'Screen 0: minimum 320 x 200, current 3840 x 1080, maximum 16384 x 16384',
    'eDP connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 193mm',
    '   1920x1080     60.00*+',
    'HDMI-1 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 527mm x 296mm',
    'DP-1 disconnected (normal left inverted right x axis y axis)',
  ].join('\n');
  assert.deepEqual(parseXrandr(text), [
    { id: 'eDP', name: 'Основной монитор', x: 0, y: 0, width: 1920, height: 1080, primary: true },
    { id: 'HDMI-1', name: 'HDMI-1', x: 1920, y: 0, width: 1920, height: 1080, primary: false },
  ]);
});

test('parseXrandr: без primary основным становится первый, мусор даёт пустой список', () => {
  const [first, second] = parseXrandr('A connected 100x100+0+0\nB connected 200x200+100+0');
  assert.equal(first.primary, true);
  assert.equal(second.primary, false);
  assert.deepEqual(parseXrandr('Can\'t open display'), []);
});

test('parseClientList: идентификаторы окон из xprop -root', () => {
  assert.deepEqual(parseClientList('_NET_CLIENT_LIST(WINDOW): window id # 0x3a00007, 0x4800003'), [0x3a00007, 0x4800003]);
  assert.deepEqual(parseClientList('_NET_CLIENT_LIST:  not found.'), []);
});

test('parseXprop: заголовок, процесс, свёрнутость и служебные окна', () => {
  const info = parseXprop([
    '_NET_WM_NAME(UTF8_STRING) = "Видео \\"тест\\""',
    'WM_NAME(STRING) = "old"',
    '_NET_WM_PID(CARDINAL) = 4242',
    '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_FOCUSED',
    '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL',
    'WM_CLASS(STRING) = "chrome", "Google-chrome"',
  ].join('\n'));
  assert.deepEqual(info, { title: 'Видео "тест"', pid: 4242, hidden: true, className: 'Google-chrome', service: false });
  assert.equal(parseXprop('_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DESKTOP').service, true);
  assert.equal(parseXprop('WM_NAME(STRING) = "только старое имя"').title, 'только старое имя');
});

test('parseXwininfo: абсолютные координаты и размер', () => {
  const text = '  Absolute upper-left X:  427\n  Absolute upper-left Y:  -75\n  Width: 930\n  Height: 667\n';
  assert.deepEqual(parseXwininfo(text), { x: 427, y: -75, width: 930, height: 667 });
  assert.equal(parseXwininfo('xwininfo: error'), null);
});

test('listWindowsX11: собирает окна, пропускает без заголовка, мелкие и служебные', async () => {
  const props = {
    100: '_NET_WM_NAME(UTF8_STRING) = "Б-окно"\n_NET_WM_PID(CARDINAL) = 1\n_NET_WM_STATE(ATOM) =\n',
    200: '_NET_WM_NAME(UTF8_STRING) = "А-окно"\n_NET_WM_PID(CARDINAL) = 2\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN\n',
    300: '_NET_WM_PID(CARDINAL) = 3\n',
    400: '_NET_WM_NAME(UTF8_STRING) = "dock"\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK\n',
    500: '_NET_WM_NAME(UTF8_STRING) = "крошка"\n',
  };
  const size = { 500: [4, 4] };
  const run = async (command, args) => {
    if (command === 'xprop' && args[0] === '-root') return { status: 0, stdout: '_NET_CLIENT_LIST(WINDOW): window id # 0x64, 0xc8, 0x12c, 0x190, 0x1f4' };
    const id = Number(args[1]);
    if (command === 'xprop') return { status: 0, stdout: props[id] || '' };
    const [width, height] = size[id] || [800, 600];
    return { status: 0, stdout: `Absolute upper-left X: 10\nAbsolute upper-left Y: 20\nWidth: ${width}\nHeight: ${height}` };
  };
  const windows = await listWindowsX11(run);
  assert.deepEqual(windows.map(item => [item.title, item.handle, item.minimized]), [['А-окно', '200', true], ['Б-окно', '100', false]]);
  assert.deepEqual([windows[1].x, windows[1].y, windows[1].width, windows[1].height], [10, 20, 800, 600]);
});

test('parsePwDump: выходы, входы и выход по умолчанию', () => {
  const dump = JSON.stringify([
    { type: 'PipeWire:Interface:Metadata', metadata: [{ key: 'default.audio.sink', value: { name: 'sink.b' } }] },
    { type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'sink.a', 'node.description': 'Колонки', 'media.class': 'Audio/Sink' } } },
    { type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'sink.b', 'media.class': 'Audio/Sink' } } },
    { type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'mic.a', 'media.class': 'Audio/Source' } } },
    { type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'video', 'media.class': 'Video/Source' } } },
    { id: 7, info: null },
  ]);
  assert.deepEqual(parsePwDump(dump), {
    sinks: [{ id: 'sink.a', name: 'Колонки', isDefault: false }, { id: 'sink.b', name: 'sink.b', isDefault: true }],
    sources: ['mic.a'],
  });
});

test('parsePwDump: два склеенных массива (граф изменился во время дампа) и мусор', () => {
  const node = { type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'sink.a', 'media.class': 'Audio/Sink' } } };
  const glued = `${JSON.stringify([node], null, 2)}\n${JSON.stringify([{ id: 63, info: null }], null, 2)}\n`;
  assert.equal(parsePwDump(glued).sinks.length, 1);
  assert.deepEqual(parsePwDump('не json'), { sinks: [], sources: [] });
});

test('parsePactlShort и запасной путь через pactl, когда pw-dump нет', async () => {
  assert.deepEqual(parsePactlShort('1\tsink.a\tPipeWire\n2\tsink.b\tPipeWire\n'), ['sink.a', 'sink.b']);
  const run = async (command, args) => {
    if (command === 'pw-dump') throw new Error('ENOENT');
    return { status: 0, stdout: args[2] === 'sinks' ? '1\tout.a\tx\n' : '1\tin.a\tx\n2\tout.a.monitor\tx\n' };
  };
  const result = await listAudioLinux(run);
  assert.deepEqual(result.sinks.map(item => item.id), ['out.a']);
  assert.deepEqual(result.sources, ['in.a']);
});

test('pulseSource: источник звука по режиму', () => {
  assert.equal(pulseSource({ audioMode: 'system' }), '@DEFAULT_MONITOR@');
  assert.equal(pulseSource({ audioMode: 'process' }), '@DEFAULT_MONITOR@');
  assert.equal(pulseSource({ audioMode: 'output', audioOutputId: 'sink.a' }), 'sink.a.monitor');
  assert.equal(pulseSource({ audioMode: 'output' }), '@DEFAULT_MONITOR@');
  assert.equal(pulseSource({ audioMode: 'device', captureAudioDevice: 'mic.a' }), 'mic.a');
  assert.equal(pulseSource({ audioMode: 'device' }), null);
  assert.equal(pulseSource({ audioMode: 'none' }), null);
});

test('screenInput: аргументы ffmpeg для экрана, области и окна', { skip: !IS_LINUX && 'только Linux' }, () => {
  const display = process.env.DISPLAY || ':0';
  assert.deepEqual(screenInput({ fps: 30 }), ['-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30', '-i', display]);
  assert.deepEqual(screenInput({ rect: { x: 1920, y: 10, width: 1280, height: 720 }, fps: 15 }),
    ['-f', 'x11grab', '-draw_mouse', '1', '-framerate', '15', '-video_size', '1280x720', '-i', `${display}+1920,10`]);
  assert.deepEqual(screenInput({ windowId: '50980409', fps: 5 }),
    ['-f', 'x11grab', '-draw_mouse', '1', '-framerate', '5', '-window_id', '0x309e639', '-i', display]);
});

test('exe, which и источники утилит', { skip: !IS_LINUX && 'только Linux' }, () => {
  assert.equal(exe('ffmpeg'), 'ffmpeg');
  const directory = mkdtempSync(join(tmpdir(), 'vrcast-which-'));
  const tool = join(directory, 'faketool');
  writeFileSync(tool, '#!/bin/sh\n');
  assert.equal(which('faketool', directory), '', 'без бита исполнения файл не считается утилитой');
  chmodSync(tool, 0o755);
  assert.equal(which('faketool', `/nonexistent:${directory}`), tool);
  const sources = toolSources();
  assert.deepEqual(Object.keys(sources).sort(), ['cloudflared', 'ffmpeg', 'mediamtx', 'yt-dlp']);
  assert.ok(sources.mediamtx.asset.test(`mediamtx_v1.9.0_linux_${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`));
  assert.deepEqual(sources.ffmpeg.unpack, ['ffmpeg', 'ffprobe']);
});
