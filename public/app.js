const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
// Запись в DOM только при настоящем изменении. Состояние приходит каждую
// секунду, а почти всё в нём от раза к разу одинаково: присвоение того же
// текста, класса или hidden всё равно пересоздаёт узлы и будит перерасчёт
// стилей и вёрстки — рядом с эфиром и VRChat это чистая потеря процессора.
function setText(node, value) { value=String(value??''); if (node.textContent!==value) node.textContent=value; }
function setHtml(node, value) { if (node._html!==value) { node._html=value; node.innerHTML=value; } }
function setHidden(node, value) { value=Boolean(value); if (node.hidden!==value) node.hidden=value; }
function setDisabled(node, value) { value=Boolean(value); if (node.disabled!==value) node.disabled=value; }
function setClass(node, value) { if (node.className!==value) node.className=value; }
function setTitle(node, value) { if (node.title!==value) node.title=value; }
// localStorage может отказать (SecurityError, запрет хранилища) — тогда
// помним в памяти до закрытия окна, а не роняем весь интерфейс.
const запасноеХранилище=new Map();
function взять(key){ try{ return localStorage.getItem(key); }catch{ return запасноеХранилище.has(key)?запасноеХранилище.get(key):null; } }
function положить(key,value){ запасноеХранилище.set(key,String(value)); try{ localStorage.setItem(key,String(value)); }catch{} }
// Предпросмотр по умолчанию выключен: декодирование эфира в окне стоит больше,
// чем само кодирование. Включается кнопкой с глазом и запоминается.
const ui = { previewOn: взять('previewOn')==='1', windowHidden: false, source: 'queue', output: 'local', status: null, sources: { windows: [], monitors: [], audioDevices: [], audioOutputs: [] }, hls: null, previewUrl: '', progressAt: 0, seeking: false, seekPending: false, seekDraft: 0, seekRevision: 0, previewBusy: false, previewTimer: null, speedPendingUntil: 0, loopPendingUntil: 0, liveApplyTimer: null, queueSignature: '', unitySelectedId: '' };

async function api(path, options = {}) {
  // Один короткий повтор при обрыве связи: программа может на секунду уйти в
  // перезапуск, и сырое «Failed to fetch» пугает без причины. Если и повтор не
  // прошёл — говорим по-человечески, что связь с ядром пропала.
  // Повторяем только чтение: POST мог дойти, а потерялся лишь ответ, и
  // повтор добавил бы трек дважды или второй раз развернул сервер.
  const чтение = ['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase());
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch {
    if (!чтение) throw new Error('Нет связи с программой — она перезапускается. Подождите пару секунд.');
    await new Promise(r => setTimeout(r, 700));
    try {
      response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    } catch {
      throw new Error('Нет связи с программой — она перезапускается. Подождите пару секунд.');
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.classList.toggle('error', error); node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function formatTime(seconds) { const n=Math.max(0,Math.floor(Number(seconds)||0)),h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=n%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`; }
function currentItem(state) { return state.queue.find(item => item.id === state.currentId); }

function progressPosition(state = ui.status) {
  if (!state?.progress) return 0;
  const extra = state.running && !state.playback?.paused && state.activeKind === 'queue' ? (Date.now() - ui.progressAt) / 1000 * (state.playback.speed || 1) : 0;
  return Math.min(Number(state.progress.duration) || Number.MAX_SAFE_INTEGER, Number(state.progress.elapsed || 0) + extra);
}


function renderProgress() {
  const state = ui.status;
  // Локальный просмотр: время и перемотка — у самого видео в окне, эфир тут ни при чём.
  if (ui.localPreviewId && !state?.running) {
    const video=$('#streamPreview'), total=Number.isFinite(video.duration)?video.duration:0;
    const position=ui.seeking?ui.seekDraft:video.currentTime||0;
    setText($('#elapsedTime'),formatTime(position)); setText($('#totalTime'),formatTime(total));
    if (!ui.seeking) paintSeek(total?Math.min(100,position/total*100):0);
    return;
  }
  if (!state?.progress || state.activeKind !== 'queue') {
    setText($('#elapsedTime'),'0:00'); setText($('#totalTime'),state?.activeKind==='screen'&&state.running?'LIVE':'0:00');
    if (!ui.seeking&&!ui.seekPending) paintSeek(0);
    return;
  }
  const position=(ui.seeking||ui.seekPending)?ui.seekDraft:progressPosition(state), total=Number(state?.progress?.duration)||0, percent=total?Math.min(100,position/total*100):0;
  setText($('#elapsedTime'),formatTime(position)); setText($('#totalTime'),total?formatTime(total):'LIVE');
  if (!ui.seeking&&!ui.seekPending) paintSeek(percent);
}
// Полоса перемотки двигается по десятым долям процента: чаще перерисовывать
// её незачем, а каждая запись стиля — это перерасчёт и отрисовка плеера.
function paintSeek(percent) {
  const bar=$('#seekBar'), step=Math.round(percent*10);
  if (bar._step===step) return;
  bar._step=step; bar.value=String(step); bar.style.setProperty('--seek',`${step/10}%`);
}

function renderNowPlaying(state) {
  const item=currentItem(state), cover=$('#nowCover');
  if (item) {
    // Под названием — что дальше: так видно, куда уйдёт «Следующее», не глядя в очередь.
    const номер=state.queue.findIndex(entry=>entry.id===item.id), следующий=state.queue[номер+1]||(state.playback?.loopMode==='all'?state.queue[0]:null);
    setText($('#nowTitle'),item.title); setText($('#nowSource'),следующий&&следующий.id!==item.id?`Дальше: ${следующий.title}`:item.local?'Файл с компьютера':'Медиа по ссылке');
    // Запасной значок лежит рядом скрытым. Раньше его разметку вставляли прямо
    // в onerror, её кавычки рвали атрибут, и под обложкой торчал текст «'))">».
    setHtml(cover,item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" onerror="this.nextElementSibling.hidden=false;this.remove()"><span hidden>${icon('note')}</span>`:`<span>${icon('note')}</span>`);
  } else if (state.running && state.activeKind==='screen') {
    setText($('#nowTitle'),captureLabel()); setText($('#nowSource'),audioLabel()); setHtml(cover,`<span>${icon('display')}</span>`);
  } else if (ui.localPreviewId) {
    const локальный=state.queue.find(entry=>entry.id===ui.localPreviewId);
    setText($('#nowTitle'),локальный?.title||'Предпросмотр'); setText($('#nowSource'),'Смотрите у себя — в эфир не идёт'); setHtml(cover,`<span>${icon('eye')}</span>`);
  } else { setText($('#nowTitle'),'Эфир не запущен'); setText($('#nowSource'),state.queue.length?'Нажмите трек справа или «Начать эфир»':'Добавьте видео справа'); setHtml(cover,`<span>${icon('note')}</span>`); }
  // Иконка паузы: в эфире — по состоянию плеера, в локальном предпросмотре — по video.
  setHtml($('#togglePause'),icon((ui.localPreviewId&&!state.running)?($('#streamPreview').paused?'play':'pause'):state.running&&state.activeKind==='queue'&&!state.playback?.paused?'pause':'play'));
  if(Date.now()>ui.speedPendingUntil)paintSpeed(state.playback?.speed||1);
  if(Date.now()>ui.loopPendingUntil)paintLoop(state.playback?.loopMode||'once');
  const локально=Boolean(ui.localPreviewId&&!state.running);
  const транспортВыкл=!локально&&(state.activeKind!=='queue'||!state.running);
  $('#playerUi').classList.toggle('disabled',транспортВыкл);
  $('#playerUi').classList.toggle('local',локально);
  // Не только вид: те же контролы выключены и для клавиатуры и экранного диктора.
  // В локальном предпросмотре играет сам браузер: пауза работает, а перемотка,
  // соседние треки, скорость и повтор — это команды эфиру, их там нет.
  for(const id of ['#previousTrack','#nextTrack','#speedSelect','#loopSelect'])setDisabled($(id),транспортВыкл||локально);
  setDisabled($('#seekBar'),транспортВыкл);
  setDisabled($('#togglePause'),транспортВыкл);
  $('#monitor').classList.toggle('capture',ui.source==='screen');
  $('#monitor').classList.toggle('idle',!state.running);
}

const SPEED_STEPS=[0.5,0.75,1,1.25,1.5,2];
const icon=name=>`<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const LOOP_STEPS=[['once','repeat','Без повтора'],['all','repeat','Повтор очереди'],['one','repeat-one','Повтор трека']];
function paintSpeed(value){const button=$('#speedSelect');if(button.dataset.value!==String(value))button.dataset.value=String(value);setText(button,`${value}×`);
  button.classList.toggle('on',Number(value)!==1);setTitle(button,`Скорость воспроизведения: ${value}×`);}
function paintLoop(mode){const button=$('#loopSelect');const step=LOOP_STEPS.find(item=>item[0]===mode)||LOOP_STEPS[0];
  if(button.dataset.value!==step[0])button.dataset.value=step[0];setHtml(button,icon(step[1]));button.classList.toggle('on',step[0]!=='once');setTitle(button,step[2]);}

function monitorPlaceholder(title, text, name = 'broadcast') {
  setText($('#monitorPlaceholderTitle'),title); setText($('#monitorPlaceholderText'),text); setHtml($('#monitorPlaceholderIcon'),icon(name));
}

// Декодирование 1080p60 в окне программы стоит около полутора ядер — больше,
// чем всё кодирование эфира. Поэтому предпросмотр выключается, а на свёрнутом
// окне останавливается сам: смотреть его в этот момент всё равно некому.
// Предпросмотр декодирует видео постоянно — это заметная нагрузка. Пока окно
// свёрнуто или вы в другой программе (в VRChat), он не нужен: отключаем, а при
// возвращении подключаемся заново за секунду.
function previewAllowed() {
  return ui.previewOn && !ui.windowHidden && !ui.windowBlurred;
}

function stopPreview() {
  ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl='';
  const video=$('#streamPreview');
  // Локальный трек на свёрнутом окне только ставим на паузу: иначе после
  // разворачивания плеер оставался пустым, а кнопка паузы управляла ничем.
  if (ui.localPreviewId && !ui.status?.running) video.pause();
  else {
    video.pause();
    if (video.srcObject) video.srcObject=null;
    if (video.hasAttribute('src')) { video.removeAttribute('src'); video.load?.(); }
    $('#monitor').classList.remove('previewing');
  }
  // Кадр захвата — отдельная картинка: без этого при выключении оставался экран.
  const снимок=$('#capturePreview');
  if (снимок.hasAttribute('src')) снимок.removeAttribute('src');
  $('#monitor').classList.remove('source-preview');
}

// Браузер сам играет только эти форматы; остальное (mkv, avi, ролики по
// ссылке) сервер отдаёт кодом 415/404, и в консоли копились ошибки загрузки.
const ЛОКАЛЬНО_ИГРАЕТСЯ=/\.(mp4|webm|m4v|m4a|mp3|aac|ogg|opus|wav)$/i;

// Локальный предпросмотр: трек играет прямо в браузере, без эфира. Так видео
// можно посмотреть и подготовить, а трансляция начнётся только по «Начать эфир».
function показатьЛокальныйПредпросмотр(id){
  const item=(ui.status?.queue||[]).find(x=>x.id===id);
  if(!item)return;
  ui.localNote=null;
  if(!item.local||item.unavailable||!ЛОКАЛЬНО_ИГРАЕТСЯ.test(item.sourceUrl||'')){
    if(ui.localPreviewId)очиститьЛокальныйПредпросмотр();
    ui.localNote=[item.title,'Смотреть можно в эфире — нажмите «Начать эфир видео»','broadcast'];
    if(ui.status)render(ui.status);
    return;
  }
  // Глаз выключен — трек не открываем: иначе видео декодировалось вопреки
  // настройке, а выключатель потом оставлял на экране последний кадр.
  if(!previewAllowed()){
    if(ui.localPreviewId)очиститьЛокальныйПредпросмотр();
    ui.localNote=[item.title,'Предпросмотр выключен — включите кнопкой с глазом внизу','eye-off'];
    if(ui.status)render(ui.status);
    return;
  }
  ui.localPreviewId=id;
  ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl='';
  const video=$('#streamPreview'), monitor=$('#monitor');
  video.srcObject=null;
  video.src=`/api/local-media/${encodeURIComponent(id)}?t=${Date.now()}`;
  video.load?.();
  monitor.classList.add('previewing'); monitor.classList.remove('source-preview');
  video.play().then(()=>video.pause()).catch(()=>{
    // Кодек внутри файла браузер не тянет (HEVC и т. п.) — показываем название
    // и подсказку: смотреть можно только в эфире.
    if(ui.localPreviewId!==id)return;
    очиститьЛокальныйПредпросмотр();
    ui.localNote=[item.title,'Смотреть можно в эфире — нажмите «Начать эфир видео»','broadcast'];
    if(ui.status)render(ui.status);
  });
  if(ui.status)render(ui.status);
}

function переключитьЛокальнуюПаузу(){
  if(!ui.localPreviewId)return;
  const video=$('#streamPreview');
  if(video.paused)video.play().catch(()=>{}); else video.pause();
}
// Иконка play/pause следует за локальным плеером сразу, не дожидаясь render.
for(const событие of ['play','pause']) $('#streamPreview').addEventListener(событие,()=>{
  if(ui.localPreviewId&&!ui.status?.running) setHtml($('#togglePause'),icon($('#streamPreview').paused?'play':'pause'));
});

function очиститьЛокальныйПредпросмотр(){
  ui.localPreviewId='';
  const video=$('#streamPreview');
  try{ video.pause(); }catch{}
  if(video.hasAttribute('src')){ video.removeAttribute('src'); video.load?.(); }
  $('#monitor').classList.remove('previewing');
}

function paintPreviewToggle() {
  const button=$('#previewToggle');
  button.classList.toggle('off',!ui.previewOn);
  setTitle(button,ui.previewOn?'Выключить предпросмотр — освободит процессор':'Включить предпросмотр');
  setHtml(button,icon(ui.previewOn?'eye':'eye-off'));
}

// Что написать в пустом кадре. Раньше надпись оставалась от прошлого
// состояния: после остановки эфира висело «Картинка выключена», а при
// выключенном предпросмотре — «Ничего не выбрано», хотя дело в выключателе.
function paintMonitorPlaceholder(state) {
  const monitor=$('#monitor');
  if (monitor.classList.contains('window-paused')||monitor.classList.contains('source-preview')) return;
  if (state.running) {
    if (!ui.previewOn) monitorPlaceholder('Картинка выключена','Эфир идёт, окно не тратит процессор','eye-off');
    else monitorPlaceholder('Эфир идёт','Картинка появится через пару секунд','broadcast');
    return;
  }
  if (ui.localPreviewId) return;
  if (ui.source==='queue' && ui.localNote) return monitorPlaceholder(...ui.localNote);
  if (!ui.previewOn) return monitorPlaceholder('Предпросмотр выключен','Так окно не тратит процессор. Включить — кнопка с глазом внизу','eye-off');
  monitorPlaceholder('Ничего не выбрано',ui.source==='queue'?'Нажмите трек в списке — он откроется здесь без эфира':'Выберите экран или окно справа','broadcast');
}

function startPreview(state) {
  const video=$('#streamPreview'), monitor=$('#monitor');
  if (!previewAllowed()) {
    if (ui.hls||ui.rtc||ui.previewUrl) stopPreview();
    return;
  }
  if (!state.running) {
    // Локальный предпросмотр трогать нельзя — он живёт своей жизнью до эфира.
    if (ui.localPreviewId) return;
    if (ui.hls||ui.rtc||ui.previewUrl||video.srcObject||video.hasAttribute('src')) {
      ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl=''; video.removeAttribute('src'); video.srcObject=null;
    }
    monitor.classList.remove('previewing'); return;
  }
  // Эфир пошёл — локальный предпросмотр больше не нужен.
  if (ui.localPreviewId) ui.localPreviewId='';
  const previewSource=(state.localPlaybackUrl||state.playbackUrl).replace(/live\.m3u8(?:\?.*)?$/,'preview.m3u8');
  // WebRTC — мгновенная картинка, но без звука: AAC эфира туда не проходит.
  // Включили звук предпросмотра — показываем HLS, в нём звук есть.
  const черезWebrtc=Boolean(state.webrtcUrl)&&!ui.webrtcFailed&&взять('previewSound')!=='1';
  const previewKey=`${черезWebrtc?'rtc':'hls'}|${previewSource}`;
  // Ключ включает способ показа: без этого связь WebRTC пересоздавалась на
  // каждом обновлении состояния, и картинка дёргалась.
  if (ui.previewUrl===previewKey && (ui.hls||ui.rtc)) return;
  ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl=previewKey;
  if (!черезWebrtc) video.srcObject=null;
  if (черезWebrtc) {
    startWebrtcPreview(state.webrtcUrl, video, monitor, previewKey);
    return;
  }
  if (window.Hls?.isSupported()) {
    // Предпросмотр всегда живой, без отложенного показа: настройка задержки
    // убрана, поэтому и здесь минимальный буфер.
    const hls=new window.Hls({lowLatencyMode:true,liveSyncDurationCount:1,liveMaxLatencyDurationCount:3,maxBufferLength:12,maxMaxBufferLength:15,backBufferLength:1,manifestLoadingTimeOut:5000,levelLoadingTimeOut:5000}); ui.hls=hls;
    hls.loadSource(`${previewSource}?preview=${Date.now()}`); hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED,()=>{monitor.classList.add('previewing');video.play().catch(()=>{});});
    hls.on(window.Hls.Events.ERROR,(_,data)=>{if(!data.fatal||!ui.status?.running)return;hls.destroy();ui.hls=null;ui.previewUrl='';if(ui.status?.stream?.state!=='offline')setTimeout(()=>startPreview(ui.status),2000);});
  }
}

function renderStorage(state){
  const cache=state.cache||{}, select=$('#cacheRoot');
  const drives=cache.drives||[];
  const signature=`${drives.join(',')}|${cache.root||''}`;
  if(ui.driveSignature!==signature){
    ui.driveSignature=signature;
    select.innerHTML=`<option value="">Диск с Windows</option>`+drives.map(drive=>`<option value="${drive}\\">${drive} диск</option>`).join('');
    select.value=cache.root||'';
  }
  const лимит=cache.limitGb?`${cache.limitGb} ГБ`:'авто';
  setText($('#cacheSize'),`Занято ${cache.sizeMb||0} МБ из ${лимит}`);
  if(document.activeElement!==$('#cacheLimit'))$('#cacheLimit').value=String(cache.limitGb||0);
  const free=state.disk?.freeMb;
  const всего=state.disk?.totalMb;
  const место=free!==null&&free!==undefined&&всего
    ? ` · свободно ${(free/1024).toFixed(1)} из ${(всего/1024).toFixed(0)} ГБ`
    : '';
  // Полный путь занимал три строки и светил имя пользователя. Показываем диск
  // и конец пути, целиком — во всплывающей подсказке.
  const путь=String(cache.path||''), части=путь.split(/[\\/]/).filter(Boolean);
  const коротко=части.length>3?[части[0],'…',...части.slice(-2)].join('\\'):путь;
  setText($('#cacheHint'),путь?`${коротко}${место}`:'');
  setTitle($('#cacheHint'),путь);
}

function renderServers(state) {
  const servers=state.config.servers||[], active=state.config.activeServerId||'';
  const remote=state.rtsp?.remote||{};
  const список=$('#serverList');
  const подпись=JSON.stringify([servers.map(item=>[item.id,item.name,item.host,item.reachable]),active,remote.live,state.config.outputMode]);
  if(список.dataset.signature!==подпись){
    список.dataset.signature=подпись;
    список.innerHTML=servers.length?servers.map(item=>{
      const выбран=item.id===active&&state.config.outputMode==='remote';
      // Лампа у каждой карточки: красная — сервер не отвечает, зелёная-пульс —
      // через него сейчас идёт эфир, спокойная зелёная — на связи, серая —
      // ещё проверяем. Недоступный сервер краснеет, а не висит в «подключаюсь».
      const лампа=item.reachable===false?'down':(выбран&&remote.live)?'live':item.reachable===true?'ok':'wait';
      const состояние=item.reachable===false?'Не отвечает':'';
      return `<li class="server-card${выбран?' on':''}" data-id="${escapeHtml(item.id)}">
        <button class="card-pick" type="button" aria-pressed="${выбран}" title="Вещать через этот сервер">
          <i class="lamp ${лампа}"></i>
          <b>${escapeHtml(item.name)}</b>
          <em>${состояние}</em>
          <small>${escapeHtml(item.host)}</small>
        </button>
        <button class="card-more" type="button" data-edit="${escapeHtml(item.id)}" aria-label="Настроить «${escapeHtml(item.name)}»">···</button>
      </li>`;
    }).join(''):'<li class="server-empty">Сервера пока нет.<br>Он даёт постоянную ссылку — раздать её можно один раз и больше не менять.</li>';
  }
  // Молчим, когда всё идёт как надо: об этом уже говорят лампа и карточка.
  // Порт — тот, что записан у сервера: раньше подсказка всегда называла 8554.
  const порт=servers.find(item=>item.id===active)?.rtspPort||8554;
  setText($('#serverHint'),!servers.length?'Есть свой VPS — подключите его, и ссылка перестанет меняться.'
    :remote.reachable===false?`Сервер не отвечает. Проверьте, что машина включена и порт ${порт} открыт.`
    :state.config.outputMode!=='remote'?'Выберите сервер, чтобы вещать через него.'
    :'');
}

// «Этот ПК»: одна ссылка для своей сети (друзьям рядом) и, если есть белый IP,
// ссылка через интернет. Подпись над ссылкой, в самой ссылке — только адрес.
function заполнитьСсылку(строкаId, подписьId, url){
  const строка=$(строкаId), подпись=$(подписьId);
  setHidden(строка,!url); setHidden(подпись,!url);
  const кнопка=строка.querySelector('.direct-copy');
  if(url){ setText(строка.querySelector('code'),url); if(кнопка.dataset.url!==url)кнопка.dataset.url=url; }
}
function renderLocalOutput(state){
  const d=state.rtsp?.direct||{};
  заполнитьСсылку('#localLinkRow','#localLinkCaption',d.local||'');
  заполнитьСсылку('#whiteLinkRow','#whiteLinkCaption',d.white||'');
  const поле=$('#whiteIp');
  if(document.activeElement!==поле) поле.value=state.config.whiteIp||'';
  // Порт берём из самой ссылки: RTSP этого ПК слушает не 8554 (тот — у своего
  // сервера), и подсказка отправляла открывать на роутере не тот порт.
  const порт=(d.white||'').match(/:(\d+)\//)?.[1]||'';
  setText($('#localHint'),d.white
    ?`Для интернета на роутере должен быть открыт порт ${порт} (TCP).`
    :d.local
      ?'Откроется у друзей в вашей сети. Для интернета впишите белый IP.'
      :'Пока ссылка работает только на этом ПК.');
}

// Прямая ссылка — по клику копируем.
$('#localOutput').addEventListener('click',async event=>{
  const кнопка=event.target.closest('.direct-copy'); if(!кнопка)return;
  const получилось=await copyText(кнопка.dataset.url||'');
  toast(получилось?'Ссылка скопирована':'Не удалось скопировать',!получилось);
});
// Белый IP: сохраняем, как только человек закончил вводить.
$('#whiteIp').addEventListener('change',async()=>{
  try{ render(await saveConfig(false)); toast($('#whiteIp').value.trim()?'Белый IP сохранён':'Белый IP убран'); }
  catch(error){ toast(error.message,true); }
});

// Карточка целиком — переключатель: нажали, значит вещаем через этот сервер.
$('#serverList').addEventListener('click',async event=>{
  const правка=event.target.closest('[data-edit]');
  if(правка)return openServerDialog(правка.dataset.edit);
  const карточка=event.target.closest('.server-card');
  if(!карточка)return;
  try{ render(await api(`/api/servers/${encodeURIComponent(карточка.dataset.id)}/activate`,{method:'POST'})); }
  catch(error){ toast(error.message,true); }
});

const serverDialog=$('#serverDialog');
let правимСервер='';

function показатьОшибку(поле,текст){ поле.textContent=текст||''; поле.hidden=!текст; }

async function openServerDialog(id){
  const сервер=(ui.status?.config?.servers||[]).find(item=>item.id===id);
  if(!сервер)return;
  правимСервер=id;
  $('#serverDialogTitle').textContent=сервер.name;
  $('#serverRename').value=сервер.name;
  $('#serverAddress').value=сервер.host;
  $('#serverPermanent').checked=сервер.permanentLink!==false;
  рисоватьРежимСсылки();
  $('#wipeConfirm').hidden=true;
  $('#wipePassword').value='';
  показатьОшибку($('#serverDialogError'),'');
  // Ключ прячем: это пароль, показывать его первым встречному через плечо ни
  // к чему. Точки, пока не нажмут «показать»; настоящее значение — в data-key.
  const плашка=$('#serverKeyValue');
  плашка.dataset.key=''; плашка.dataset.shown='0'; плашка.textContent='••••••••••••';
  if(!serverDialog.open||serverDialog.classList.contains('closing'))serverDialog.showModal();
  // Запоздалый ответ по прошлому серверу не должен показать его ключ в окне
  // другого: пишем, только если это всё ещё последний запрос и тот же сервер.
  const номер=ui.keyRequest=(ui.keyRequest||0)+1;
  let ключ='';
  try{ ключ=(await api(`/api/servers/${encodeURIComponent(id)}/key`)).key||''; }catch{}
  if(номер!==ui.keyRequest||правимСервер!==id||!serverDialog.open)return;
  плашка.dataset.key=ключ;
  рисоватьКлюч();
}

function рисоватьКлюч(){
  const плашка=$('#serverKeyValue');
  const есть=Boolean(плашка.dataset.key);
  const открыт=плашка.dataset.shown==='1';
  плашка.textContent=!есть?'ключа нет — сервер подключён без него'
    :открыт?плашка.dataset.key:'••••••••••••';
  $('#revealServerKey').querySelector('use').setAttribute('href',открыт?'#i-eye-off':'#i-eye');
  $('#revealServerKey').hidden=!есть;
  $('#copyServerKey').hidden=!есть;
}

function рисоватьРежимСсылки(){
  const постоянная=$('#serverPermanent').checked;
  $('#permanentNote').textContent=постоянная
    ?'Один адрес навсегда — раздайте его раз и не меняйте.'
    :'Случайный адрес. Можно сменить в любой момент — старая ссылка перестанет открываться.';
  $('#serverNewLink').hidden=постоянная;
}
$('#serverPermanent').addEventListener('change',рисоватьРежимСсылки);
$('#serverNewLink').addEventListener('click',async()=>{
  const кнопка=$('#serverNewLink'); кнопка.disabled=true;
  try{
    render(await api(`/api/servers/${encodeURIComponent(правимСервер)}/linkmode`,{method:'POST',body:JSON.stringify({permanent:false,regenerate:true})}));
    toast('Новый адрес готов — старая ссылка больше не работает');
  }catch(error){ показатьОшибку($('#serverDialogError'),error.message); }
  finally{ кнопка.disabled=false; }
});

function закрытьДиалогСервера(){
  // Только close(): removeAttribute('open') оставляло модальное окно в
  // половинчатом состоянии — логически закрыто, а на экране висит.
  try{ serverDialog.close(); }catch{ serverDialog.removeAttribute('open'); }
}
$('#serverDialogClose').addEventListener('click',закрытьДиалогСервера);
// Клик по затемнению и Escape закрывают тоже — как ждёшь от любого окна.
// Но закрываем только если нажатие И началось на затемнении: иначе выделение
// текста в поле, когда мышь заезжает за край и отпускается на фоне, считалось
// кликом по фону и захлопывало окно — бесячий стандартный баг.
let нажалиНаФон=false;
serverDialog.addEventListener('mousedown',event=>{ нажалиНаФон=(event.target===serverDialog); });
serverDialog.addEventListener('click',event=>{ if(event.target===serverDialog && нажалиНаФон)закрытьДиалогСервера(); });
serverDialog.addEventListener('cancel',event=>{ event.preventDefault(); закрытьДиалогСервера(); });
$('#revealServerKey').addEventListener('click',()=>{
  const плашка=$('#serverKeyValue');
  плашка.dataset.shown=плашка.dataset.shown==='1'?'0':'1';
  рисоватьКлюч();
});
$('#copyServerKey').addEventListener('click',async()=>{
  const ключ=$('#serverKeyValue').dataset.key||'';
  if(!ключ)return toast('Ключа нет',true);
  const получилось=await copyText(ключ);
  toast(получилось?'Ключ скопирован — можно отдать другу':'Не удалось скопировать',!получилось);
});
$('#saveServer').addEventListener('click',async()=>{
  const кнопка=$('#saveServer'); кнопка.disabled=true;
  try{
    const результат=await api(`/api/servers/${encodeURIComponent(правимСервер)}/edit`,{method:'POST',
      body:JSON.stringify({name:$('#serverRename').value,host:$('#serverAddress').value,permanentLink:$('#serverPermanent').checked})});
    // Окно закрываем первым: если перерисовка споткнётся, это не должно
    // оставлять человека в открытом окне с уже сохранёнными изменениями.
    закрытьДиалогСервера(); toast('Сохранено'); render(результат.status);
  }catch(error){ показатьОшибку($('#serverDialogError'),error.message); }
  finally{ кнопка.disabled=false; }
});
$('#serverForget').addEventListener('click',async()=>{
  const сервер=(ui.status?.config?.servers||[]).find(item=>item.id===правимСервер);
  if(!await подтвердить(`Убрать сервер «${сервер?.name||'без названия'}» из списка?`,'Убрать','Ссылка через него перестанет работать. На самой машине ничего не изменится.'))return;
  try{
    const результат=await api(`/api/servers/${encodeURIComponent(правимСервер)}/remove`,{method:'POST',body:JSON.stringify({password:''})});
    закрытьДиалогСервера(); toast('Сервер убран из списка — на машине ничего не изменилось'); render(результат.status);
  }catch(error){ показатьОшибку($('#serverDialogError'),error.message); }
});
// Первое нажатие раскрывает поле пароля, второе — сносит. Раньше здесь стояло
// системное окно ввода, и его закрытие крестиком считалось за согласие: сервер
// исчезал из списка, хотя человек отказался.
$('#serverWipe').addEventListener('click',async()=>{
  if($('#wipeConfirm').hidden){
    $('#wipeConfirm').hidden=false;
    $('#serverWipe').textContent='Снести';
    $('#wipePassword').focus();
    return;
  }
  const пароль=$('#wipePassword').value;
  if(!пароль)return показатьОшибку($('#serverDialogError'),'Введите пароль root — без него удалить с машины нельзя.');
  const кнопка=$('#serverWipe'); кнопка.disabled=true; кнопка.textContent='Сношу…';
  try{
    const результат=await api(`/api/servers/${encodeURIComponent(правимСервер)}/remove`,{method:'POST',body:JSON.stringify({password:пароль})});
    закрытьДиалогСервера();
    toast(результат.cleaned?'Сервер очищен и убран из списка':'Убран из списка, но на машине не очистился');
    render(результат.status);
  }catch(error){ показатьОшибку($('#serverDialogError'),error.message); }
  finally{ кнопка.disabled=false; кнопка.textContent='Снести'; }
});
serverDialog.addEventListener('close',()=>{ $('#serverWipe').textContent='Снести с машины…'; $('#wipeConfirm').hidden=true; });

// Каждый сохранённый список — строка со своими кнопками. Раньше был выпадающий
// список и общая кнопка «Сохранить»: выбрал список, чтобы открыть, нажал
// «Сохранить» — и он молча перезаписался текущей очередью (так пропал список
// на 170+ клипов). Теперь всё, что стирает, называется прямо и переспрашивает.
function renderTemplates(state) {
  const templates=state.templates||[];
  const текущий=state.currentTemplate;
  // Во время переименования строку не перерисовываем — иначе поле ввода пропадёт.
  if($('#templateList').querySelector('.t-name input'))return;
  const html=templates.length?templates.map(item=>{const открыт=текущий?.id===item.id;return `<div class="template-row${открыт?' current':''}" data-template="${escapeHtml(item.id)}">`
    +`<span class="t-cover">${item.cover?`<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`:''}${icon('log')}</span>`
    +`<span class="t-name"><span class="t-title"><b title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</b><button class="icon-btn t-rename" type="button" data-t="rename" title="Переименовать" aria-label="Переименовать список">${icon('pencil')}</button></span><small>${штук(Number(item.count)||0,['ролик','ролика','роликов'])}${открыт?(текущий.dirty?' · открыт, есть изменения':' · открыт'):''}</small></span>`
    +`<span class="t-actions">${открыт?`<button class="btn small" type="button" disabled title="Этот список уже открыт в очереди">${icon('check')}Открыто</button>`:`<button class="btn small primary" type="button" data-t="open" title="Заменить текущую очередь этим списком">${icon('play')}Открыть</button>`}`
    +`<button class="btn small" type="button" data-t="append" title="Добавить ролики списка в конец текущей очереди">${icon('plus')}В конец</button>`
    +`<button class="btn small" type="button" data-t="update" title="Заменить содержимое этого списка текущей очередью">${icon('refresh')}Перезаписать</button>`
    +`<button class="icon-btn t-delete" type="button" data-t="delete" title="Удалить список" aria-label="Удалить список">${icon('trash')}</button></span></div>`;}).join('')
    :'<p class="template-empty">Пока пусто. Соберите очередь и сохраните её ниже — потом откроете одним нажатием.</p>';
  setHtml($('#templateList'),html);
  setText($('#templateCount'),String(templates.length));
  setDisabled($('#saveTemplate'),!state.queue.length);
  // Открытый список — в заголовке очереди; кнопка внизу сохраняет в него.
  setHidden($('#currentList'),!текущий);
  setText($('#currentListName'),текущий?`· ${текущий.name}`:'');
  setHidden($('#currentListDirty'),!текущий?.dirty);
  const кнопка=$('#saveTemplateQuick');
  setText(кнопка,текущий?(текущий.dirty?'Сохранить изменения':'Сохранено'):'Сохранить список');
  setTitle(кнопка,текущий?`Сохранить очередь в список «${текущий.name}»`:'Сохранить очередь как новый список');
  setDisabled(кнопка,!state.queue.length||Boolean(текущий&&!текущий.dirty));
}

// Откуда ролик — по адресу: человеку понятнее «YouTube», чем «медиа по ссылке».
function источник(item){
  if(item.local)return 'Файл';
  const адрес=String(item.sourceUrl||'').toLowerCase();
  if(/youtu\.?be/.test(адрес))return 'YouTube';
  if(/vk\.(com|ru)|vkvideo/.test(адрес))return 'VK Видео';
  if(/rutube/.test(адрес))return 'Rutube';
  if(/twitch/.test(адрес))return 'Twitch';
  if(/animelib|anilib/.test(адрес))return 'AnimeLib';
  if(/kodik|aniqit/.test(адрес))return 'Kodik';
  try{ return new URL(item.sourceUrl).hostname.replace(/^www\./,''); }catch{ return 'Ссылка'; }
}
function queueRowHtml(item,index,state,{готовые,качаются,unityВыбор,подсказкаТрека}){
  const играет=state.currentId===item.id&&state.running, смотрим=ui.localPreviewId===item.id&&!state.running;
  const метка=item.unavailable?'<span class="q-bad">недоступен — пропускается</span>'
    :играет?'<span class="q-live">В эфире</span>'
    :смотрим?'<span class="q-ready">Смотрите здесь</span>'
    :качаются.has(item.id)?'<span class="q-load">Скачиваю…</span>'
    :item.local||готовые.has(item.id)?`<span class="q-ready">${icon('check')}Готово</span>`
    :'<span class="q-wait">В очереди</span>';
  const длина=item.duration?formatTime(item.duration):'';
  const классы=['queue-item',играет?'playing':'',item.unavailable?'unavailable':'',unityВыбор&&ui.unitySelectedId===item.id?'unity-selected':''].filter(Boolean).join(' ');
  return `<div class="${классы}" data-id="${escapeHtml(item.id)}"${item.unavailable?' data-unavailable="1"':''}>`
    +`<button type="button" class="queue-pick" title="${подсказкаТрека}">`
    +(играет?'<span class="q-bars" aria-label="В эфире"><i></i><i></i><i></i></span>':`<span class="q-index">${index+1}</span>`)
    +`<span class="q-grip" aria-hidden="true">${icon('grip')}</span>`
    // При наведении поверх превью — кнопка «играть»: сразу видно, что клик включит ролик.
    +`<span class="queue-art">${item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`:icon('note')}${длина?`<span class="q-dur">${длина}</span>`:''}${играет?'':`<span class="q-play">${icon('play')}</span>`}</span>`
    +`<span class="queue-title"><b title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</b><small><span>${escapeHtml(источник(item))}</span><i></i>${метка}</small></span></button>`
    +`<button type="button" class="remove-item" aria-label="Убрать из очереди" title="Убрать из очереди">${icon('close')}</button></div>`;
}
// Пустая очередь — приглашение, а не пустота: куда перетащить и что можно вставить.
function queueEmptyHtml(){
  return `<div class="queue-empty"><div class="deck-icon">${icon('folder-plus')}</div><div><b>Перетащите видео сюда</b><br><small>или вставьте ссылку выше — ролик, плейлист или аниме-сайт</small></div>`
    +`<button class="btn" type="button" data-pick-local>Выбрать файлы</button><div class="source-chips"><span>YouTube</span><span>VK Видео</span><span>Rutube</span><span>Файлы</span></div></div>`;
}

// Часы эфира в шапке тикают раз в секунду, только пока идёт эфир и окно видно.
function paintLiveClock(){
  if(!ui.liveSince)return;
  setText($('#liveClock'),formatTime((Date.now()-ui.liveSince)/1000));
}
function scheduleLiveClock(state){
  const нужно=Boolean(state?.running&&!ui.windowHidden);
  if(нужно&&!ui.liveClockTimer)ui.liveClockTimer=setInterval(paintLiveClock,1000);
  else if(!нужно&&ui.liveClockTimer){clearInterval(ui.liveClockTimer);ui.liveClockTimer=null;}
}

// Метки на кадре: красное «ЭФИР» — то, что видят в VRChat; жёлтое
// «ПРЕДПРОСМОТР» — источник, который ещё не в эфире.
// Канал наружу: сколько реально пролезает до своего сервера или через туннель,
// и предупреждение, если включён VPN — поток тогда идёт через него кругом.
// Напротив каждого сервиса быстрой ссылки — его средняя скорость по замерам.
const мбит=kbps=>`${(kbps/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} Мбит/с`;
function paintTunnelSpeeds(state){
  const скорости=state.tunnel?.speeds||{}, проверка=state.tunnel?.test||{};
  for(const option of $('#tunnelProviderSelect').options){
    if(option.value==='auto')continue;
    option.dataset.base||=option.textContent;
    const итог=проверка.results?.[option.value];
    const хвост=проверка.current===option.value?' · проверяю…':итог?.error?' · не отвечает':скорости[option.value]?` · ~${мбит(скорости[option.value])}`:option.value==='pinggy'?' · не для VRChat':'';
    setText(option,option.dataset.base+хвост);
  }
  const кнопка=$('#testTunnels');
  setDisabled(кнопка,Boolean(проверка.running||state.running));
  setText(кнопка,проверка.running?'Проверяю…':'Проверить');
  setTitle(кнопка,state.running?'Остановите эфир, чтобы проверить сервисы':'Поднять каждый сервис по очереди и измерить скорость');
}
$('#testTunnels').addEventListener('click',async()=>{try{render(await api('/api/tunnels/test',{method:'POST'}));toast('Проверяю сервисы по очереди — около минуты');}catch(error){toast(error.message,true);}});
// Выбор сетевой карты для потока на свой сервер. Перерисовываем только когда
// список карт или выбор поменялись, иначе открытый список закрывался бы сам.
function paintAdapters(state){
  const select=$('#remoteAdapter'), карты=state.network?.adapters||[], выбрана=state.config.remoteBindAddress||'';
  const подпись=JSON.stringify([карты,выбрана]);
  if(select.dataset.sig===подпись||document.activeElement===select)return;
  select.dataset.sig=подпись;
  const есть=карты.some(к=>к.address===выбрана);
  select.innerHTML=`<option value="">Как в системе</option>`+карты.map(к=>`<option value="${escapeHtml(к.address)}"${к.vpn?' disabled':''}>${escapeHtml(к.name)} · ${escapeHtml(к.address)}${к.vpn?' · VPN':''}</option>`).join('')
    +(выбрана&&!есть?`<option value="${escapeHtml(выбрана)}">${escapeHtml(выбрана)} · сейчас не подключена</option>`:'');
  select.value=выбрана;
}
$('#remoteAdapter').addEventListener('change',async event=>{
  try{render(await api('/api/config',{method:'POST',body:JSON.stringify({remoteBindAddress:event.target.value})}));toast(event.target.value?'Поток пойдёт через выбранную карту':'Поток пойдёт как решит система');}
  catch(error){toast(error.message,true);}
});
function paintNetInfo(state){
  const наружу=state.config.outputMode!=='local', perf=state.performance||{};
  const мбит=state.config.outputMode==='remote'?Number(perf.remoteCapacityKbps)/1000:Number(state.tunnel?.metrics?.throughputMbps)||0;
  // «Через VPN» — только если так и есть: при правиле DIRECT поток идёт мимо,
  // хотя адаптер VPN в системе остаётся.
  const маршрут=state.network?.route||'';
  const vpn=наружу&&маршрут!=='direct'?state.network?.vpn:'';
  const части=[];
  if(наружу&&мбит>0)части.push(`канал ~${мбит.toLocaleString('ru-RU',{maximumFractionDigits:1})} Мбит/с`);
  // Про VPN пишем только когда поток реально идёт через него.
  if(маршрут==='vpn'&&vpn)части.push(`через VPN (${vpn})`);
  setHidden($('#netInfo'),!части.length); setHidden($('#netSep'),!части.length);
  setText($('#netInfo'),части.length?части.join(' · '):'');
  $('#netInfo').classList.toggle('warn',маршрут==='vpn');
  setTitle($('#netInfo'),маршрут==='vpn'?`Поток идёт через VPN «${vpn}» и упирается в его скорость. Добавьте правило DIRECT для ffmpeg.exe и адреса своего сервера.`:маршрут==='direct'?'Поток идёт напрямую: правило VPN пускает его мимо прокси':vpn?`Включён VPN «${vpn}». Как идёт поток, узнать не удалось — если лагает, добавьте правило DIRECT для ffmpeg.exe.`:'Сколько реально проходит до зрителей');
}

function paintMonitorTags(state){
  const кадр=$('#monitor'), метка=$('#monitorTag'), подпись=$('#monitorBadge');
  let текст='', класс='', пояснение='Нет эфира';
  if(!$('#firstRun').hidden){ setHidden(метка,true); setHidden(подпись,true); return; }
  if(state.running){
    const готов=Boolean(state.stream?.ready);
    текст=готов?'ЭФИР':'ЗАПУСК'; класс=готов?'live':'cue';
    пояснение=!ui.previewOn?'Эфир идёт, картинка выключена':ui.source!==(state.activeKind==='screen'?'screen':'queue')?`В эфире ${state.activeKind==='screen'?'экран':'видео'}`:'Так видят в VRChat';
  } else if(кадр.classList.contains('source-preview')||кадр.classList.contains('window-paused')){
    текст='ПРЕДПРОСМОТР'; класс='cue'; пояснение=ui.captureBadge||'Эфир не запущен';
  } else if(ui.localPreviewId){
    текст='ПРОСМОТР'; класс='plain'; пояснение='Только у вас — в эфир не идёт';
  }
  setHidden(метка,!текст); setHidden(подпись,false);
  if(текст){ setText(метка,текст); setClass(метка,`tag-chip ${класс}`); }
  setText(подпись,пояснение);
}

// Кнопка под настройками экрана: начать эфир, переключить его на экран или
// применить изменения к уже идущему захвату. Подпись говорит, что именно будет.
// «Только я» не ждёт готовности: локальный канал поднимается вместе с эфиром,
// а запасная HLS-ссылка работает и без MediaMTX. Ждать надо туннель и свой сервер.
const ссылкаНеГотова=state=>state.config?.outputMode!=='local'&&!state.delivery?.ready;
function paintApply(state){
  const экранВЭфире=state.running&&state.activeKind==='screen';
  setText($('#applyCapture'),экранВЭфире?'Применить в эфире':state.running?'Вещать экран':'Показать в эфире');
  setDisabled($('#applyCapture'),(экранВЭфире&&!ui.captureDirty)||(!state.running&&ссылкаНеГотова(state)));
  const [вид,текст]=экранВЭфире?(ui.captureDirty?['dirty','Изменения ещё не в эфире']:['live','Экран в эфире — изменения применятся по кнопке'])
    :state.running?['','Сейчас в эфире видео — эфир не прервётся']:['','Эфир не запущен — кнопка его начнёт'];
  setClass($('#applyHint'),`apply-hint ${вид}`); setText($('#applyHintText'),текст);
}

// Нижняя карточка и первый запуск зависят от вкладки и от того, есть ли что вещать.
function paintStage(state){
  const первый=ui.source==='queue'&&!state.running&&!ui.localPreviewId&&!state.queue.length;
  setHidden($('#firstRun'),!первый); $('#monitor').classList.toggle('first',первый);
  setHidden($('#playerUi'),ui.source!=='queue'||первый);
  setHidden($('#hintDeck'),!первый);
  setHidden($('#screenDeck'),ui.source!=='screen');
  if(ui.source==='screen'){
    const режим=$('#captureMode').value;
    const окноВыбрано=Boolean($('#windowSource').value);
    setText($('#captureTitle'),режим==='window'?(окноВыбрано?`Окно «${captureLabel()}»`:'Окно не выбрано'):captureLabel());
    setText($('#captureSub'),режим==='window'?`${audioLabel()} · чужие окна поверх него в кадр не попадут`:audioLabel());
    setText($('#highlightSource').querySelector('span'),режим==='window'?'Подсветить окно':'Подсветить');
  }
}

function render(state) {
  // Любая отрисовка не из опроса (ответ на нажатие) сбрасывает сравнение:
  // следующий опрос обязан перерисовать, даже если совпал с прошлым опросом.
  ui.lastPollText='';
  ui.status=state; ui.progressAt=Date.now();  const ready=state.tools.ffmpeg&&state.tools.ytdlp;
  if(ui.seekPending&&!state.playback?.busy&&Number(state.playback?.revision)>=ui.seekRevision)ui.seekPending=false;
  const streamReady=Boolean(state.stream?.ready), streamStalled=state.stream?.state==='stalled';
  // Связь с ядром пропала — старое «В эфире»/«Готово» было бы враньём.
  const нетСвязи=ui.pollFails>=2;
  const вид=нетСвязи||state.disk?.low||streamStalled?'error':state.running?'live':ready?'ready':'';
  setClass($('#stateDot'),`state-dot ${вид}`);
  setClass($('#statusPill'),`status-pill ${вид}`);
  // Таймер эфира: сколько уже вещаем. Считаем от момента, когда окно увидело
  // запуск, — точности до секунды тут достаточно.
  if(state.running&&!ui.liveSince)ui.liveSince=Date.now();
  if(!state.running)ui.liveSince=0;
  setHidden($('#liveClock'),!(state.running&&!нетСвязи));
  paintLiveClock();
  // Раньше при любом недостающем инструменте писалось «Нужен FFmpeg» — даже
  // когда FFmpeg на месте, а не хватает yt-dlp, и пока всё это само качается.
  const качаюИнструменты=Object.values(state.toolDownloads||{}).some(item=>item.state==='work');
  setText($('#systemState'),нетСвязи?'Нет связи':state.disk?.low?`Мало места на диске · ${Math.max(0,Math.round(state.disk.freeMb/1024*10)/10)} ГБ`:state.playback?.buffering?'Загружаю видео':streamStalled?'Не успевает':state.running&&streamReady?'В эфире':state.running?'Запускаю…':streamReady?'Готово':ready?'Готов к эфиру':качаюИнструменты?'Докачиваю инструменты':!state.tools.ffmpeg?'Нужен FFmpeg':'Нужен yt-dlp');
  const tunnelMode=state.config.outputMode==='tunnel', tunnelReady=tunnelMode&&state.tunnel?.ready, tunnelStarting=tunnelMode&&state.tunnel?.state==='starting';
  const tunnelServes=tunnelMode&&state.tunnel?.serves===true, tunnelVerifying=tunnelMode&&state.tunnel?.verifying, tunnelBroken=tunnelMode&&state.tunnel?.serves===false;
  const unityMode=$('#playerMode').value==='unity', unity=state.compatibility?.unity||{};
  if(!ui.unitySelectedId||!state.queue.some(item=>item.id===ui.unitySelectedId))ui.unitySelectedId=unity.queue?.itemId||state.currentId||state.queue[0]?.id||'';
  const storedUnitySource=ui.source==='screen'?unity.capture||{}:unity.queue||{};
  // «Выбран другой трек» — только если какой-то трек уже собран. Раньше это
  // писалось при первом же входе в режим Unity, когда не собрано ничего.
  const unitySource=ui.source==='queue'&&ui.unitySelectedId&&storedUnitySource.itemId&&storedUnitySource.itemId!==ui.unitySelectedId
    ?{...storedUnitySource,available:false,url:'',stale:true}:storedUnitySource;
  let shownUrl='', hint='', linkText='', linkGood=false, linkError=false;
  if(unityMode){shownUrl=unitySource.available?unitySource.url:'';hint=unitySource.scope==='local'&&tunnelMode?'Эта ссылка работает только у вас. Друзьям — плеер AVPro.':ui.source==='screen'?'Unity получит готовую запись, а не прямой эфир.':unitySource.stale?'Трек изменился — подготовьте заново.':'Unity играет один трек — выберите его в списке.';linkText=unitySource.available?(ui.source==='screen'?'Клип готов':'Трек готов'):unitySource.state==='building'||unitySource.state==='recording'||unitySource.state==='finalizing'?'Готовлю файл…':'Файл не готов';linkGood=Boolean(unitySource.available);linkError=unitySource.state==='error';}
  else if(state.config.outputMode==='remote'){
    const remote=state.rtsp?.remote||{};
    shownUrl=remote.configured?remote.url:'';
    hint=remote.channelRejected?'Сервер принимает только постоянную ссылку: «···» у сервера → «Постоянная ссылка».'
      :remote.reachable===false?'Сервер не отвечает. Проверьте, что машина включена.':'';
    // «Подключаюсь…» — только когда эфир реально идёт и ждём канал. Просто
    // выбрали живой сервер и не вещаем — это «Сервер на связи», а не вечное
    // подключение. Не отвечает — честная ошибка, а не зелёная лампа.
    linkText=!remote.configured?'Выберите сервер'
      :remote.reachable===false?'Сервер не отвечает'
      :remote.channelRejected?'Нужна постоянная ссылка'
      :remote.live?'Через ваш сервер'
      :state.running?'Подключаюсь…'
      // «На связи» — только когда проверка действительно ответила; пока ответа
      // нет, раньше здесь тоже писалось «на связи», даже для мёртвого адреса.
      :remote.reachable===true?'Сервер на связи':'Проверяю сервер…';
    linkGood=Boolean(remote.live);
    linkError=Boolean(remote.configured&&(remote.reachable===false||remote.channelRejected||(!remote.live&&state.running)));
  }
  else {
    // «Готово» теперь означает, что канал реально отвечает плееру, а не что
    // запущен процесс: раньше надпись загоралась за секунды до того, как
    // ссылку можно было вставить, и в VRChat она молча не открывалась.
    const rtspLive=!tunnelMode&&Boolean(state.linkReady);
    shownUrl=tunnelReady?state.tunnel.url:tunnelMode?'':state.playbackUrl;
    hint=rtspLive?'':'В мире выберите плеер AVPro и разрешите Untrusted URLs.';
    // Бесплатный туннель не тянет тяжёлый поток — это и есть причина рывков у друзей.
    if(tunnelMode){const heavy=ui.source==='screen'?(state.config.quality==='1080p'||Number(state.config.fps)>30):(state.config.mediaQuality==='1080p'||Number(state.config.mediaFps)>30);
      if(heavy&&!(Number(state.tunnel?.metrics?.throughputMbps)>=7.7))hint+=' Этот туннель медленный — эфир пойдёт в 720p и 30 кадров.';
      // Адрес выдаётся на один сеанс. Кто вставил его раньше — смотрит, а кто
      // зайдёт после перезапуска, получит нерабочую ссылку и будет думать,
      // что сломалась программа. Про это надо предупреждать заранее.
      hint+=' Адрес сменится при следующем запуске.';}
    // Если ссылка проверена и не отдаёт поток (Pinggy-заглушка, блок сети) —
    // показываем причину прямо здесь, а не ложное «готово».
    if(tunnelBroken&&state.tunnel?.error)hint=state.tunnel.error;
    linkText=streamStalled?'Поток отстаёт'
      :rtspLive?'Готово'
      :tunnelBroken?'Ссылка не отдаёт поток'
      :tunnelServes?`Готово · ${state.tunnel.provider}`
      :tunnelVerifying?`Проверяю ссылку · ${state.tunnel.provider||''}`
      :tunnelStarting?'Получаю ссылку…'
      :'Канал поднимается…';
    linkGood=(tunnelMode?tunnelServes:rtspLive);
    linkError=streamStalled||state.tunnel?.state==='error'||tunnelBroken;
  }
  setText($('#playbackUrl'),shownUrl||(linkError?'Ссылка пока недоступна':'Подготовка ссылки…')); setText($('#trustHint'),hint);
  paintNetInfo(state); paintAdapters(state); paintTunnelSpeeds(state);
  setDisabled($('#copyUrl'),!shownUrl);
  const linkState=$('#linkState'); setClass(linkState,`link-state ${linkGood?'public':linkError?'error':''}`); setText(linkState.querySelector('span'),linkText);
  // Транспорт имеет смысл только для RTSP-ссылки
  setHidden($('#unityTools'),!unityMode);
  if(unityMode){
    const storedQueueTask=unity.queue||{}, queueTask=ui.unitySelectedId&&storedQueueTask.itemId&&storedQueueTask.itemId!==ui.unitySelectedId?{...storedQueueTask,available:false,stale:true}:storedQueueTask, captureTask=unity.capture||{}, task=ui.source==='screen'?captureTask:queueTask;
    const progress=ui.source==='screen'?(task.state==='ready'?1:task.state==='recording'||task.state==='finalizing'?Math.min(.95,(Number(task.elapsed)||0)/60):0):Number(task.progress)||0;
    setText($('#unityTaskText'),task.stale?'Выбран другой трек — подготовьте его':task.message||(ui.source==='screen'?'Запись ещё не создана':'Трек ещё не подготовлен'));
    setText($('#unityTaskPercent'),task.state==='recording'?formatTime(task.elapsed):task.state==='finalizing'?'…':`${Math.round(progress*100)}%`);
    const ширина=`${Math.round(progress*100)}%`; if($('#unityTaskBar').style.width!==ширина)$('#unityTaskBar').style.width=ширина;
    setHidden($('#prepareUnityQueue'),ui.source!=='queue'); setDisabled($('#prepareUnityQueue'),queueTask.state==='building'||state.running||!state.queue.length);
    setText($('#prepareUnityQueue'),queueTask.state==='building'?'Подготовка трека…':queueTask.available&&!queueTask.stale?'Подготовить этот трек заново':'Подготовить выбранный трек');
    setHidden($('#recordUnityCapture'),ui.source!=='screen'); setDisabled($('#recordUnityCapture'),captureTask.state==='finalizing'||(captureTask.state!=='recording'&&state.activeKind!=='screen'));
    setText($('#recordUnityCapture'),captureTask.state==='recording'?'Завершить запись и создать MP4':captureTask.state==='finalizing'?'Завершаю MP4…':'Записать Unity-клип из эфира');
  }
  setText($('#appVersion'),state.appVersion||'');
  const update=state.update||{};
  const качается=Object.values(state.toolDownloads||{}).find(item=>item.state==='work');
  setHidden($('#toolProgress'),!качается);
  if(качается){
    // Здесь стояла несуществующая функция «качества()»: при любой загрузке с
    // известным размером render падал, и весь интерфейс замирал до её конца.
    const мегабайты=качается.totalMb?` · ${качается.doneMb} из ${качается.totalMb} МБ`:'';
    setHtml($('#toolProgress'),`<i style="width:${качается.percent}%"></i><span>${escapeHtml(качается.label)} ${качается.percent}%${мегабайты}</span>`);
  }
  offerUpdate(update);
  setText($('#updateNote'),update.available?`Вышла ${update.version} — установлена ${state.appVersion}`
    :update.error?`Не удалось проверить: ${update.error}`
    :update.checked?`Установлена ${state.appVersion} — это последняя версия`:`Установлена ${state.appVersion}`);
  setHidden($('#updateButton'),!update.available);
  if(update.available)setText($('#updateButton'),update.installing?(update.ready?`Устанавливаю ${update.version}…`:`Скачиваю ${update.version} — ${Number(update.percent)||0}%`):`Обновить до ${update.version}`);
  setDisabled($('#updateButton'),Boolean(update.installing));
  setText($('#encoderLabel'),state.performance?.encoder||'неизвестно');
  const реж=state.performance?.encoderMode||'auto', гпу=state.performance?.gpuLabel||'';
  setText($('#encoderNote'),
    реж==='cpu'?'Процессор: нагрузка выше, видеокарта свободна для игры'
    :реж==='gpu'?(гпу?`Сейчас: ${гпу}`:'Видеокарты не нашлось — считает процессор')
    :(гпу?`Сейчас: ${гпу}`:'Видеокарты не нашлось — считает процессор'));
  const слабый=state.performance&&state.performance.hardware===false;
  const тяжело=слабый&&(ui.source==='screen'?(state.config.quality==='1080p'||Number(state.config.fps)>30):(state.config.mediaQuality==='1080p'||Number(state.config.mediaFps)>30));
  const ratio=Number(state.performance?.realtimeRatio||0);
  const perf=state.performance||{}, q=perf.quality||{}, events=perf.events||[];
  // liveLatencySec — дрейф внутренних часов кодировщика, а не задержка у
  // зрителя. Для туннеля показываем измеренный через внешний URL возраст края.
  const drift=Number(perf.liveLatencySec||0);
  const audienceLatency=Number(state.tunnel?.metrics?.audienceLatencySec);
  const hasAudienceLatency=state.config.outputMode==='tunnel'&&Number.isFinite(audienceLatency)&&audienceLatency>=0;
  // У зрителя — диапазон: от края плейлиста до его начала (плеер VRChat
  // на Windows часто стартует ближе к началу окна).
  const задержкаДо=Number(state.tunnel?.metrics?.audienceLatencyMaxSec);
  const задержкаТекст=`${Math.round(audienceLatency)}–${Math.round(Number.isFinite(задержкаДо)?задержкаДо:audienceLatency)} с`;
  const congested=events.some(e=>e.kind==='remote-congestion'&&Date.now()-e.at<15000);
  let health=тяжело?'видеокарта не кодирует — поставьте 720p и 30 кадров':streamReady?(ratio&&ratio<0.97?`отстаёт на ${Math.round((1-ratio)*100)}%`:'идёт вовремя'):streamStalled?'не успевает — снизьте качество':'набирает буфер';
  // Бесплатный туннель на 0,5–1 Мбит/с поток не тянет, как ни настраивай, —
  // говорим об этом прямо, а не «набирает буфер».
  const туннельМбит=Number(state.tunnel?.metrics?.throughputMbps)||0;
  const туннельМедленный=state.config.outputMode==='tunnel'&&туннельМбит>0&&туннельМбит<1.2;
  if(туннельМедленный)health=`туннель медленный (~${туннельМбит.toLocaleString('ru-RU')} Мбит/с) — у зрителей будут паузы, нужен свой сервер`;
  else if(congested)health='свой сервер не успевал — битрейт снижен автоматически';
  // Хвост до своего сервера — это задержка, которую видит зритель в VRChat.
  // Раньше здесь горело «идёт вовремя», хотя зрители отставали на секунды.
  else if(Number(perf.remoteBacklogSec)>=1)health=`свой сервер отстаёт на ${Number(perf.remoteBacklogSec).toFixed(1).replace('.',',')} с`;
  else if(state.running&&streamReady){
    if(hasAudienceLatency)health+=` · у зрителя ≈ ${задержкаТекст}`;
    else if(drift>0.3)health+=` · дрейф ${drift.toFixed(1)}с`;
    if(q.freezes>0)health+=` · фризов ${q.freezes}`;
    if(q.driftCorrections>0)health+=` · синхр. ${q.driftCorrections}`;
  }
  const last=events[events.length-1];
  // Первая буква заглавная — в строке состояния это самостоятельная фраза.
  setText($('#streamHealth'),`Поток ${health}`.replace(/^Поток (видеокарта|свой)/,(m,x)=>x[0].toUpperCase()+x.slice(1)));
  const здоровье=streamStalled||congested||тяжело?'bad':!streamReady?'warn':ratio&&ratio<0.97?'warn':'ok';
  setClass($('#healthDot'),`dot ${здоровье}`);
  // Метка на кадре — только в эфире: без эфира о потоке говорить нечего.
  setHidden($('#healthChip'),!state.running);
  if(state.running){
    setClass($('#healthChip'),`tag-chip soft health-chip ${здоровье==='ok'?'':здоровье}`);
    setText($('#healthChipText'),здоровье==='ok'?(hasAudienceLatency?`У зрителя ≈ ${задержкаТекст}`:drift>0.3?`Дрейф ${drift.toFixed(1).replace('.',',')} с`:'Поток вовремя'):здоровье==='warn'?'Набирает буфер':'Не успевает');
  }
  setTitle($('#streamHealth'),state.running
    ?`${hasAudienceLatency?`Задержка у зрителей публичной ссылки ≈ ${задержкаТекст} (зависит от их плеера)`:`Дрейф кодировщика ${drift.toFixed(1)}с (пик ${Number(perf.maxLiveLatencySec||0).toFixed(1)}с)`}\nФризов ${q.freezes||0} на ${q.freezeSeconds||0}с всего\nСинхронизаций часов ${q.driftCorrections||0}${last?`\nПоследнее: ${last.detail}${last.position!=null?` (${last.title||'трек'} на ${last.position}с)`:''}`:''}`
    :'');
  setText($('#queueCount'),state.queue.length);
  const всегоСекунд=state.queue.reduce((sum,item)=>sum+(Number(item.duration)||0),0);
  setHtml($('#queueSummary'),`${штук(state.queue.length,['видео','видео','видео'])}${всегоСекунд?` · <b>${formatTime(всегоСекунд)}</b>`:''}`);
  setHidden($('#pickLocal'),!state.queue.length);
  setDisabled($('#clearQueue'),!state.queue.length);
  // Журнал в сотню строк переписываем, только пока его окно открыто: иначе
  // это самая тяжёлая запись в DOM на каждом опросе, и её никто не видит.
  if($('#logDialog').open)paintLogs(state);
  syncConfigControls(state);
  // Показания выхода всегда на виду: что уходит в эфир, какая чёткость и
  // сколько кадров. Раньше это было спрятано под шестерёнкой, и автопонижение
  // качества человек замечал только в журнале.
  const выход=state.running?(state.activeKind==='screen'?'screen':'queue'):(ui.source==='screen'?'screen':'queue');
  // Через бесплатный туннель уходит не больше 720p/30 — показываем то, что
  // реально получат зрители, а не выбранное в настройках.
  // Быстрый туннель (замер от ~7,7 Мбит/с) пропускает выбранное как есть.
  const туннель=state.config.outputMode==='tunnel'&&!(Number(state.tunnel?.metrics?.throughputMbps)>=7.7);
  let чёткость=выход==='screen'?state.config.quality:state.config.mediaQuality;
  let кадры=выход==='screen'?state.config.fps:state.config.mediaFps;
  if(туннель&&чёткость==='1080p')чёткость='720p';
  if(туннель&&Number(кадры)>30)кадры=30;
  const битрейт=Number(state.config.videoBitrate)||0;
  setText($('#qualityLabel'),`${чёткость} · ${кадры} к/с${perf.pendingProfile?' · со следующего запуска':''}`);
  // В подписи — уровень и сколько реально уходит (с учётом автоснижения).
  const уровень=$('#videoBitrate').selectedOptions[0]?.dataset.short||'Авто';
  const битрейты=[perf.remoteBudgetKbps,perf.desiredProfile?.bitrateKbps].map(Number).filter(n=>n>0), реально=битрейты.length?Math.min(...битрейты):0;
  setText($('#bitrateLabel'),реально?`${уровень} · ${(реально/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} Мбит/с`:уровень);
  setTitle($('#playerSettings'),`Что уходит в эфир: ${чёткость}, ${кадры} кадров, ${битрейт?`${битрейт} Кбит/с`:'поток авто'}`);
  const monitor=$('#monitor');
  // Транспорт (перемотка, пауза, скорость) нужен только когда идёт живое
  // видео. На предпросмотре источника и при остановленном эфире управлять
  // нечем — панель тогда прячется, чтобы не всплывать пустыми кнопками.
  // Транспорт нужен и при живом видео, и при локальном предпросмотре трека.
  monitor.classList.toggle('live-video',Boolean(state.running&&state.activeKind==='queue'));
  monitor.classList.toggle('local-preview',Boolean(!state.running&&ui.localPreviewId));
  monitor.classList.toggle('tally-live',Boolean(state.running&&streamReady));
  monitor.classList.toggle('tally-cue',Boolean(state.running&&!streamReady));
  const list=$('#queueList');
  const unityВыбор=$('#playerMode').value==='unity';
  const подсказкаТрека=unityВыбор?'Выбрать для подготовки Unity':state.running?'Включить этот трек в эфире':'Посмотреть здесь, без эфира';
  const готовые=new Set(state.cache?.readyIds||[]), качаются=new Set(state.cache?.downloading||[]);
  const queueSignature=JSON.stringify([state.currentId,state.running,ui.localPreviewId,ui.unitySelectedId,подсказкаТрека,[...качаются],[...готовые],state.queue.map(item=>[item.id,item.title,item.thumbnail,item.duration,item.unavailable,item.local])]);
  if(!ui.dragging&&queueSignature!==ui.queueSignature){ui.queueSignature=queueSignature;list.innerHTML=state.queue.length?state.queue.map((item,index)=>queueRowHtml(item,index,state,{готовые,качаются,unityВыбор,подсказкаТрека})).join(''):queueEmptyHtml();}
  const screenSource=ui.source==='screen';
  setHidden($('#menuMediaQuality'),screenSource); setHidden($('#menuMediaFps'),screenSource);
  setHidden($('#menuScreenQuality'),!screenSource); setHidden($('#menuScreenFps'),!screenSource);
  renderNowPlaying(state); renderProgress(); renderTemplates(state); renderServers(state); renderLocalOutput(state); renderStorage(state); startPreview(state); paintMonitorPlaceholder(state);
  // Пуск и остановка — отдельная явная кнопка, и её название прямо говорит,
  // что именно начнётся или прекратится. Раньше кнопка пуска была спрятана
  // всегда, и запустить эфир экрана можно было только через «Показать экран
  // в эфире» в настройках источника — это находили не сразу.
  const экран=ui.source==='screen';
  // Эфир идёт с другой вкладки — кнопка переключает его сюда. Сервер меняет
  // источник внутри того же сеанса, плеер в мире не переподключается. Раньше
  // при идущем эфире кнопки пуска не было вовсе, и перейти с плейлиста на
  // захват (или обратно) можно было только через остановку эфира.
  const чужойЭфир=state.running&&state.activeKind!==(экран?'screen':'queue');
  setHidden($('#goLive'),state.running&&!чужойЭфир);
  $('#goLive').classList.toggle('switch',чужойЭфир);
  setText($('#goLiveLabel'),чужойЭфир?(экран?'Вещать экран':'Вещать видео'):'Начать эфир');
  // Пустая очередь — пускать нечего; кнопка честно неактивна, а не падает с ошибкой.
  setDisabled($('#goLive'),(!экран&&!state.running&&!state.queue.length)||(!state.running&&ссылкаНеГотова(state)));
  setTitle($('#goLive'),чужойЭфир?'Эфир не прервётся: зрители сразу увидят новый источник':ссылкаНеГотова(state)?(state.delivery?.error||'Ссылка ещё готовится — дождитесь готовности'):'');
  setHidden($('#stopLive'),!state.running);
  setText($('#stopLive'),'Остановить эфир');
  paintApply(state);
  // Режим ссылки во время эфира не меняем: зрители, вставившие адрес, остались бы без картинки.
  $$('#audienceMenu [data-output]').forEach(node=>setDisabled(node,state.running));
  setText($('#audienceMenu .menu-caption'),state.running?'Во время эфира не меняется — сначала остановите эфир':'Кто сможет открыть ссылку');
  schedulePlaybackClock(); scheduleLiveClock(state); paintStage(state); paintMonitorTags(state);
  // Эфир закончился, а открыта вкладка «Экран» — возвращаем живой кадр
  // источника. Раньше после остановки там оставалась пустая заглушка.
  if(ui.wasRunning&&!state.running&&ui.source==='screen')refreshCapturePreview(false).catch(()=>{});
  ui.wasRunning=state.running;
}

function paintLogs(state=ui.status) {
  // Обычный опрос приходит без журнала — тогда ничего не трогаем.
  if(!Array.isArray(state?.logs))return;
  setText($('#logs'),state.logs.join('\n')||'Журнал пуст');
}

// Настройки качества могут поменяться и без нас — автопонижение, другая
// вкладка. Меню показывало то, что было при запуске окна, и врало. Сверяем
// со статусом, но не в те полторы секунды, пока человек сам что-то жмёт.
function syncConfigControls(state) {
  if (Date.now()<ui.configEditUntil) return;
  const c=state.config||{};
  const значения={quality:c.quality,fps:c.fps,mediaQuality:c.mediaQuality,mediaFps:c.mediaFps,videoBitrate:c.videoBitrate??0,encoderMode:c.encoderMode||'auto',tunnelProviderSelect:c.tunnelProvider||'auto',closeAction:c.closeToTray===false?'exit':'tray'};
  for (const [id,value] of Object.entries(значения)) {
    if (value===undefined||value===null) continue;
    const select=document.getElementById(id);
    if (!select||select.value===String(value)||![...select.options].some(option=>option.value===String(value))) continue;
    select.value=String(value); paintSegments(select);
  }
}

function chooseSource(source) {
  ui.source=source;
  $$('.nav-item').forEach(button=>{const on=button.dataset.tab===source;button.classList.toggle('active',on);button.setAttribute('aria-selected',String(on));});
  $('#queuePanel').hidden=source!=='queue'; $('#screenPanel').hidden=source!=='screen';
  if(source!=='screen'&&!ui.status?.running)$('#monitor').classList.remove('source-preview','window-paused');
  if (source==='screen'){refreshWindows().catch(()=>{});if(!ui.status?.running)refreshCapturePreview().catch(()=>{});}
  if(ui.status)render(ui.status);
}
// Кто откроет ссылку. Рисуем пункт меню и подпись на кнопке в шапке.
const АУДИТОРИЯ={local:['display','Только я'],tunnel:['globe','Все в мире'],remote:['server','Свой сервер']};
function chooseOutput(output) {
  ui.output=output;
  $$('#audienceMenu [data-output]').forEach(button=>button.setAttribute('aria-checked',String(button.dataset.output===output)));
  const [значок,подпись]=АУДИТОРИЯ[output]||АУДИТОРИЯ.local;
  $('#audienceIcon').setAttribute('href',`#i-${значок}`); setText($('#audienceLabel'),подпись);
}
// auto=false — при загрузке настроек: сохранённый режим звука не трогаем.
// Раньше при каждом открытии программы с захватом окна звук молча менялся с
// «Всё, что слышно в Windows» на «звук окна», а подпись оставалась от прежнего.
function chooseCaptureMode(mode, auto=true) { for(const card of $$('#captureCards [data-capture]'))card.setAttribute('aria-checked',String(card.dataset.capture===mode)); $('#monitorFields').hidden=mode!=='monitor'; $('#windowFields').hidden=mode!=='window'&&$('#audioMode').value!=='process'; $('#regionFields').hidden=mode!=='region'; if(auto&&mode==='window'&&$('#audioMode').value==='system'){$('#audioMode').value='process';chooseAudioMode('process');} }
function chooseAudioMode(mode) {
  // Звук процесса привязан к выбранному окну — селектор окна нужен даже при захвате монитора/области.
  for(const card of $$('#audioCards [data-audio]'))card.setAttribute('aria-checked',String(card.dataset.audio===mode));
  $('#windowFields').hidden=$('#captureMode').value!=='window'&&mode!=='process';
  if(mode==='process')refreshWindows().catch(()=>{});
  $('#audioOutputFields').hidden=mode!=='output'; $('#audioDeviceFields').hidden=mode!=='device'; $('#localVolumeFields').hidden=mode!=='process';
  const text={process:'Звук выбранного окна и его дочерних процессов.',system:'Устройство вывода Windows по умолчанию.',output:'Колонки, наушники или HDMI-звук нужного монитора.',device:'Микрофон или виртуальный вход.',none:'Эфир без звука.'}; $('#audioHelp').textContent=text[mode]||'';
}
function captureLabel() { const mode=$('#captureMode').value; if(mode==='window')return $('#windowPickerButton').querySelector('b').textContent||'Окно'; if(mode==='monitor')return $('#monitorSource').selectedOptions[0]?.textContent||'Монитор'; if(mode==='region')return `Область ${$('#regionWidth').value}×${$('#regionHeight').value}`; return 'Все мониторы'; }
function audioLabel() { return $('#audioMode').selectedOptions[0]?.textContent||'Без звука'; }

// Список окон рисуем сами: в обычный выпадающий список картинку не положить, а
// без значка два десятка одинаковых заголовков глазом не разобрать.
function windowRowHtml(item, selected) {
  return `<button type="button" role="option" aria-selected="${item.handle===selected}" class="app-row${item.handle===selected?' on':''}" data-handle="${item.handle}" data-pid="${item.id}">`
    + (item.icon?`<img src="${item.icon}" alt="">`:'<i class="app-row-blank"></i>')
    + `<span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.process)}${item.minimized?' · свёрнуто':''}</small></span></button>`;
}

function fillWindowPicker(items, value) {
  const выбран=items.find(item=>item.handle===String(value||''))||null;
  const кнопка=$('#windowPickerButton'), значок=кнопка.querySelector('img');
  кнопка.querySelector('b').textContent=выбран?выбран.title:'Выберите окно';
  значок.hidden=!выбран?.icon; if(выбран?.icon)значок.src=выбран.icon;
  $('#windowPickerList').innerHTML=items.length?items.map(item=>windowRowHtml(item,String(value||''))).join(''):'<p class="app-empty">Открытых окон не найдено</p>';
  $('#windowSource').value=выбран?выбран.handle:'';
}

function openWindowPicker(open) {
  $('#windowPickerList').hidden=!open;
  $('#windowPickerButton').setAttribute('aria-expanded',String(open));
}

$('#windowPickerButton').addEventListener('click',async()=>{
  const открыть=$('#windowPickerList').hidden;
  openWindowPicker(открыть);
  if(открыть)await refreshWindows().catch(()=>{});
});
$('#windowPickerList').addEventListener('click',event=>{
  const строка=event.target.closest('.app-row'); if(!строка)return;
  fillWindowPicker(ui.sources.windows,строка.dataset.handle);
  openWindowPicker(false);
  $('#windowSource').dispatchEvent(new Event('change'));
});
document.addEventListener('click',event=>{ if(!event.target.closest('#windowPicker'))openWindowPicker(false); });
// Стрелки по списку окон: у нативного списка это было бесплатно, свой список
// без этого хуже того, что заменил.
$('#windowPickerList').addEventListener('keydown',event=>{
  const шаг={ArrowDown:1,ArrowUp:-1}[event.key];
  if(шаг){
    event.preventDefault();
    const строки=[...$$('#windowPickerList .app-row')];
    if(!строки.length)return;
    const текущая=строки.indexOf(document.activeElement);
    строки[(текущая+шаг+строки.length)%строки.length].focus();
    return;
  }
  if(event.key==='Escape'){ openWindowPicker(false); $('#windowPickerButton').focus(); }
});

function fillSelect(select, items, value, placeholder, mapper) {
  select.innerHTML=`<option value="">${placeholder}</option>`+items.map(mapper).join(''); if(value&&[...select.options].some(option=>option.value===String(value)))select.value=String(value);
}
async function loadCaptureSources() {
  const saved={...(ui.status?.config||{})}, currentWindow=$('#windowSource').value, currentMonitor=$('#monitorSource').value, currentOutput=$('#audioOutput').value, currentDevice=$('#audioDevice').value; ui.sources=await api('/api/capture-sources');
  if(currentWindow)saved.captureWindowHandle=currentWindow;if(currentMonitor)saved.captureMonitorId=currentMonitor;if(currentOutput)saved.audioOutputId=currentOutput;if(currentDevice)saved.captureAudioDevice=currentDevice;
  fillSelect($('#monitorSource'),ui.sources.monitors,saved.captureMonitorId,'Автовыбор основного',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.width}×${item.height}</option>`);
  fillWindowPicker(ui.sources.windows,saved.captureWindowHandle);
  fillSelect($('#audioOutput'),ui.sources.audioOutputs,saved.audioOutputId,'Выберите выход',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`);
  fillSelect($('#audioDevice'),ui.sources.audioDevices,saved.captureAudioDevice,'Выберите вход',name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  ui.sourcesLoaded=true;
  paintMuteDevices();
}

// «Не слышать у себя» уводит звук на выход, который никто не слушает. Своими
// наушниками (выход по умолчанию) он быть не может. Рекомендуем тот же, что
// выбрал бы помощник: Steam Streaming, VB-CABLE, Voicemeeter.
const БЕЗЗВУЧНЫЙ=/steam streaming|cable input|voicemeeter|vb-audio/i;
function muteTarget(){
  const выходы=ui.sources.audioOutputs||[], выбран=ui.status?.config?.muteDevice||'';
  const свой=выходы.find(item=>item.id===выбран&&!item.isDefault);
  return свой||выходы.find(item=>!item.isDefault&&БЕЗЗВУЧНЫЙ.test(item.name))||null;
}
function paintMuteDevices(){
  const выходы=ui.sources.audioOutputs||[], выбран=ui.status?.config?.muteDevice||'';
  const рекомендованный=выходы.find(item=>!item.isDefault&&БЕЗЗВУЧНЫЙ.test(item.name));
  fillSelect($('#muteDevice'),выходы.filter(item=>!item.isDefault),выбран,
    рекомендованный?`Авто — рекомендуется: ${escapeHtml(рекомендованный.name)}`:'Авто — подходящего выхода нет',
    item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${БЕЗЗВУЧНЫЙ.test(item.name)?' — беззвучный':' — его может быть слышно'}</option>`);
  const цель=muteTarget(), загружено=ui.sourcesLoaded;
  // Некуда уводить — переключатель серый (если он не включён прямо сейчас),
  // и рядом прямой путь в настройки.
  setDisabled($('#muteLocalApp'),загружено&&!цель&&!$('#muteLocalApp').checked);
  setHidden($('#muteSetupNote'),!загружено||Boolean(цель));
  setText($('#muteDeviceNote'),цель?`Сейчас: ${цель.name}. Звук приложения уходит туда и в программу, а не в наушники`:'Подходящего выхода нет — установите VB-CABLE или выберите другой выход');
}
$('#openMuteSettings').addEventListener('click',()=>открытьНастройки('setStream'));
$('#refreshOutputs').addEventListener('click',()=>loadCaptureSources().then(()=>toast('Список выходов обновлён')).catch(error=>toast(error.message,true)));
$('#muteDevice').addEventListener('change',async()=>{try{const live=ui.status?.activeKind==='screen';render(await saveConfig(live));paintMuteDevices();toast('Выход сохранён');}catch(error){toast(error.message,true);}});

async function refreshWindows() {
  const windows=await api('/api/windows');
  // Выбор читаем ПОСЛЕ ответа, а не до: запрос идёт через PowerShell 1–2 с, и
  // за это время загрузка источников успевала выставить сохранённое окно. Старое
  // (пустое) значение его затирало — при режиме «звук окна» выбранное окно
  // терялось на каждом запуске, и «Вещать экран» падало с «Выберите окно».
  const selected=$('#windowSource').value||(!ui.sourcesLoaded?ui.status?.config?.captureWindowHandle||'':'');
  ui.sources.windows=windows;
  fillWindowPicker(windows,selected);
}

function configPayload() {
  // Пока списки окон и устройств не загрузились (PowerShell, пара секунд после
  // открытия), поля пустые. Раньше пустота уходила на сервер и затирала
  // сохранённое окно: «Начать эфир экрана» сразу после запуска падало с
  // «Выберите окно», а звук окна терял процесс. Пока списков нет — шлём сохранённое.
  const saved=ui.status?.config||{}, ждём=!ui.sourcesLoaded;
  const handle=$('#windowSource').value||(ждём?saved.captureWindowHandle||'':'');
  const selectedWindow=ui.sources.windows.find(item=>item.handle===handle);
  const processId=selectedWindow?selectedWindow.id:(ждём&&handle===saved.captureWindowHandle?saved.audioProcessId||'':'');
  return { outputMode:ui.output,activeServerId:ui.status?.config?.activeServerId||'',quality:$('#quality').value,fps:Number($('#fps').value),mediaQuality:$('#mediaQuality').value,mediaFps:Number($('#mediaFps').value),videoBitrate:Number($('#videoBitrate').value),encoderMode:$('#encoderMode').value,captureMode:$('#captureMode').value,captureMonitorId:ждём?saved.captureMonitorId||'':$('#monitorSource').value,captureWindowHandle:handle,regionX:Number($('#regionX').value),regionY:Number($('#regionY').value),regionWidth:Number($('#regionWidth').value),regionHeight:Number($('#regionHeight').value),audioMode:$('#audioMode').value,audioOutputId:ждём?saved.audioOutputId||'':$('#audioOutput').value,audioProcessId:processId,captureAudioDevice:ждём?saved.captureAudioDevice||'':$('#audioDevice').value,localAppVolume:Number($('#localAppVolume').value),muteLocalApp:$('#muteLocalApp').checked,muteDevice:ui.sourcesLoaded?$('#muteDevice').value:(ui.status?.config?.muteDevice||''),loopMode:$('#loopSelect').dataset.value,playbackSpeed:Number($('#speedSelect').dataset.value),captureVolume:Number($('#captureVolume').value)/100,mediaVolume:Number($('#mediaVolume').value)/100,whiteIp:$('#whiteIp').value.trim(),tunnelProvider:$('#tunnelProviderSelect').value,closeToTray:$('#closeAction').value!=='exit' };
}
async function saveConfig(applyLive = false) { return api('/api/config',{method:'POST',body:JSON.stringify({...configPayload(),applyLive})}); }

function selectedRect() {
  const mode=$('#captureMode').value;
  if(mode==='window')return ui.sources.windows.find(item=>item.handle===$('#windowSource').value)||null;
  if(mode==='monitor')return ui.sources.monitors.find(item=>item.id===$('#monitorSource').value)||ui.sources.monitors.find(item=>item.primary)||null;
  if(mode==='region')return{x:Number($('#regionX').value),y:Number($('#regionY').value),width:Number($('#regionWidth').value),height:Number($('#regionHeight').value)};
  if(mode==='desktop'&&ui.sources.monitors.length){const left=Math.min(...ui.sources.monitors.map(x=>x.x)),top=Math.min(...ui.sources.monitors.map(x=>x.y)),right=Math.max(...ui.sources.monitors.map(x=>x.x+x.width)),bottom=Math.max(...ui.sources.monitors.map(x=>x.y+x.height));return{x:left,y:top,width:right-left,height:bottom-top};} return null;
}
// force — явное нажатие «Обновить кадр»: один снимок даже при выключенном
// предпросмотре. Раньше кнопка при выключенном глазе молча ничего не делала.
async function refreshCapturePreview(save = true, force = false) {
  if (ui.source!=='screen'||ui.status?.running||(!previewAllowed()&&!force)) return;
  // Пока идёт прошлый запрос, новый не шлём, но и не теряем: сменили режим
  // посреди запроса — после него кадр запросится заново, уже для нового.
  if (ui.previewBusy) { if (save) ui.previewAgain=true; return; }
  ui.previewBusy=true; const номер=ui.captureRequest||0;
  try {
    if(save)await saveConfig(); const result=await api('/api/capture-preview',{method:'POST'}); const monitor=$('#monitor');
    if(ui.source!=='screen'||ui.status?.running||номер!==(ui.captureRequest||0))return;
    monitor.classList.toggle('window-paused',Boolean(result.minimized||result.unavailable));
    if(result.minimized){monitor.classList.remove('source-preview');monitorPlaceholder('Окно свёрнуто','В эфире заглушка, звук продолжает идти','minus');}
    else if(result.unavailable){monitor.classList.remove('source-preview');monitorPlaceholder('Окно недоступно','Откройте приложение или обновите список','alert');}
    else{$('#capturePreview').src=`${result.url}&cache=${Date.now()}`;monitor.classList.add('source-preview');}
    ui.captureBadge=result.minimized?'Окно свёрнуто':result.unavailable?'Окно не найдено':'Эфир не запущен';
    if(ui.status)paintMonitorTags(ui.status);
    scheduleCaptureFrames();
  } catch(error){
    if(номер===(ui.captureRequest||0)&&!$('#monitor').classList.contains('source-preview')){monitorPlaceholder('Нет предпросмотра',error.message||'Обновите список источников','alert');ui.captureBadge='Нет кадра';}
    throw error;
  } finally {
    ui.previewBusy=false;
    if(ui.previewAgain){ ui.previewAgain=false; refreshCapturePreview().catch(()=>{}); }
  }
}
function highlightSelected() { const rect=selectedRect(); if(!rect?.width||!rect?.height)return toast('Сначала выберите источник',true); window.location.href=`vrcast://highlight?x=${rect.x}&y=${rect.y}&width=${rect.width}&height=${rect.height}`; }

$$('.nav-item').forEach(button=>button.addEventListener('click',()=>chooseSource(button.dataset.tab)));
// Режим выхода: рисуем сразу, но верим только ответу сервера. Не сохранилось —
// кнопка возвращается к тому, что стоит на сервере; ответ на прошлое нажатие,
// пришедший после нового, отбрасываем, чтобы он не перебил свежий выбор.
$$('#audienceMenu [data-output]').forEach(button=>button.addEventListener('click',async()=>{
  openAudienceMenu(false);
  // «Свой сервер» без единого сервера — сразу туда, где его добавляют.
  if(button.dataset.output==='remote'&&!(ui.status?.config?.servers||[]).length){ открытьНастройки('setNet'); открытьДобавление(true); return; }
  const номер=ui.outputRequest=(ui.outputRequest||0)+1;
  chooseOutput(button.dataset.output);
  try{
    const state=await saveConfig(false);
    if(номер!==ui.outputRequest)return;
    render(state);
    if(state.config?.outputMode&&state.config.outputMode!==ui.output)chooseOutput(state.config.outputMode);
  }catch(error){
    if(номер===ui.outputRequest&&ui.status?.config?.outputMode)chooseOutput(ui.status.config.outputMode);
    toast(error.message,true);
  }
}));
$('#captureMode').addEventListener('change',event=>{
  chooseCaptureMode(event.target.value);
  // Новый режим — новый источник: «Окно недоступно» и старый кадр прошлого
  // источника здесь больше ни при чём. Ответ по старому режиму отбросится.
  ui.captureRequest=(ui.captureRequest||0)+1;
  if(!ui.status?.running){
    $('#monitor').classList.remove('window-paused','source-preview');
    if($('#capturePreview').hasAttribute('src'))$('#capturePreview').removeAttribute('src');
    if(ui.status)render(ui.status);
  }
  refreshCapturePreview().catch(error=>toast(error.message,true));
});
$('#audioMode').addEventListener('change',event=>chooseAudioMode(event.target.value));
$('#localAppVolume').addEventListener('change',async()=>{try{const live=ui.status?.activeKind==='screen';render(await saveConfig(live));toast(live?'Громкость изменена, в эфире прежняя':'Сохранено');}catch(error){toast(error.message,true);}});
$('#muteLocalApp').addEventListener('change',async()=>{try{const live=ui.status?.activeKind==='screen';render(await saveConfig(live));toast($('#muteLocalApp').checked?'У вас звук выключен, в эфире остался':'Звук приложения у вас возвращён');}catch(error){toast(error.message,true);}});
$('#monitorSource').addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true)));
$('#windowSource').addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true)));

$('#refreshSources').addEventListener('click',async()=>{try{await loadCaptureSources();toast('Список обновлён');}catch(error){toast(error.message,true);}});
$('#refreshPreview').addEventListener('click',()=>{
  if(ui.status?.running)return toast('Идёт эфир — картинка источника видна в самом эфире',true);
  refreshCapturePreview(true,true).catch(error=>toast(error.message,true));
});
// Координаты области, введённые руками, тоже должны сразу попадать в кадр.
for(const id of ['#regionX','#regionY','#regionWidth','#regionHeight'])$(id).addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true))); $('#highlightSource').addEventListener('click',highlightSelected);
$('#applyCapture').addEventListener('click',async()=>{
  const button=$('#applyCapture');
  // Эфир экрана не идёт — кнопка делает то же, что «Начать эфир» / «Вещать экран».
  if(!(ui.status?.running&&ui.status.activeKind==='screen'))return начатьЭфир();
  button.disabled=true;
  try{await saveConfig();$('#monitor').classList.remove('source-preview','window-paused');ui.captureDirty=false;render(await api('/api/start/screen',{method:'POST'}));toast('Изменения в эфире');}
  catch(error){toast(error.message,true);}finally{if(ui.status)paintApply(ui.status);}
});
// Карточки режима и звука — это те же select, только нажимать удобнее.
$('#captureCards').addEventListener('click',event=>{const card=event.target.closest('[data-capture]');if(!card||card.dataset.capture===$('#captureMode').value)return;$('#captureMode').value=card.dataset.capture;$('#captureMode').dispatchEvent(new Event('change'));});
$('#audioCards').addEventListener('click',event=>{const card=event.target.closest('[data-audio]');if(!card||card.dataset.audio===$('#audioMode').value)return;$('#audioMode').value=card.dataset.audio;$('#audioMode').dispatchEvent(new Event('change'));});
// Что-то поменяли в источнике, пока экран в эфире, — честно говорим, что это ещё не в эфире.
for(const id of ['#captureMode','#monitorSource','#windowSource','#regionX','#regionY','#regionWidth','#regionHeight','#audioMode','#audioOutput','#audioDevice'])
  $(id).addEventListener('change',()=>{ ui.captureDirty=true; if(ui.status){ paintApply(ui.status); paintStage(ui.status); } });
$('#selectRegion').addEventListener('click',()=>{window.location.href='vrcast://select-region';}); $('#pickLocal').addEventListener('click',()=>{window.location.href='vrcast://pick-media';});
window.applySelectedRegion=region=>{$('#regionX').value=region.x;$('#regionY').value=region.y;$('#regionWidth').value=region.width;$('#regionHeight').value=region.height;refreshCapturePreview().catch(()=>{});toast(`Выбрано ${region.width}×${region.height}`);};
window.addLocalFiles=async paths=>{try{const result=await api('/api/queue/local',{method:'POST',body:JSON.stringify({paths})});render(result.status);toast(`Добавлено: ${result.added.length}`);}catch(error){toast(error.message,true);}};

// Окно выбора при добавлении. Возвращает нажатое действие (или null) и то,
// что выбрано внутри. Кнопки: [значение, подпись, класс].
function окноДобавления({title,sub='',cover='',body='',кнопки,начать}){
  const окно=$('#addDialog');
  setText($('#addDialogTitle'),title); setText($('#addDialogSub'),sub);
  $('#addCover').innerHTML=cover?`<img src="${escapeHtml(cover)}" alt="" onerror="this.remove()">`:icon('log');
  $('#addDialogBody').innerHTML=body;
  $('#addDialogActions').innerHTML=кнопки.map(([значение,подпись,класс=''])=>`<button class="btn ${класс}" type="button" data-add="${escapeHtml(значение)}">${escapeHtml(подпись)}</button>`).join('');
  начать?.(окно);
  return new Promise(resolve=>{
    const готово=значение=>{окно.removeEventListener('close',закрыли);$('#addDialogActions').onclick=null;if(окно.open)окно.close();resolve(значение);};
    const закрыли=()=>готово(null);
    окно.addEventListener('close',закрыли);
    $('#addDialogActions').onclick=event=>{const кнопка=event.target.closest('[data-add]');if(кнопка)готово(кнопка.dataset.add==='cancel'?null:кнопка.dataset.add);};
    окно.showModal();
    ($('#addDialogActions .primary')||$('#addDialogActions button')).focus();
  });
}

// Примерный размер серии на 24 минуты — чтобы выбор качества был понятен.
const РАЗМЕР_СЕРИИ={1080:'≈ 700 МБ',720:'≈ 350 МБ',480:'≈ 200 МБ',360:'≈ 130 МБ'};
async function выбратьСерии(info){
  const серии=info.episodes, много=серии.length>1;
  const номер=id=>серии.findIndex(e=>e.id===id);
  let scope=много&&!info.episode?'all':'one', quality=720;
  const озвучки=info.teams.map(t=>`<option value="${escapeHtml(t.id)}|${escapeHtml(t.translation)}"${t.id===info.team&&t.translation===info.translation?' selected':''}>${escapeHtml(t.name)}${t.kind?` · ${escapeHtml(t.kind.toLowerCase())}`:''}</option>`).join('');
  const body=(много?`<label class="field-label">Серия<select id="animeEpisode">${серии.map(e=>`<option value="${escapeHtml(e.id)}"${e.id===info.episode?' selected':''}>${escapeHtml(e.number)}${e.name?`. ${escapeHtml(e.name)}`:''}</option>`).join('')}</select></label>`
      +`<div class="field-label">Что добавить<div class="seg fill" id="animeScope" role="radiogroup" aria-label="Что добавить"></div></div>`:'')
    +(info.teams.length?`<label class="field-label">Озвучка<select id="animeTeam">${озвучки}</select><small class="field-hint">Если у какой-то серии этой озвучки нет — возьмётся похожая.</small></label>`:'')
    +`<div class="field-label">Качество<div class="seg fill" id="animeQuality" role="radiogroup" aria-label="Качество"></div><small class="field-hint" id="animeSize"></small></div>`;
  const сколько=()=>{if(!много)return 1;const i=Math.max(0,номер($('#animeEpisode').value));return scope==='all'?серии.length:scope==='from'?серии.length-i:1;};
  const рисовать=()=>{
    if(много){const i=Math.max(0,номер($('#animeEpisode').value));
      $('#animeScope').innerHTML=[['one','Эту серию'],['from',`С неё до конца · ${серии.length-i}`],['all',`Все · ${серии.length}`]].map(([v,t])=>`<button type="button" role="radio" data-value="${v}" aria-checked="${v===scope}">${t}</button>`).join('');}
    $('#animeQuality').innerHTML=[[1080,'Лучшее'],[720,'720p'],[480,'480p'],[360,'360p']].map(([v,t])=>`<button type="button" role="radio" data-value="${v}" aria-checked="${v===quality}">${t}</button>`).join('');
    setText($('#animeSize'),`${РАЗМЕР_СЕРИИ[quality]} за серию. Скачиваются только ближайшие серии, остальные играют прямо с сайта.`);
    const добавить=$('#addDialogActions [data-add="add"]'); if(добавить)setText(добавить,сколько()===1?'Добавить серию':`Добавить ${штук(сколько(),['серию','серии','серий'])}`);
  };
  const ответ=await окноДобавления({title:info.title,sub:`${info.site} · ${штук(серии.length,['серия','серии','серий'])}`,cover:info.cover,body,
    кнопки:[['cancel','Отмена'],['add','Добавить','primary']],
    начать:окно=>{
      рисовать();
      окно.querySelector('#animeEpisode')?.addEventListener('change',рисовать);
      окно.querySelector('#animeScope')?.addEventListener('click',e=>{const b=e.target.closest('[data-value]');if(b){scope=b.dataset.value;рисовать();}});
      окно.querySelector('#animeQuality').addEventListener('click',e=>{const b=e.target.closest('[data-value]');if(b){quality=Number(b.dataset.value);рисовать();}});
    }});
  if(ответ!=='add')return null;
  const [team,translation]=($('#animeTeam')?.value||'|').split('|');
  return {scope:много?scope:'one',episode:много?$('#animeEpisode').value:undefined,team,translation,quality};
}

async function добавитьСсылку(url){
  const info=await api('/api/queue/inspect',{method:'POST',body:JSON.stringify({url})});
  let запрос={url};
  if(info.kind==='anime'){const выбор=await выбратьСерии(info);if(!выбор)return null;запрос.anime=выбор;}
  let result=await api('/api/queue',{method:'POST',body:JSON.stringify(запрос)});
  // Много видео разом — спрашиваем, прежде чем забить очередь.
  if(result.ask){
    const {count,title,single}=result.ask;
    const ответ=await окноДобавления({title:`Добавить ${штук(count,['видео','видео','видео'])}?`,sub:title?`Плейлист «${title}»`:'Плейлист',
      body:`<p class="confirm-text">Все ролики встанут в очередь и начнут скачиваться по порядку — сначала ближайшие.</p>`,
      кнопки:[['cancel','Отмена'],...(single?[['single','Только это видео']]:[]),['all',`Добавить все ${count}`,'primary']]});
    if(!ответ)return null;
    result=await api('/api/queue',{method:'POST',body:JSON.stringify({url,confirm:ответ})});
  }
  return result;
}

$('#addForm').addEventListener('submit',async event=>{event.preventDefault();const button=$('#addButton');button.disabled=true;button.textContent='…';try{const result=await добавитьСсылку($('#mediaUrl').value.trim());if(result){$('#mediaUrl').value='';render(result.status);toast(`Добавлено: ${result.added.length}`);}}catch(error){toast(error.message,true);}finally{button.disabled=false;button.textContent='Добавить';}});
// Перетаскивание в очереди: схватил — строка едет за курсором, соседние
// плавно расступаются; отпустил — встаёт на место и порядок уходит на сервер.
// Пока тянем, список не перерисовывается из статуса, иначе строка «выпадет».
let тяга=null;
$('#queueList').addEventListener('pointerdown',event=>{
  if(event.button!==0||тяга)return;
  const row=event.target.closest('.queue-item');
  if(!row||event.target.closest('.remove-item')||(ui.status?.queue?.length||0)<2)return;
  тяга={row,startY:event.clientY,y:event.clientY,started:false};
});
function тянуть(){
  const list=$('#queueList'), т=тяга;
  const сдвиг=т.y-т.startY+(list.scrollTop-т.scroll);
  т.to=Math.max(0,Math.min(т.rows.length-1,т.from+Math.round(сдвиг/т.step)));
  т.row.style.transform=`translateY(${сдвиг}px)`;
  т.rows.forEach((r,i)=>{if(r===т.row)return;
    const место=т.from<i&&i<=т.to?-т.step:т.to<=i&&i<т.from?т.step:0;
    r.style.transform=место?`translateY(${место}px)`:'';});
}
addEventListener('pointermove',event=>{
  if(!тяга)return;
  тяга.y=event.clientY;
  if(!тяга.started){
    if(Math.abs(тяга.y-тяга.startY)<6)return;
    const list=$('#queueList');
    тяга.started=true; ui.dragging=true;
    тяга.rows=[...list.querySelectorAll('.queue-item')]; тяга.from=тяга.to=тяга.rows.indexOf(тяга.row);
    тяга.step=тяга.row.offsetHeight+(parseFloat(getComputedStyle(list).rowGap)||0); тяга.scroll=list.scrollTop;
    list.classList.add('sorting'); тяга.row.classList.add('dragging');
    // У краёв списка прокручиваем сами — иначе длинную очередь не протащить.
    тяга.timer=setInterval(()=>{if(!тяга?.started)return;const край=list.getBoundingClientRect();
      const d=тяга.y<край.top+40?-10:тяга.y>край.bottom-40?10:0;if(d){list.scrollTop+=d;тянуть();}},16);
  }
  тянуть();
});
// Колесо мыши во время перетаскивания: список едет, а курсор стоит — строку
// пересчитываем на каждую прокрутку, иначе она стояла и потом прыгала.
$('#queueList').addEventListener('scroll',()=>{if(тяга?.started)тянуть();},{passive:true});
async function отпустить(){
  const т=тяга; тяга=null;
  if(!т?.started)return;
  clearInterval(т.timer);
  ui.тянули=true; setTimeout(()=>{ui.тянули=false;},0);
  const list=$('#queueList');
  // Сразу ставим строку на новое место в DOM, чтобы не мигнуло до ответа сервера.
  for(const r of т.rows)r.style.transform='';
  list.classList.remove('sorting'); т.row.classList.remove('dragging');
  if(т.to!==т.from){const опора=т.rows[т.to];list.insertBefore(т.row,т.to>т.from?опора.nextSibling:опора);}
  try{ if(т.to!==т.from){ui.queueSignature=null;render(await api('/api/queue/move',{method:'POST',body:JSON.stringify({id:т.row.dataset.id,to:т.to})}));} }
  catch(error){toast(error.message,true);}
  finally{ui.dragging=false;ui.queueSignature=null;if(ui.status)render(ui.status);}
}
addEventListener('pointerup',отпустить);
addEventListener('pointercancel',отпустить);
$('#queueList').addEventListener('click',async event=>{
  if(ui.тянули){event.preventDefault();return;}
  if(event.target.closest('[data-pick-local]')){ window.location.href='vrcast://pick-media'; return; }
  const row=event.target.closest('.queue-item'); if(!row)return;
  const id=row.dataset.id;
  try{
    if(event.target.closest('.remove-item')){ if(id===ui.localPreviewId)очиститьЛокальныйПредпросмотр(); ui.localNote=null; render(await api(`/api/queue/${encodeURIComponent(id)}`,{method:'DELETE'})); return; }
    if($('#playerMode').value==='unity'){ ui.unitySelectedId=id; if(ui.status)render(ui.status); toast('Трек выбран — нажмите «Подготовить».'); return; }
    // Эфир идёт — переключаемся на этот трек прямо в эфире.
    if(ui.status?.running){ await playback('jump',{id}); return; }
    // Эфира нет — открываем трек в предпросмотре, ничего не вещая. Стрим
    // начнётся только по кнопке «Начать эфир видео».
    показатьЛокальныйПредпросмотр(id);
  }catch(error){toast(error.message,true);}
});
// Enter/пробел выбирают трек сами: выбор — настоящая кнопка .queue-pick рядом
// с кнопкой удаления, а не строка-«кнопка» с вложенной кнопкой внутри.
$('#clearQueue').addEventListener('click',async()=>{const всего=ui.status?.queue?.length||0;if(всего&&!await подтвердить(`Очистить очередь — ${штук(всего,['ролик','ролика','роликов'])}?`,'Очистить','Список опустеет целиком. Сохранённые списки и скачанные файлы останутся.'))return;try{очиститьЛокальныйПредпросмотр();ui.localNote=null;render(await api('/api/queue',{method:'DELETE'}));}catch(error){toast(error.message,true);}});
const ролики=n=>штук(Number(n)||0,['ролик','ролика','роликов']);
async function сохранитьСписок(id,name){render((await api('/api/templates',{method:'POST',body:JSON.stringify({id,name})})).status);}
$('#templateSaveForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const name=$('#templateName').value.trim(), очередь=ui.status?.queue?.length||0;
  if(!name){$('#templateName').focus();return toast('Введите название списка',true);}
  // Совпало имя — это перезапись чужого содержимого, её надо подтвердить.
  const тот=ui.status?.templates?.find(item=>item.name.trim().toLowerCase()===name.toLowerCase());
  if(тот&&!await подтвердить(`Список «${тот.name}» уже есть — перезаписать?`,'Перезаписать',`Сейчас в нём ${ролики(тот.count)}. Их заменит текущая очередь — ${ролики(очередь)}.`))return;
  try{await сохранитьСписок(тот?.id||'',name);$('#templateName').value='';toast(тот?'Список перезаписан':'Список сохранён');}catch(error){toast(error.message,true);}
});
$('#templateList').addEventListener('click',async event=>{
  const button=event.target.closest('[data-t]'), row=event.target.closest('[data-template]'); if(!button||!row)return;
  const список=ui.status?.templates?.find(item=>item.id===row.dataset.template); if(!список)return;
  const очередь=ui.status?.queue?.length||0, путь=`/api/templates/${encodeURIComponent(список.id)}`;
  try{
    if(button.dataset.t==='open'){
      if(очередь&&!await подтвердить(`Открыть «${список.name}» вместо текущей очереди?`,'Открыть',`Текущая очередь (${ролики(очередь)}) будет заменена. Если она нужна — сначала сохраните её как список.`))return;
      render(await api(`${путь}/load`,{method:'POST',body:JSON.stringify({append:false})}));toast(`Открыт список «${список.name}»`);openTemplateMenu(false);
    }else if(button.dataset.t==='append'){
      render(await api(`${путь}/load`,{method:'POST',body:JSON.stringify({append:true})}));toast(`В конец очереди добавлено: ${ролики(список.count)}`);
    }else if(button.dataset.t==='update'){
      if(!очередь)return toast('Очередь пуста — перезаписывать нечем',true);
      if(!await подтвердить(`Перезаписать список «${список.name}» текущей очередью?`,'Перезаписать',`Сейчас в списке ${ролики(список.count)}. Их заменит текущая очередь — ${ролики(очередь)}. Отменить это нельзя.`))return;
      await сохранитьСписок(список.id,список.name);toast('Список перезаписан');
    }else if(button.dataset.t==='rename'){
      // Имя правится прямо в строке: Enter — сохранить, Esc — отменить.
      const место=row.querySelector('.t-title'), поле=document.createElement('input');
      поле.type='text'; поле.maxLength=80; поле.value=список.name; поле.setAttribute('aria-label','Новое название списка');
      место.replaceWith(поле); поле.focus(); поле.select();
      let готово=false;
      const закончить=async сохранить=>{
        if(готово)return; готово=true; поле.remove();
        // Строку надо перерисовать в любом случае: setHtml сравнивает с прошлой
        // разметкой, и без сброса название так и осталось бы вырезанным.
        $('#templateList')._html='';
        const имя=поле.value.trim();
        if(сохранить&&имя&&имя!==список.name){ try{ render(await api(`${путь}/rename`,{method:'POST',body:JSON.stringify({name:имя})})); toast('Список переименован'); return; }catch(error){ toast(error.message,true); } }
        if(ui.status)render(ui.status);
      };
      поле.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();закончить(true);} if(e.key==='Escape'){e.preventDefault();e.stopPropagation();закончить(false);} });
      поле.addEventListener('blur',()=>закончить(true));
    }else if(button.dataset.t==='delete'){
      if(!await подтвердить(`Удалить список «${список.name}» — ${ролики(список.count)}?`,'Удалить','Текущая очередь и скачанные ролики не изменятся.'))return;
      render(await api(путь,{method:'DELETE'}));toast('Список удалён');
    }
  }catch(error){toast(error.message,true);}
});
// Форма добавления: два ясных случая вместо одной анкеты на всё.
// «Уже настроен» — вставили адрес и ключ, который выдал сервер при установке.
// «Настроить с нуля» — пароль root, и программа сама всё поставит.
let режимДобавления='attach';

function выбратьРежим(режим){
  режимДобавления=режим;
  for(const кнопка of $$('#addMode button'))кнопка.setAttribute('aria-checked',String(кнопка.dataset.mode===режим));
  $('#attachFields').hidden=режим!=='attach';
  $('#deployFields').hidden=режим!=='deploy';
  $('#addServerSubmit').textContent=режим==='attach'?'Подключить':'Настроить сервер';
  показатьОшибку($('#addServerError'),'');
}

function открытьДобавление(открыть){
  const форма=$('#addServerForm');
  форма.hidden=!открыть;
  $('#addServerToggle').setAttribute('aria-expanded',String(открыть));
  $('#addServerToggle').hidden=открыть;
  if(открыть){ выбратьРежим('attach'); $('#serverHost').focus(); }
  else { показатьОшибку($('#addServerError'),''); $('#deployProgress').hidden=true; }
}

$('#addServerToggle').addEventListener('click',()=>открытьДобавление(true));
$('#addServerCancel').addEventListener('click',()=>открытьДобавление(false));
$('#addMode').addEventListener('click',event=>{
  const кнопка=event.target.closest('button[data-mode]');
  if(кнопка)выбратьРежим(кнопка.dataset.mode);
});

$('#addServerForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const кнопка=$('#addServerSubmit');
  const адрес=$('#serverHost').value.trim();
  const имя=$('#serverName').value.trim();
  if(!адрес)return показатьОшибку($('#addServerError'),'Укажите адрес сервера.');
  показатьОшибку($('#addServerError'),'');
  кнопка.disabled=true;
  try{
    if(режимДобавления==='attach'){
      const ключ=$('#serverKey').value.trim();
      if(!ключ)throw new Error('Нужен ключ публикации. Его показывает приложение хозяина сервера в настройках этого сервера.');
      кнопка.textContent='Проверяю…';
      const результат=await api('/api/servers/attach',{method:'POST',body:JSON.stringify({host:адрес,name:имя,key:ключ})});
      render(результат.status); открытьДобавление(false);
      $('#serverHost').value=''; $('#serverName').value=''; $('#serverKey').value='';
      toast(`Сервер подключён: ${результат.server.name}`);
    } else {
      const пароль=$('#serverPassword').value;
      if(!пароль)throw new Error('Нужен пароль root — им программа поставит себя на машину.');
      кнопка.textContent='Настраиваю…';
      ui.deploying=true; $('#deployProgress').hidden=false;
      $('#deployProgress').textContent='Подключаюсь по SSH · обычно одна-две минуты';
      const результат=await api('/api/servers',{method:'POST',body:JSON.stringify({host:адрес,password:пароль,name:имя})});
      render(результат.status); открытьДобавление(false);
      $('#serverHost').value=''; $('#serverName').value=''; $('#serverPassword').value='';
      toast(`Сервер готов: ${результат.server.name}`);
    }
  }catch(error){ показатьОшибку($('#addServerError'),error.message); }
  finally{ ui.deploying=false; $('#deployProgress').hidden=true; кнопка.disabled=false;
    кнопка.textContent=режимДобавления==='attach'?'Подключить':'Настроить сервер'; }
});
// В WebView2 navigator.clipboard отказывает, когда окно не в фокусе, поэтому
// нужен запасной путь через скрытое поле — иначе кнопка молча ничего не делает.
async function copyText(value){
  try{ await navigator.clipboard.writeText(value); return true; }catch{}
  const field=document.createElement('textarea');
  field.value=value; field.setAttribute('readonly','');
  field.style.cssText='position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(field); field.select(); field.setSelectionRange(0,value.length);
  let ok=false;
  try{ ok=document.execCommand('copy'); }catch{}
  field.remove();
  return ok;
}
$('#copyUrl').addEventListener('click',async()=>{const value=$('#playbackUrl').textContent;if(!/^(https?|rtspt?):\/\//.test(value))return toast('Ссылка ещё создаётся',true);const ok=await copyText(value);toast(ok?'Ссылка скопирована':'Не удалось скопировать',!ok);});
$('#playerMode').addEventListener('change',()=>{if(ui.status)render(ui.status);});
$('#prepareUnityQueue').addEventListener('click',async()=>{const button=$('#prepareUnityQueue');button.disabled=true;try{render(await api('/api/unity/queue/build',{method:'POST',body:JSON.stringify({id:ui.unitySelectedId})}));toast('Подготовка выбранного трека началась');}catch(error){toast(error.message,true);}finally{if(ui.status?.compatibility?.unity?.queue?.state!=='building')button.disabled=false;}});
$('#recordUnityCapture').addEventListener('click',async()=>{const recording=ui.status?.compatibility?.unity?.capture?.state==='recording';try{render(await api(recording?'/api/unity/capture/stop':'/api/unity/capture/start',{method:'POST'}));toast(recording?'Завершаю MP4…':'Запись Unity-клипа началась');}catch(error){toast(error.message,true);}});

async function playback(action,extra={}){try{render(await api('/api/playback',{method:'POST',body:JSON.stringify({action,...extra})}));return true;}catch(error){toast(error.message,true);return false;}}
$('#togglePause').addEventListener('click',()=>{
  if(!ui.status?.running){ переключитьЛокальнуюПаузу(); return; }
  return ui.status?.playback?.paused?playback('resume'):playback('pause',{position:ui.seekPending?ui.seekDraft:progressPosition(ui.status)});
});
$('#previousTrack').addEventListener('click',()=>playback('previous')); $('#nextTrack').addEventListener('click',()=>playback('next'));
$('#cacheRoot').addEventListener('change',async()=>{
  try{ render(await api('/api/config',{method:'POST',body:JSON.stringify({...configPayload(),cacheRoot:$('#cacheRoot').value})}));
    toast('Кеш переехал, треки перекачаются на новое место'); }
  catch(error){ toast(error.message,true); }
});
$('#previewToggle').addEventListener('click',()=>{
  ui.previewOn=!ui.previewOn;
  положить('previewOn',ui.previewOn?'1':'0');
  paintPreviewToggle();
  // Явное выключение закрывает и локальный трек целиком, а не только паузой.
  if (!ui.previewOn) { stopPreview(); if (ui.localPreviewId) очиститьЛокальныйПредпросмотр(); }
  else ui.localNote=null;
  if (ui.status) render(ui.status);
  if (ui.previewOn && ui.source==='screen' && !ui.status?.running) refreshCapturePreview(false).catch(()=>{});
  toast(ui.previewOn?'Предпросмотр включён':'Предпросмотр выключен — процессор свободнее');
});
// Свёрнутое окно программы не должно ничего декодировать, анимировать и
// часто опрашивать сервер. WebView2 при сворачивании не всегда скрывает
// страницу для браузера, поэтому оболочка шлёт свои vrcast-hidden/-shown.
function setWindowHidden(hidden) {
  if (ui.windowHidden===hidden) return;
  ui.windowHidden=hidden;
  document.documentElement.classList.toggle('window-hidden',hidden);
  if (hidden) stopPreview();
  else if (ui.status) { render(ui.status); if (ui.source==='screen'&&!ui.status.running) refreshCapturePreview(false).catch(()=>{}); }
  scheduleCaptureFrames();
  // Вернулись — сразу свежее состояние, а не через пять секунд.
  schedulePoll(hidden?undefined:0);
}
document.addEventListener('visibilitychange',()=>setWindowHidden(document.hidden));
function setWindowBlurred(blurred){
  if(ui.windowBlurred===blurred)return;
  ui.windowBlurred=blurred;
  if(blurred)stopPreview(); else if(ui.status)render(ui.status);
}
document.addEventListener('vrcast-blur',()=>setWindowBlurred(true));
document.addEventListener('vrcast-focus',()=>setWindowBlurred(false));
document.addEventListener('vrcast-hidden',()=>setWindowHidden(true));
document.addEventListener('vrcast-shown',()=>setWindowHidden(document.hidden));
$('#clearCache').addEventListener('click',async()=>{
  const мб=Number(ui.status?.cache?.sizeMb)||0;
  if(!await подтвердить(`Удалить скачанное — ${мб>=1024?`${(мб/1024).toFixed(1)} ГБ`:`${мб} МБ`}?`,'Удалить','Видео скачаются заново, когда понадобятся. Играющий трек не тронем.'))return;
  try{ render(await api('/api/cache/clear',{method:'POST'})); toast('Скачанное удалено — играющий трек не тронут'); }
  catch(error){ toast(error.message,true); }
});
const локальноеВидео=()=>Boolean(ui.localPreviewId&&!ui.status?.running);
for(const событие of ['timeupdate','loadedmetadata','seeked'])$('#streamPreview').addEventListener(событие,()=>{ if(локальноеВидео())renderProgress(); });
$('#seekBar').addEventListener('input',event=>{ui.seeking=true;event.target._step=undefined;const percent=Number(event.target.value)/10;event.target.style.setProperty('--seek',`${percent}%`);const total=локальноеВидео()?(Number($('#streamPreview').duration)||0):Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*percent/100;setText($('#elapsedTime'),formatTime(ui.seekDraft));});
$('#seekBar').addEventListener('change',async event=>{
  if(локальноеВидео()){ const video=$('#streamPreview'); if(Number.isFinite(video.duration))video.currentTime=video.duration*Number(event.target.value)/1000; ui.seeking=false; renderProgress(); return; }
  const total=Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*Number(event.target.value)/1000;ui.seeking=false;ui.seekPending=true;ui.seekRevision=Number(ui.status?.playback?.revision||0)+1;if(!await playback('seek',{position:ui.seekDraft})){ui.seekPending=false;renderProgress();}});
function applyQualityLive(kind,что='Качество'){ui.configEditUntil=Date.now()+2500;clearTimeout(ui.liveApplyTimer);ui.liveApplyTimer=setTimeout(async()=>{try{const live=ui.status?.activeKind===kind;render(await saveConfig(live));
  // «Качество» — среднего рода: раньше выходило «Качество применёно».
  const о=что==='Качество';toast(live?`${что} ${о?'применено':'применён'}`:`${что} ${о?'сохранено':'сохранён'}`);}catch(error){ui.configEditUntil=0;toast(error.message,true);if(ui.status)syncConfigControls(ui.status);}},350);}
$('#quality').addEventListener('change',()=>applyQualityLive('screen'));$('#fps').addEventListener('change',()=>applyQualityLive('screen'));
// Битрейт применяется к тому, что идёт прямо сейчас: раньше выбор просто лежал
// в настройках до следующего запуска, и казалось, что регулятор ничего не делает.
$('#videoBitrate').addEventListener('change',()=>applyQualityLive(ui.status?.activeKind||'screen','Битрейт'));
$('#encoderMode').addEventListener('change',()=>applyQualityLive(ui.status?.activeKind||'screen','Кодировщик'));
$('#tunnelProviderSelect').addEventListener('change',async()=>{ui.configEditUntil=Date.now()+2500;try{render(await saveConfig(false));toast(ui.output==='tunnel'?'Быстрая ссылка переподключается':'Сохранено');}catch(error){ui.configEditUntil=0;toast(error.message,true);}});
$('#mediaQuality').addEventListener('change',()=>applyQualityLive('queue'));$('#mediaFps').addEventListener('change',()=>applyQualityLive('queue'));
// Не получилось — кнопка возвращается к тому, что на самом деле стоит на
// сервере. Раньше она оставалась на новом значении, которого не было.
// Скорость и повтор — выпадающий список над кнопкой: видно все варианты сразу
// и выбирается нужный, а не перебирается по кругу.
function открытьВыбор(кнопка,варианты,текущее,выбрать){
  закрытьВыбор();
  const меню=document.createElement('div');
  меню.className='menu pick-menu'; меню.setAttribute('role','menu');
  меню.innerHTML=варианты.map(([значение,подпись,значок])=>`<button type="button" role="menuitemradio" aria-checked="${String(значение)===String(текущее)}" data-value="${escapeHtml(String(значение))}">${значок?icon(значок):''}<span>${escapeHtml(подпись)}</span>${icon('check')}</button>`).join('');
  document.body.append(меню);
  const место=кнопка.getBoundingClientRect(), размер=меню.getBoundingClientRect();
  меню.style.left=`${Math.max(8,Math.min(innerWidth-размер.width-8,место.left+место.width/2-размер.width/2))}px`;
  меню.style.top=`${Math.max(8,место.top-размер.height-8)}px`;
  кнопка.setAttribute('aria-expanded','true');
  меню.addEventListener('click',event=>{const пункт=event.target.closest('button[data-value]');if(!пункт)return;закрытьВыбор();выбрать(пункт.dataset.value);});
  ui.выбор={меню,кнопка};
  (меню.querySelector('[aria-checked="true"]')||меню.querySelector('button')).focus();
}
function закрытьВыбор(){if(!ui.выбор)return;ui.выбор.меню.remove();ui.выбор.кнопка.setAttribute('aria-expanded','false');ui.выбор=null;}
document.addEventListener('pointerdown',event=>{if(ui.выбор&&!event.composedPath().some(el=>el===ui.выбор.меню||el===ui.выбор.кнопка))закрытьВыбор();},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&ui.выбор){const кнопка=ui.выбор.кнопка;закрытьВыбор();кнопка.focus();}});
addEventListener('resize',закрытьВыбор);
$('#speedSelect').addEventListener('click',()=>{if(ui.выбор?.кнопка===$('#speedSelect'))return закрытьВыбор();
  открытьВыбор($('#speedSelect'),SPEED_STEPS.map(value=>[value,value===1?'1× — обычная':`${String(value).replace('.',',')}×`]),$('#speedSelect').dataset.value,async value=>{
    const next=Number(value);paintSpeed(next);ui.speedPendingUntil=Date.now()+1500;const ok=await playback('speed',{speed:next});ui.speedPendingUntil=0;paintSpeed(ok?next:(ui.status?.playback?.speed||1));});});
$('#loopSelect').addEventListener('click',()=>{if(ui.выбор?.кнопка===$('#loopSelect'))return закрытьВыбор();
  открытьВыбор($('#loopSelect'),LOOP_STEPS.map(([value,значок,подпись])=>[value,подпись,value==='once'?'repeat-off':значок]),$('#loopSelect').dataset.value||'once',async next=>{
    paintLoop(next);ui.loopPendingUntil=Date.now()+1500;const ok=await playback('loop',{mode:next});ui.loopPendingUntil=0;paintLoop(ok?next:(ui.status?.playback?.loopMode||'once'));});});
// Сегменты: один клик — одно изменение, без второго выпадающего списка
// поверх первого. Значение продолжает жить в скрытом select, поэтому весь
// остальной код (сохранение настроек, восстановление при запуске) не менялся.
function paintSegments(select) {
  const box=document.querySelector(`.seg[data-for="${select.id}"]`);
  if(!box)return;
  for(const button of box.children){const on=String(button.dataset.value===select.value);if(button.getAttribute('aria-checked')!==on)button.setAttribute('aria-checked',on);}
  // Пояснение выбранного варианта — одной строкой под рядом, а не у каждого.
  if(select.id==='videoBitrate')setText($('#bitrateHint'),select.selectedOptions[0]?.dataset.hint||'');
}

function buildSegments() {
  for(const box of $$('.seg[data-for]')){
    const select=document.getElementById(box.dataset.for);
    if(!select)continue;
    box.innerHTML=[...select.options].map(option=>
      `<button type="button" role="radio" aria-checked="false" data-value="${escapeHtml(option.value)}"${option.dataset.hint?` title="${escapeHtml(option.dataset.hint)}"`:''}>${escapeHtml(option.dataset.short||option.textContent)}</button>`).join('');
    box.addEventListener('click',event=>{
      const button=event.target.closest('button[data-value]');
      if(!button||button.dataset.value===select.value)return;
      select.value=button.dataset.value;
      paintSegments(select);
      select.dispatchEvent(new Event('change'));
    });
    box.addEventListener('keydown',event=>{
      const шаг={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[event.key];
      if(!шаг)return;
      event.preventDefault();
      const кнопки=[...box.children];
      const следующая=кнопки[(кнопки.indexOf(document.activeElement)+шаг+кнопки.length)%кнопки.length];
      следующая.focus(); следующая.click();
    });
    paintSegments(select);
  }
}

function paintVolume(input, output) { const value=Number(input.value); output.value=`${value}%`; input.style.setProperty('--volume',`${value/input.max*100}%`); }
// В эфире громкость меняется прямо во время перетаскивания, а не когда
// отпустили ползунок. Шлём не чаще раза в 150 мс и только саму громкость.
function живаяГромкость(отправить){
  let таймер=null, последнее=0;
  return value=>{ clearTimeout(таймер); const ждать=Math.max(0,150-(Date.now()-последнее));
    таймер=setTimeout(()=>{ последнее=Date.now(); отправить(value).catch(()=>{}); },ждать); };
}
const громкостьРолика=живаяГромкость(value=>api('/api/playback',{method:'POST',body:JSON.stringify({action:'volume',volume:value})}));
const громкостьЗахвата=живаяГромкость(value=>api('/api/config',{method:'POST',body:JSON.stringify({captureVolume:value,applyLive:true})}));
$('#mediaVolume').addEventListener('input',event=>{paintVolume(event.target,$('#mediaVolumeValue'));if(ui.status?.activeKind==='queue'&&!ui.status?.playback?.paused)громкостьРолика(Number(event.target.value)/100);});
$('#mediaVolume').addEventListener('change',async event=>{if(ui.status?.activeKind==='queue')playback('volume',{volume:Number(event.target.value)/100});else try{render(await saveConfig());}catch(error){toast(error.message,true);}});
$('#captureVolume').addEventListener('input',event=>{paintVolume(event.target,$('#captureVolumeValue'));if(ui.status?.activeKind==='screen')громкостьЗахвата(Number(event.target.value)/100);});
// Громкость экрана раньше только рисовалась: в настройки она попадала лишь при
// следующем пуске, а в идущем эфире не менялась вовсе.
$('#captureVolume').addEventListener('change',async()=>{
  try{ const live=ui.status?.activeKind==='screen'; render(await saveConfig(live)); toast(live?'Громкость эфира изменена':'Громкость сохранена'); }
  catch(error){ toast(error.message,true); }
});

async function начатьЭфир(){const button=$('#goLive'),карточка=$('#applyCapture');if(ui.status&&!ui.status.running&&ссылкаНеГотова(ui.status))return toast(ui.status?.delivery?.error||'Ссылка ещё готовится. Дождитесь статуса «Готово».',true);button.disabled=true;карточка.disabled=true;try{await saveConfig();const тело=ui.source==='queue'&&ui.localPreviewId?JSON.stringify({id:ui.localPreviewId}):undefined;
  $('#monitor').classList.remove('source-preview','window-paused');
  if(ui.source==='queue')очиститьЛокальныйПредпросмотр();
  render(await api(`/api/start/${ui.source}`,{method:'POST',body:тело}));ui.localPreviewId='';ui.localNote=null;ui.captureDirty=false;toast(ui.output==='tunnel'?'Запускаю эфир и получаю публичную ссылку':'Эфир запускается');}catch(error){toast(error.message,true);}finally{button.disabled=false;карточка.disabled=false;if(ui.status)render(ui.status);}}
$('#goLive').addEventListener('click',начатьЭфир);
$('#stopLive').addEventListener('click',async()=>{try{render(await api('/api/stop',{method:'POST'}));}catch(error){toast(error.message,true);}});
$('#updateButton').addEventListener('click',()=>{const update=ui.status?.update;if(!update?.available)return;ui.offeredVersion=update.version;paintUpdateDialog(update);if(!updateDialog.open||updateDialog.classList.contains('closing'))updateDialog.showModal();});
function открытьЖурнал(){закрытьНастройки(true);paintLogs();$('#logDialog').showModal();const журнал=$('#logs');журнал.scrollTop=журнал.scrollHeight;schedulePoll(0);}
$('#showLogs').addEventListener('click',открытьЖурнал); $('#showLogsBar').addEventListener('click',открытьЖурнал);
$('#untrustedHelp').addEventListener('click',()=>открытьНастройки('setHelp'));
// «Проверить» спрашивает GitHub сейчас, а не ждёт плановой проверки.
$('#checkUpdate').addEventListener('click',async()=>{
  const кнопка=$('#checkUpdate'); кнопка.disabled=true; setText($('#updateNote'),'Проверяю…');
  try{
    const state=await api('/api/update/check',{method:'POST'}); render(state);
    if(state.update?.available){ закрытьНастройки(true); ui.offeredVersion=state.update.version; paintUpdateDialog(state.update); updateDialog.showModal(); }
    else toast(state.update?.error?`Не удалось проверить: ${state.update.error}`:'Установлена последняя версия',Boolean(state.update?.error));
  }catch(error){ toast(error.message,true); }
  finally{ кнопка.disabled=false; }
});
$('#openLogFolder').addEventListener('click',()=>{window.location.href='vrcast://open-folder';});
$('#closeLogs').addEventListener('click',()=>$('#logDialog').close());

// Опрос состояния подстраивается под то, что происходит. Раньше запрос шёл
// каждые 800 мс круглосуточно, а часы перемотки перерисовывались пять раз
// в секунду даже без эфира и на свёрнутом окне.
function pollDelay() {
  const s=ui.status;
  if (ui.windowHidden) return 5000;
  if (!s) return 1000;
  const занят=s.running||$('#logDialog').open||ui.deploying||ui.seekPending
    ||s.playback?.busy||s.playback?.buffering||s.update?.installing||(s.cache?.downloading||[]).length
    ||Object.values(s.toolDownloads||{}).some(item=>item.state==='work')
    ||['building','recording','finalizing'].includes(s.compatibility?.unity?.queue?.state)
    ||['building','recording','finalizing'].includes(s.compatibility?.unity?.capture?.state)
    ||(s.config?.outputMode==='tunnel'&&!(s.tunnel?.serves===true||s.tunnel?.serves===false))
    ||(s.config?.outputMode==='remote'&&s.rtsp?.remote?.reachable==null)
    ||s.stream?.state==='starting';
  return занят?1000:2500;
}
async function refresh(){
  try{
    const response=await fetch($('#logDialog').open?'/api/status':'/api/status?logs=0',{cache:'no-store'});
    if(!response.ok)throw new Error(`Ошибка ${response.status}`);
    const text=await response.text();
    ui.offline=false;
    // Связь вернулась — перерисовать обязательно, даже если состояние то же:
    // на индикаторе ещё висит «Нет связи».
    if(ui.pollFails>=2)ui.lastPollText='';
    ui.pollFails=0;
    // Ничего не поменялось — и рисовать нечего. На простое это почти каждый опрос.
    if(text===ui.lastPollText&&ui.status)return;
    const state=JSON.parse(text);
    // Ошибка отрисовки — не обрыв связи: раньше она попадала в тот же catch,
    // и при живом сервере висело «Нет связи».
    try{ render(state); }catch(error){ console.error(error); }
    ui.lastPollText=text;
  }catch{
    // Одно сообщение на обрыв, а не тост на каждый опрос.
    if(ui.status&&!ui.offline){ui.offline=true;toast('Нет связи с программой — она перезапускается. Подождите пару секунд.',true);}
    // Второй провал подряд — уже не мигание: индикатор честно пишет «Нет связи»
    // и держит это, пока опрос снова не ответит.
    ui.pollFails=(ui.pollFails||0)+1;
    if(ui.pollFails===2&&ui.status)render(ui.status);
  }
}
function schedulePoll(delay=pollDelay()) {
  clearTimeout(ui.pollTimer);
  ui.pollTimer=setTimeout(async()=>{ await refresh(); schedulePoll(); },delay);
}
// Часы и полоса перемотки идут сами между опросами, но только пока видео
// действительно играет и окно видно.
function schedulePlaybackClock() {
  const s=ui.status;
  const нужно=Boolean(s?.running&&s.activeKind==='queue'&&!s.playback?.paused&&s.progress&&!ui.windowHidden);
  if(нужно&&!ui.clockTimer)ui.clockTimer=setInterval(renderProgress,250);
  else if(!нужно&&ui.clockTimer){clearInterval(ui.clockTimer);ui.clockTimer=null;}
}
// Пока открыта вкладка «Экран», окно видно и эфир не идёт, сервер держит живой
// поток картинки источника. Следующий кадр просим, только когда пришёл
// предыдущий: раньше запрос уходил каждые 66 мс, сколько бы ни висело старых.
// Раз в две секунды просим сервер поддержать поток — иначе он гаснет сам.
function captureFramesWanted() {
  return ui.source==='screen'&&previewAllowed()&&!ui.status?.running&&$('#monitor').classList.contains('source-preview');
}
function scheduleCaptureFrames() {
  const нужно=captureFramesWanted();
  if(нужно&&!ui.keepAliveTimer)ui.keepAliveTimer=setInterval(()=>{ if(captureFramesWanted())refreshCapturePreview(false).catch(()=>{}); else scheduleCaptureFrames(); },2000);
  else if(!нужно&&ui.keepAliveTimer){clearInterval(ui.keepAliveTimer);ui.keepAliveTimer=null;}
}
$('#capturePreview').addEventListener('load',()=>{
  if(!captureFramesWanted())return;
  clearTimeout(ui.frameTimer);
  ui.frameTimer=setTimeout(()=>{ if(captureFramesWanted())$('#capturePreview').src=`/api/capture-preview?time=${Date.now()}`; },66);
});
$('#capturePreview').addEventListener('error',()=>{
  // Кадр ещё не готов — пробуем реже, а не долбим сервер 15 раз в секунду.
  if(!captureFramesWanted())return;
  clearTimeout(ui.frameTimer);
  ui.frameTimer=setTimeout(()=>{ if(captureFramesWanted())$('#capturePreview').src=`/api/capture-preview?time=${Date.now()}`; },1000);
});

async function init(){const state=await api('/api/status');ui.output=state.config.outputMode;chooseOutput(ui.output);$('#quality').value=state.config.quality;$('#fps').value=String(state.config.fps);$('#mediaQuality').value=state.config.mediaQuality||'720p';$('#mediaFps').value=String(state.config.mediaFps||30);$('#videoBitrate').value=String(state.config.videoBitrate??0);$('#encoderMode').value=state.config.encoderMode||'auto';$('#tunnelProviderSelect').value=state.config.tunnelProvider||'auto';$('#closeAction').value=state.config.closeToTray===false?'exit':'tray';paintCloseNote();$('#captureMode').value=state.config.captureMode;$('#regionX').value=state.config.regionX;$('#regionY').value=state.config.regionY;$('#regionWidth').value=state.config.regionWidth;$('#regionHeight').value=state.config.regionHeight;$('#audioMode').value=state.config.audioMode;$('#localAppVolume').value=String(state.config.localAppVolume??1);$('#muteLocalApp').checked=Boolean(state.config.muteLocalApp);paintLoop(state.config.loopMode||'once');paintSpeed(state.config.playbackSpeed||1);$('#mediaVolume').value=String(Math.round((state.config.mediaVolume??1)*100));$('#captureVolume').value=String(Math.round((state.config.captureVolume??1.5)*100));paintVolume($('#mediaVolume'),$('#mediaVolumeValue'));paintVolume($('#captureVolume'),$('#captureVolumeValue'));chooseCaptureMode(state.config.captureMode,false);chooseAudioMode(state.config.audioMode);открытьДобавление(!state.config.servers?.length);paintPreviewToggle();buildSegments();
  ui.windowHidden=document.hidden; document.documentElement.classList.toggle('window-hidden',document.hidden);
  render(state);
  // Опрос запускаем до списка источников: тот идёт через PowerShell и может
  // упасть — раньше тогда интерфейс так и оставался без обновлений.
  schedulePoll();
  await loadCaptureSources().catch(error=>toast(error.message,true));
const stall={time:0,strikes:0};
setInterval(()=>{if(!ui.hls)return;const video=$('#streamPreview');
  if(!ui.status?.running||ui.status?.stream?.state!=='ready'){stall.strikes=0;stall.time=video.currentTime;return;}
  if(video.currentTime===stall.time){if(++stall.strikes>=3){stall.strikes=0;ui.hls.destroy();ui.hls=null;ui.previewUrl='';startPreview(ui.status);}}
  else stall.strikes=0;
  stall.time=video.currentTime;},3000);}
init().catch(error=>toast(error.message,true));


// Предпросмотр по умолчанию беззвучный: звук уже идёт в наушниках напрямую,
// а вторая копия с задержкой сбивает. Одна кнопка — вкл/выкл, выбор помнится.
const preview=$('#streamPreview');
function paintPreviewSound(){
  const звук=взять('previewSound')==='1';
  preview.muted=!звук; preview.volume=звук?0.8:0;
  setHtml($('#previewMute'),icon(звук?'sound':'mute'));
  setTitle($('#previewMute'),звук?'Выключить звук предпросмотра (картинка снова без задержки)':'Включить звук предпросмотра (картинка отстанет на пару секунд)');
}
$('#previewMute').addEventListener('click',()=>{
  положить('previewSound',взять('previewSound')==='1'?'0':'1'); paintPreviewSound();
  // Звук есть только в HLS-предпросмотре — пересобираем показ под выбор.
  if(ui.status?.running){ ui.previewUrl=''; startPreview(ui.status); }
});
paintPreviewSound();

// ── Живой фон и подсветка плеера ────────────────────────────────────────────
// Всё по минимуму для видеокарты: пятна фона анимирует CSS (translate/scale),
// сюда приходит только «энергия» музыки раз в кадр и кадр 32×18 для подсветки
// десять раз в секунду. Окно свёрнуто или фон выключен — ничего не считается.
const фон=$('#ambient'), подсветка=$('#playerGlow'), кистьПодсветки=подсветка.getContext('2d',{willReadFrequently:false});
const фонВключён=()=>взять('ambient')!=='0';
function paintAmbient(){
  const вкл=фонВключён();
  фон.classList.toggle('off',!вкл);
  $('#ambientToggle').checked=вкл;
  if(!вкл){ подсветка.classList.remove('on'); фон.style.setProperty('--energy','0'); }
}
$('#ambientToggle').addEventListener('change',event=>{ положить('ambient',event.target.checked?'1':'0'); paintAmbient(); });
paintAmbient();

// Подсветка стоит точно за плеером и чуть шире него.
function поставитьПодсветку(){
  const m=$('#monitor'), запас=Math.round(m.offsetWidth*0.05);
  Object.assign(подсветка.style,{left:`${m.offsetLeft-запас}px`,top:`${m.offsetTop-запас}px`,width:`${m.offsetWidth+запас*2}px`,height:`${m.offsetHeight+запас*2}px`});
}
new ResizeObserver(поставитьПодсветку).observe($('#monitor'));
поставитьПодсветку();

setInterval(()=>{
  if(!фонВключён()||document.hidden){ подсветка.classList.remove('on'); return; }
  const картинка=$('#capturePreview');
  const источник=preview.checkVisibility?.()&&preview.readyState>=2&&preview.videoWidth?preview
    :картинка.checkVisibility?.()&&картинка.complete&&картинка.naturalWidth?картинка:null;
  if(!источник){ подсветка.classList.remove('on'); return; }
  try{ кистьПодсветки.drawImage(источник,0,0,подсветка.width,подсветка.height); подсветка.classList.add('on'); }
  catch{ подсветка.classList.remove('on'); }
},100);

// Энергия музыки приходит с сервера: он сам слушает звук эфира (в WebRTC-
// предпросмотре звука нет — AAC туда не проходит). Подписка есть, только пока
// фон включён и окно на экране; значение — басы, 0…1, ~20 раз в секунду.
let энергия=0, цельЭнергии=0, показано=-1, прошлыйКадр=0, поток=null;
function подпискаЭнергии(){
  const нужна=фонВключён()&&!document.hidden&&Boolean(ui.status?.running);
  if(нужна&&!поток){ поток=new EventSource('/api/energy'); поток.onmessage=e=>{ цельЭнергии=Number(e.data)||0; }; }
  else if(!нужна&&поток){ поток.close(); поток=null; цельЭнергии=0; }
}
setInterval(подпискаЭнергии,1000);
function тикФона(время){
  requestAnimationFrame(тикФона);
  if(время-прошлыйКадр<33||document.hidden)return; // ~30 раз в секунду хватает глазу
  прошлыйКадр=время;
  // Быстро вспыхивает, плавно гаснет — как индикатор на пульте.
  энергия=цельЭнергии>энергия?энергия+(цельЭнергии-энергия)*0.6:энергия*0.9;
  const округл=Math.round(энергия*50)/50;
  if(округл!==показано){ показано=округл; фон.style.setProperty('--energy',String(округл)); }
}
requestAnimationFrame(тикФона);
document.addEventListener('visibilitychange',()=>{ фон.classList.toggle('still',document.hidden); подпискаЭнергии(); });

// Меню настроек — как у видеосервисов: одна шестерёнка в углу кадра.
const playerMenu=$('#playerMenu');
function togglePlayerMenu(open){
  const было=!playerMenu.hidden;
  playerMenu.hidden=open===undefined?было:!open;
  const открыто=!playerMenu.hidden;
  $('#monitor').classList.toggle('menu-open',открыто);
  $('#playerSettings').classList.toggle('on',открыто);
  $('#playerSettings').setAttribute('aria-expanded',String(открыто));
  // Закрыли — фокус возвращается на шестерёнку, а не повисает в пустоте.
  if(было&&!открыто&&playerMenu.contains(document.activeElement))$('#playerSettings').focus();
}
$('#playerSettings').addEventListener('click',()=>togglePlayerMenu());

// Меню «кто откроет ссылку» и «Мои списки» — такие же всплывающие окна.
function openAudienceMenu(open){
  const меню=$('#audienceMenu'), было=!меню.hidden;
  меню.hidden=open===undefined?было:!open;
  $('#audienceButton').setAttribute('aria-expanded',String(!меню.hidden));
  if(было&&меню.hidden&&меню.contains(document.activeElement))$('#audienceButton').focus();
}
function openTemplateMenu(open){
  const меню=$('#templateMenu'), было=!меню.hidden;
  меню.hidden=open===undefined?было:!open;
  $('#templatesButton').setAttribute('aria-expanded',String(!меню.hidden));
  if(было&&меню.hidden&&меню.contains(document.activeElement))$('#templatesButton').focus();
}
$('#audienceButton').addEventListener('click',()=>openAudienceMenu());
$('#templatesButton').addEventListener('click',()=>openTemplateMenu());
$('#saveTemplateQuick').addEventListener('click',async()=>{
  const текущий=ui.status?.currentTemplate;
  // Список открыт — сохраняем в него (прежний вариант уходит в резервную копию).
  if(текущий){ try{ render(await api('/api/templates/current/save',{method:'POST'})); toast(`Сохранено в «${текущий.name}»`); }catch(error){ toast(error.message,true); } return; }
  openTemplateMenu(true);
  $('#templateName').value=''; $('#templateName').focus();
});
$('#manageServers').addEventListener('click',()=>{ openAudienceMenu(false); открытьНастройки('setNet'); });
// Путь события берём на момент клика: кнопка внутри меню могла уже исчезнуть
// (карандаш превращается в поле ввода), и closest() по оторванному элементу
// решал, что клик был снаружи, — меню закрывалось посреди переименования.
document.addEventListener('click',event=>{
  const внутри=ids=>event.composedPath().some(node=>ids.includes(node.id));
  if(!внутри(['playerMenu','playerSettings']))togglePlayerMenu(false);
  if(!внутри(['audienceMenu','audienceButton']))openAudienceMenu(false);
  if(!внутри(['templateMenu','templatesButton']))openTemplateMenu(false);
});
document.addEventListener('keydown',event=>{ if(event.key==='Escape'){ togglePlayerMenu(false); openAudienceMenu(false); openTemplateMenu(false); } });

$('#copyLogs').addEventListener('click',async()=>{
  const text=$('#logs').textContent||'';
  const ok=await copyText(text);
  toast(ok?'Журнал скопирован':'Не удалось скопировать',!ok);
});


// Обновление: окно появляется само, когда на GitHub вышла версия новее.
// «Позже» откладывает на сутки, «Пропустить» — до следующей версии.
const updateDialog=$('#updateDialog');
function updateBlocked(version){
  if(взять('skipVersion')===version)return true;
  const снова=Number(взять('updateSnooze')||0);
  return Date.now()<снова;
}

function paintUpdateDialog(update){
  setText($('#updateVersion'),update.version||'');
  setText($('#updateNotes'),(update.notes||'').replace(/^#{1,6}\s*/gm,'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/`/g,'').trim()||'Исправления и улучшения.');
  // Качаем и ставим по кнопке. Загрузка не начинается сама — только после
  // нажатия «Обновить»; дальше видно проценты, потом установка и перезапуск.
  const процент=Number(update.percent)||0;
  const качается=update.installing&&!update.ready;
  const ставится=update.installing&&update.ready;
  // «Готова к установке» писалось и тогда, когда файл ещё даже не скачан.
  const строка=update.error?`Не удалось: ${update.error}`
    :ставится?'Устанавливаю, программа перезапустится…'
    :качается?(update.totalMb?`Скачиваю ${update.version} — ${update.doneMb||0} из ${update.totalMb} МБ`:'Начинаю загрузку…')
    :update.ready?`Версия ${update.version} скачана и готова к установке.`
    :`Вышла версия ${update.version}. «Обновить» — скачаю и установлю, программа перезапустится.`;
  setText($('#updateProgress'),строка);
  setHidden($('#updateBar'),!качается);
  const ширина=`${качается?процент:0}%`, полоса=$('#updateBar').firstElementChild;
  if(полоса.style.width!==ширина)полоса.style.width=ширина;
  setDisabled($('#updateNow'),Boolean(update.installing));
  setText($('#updateNow'),update.error?'Повторить':ставится?'Устанавливаю…':качается?`Скачиваю ${процент}%`:'Обновить');
}
function offerUpdate(update){
  if(!update?.available||!update.version)return;
  // Закрытое окно не перерисовываем на каждом опросе — его никто не видит.
  if(updateDialog.open)paintUpdateDialog(update);
  // Закрыли Escape'ом — до следующего запуска не навязываемся. Раньше окно
  // через секунду выскакивало снова, и закрыть его можно было только «Позже».
  if(updateDialog.open||updateBlocked(update.version)||ui.updateDismissed===update.version)return;
  ui.offeredVersion=update.version;
  paintUpdateDialog(update);
  updateDialog.showModal();
}
updateDialog.addEventListener('close',()=>{ if(!ui.status?.update?.installing)ui.updateDismissed=ui.offeredVersion; });
$('#updateLater').addEventListener('click',()=>{
  положить('updateSnooze',String(Date.now()+24*60*60*1000));
  updateDialog.close(); toast('Напомню завтра');
});
$('#updateSkip').addEventListener('click',()=>{
  if(ui.offeredVersion)положить('skipVersion',ui.offeredVersion);
  updateDialog.close(); toast('Эта версия пропущена');
});
$('#updateNow').addEventListener('click',async()=>{
  $('#updateNow').disabled=true;
  // Запускаем скачивание+установку. Сервер отвечает сразу (202), прогресс
  // приходит в статусе и рисуется в этом же окне; когда файл готов — сервер
  // подменяет exe и перезапускается, поэтому под конец связь оборвётся, и это
  // норма, а не сбой.
  try{ const state=await api('/api/update/apply',{method:'POST'}); render(state); paintUpdateDialog(state.update||{}); schedulePoll(0); }
  catch(error){ if(!/fetch|network|Failed|Нет связи/i.test(String(error.message)))toast(error.message,true); $('#updateNow').disabled=false; }
});

// WHEP: браузер отправляет предложение, медиасервер отвечает — и картинка идёт
// напрямую, без нарезки на куски. Не получилось — откатываемся на HLS.
async function startWebrtcPreview(url, video, monitor, key){
  let rtc=null;
  try{
    ui.rtc?.close();
    rtc=new RTCPeerConnection({iceServers:[]});
    ui.rtc=rtc;
    rtc.addTransceiver('video',{direction:'recvonly'});
    rtc.addTransceiver('audio',{direction:'recvonly'});
    const поток=new MediaStream();
    rtc.ontrack=event=>{ поток.addTrack(event.track); video.srcObject=поток; monitor.classList.add('previewing'); video.play().catch(()=>{}); };
    rtc.onconnectionstatechange=()=>{
      // Только 'failed' — это конец. 'disconnected' WebRTC часто чинит сам за
      // пару секунд; если рвать и пересобирать предпросмотр на каждом таком
      // мигании, картинка как раз и дёргается. Не починится — станет 'failed'.
      if(rtc.connectionState==='failed'&&ui.rtc===rtc){
        ui.rtc=null; ui.previewUrl='';
        if(ui.status?.running)setTimeout(()=>startPreview(ui.status),1500);
      }
    };
    const offer=await rtc.createOffer();
    await rtc.setLocalDescription(offer);
    const ответ=await fetch(url,{method:'POST',headers:{'Content-Type':'application/sdp'},body:offer.sdp});
    if(!ответ.ok)throw new Error(`медиасервер ответил ${ответ.status}`);
    if(!previewAllowed()||ui.previewUrl!==key){ rtc.close(); if(ui.rtc===rtc)ui.rtc=null; return; }
    await rtc.setRemoteDescription({type:'answer',sdp:await ответ.text()});
  }catch(error){
    // Закрываем только своё соединение. Устаревшее рукопожатие (источник
    // сменили, глаз перещёлкнули) раньше закрывало уже новое и на минуту
    // запрещало WebRTC.
    rtc?.close();
    if(ui.previewUrl!==key||(rtc&&ui.rtc!==rtc))return;
    ui.rtc=null; ui.webrtcFailed=true;setTimeout(()=>{ui.webrtcFailed=false;},60000); ui.previewUrl='';
    console.warn('WebRTC-предпросмотр недоступен, перехожу на HLS:',error.message);
    if(ui.status)startPreview(ui.status);
  }
}

// Лимит кеша: сколько места программе разрешено занимать под скачанное видео.
$('#cacheLimit').addEventListener('change',async()=>{
  try{
    render(await api('/api/config',{method:'POST',body:JSON.stringify({...configPayload(),cacheLimitGb:Number($('#cacheLimit').value)})}));
    toast('Лимит сохранён');
  }catch(error){ toast(error.message,true); }
});

// ─── Настройки ──────────────────────────────────────────────────────────────
// Окно со всем редким: тема, крестик окна, кодировщик, туннель, место на
// диске и журнал. Всё это раньше занимало основной экран и мешало найти
// плейлист. Окно раскрывается и закрывается с короткой анимацией; при
// системной настройке «меньше движения» — мгновенно.
const settingsDialog=$('#settingsDialog');
const ТЕМЫ={night:'#0e0c18',broadcast:'#0f1115',projector:'#121110'};

function применитьТему(тема){
  if(!ТЕМЫ[тема])тема='night';
  if(тема==='night')delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme=тема;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',ТЕМЫ[тема]);
  for(const кнопка of $$('[data-theme-choice]'))кнопка.setAttribute('aria-checked',String(кнопка.dataset.themeChoice===тема));
}
применитьТему(document.documentElement.dataset.theme||'night');
$('.theme-picker').addEventListener('click',event=>{
  const кнопка=event.target.closest('[data-theme-choice]'); if(!кнопка)return;
  применитьТему(кнопка.dataset.themeChoice);
  положить('theme',кнопка.dataset.themeChoice);
});
// Стрелки внутри выбора темы — как у остальных переключателей.
$('.theme-picker').addEventListener('keydown',event=>{
  const шаг={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[event.key]; if(!шаг)return;
  event.preventDefault();
  const кнопки=$$('[data-theme-choice]'), i=кнопки.indexOf(document.activeElement);
  const следующая=кнопки[(i+шаг+кнопки.length)%кнопки.length]; следующая.focus(); следующая.click();
});

function paintCloseNote(){
  setText($('#closeActionNote'),$('#closeAction').value==='exit'
    ?'Программа закроется, эфир остановится'
    :'Эфир продолжится, значок будет у часов');
}
$('#closeAction').addEventListener('change',async()=>{
  paintCloseNote(); ui.configEditUntil=Date.now()+2500;
  try{ render(await saveConfig(false)); toast($('#closeAction').value==='exit'?'Крестик закрывает программу':'Крестик прячет окно в трей'); }
  catch(error){ ui.configEditUntil=0; toast(error.message,true); }
});

const меньшеДвижения=matchMedia('(prefers-reduced-motion: reduce)');
function открытьНастройки(раздел){
  if(!settingsDialog.open){
    settingsDialog.classList.remove('closing');
    settingsDialog.showModal();
  }
  const тело=$('#settingsBody');
  if(typeof раздел==='string'&&document.getElementById(раздел)){ ui.navPinned=раздел; ui.navPinnedUntil=Date.now()+900; тело.style.scrollBehavior='auto'; тело.scrollTop=document.getElementById(раздел).offsetTop-8; тело.style.scrollBehavior=''; }
  else тело.scrollTop=0;
  paintSettingsNav();
  // Фокус — на выбранную тему, а не на крестик: так Tab ведёт по порядку.
  if(typeof раздел!=='string')settingsDialog.querySelector('[data-theme-choice][aria-checked="true"]')?.focus();
}
function paintSettingsNav(){
  const тело=$('#settingsBody'); let текущий='setLook';
  if(Date.now()<(ui.navPinnedUntil||0)){ for(const кнопка of $$('.settings-nav [data-section]'))кнопка.classList.toggle('on',кнопка.dataset.section===ui.navPinned); return; }
  for(const раздел of $$('.settings-group'))if(раздел.offsetTop-40<=тело.scrollTop)текущий=раздел.id;
  if(тело.scrollTop+тело.clientHeight>=тело.scrollHeight-4)текущий=$$('.settings-group').at(-1).id;
  for(const кнопка of $$('.settings-nav [data-section]'))кнопка.classList.toggle('on',кнопка.dataset.section===текущий);
}
$('.settings-nav').addEventListener('click',event=>{
  const кнопка=event.target.closest('[data-section]'); if(!кнопка)return;
  ui.navPinned=кнопка.dataset.section; ui.navPinnedUntil=Date.now()+900;
  $('#settingsBody').scrollTop=document.getElementById(кнопка.dataset.section).offsetTop-8;
  paintSettingsNav();
});
$('#settingsBody').addEventListener('scroll',()=>{ cancelAnimationFrame(ui.navFrame); ui.navFrame=requestAnimationFrame(paintSettingsNav); },{passive:true});
function закрытьНастройки(сразу=false){
  if(!settingsDialog.open)return;
  if(сразу||меньшеДвижения.matches){ settingsDialog.classList.remove('closing'); settingsDialog.close(); return; }
  settingsDialog.classList.add('closing');
  // Страховка по таймеру: animationend не придёт, если окно свёрнуто.
  let таймер=0;
  const готово=()=>{ clearTimeout(таймер); settingsDialog.removeEventListener('animationend',готово); settingsDialog.classList.remove('closing'); if(settingsDialog.open)settingsDialog.close(); };
  таймер=setTimeout(готово,220);
  settingsDialog.addEventListener('animationend',готово);
}
$('#openSettings').addEventListener('click',()=>открытьНастройки());
$('#closeSettings').addEventListener('click',()=>закрытьНастройки());
settingsDialog.addEventListener('cancel',event=>{ event.preventDefault(); закрытьНастройки(); });
// Остальные окна (журнал, сервер, обновление) закрываются так же плавно, как
// настройки: их close() и Escape сначала проигрывают затухание. Раньше они
// исчезали мгновенно, и окна программы вели себя по-разному.
for(const окно of document.querySelectorAll('dialog')){
  if(окно===settingsDialog)continue;
  const закрыть=окно.close.bind(окно), показать=окно.showModal.bind(окно);
  окно.close=()=>{
    if(!окно.open||окно.classList.contains('closing'))return;
    if(меньшеДвижения.matches){ закрыть(); return; }
    окно.classList.add('closing');
    let таймер=0;
    const готово=()=>{ clearTimeout(таймер); окно.removeEventListener('animationend',готово); if(!окно.classList.contains('closing'))return; окно.classList.remove('closing'); if(окно.open)закрыть(); };
    таймер=setTimeout(готово,220);
    окно.addEventListener('animationend',готово);
  };
  // Открыли снова, пока идёт затухание, — довести закрытие мгновенно, иначе showModal упадёт.
  окно.showModal=()=>{ if(окно.classList.contains('closing')){ окно.classList.remove('closing'); закрыть(); } показать(); };
  окно.addEventListener('cancel',event=>{ event.preventDefault(); окно.close(); });
}
let настройкиНажалиНаФон=false;
settingsDialog.addEventListener('mousedown',event=>{ настройкиНажалиНаФон=(event.target===settingsDialog); });
settingsDialog.addEventListener('click',event=>{ if(event.target===settingsDialog&&настройкиНажалиНаФон)закрытьНастройки(); });

// ─── Подтверждение ──────────────────────────────────────────────────────────
// Для того, что не вернуть: очередь, сервер, сохранённый список, скачанное.
// Окно то же, что остальные, с тем же затуханием; фокус — на «Отмена», чтобы
// случайный Enter ничего не удалил. Escape, фон и «Отмена» — это «нет».
const confirmDialog=$('#confirmDialog');
let ответитьПодтверждению=null;
function подтвердить(вопрос, действие='Удалить', пояснение=''){
  ответитьПодтверждению?.(false);
  setText($('#confirmTitle'),вопрос);
  setText($('#confirmText'),пояснение); setHidden($('#confirmText'),!пояснение);
  setText($('#confirmOk'),действие);
  return new Promise(resolve=>{
    ответитьПодтверждению=resolve;
    confirmDialog.showModal();
    $('#confirmCancel').focus();
  });
}
function ответПодтверждения(да){ const ответ=ответитьПодтверждению; ответитьПодтверждению=null; ответ?.(да); }
$('#confirmOk').addEventListener('click',()=>{ ответПодтверждения(true); confirmDialog.close(); });
$('#confirmCancel').addEventListener('click',()=>{ ответПодтверждения(false); confirmDialog.close(); });
// Запоздалое close от прошлого закрытия приходит, когда окно уже открыто
// заново, — на новый вопрос оно отвечать не должно.
confirmDialog.addEventListener('close',()=>{ if(!confirmDialog.open)ответПодтверждения(false); });
let подтверждениеНажалиНаФон=false;
// Фон — только то, что снаружи рамки окна: у dialog нет внутренней обёртки,
// и event.target===confirmDialog срабатывал и на его внутренних отступах —
// промах мимо «Удалить» превращался в «Отмену».
const наФоне=event=>{ const r=confirmDialog.getBoundingClientRect(); return event.target===confirmDialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom); };
confirmDialog.addEventListener('mousedown',event=>{ подтверждениеНажалиНаФон=наФоне(event); });
confirmDialog.addEventListener('click',event=>{ if(подтверждениеНажалиНаФон&&наФоне(event)){ ответПодтверждения(false); confirmDialog.close(); } });
// «1 ролик», «2 ролика», «5 роликов».
function штук(n, формы){ const d=n%10, dd=n%100; return `${n} ${формы[d===1&&dd!==11?0:d>=2&&d<=4&&(dd<12||dd>14)?1:2]}`; }
