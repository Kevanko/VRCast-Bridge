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
// Предпросмотр по умолчанию выключен: декодирование эфира в окне стоит больше,
// чем само кодирование. Включается кнопкой с глазом и запоминается.
const ui = { previewOn: localStorage.getItem('previewOn')==='1', windowHidden: false, source: 'queue', output: 'local', status: null, sources: { windows: [], monitors: [], audioDevices: [], audioOutputs: [] }, hls: null, previewUrl: '', progressAt: 0, seeking: false, seekPending: false, seekDraft: 0, seekRevision: 0, previewBusy: false, previewTimer: null, speedPendingUntil: 0, loopPendingUntil: 0, liveApplyTimer: null, queueSignature: '', unitySelectedId: '' };

async function api(path, options = {}) {
  // Один короткий повтор при обрыве связи: программа может на секунду уйти в
  // перезапуск, и сырое «Failed to fetch» пугает без причины. Если и повтор не
  // прошёл — говорим по-человечески, что связь с ядром пропала.
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch {
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
    setText($('#nowTitle'),item.title); setText($('#nowSource'),item.local?'Файл с компьютера':'Медиа по ссылке');
    // Запасной значок лежит рядом скрытым. Раньше его разметку вставляли прямо
    // в onerror, её кавычки рвали атрибут, и под обложкой торчал текст «'))">».
    setHtml(cover,item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" onerror="this.nextElementSibling.hidden=false;this.remove()"><span hidden>${icon('note')}</span>`:`<span>${icon('note')}</span>`);
  } else if (state.running && state.activeKind==='screen') {
    setText($('#nowTitle'),captureLabel()); setText($('#nowSource'),audioLabel()); setHtml(cover,`<span>${icon('display')}</span>`);
  } else { setText($('#nowTitle'),'Эфир не запущен'); setText($('#nowSource'),ui.source==='queue'?'Добавьте видео справа':'Выберите экран или окно справа'); setHtml(cover,`<span>${icon('note')}</span>`); }
  // Иконка паузы: в эфире — по состоянию плеера, в локальном предпросмотре — по video.
  setHtml($('#togglePause'),icon((ui.localPreviewId&&!state.running)?($('#streamPreview').paused?'play':'pause'):(state.playback?.paused?'play':'pause')));
  if(Date.now()>ui.speedPendingUntil)paintSpeed(state.playback?.speed||1);
  if(Date.now()>ui.loopPendingUntil)paintLoop(state.playback?.loopMode||'once');
  $('#playerUi').classList.toggle('disabled',ui.source==='queue'&&(state.activeKind!=='queue'||!state.running));
  $('#monitor').classList.toggle('capture',ui.source==='screen');
  $('#monitor').classList.toggle('idle',!state.running);
}

const SPEED_STEPS=[0.5,0.75,1,1.25,1.5,2];
const icon=name=>`<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const LOOP_STEPS=[['once','repeat','Без повтора'],['all','repeat','Повтор очереди'],['one','repeat-one','Повтор трека']];
function paintSpeed(value){const button=$('#speedSelect');if(button.dataset.value!==String(value))button.dataset.value=String(value);setText(button,`${value}×`);
  button.classList.toggle('on',Number(value)!==1);setTitle(button,`Скорость ${value}× — нажмите, чтобы изменить`);}
function paintLoop(mode){const button=$('#loopSelect');const step=LOOP_STEPS.find(item=>item[0]===mode)||LOOP_STEPS[0];
  if(button.dataset.value!==step[0])button.dataset.value=step[0];setHtml(button,icon(step[1]));button.classList.toggle('on',step[0]!=='once');setTitle(button,`${step[2]} — нажмите, чтобы изменить`);}

function monitorPlaceholder(title, text, name = 'broadcast') {
  setText($('#monitorPlaceholderTitle'),title); setText($('#monitorPlaceholderText'),text); setHtml($('#monitorPlaceholderIcon'),icon(name));
}

// Декодирование 1080p60 в окне программы стоит около полутора ядер — больше,
// чем всё кодирование эфира. Поэтому предпросмотр выключается, а на свёрнутом
// окне останавливается сам: смотреть его в этот момент всё равно некому.
function previewAllowed() {
  return ui.previewOn && !ui.windowHidden;
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
  if (!ui.previewOn) return monitorPlaceholder('Предпросмотр выключен','Окно не декодирует видео и не тратит процессор. Включить — кнопка с глазом','eye-off');
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
  const черезWebrtc=Boolean(state.webrtcUrl)&&!ui.webrtcFailed;
  const previewKey=`${черезWebrtc?'rtc':'hls'}|${previewSource}`;
  // Ключ включает способ показа: без этого связь WebRTC пересоздавалась на
  // каждом обновлении состояния, и картинка дёргалась.
  if (ui.previewUrl===previewKey && (ui.hls||ui.rtc)) return;
  ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl=previewKey;
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
    select.innerHTML=`<option value="">По умолчанию (диск с Windows)</option>`+drives.map(drive=>`<option value="${drive}\\">${drive} диск</option>`).join('');
    select.value=cache.root||'';
  }
  const лимит=cache.limitGb?`${cache.limitGb} ГБ`:'авто';
  setText($('#cacheSize'),`${cache.sizeMb||0} МБ из ${лимит}`);
  if(document.activeElement!==$('#cacheLimit'))$('#cacheLimit').value=String(cache.limitGb||0);
  const free=state.disk?.freeMb;
  const всего=state.disk?.totalMb;
  const место=free!==null&&free!==undefined&&всего
    ? ` · свободно ${(free/1024).toFixed(1)} из ${(всего/1024).toFixed(0)} ГБ`
    : '';
  setText($('#cacheHint'),cache.path?`${cache.path}${место}`:'');
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
    ?`Ссылка через интернет откроется у друзей, если на роутере открыт порт ${порт} (TCP).`
    :d.local
      ?'Эту ссылку открывают друзья в одной сети с вами. Есть белый IP — впишите, дам ссылку для интернета.'
      :'Пока видно только этот ПК. Друзьям рядом — впишите адрес своей сети, из интернета — белый IP.');
}

// Прямая ссылка — по клику копируем.
$('#localOutput').addEventListener('click',async event=>{
  const кнопка=event.target.closest('.direct-copy'); if(!кнопка)return;
  try{ await navigator.clipboard.writeText(кнопка.dataset.url); toast('Ссылка скопирована'); }
  catch{ toast('Не удалось скопировать',true); }
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
  if(!serverDialog.open)serverDialog.showModal();
  try{
    const ответ=await api(`/api/servers/${encodeURIComponent(id)}/key`);
    плашка.dataset.key=ответ.key||'';
  }catch{ плашка.dataset.key=''; }
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

function renderTemplates(state) {
  const select=$('#templateSelect'), selected=select.value, templates=state.templates||[];
  // Список пересобираем только когда наборы поменялись: пересборка на каждом
  // опросе захлопывала раскрытый список прямо под курсором.
  const html='<option value="">Новый набор…</option>'+templates.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.count}</option>`).join('');
  if(select._html!==html){
    setHtml(select,html);
    if(selected&&templates.some(item=>item.id===selected))select.value=selected;
  }
  setText($('#templateCount'),String(templates.length));
  const has=Boolean(select.value); setDisabled($('#loadTemplate'),!has); setDisabled($('#appendTemplate'),!has); setDisabled($('#deleteTemplate'),!has);
}

function render(state) {
  // Любая отрисовка не из опроса (ответ на нажатие) сбрасывает сравнение:
  // следующий опрос обязан перерисовать, даже если совпал с прошлым опросом.
  ui.lastPollText='';
  ui.status=state; ui.progressAt=Date.now();  const ready=state.tools.ffmpeg&&state.tools.ytdlp;
  if(ui.seekPending&&!state.playback?.busy&&Number(state.playback?.revision)>=ui.seekRevision)ui.seekPending=false;
  const streamReady=Boolean(state.stream?.ready), streamStalled=state.stream?.state==='stalled';
  setClass($('#stateDot'),`state-dot ${state.disk?.low||streamStalled?'error':state.running?'live':ready?'ready':''}`);
  // Раньше при любом недостающем инструменте писалось «Нужен FFmpeg» — даже
  // когда FFmpeg на месте, а не хватает yt-dlp, и пока всё это само качается.
  const качаюИнструменты=Object.values(state.toolDownloads||{}).some(item=>item.state==='work');
  setText($('#systemState'),state.disk?.low?`Мало места на диске · ${Math.max(0,Math.round(state.disk.freeMb/1024*10)/10)} ГБ`:state.playback?.buffering?'Загружаю видео':streamStalled?'Не успевает':state.running&&streamReady?'В эфире':state.running?'Запускаю…':streamReady?'Готово':ready?'Готов к эфиру':качаюИнструменты?'Докачиваю инструменты':!state.tools.ffmpeg?'Нужен FFmpeg':'Нужен yt-dlp');
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
  if(unityMode){shownUrl=unitySource.available?unitySource.url:'';hint=unitySource.scope==='local'&&tunnelMode?'Рабочая локальная Unity-ссылка. Для друзей используйте AVPro: бесплатный Pinggy подменяет Unity-запрос страницей предупреждения.':ui.source==='screen'?'Unity получит завершённую запись, а не прямой эфир.':unitySource.stale?'Трек изменился — подготовьте заново.':'Unity получает один трек — выберите его в очереди.';linkText=unitySource.available?(ui.source==='screen'?'Клип готов':'Трек готов'):unitySource.state==='building'||unitySource.state==='recording'||unitySource.state==='finalizing'?'Готовлю файл…':'Файл не готов';linkGood=Boolean(unitySource.available);linkError=unitySource.state==='error';}
  else if(state.config.outputMode==='remote'){
    const remote=state.rtsp?.remote||{};
    shownUrl=remote.configured?remote.url:'';
    hint=remote.channelRejected?'Этот сервер принимает только постоянную ссылку. Откройте «···» рядом с ним и включите «Постоянная ссылка».'
      :remote.reachable===false?'Сервер не отвечает. Проверьте, что машина включена и запущена трансляция.':'';
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
      if(heavy)hint+=' Через бесплатный туннель 1080p и 60 кадров рвутся — поставьте 720p и 30 кадров.';
      // Адрес выдаётся на один сеанс. Кто вставил его раньше — смотрит, а кто
      // зайдёт после перезапуска, получит нерабочую ссылку и будет думать,
      // что сломалась программа. Про это надо предупреждать заранее.
      hint+=' Ссылка живёт до закрытия программы, в следующий раз будет другой. Если в мир заходят новые люди — берите свой сервер, его адрес постоянный.';}
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
  setHidden($('#altLinkRow'),true);
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
  setHidden($('#updateButton'),!update.available);
  if(update.available)setText($('#updateButton'),update.installing?(update.ready?`Устанавливаю ${update.version}…`:`Скачиваю ${update.version} — ${Number(update.percent)||0}%`):`Обновить до ${update.version}`);
  setDisabled($('#updateButton'),Boolean(update.installing));
  setText($('#encoderLabel'),state.performance?.encoder||'неизвестно');
  const реж=state.performance?.encoderMode||'auto', гпу=state.performance?.gpuLabel||'';
  setText($('#encoderNote'),
    реж==='cpu'?'Считает процессор: качество чуть выше, но нагрузка на CPU. Берите, когда видеокарта занята игрой.'
    :реж==='gpu'?(гпу?`${гпу} — кодирование уходит на видеокарту, процессор свободнее.`:'Видеокарты не нашлось — эфир считает процессор.')
    :(гпу?`Авто: сейчас ${гпу}. Программа сама берёт видеокарту, если она есть.`:'Авто: видеокарты не нашлось — считает процессор.'));
  const слабый=state.performance&&state.performance.hardware===false;
  const тяжело=слабый&&(ui.source==='screen'?(state.config.quality==='1080p'||Number(state.config.fps)>30):(state.config.mediaQuality==='1080p'||Number(state.config.mediaFps)>30));
  const ratio=Number(state.performance?.realtimeRatio||0);
  const perf=state.performance||{}, q=perf.quality||{}, events=perf.events||[];
  const lat=Number(perf.liveLatencySec||0);
  const congested=events.some(e=>e.kind==='remote-congestion'&&Date.now()-e.at<15000);
  let health=тяжело?'видеокарта не кодирует — поставьте 720p и 30 кадров':streamReady?(ratio&&ratio<0.97?`отстаёт на ${Math.round((1-ratio)*100)}%`:'идёт вовремя'):streamStalled?'не успевает — снизьте качество':'набирает буфер';
  if(congested)health='свой сервер не тянет битрейт — снизьте качество';
  else if(state.running&&streamReady){
    if(lat>0.3)health+=` · задержка ${lat.toFixed(1)}с`;
    if(q.freezes>0)health+=` · фризов ${q.freezes}`;
    if(q.driftCorrections>0)health+=` · синхр. ${q.driftCorrections}`;
  }
  const last=events[events.length-1];
  setText($('#streamHealth'),health);
  setTitle($('#streamHealth'),state.running
    ?`Задержка сейчас ${lat.toFixed(1)}с (пик ${Number(perf.maxLiveLatencySec||0).toFixed(1)}с)\nФризов ${q.freezes||0} на ${q.freezeSeconds||0}с всего\nСинхронизаций задержки ${q.driftCorrections||0}${last?`\nПоследнее: ${last.detail}${last.position!=null?` (${last.title||'трек'} на ${last.position}с)`:''}`:''}`
    :'');
  setText($('#queueCount'),state.queue.length);
  // Журнал в сотню строк переписываем, только пока его окно открыто: иначе
  // это самая тяжёлая запись в DOM на каждом опросе, и её никто не видит.
  if($('#logDialog').open)paintLogs(state);
  syncConfigControls(state);
  // Показания выхода всегда на виду: что уходит в эфир, какая чёткость и
  // сколько кадров. Раньше это было спрятано под шестерёнкой, и автопонижение
  // качества человек замечал только в журнале.
  const выход=state.activeKind==='screen'?'screen':'queue';
  const чёткость=выход==='screen'?state.config.quality:state.config.mediaQuality;
  const кадры=выход==='screen'?state.config.fps:state.config.mediaFps;
  setText($('#monitorBadge'),state.running
    ?`${state.activeKind==='screen'?'Экран':'Видео'} · ${чёткость} · ${кадры} к/с`
    // Надпись кадра источника («Предпросмотр», «Окно свёрнуто») ставит его
    // обновление; раньше каждый опрос затирал её обратно на «Нет эфира».
    :$('#monitor').matches('.source-preview,.window-paused')?$('#monitorBadge').textContent:'Нет эфира');
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
  const queueSignature=JSON.stringify([state.currentId,ui.unitySelectedId,подсказкаТрека,state.queue.map(item=>[item.id,item.title,item.thumbnail,item.duration,item.unavailable,item.local])]);
  if(queueSignature!==ui.queueSignature){ui.queueSignature=queueSignature;list.innerHTML=state.queue.length?state.queue.map((item,index)=>`<div class="queue-item ${state.currentId===item.id?'playing':''} ${item.unavailable?'unavailable':''} ${unityВыбор&&ui.unitySelectedId===item.id?'unity-selected':''}" data-id="${escapeHtml(item.id)}" ${item.unavailable?'data-unavailable="1"':''} role="button" tabindex="0" title="${подсказкаТрека}"><span class="queue-art">${item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" onerror="this.replaceWith('${String(index+1).padStart(2,'0')}')">`:String(index+1).padStart(2,'0')}</span><span class="queue-title"><b title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</b><small>${item.unavailable?'⚠ недоступен — пропускается':`${item.local?'Локальный файл · ':''}${item.duration?formatTime(item.duration):'длительность неизвестна'}`}</small></span><button class="remove-item" aria-label="Удалить из очереди" title="Удалить">×</button></div>`).join(''):'<div class="empty-state">Очередь пуста</div>';}
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
  setText($('#goLive'),чужойЭфир?(экран?'Переключить эфир на экран':'Переключить эфир на видео'):(экран?'Начать эфир экрана':'Начать эфир видео'));
  setHidden($('#stopLive'),!state.running);
  setText($('#stopLive'),state.activeKind==='screen'?'Остановить эфир экрана':'Остановить эфир');
  setHidden($('#skipTrack'),!(state.running&&state.activeKind==='queue'));
  // Пока эфир экрана идёт, эта кнопка применяет смену источника или настроек.
  // Когда эфира нет, её работу делает кнопка пуска — двух одинаковых не нужно.
  setHidden($('#applyCapture'),!(экран&&state.activeKind==='screen'));
  setText($('#applyCapture'),'Применить изменения');
  $$('.broadcast-mode button').forEach(node=>setDisabled(node,state.running));
  schedulePlaybackClock();
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
  const значения={quality:c.quality,fps:c.fps,mediaQuality:c.mediaQuality,mediaFps:c.mediaFps,videoBitrate:c.videoBitrate??0,encoderMode:c.encoderMode||'auto',tunnelProviderSelect:c.tunnelProvider||'auto'};
  for (const [id,value] of Object.entries(значения)) {
    if (value===undefined||value===null) continue;
    const select=document.getElementById(id);
    if (!select||select.value===String(value)||![...select.options].some(option=>option.value===String(value))) continue;
    select.value=String(value); paintSegments(select);
  }
}

function chooseSource(source) {
  ui.source=source; $$('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.tab===source));
  $('#queuePanel').hidden=source!=='queue'; $('#screenPanel').hidden=source!=='screen'; $('#panelTitle').textContent=source==='queue'?'Плейлист':'Экран';
  $('#queueCount').hidden=source!=='queue';
  if(source!=='screen'&&!ui.status?.running)$('#monitor').classList.remove('source-preview','window-paused');
  if (source==='screen'){refreshWindows().catch(()=>{});if(!ui.status?.running)refreshCapturePreview().catch(()=>{});}
  if(ui.status)render(ui.status);
}
function chooseOutput(output) { ui.output=output; $$('.broadcast-mode button').forEach(button=>button.classList.toggle('active',button.dataset.output===output)); $('#remoteOutput').hidden=output!=='remote'; $('#localOutput').hidden=output!=='local'; $('#tunnelOutput').hidden=output!=='tunnel'; }
// auto=false — при загрузке настроек: сохранённый режим звука не трогаем.
// Раньше при каждом открытии программы с захватом окна звук молча менялся с
// «Всё, что слышно в Windows» на «звук окна», а подпись оставалась от прежнего.
function chooseCaptureMode(mode, auto=true) { $('#monitorFields').hidden=mode!=='monitor'; $('#windowFields').hidden=mode!=='window'&&$('#audioMode').value!=='process'; $('#regionFields').hidden=mode!=='region'; if(auto&&mode==='window'&&$('#audioMode').value==='system'){$('#audioMode').value='process';chooseAudioMode('process');} }
function chooseAudioMode(mode) {
  // Звук процесса привязан к выбранному окну — селектор окна нужен даже при захвате монитора/области.
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
  fillSelect($('#monitorSource'),ui.sources.monitors,saved.captureMonitorId,'Основной монитор',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.width}×${item.height}</option>`);
  fillWindowPicker(ui.sources.windows,saved.captureWindowHandle);
  fillSelect($('#audioOutput'),ui.sources.audioOutputs,saved.audioOutputId,'Выберите выход',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`);
  fillSelect($('#audioDevice'),ui.sources.audioDevices,saved.captureAudioDevice,'Выберите вход',name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  ui.sourcesLoaded=true;
}

async function refreshWindows() {
  const selected=$('#windowSource').value, windows=await api('/api/windows');
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
  return { outputMode:ui.output,activeServerId:ui.status?.config?.activeServerId||'',quality:$('#quality').value,fps:Number($('#fps').value),mediaQuality:$('#mediaQuality').value,mediaFps:Number($('#mediaFps').value),videoBitrate:Number($('#videoBitrate').value),encoderMode:$('#encoderMode').value,captureMode:$('#captureMode').value,captureMonitorId:ждём?saved.captureMonitorId||'':$('#monitorSource').value,captureWindowHandle:handle,regionX:Number($('#regionX').value),regionY:Number($('#regionY').value),regionWidth:Number($('#regionWidth').value),regionHeight:Number($('#regionHeight').value),audioMode:$('#audioMode').value,audioOutputId:ждём?saved.audioOutputId||'':$('#audioOutput').value,audioProcessId:processId,captureAudioDevice:ждём?saved.captureAudioDevice||'':$('#audioDevice').value,localAppVolume:Number($('#localAppVolume').value),loopMode:$('#loopSelect').dataset.value,playbackSpeed:Number($('#speedSelect').dataset.value),captureVolume:Number($('#captureVolume').value)/100,mediaVolume:Number($('#mediaVolume').value)/100,whiteIp:$('#whiteIp').value.trim(),tunnelProvider:$('#tunnelProviderSelect').value };
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
  if (ui.source!=='screen'||ui.previewBusy||ui.status?.running||(!previewAllowed()&&!force)) return; ui.previewBusy=true;
  try {
    if(save)await saveConfig(); const result=await api('/api/capture-preview',{method:'POST'}); const monitor=$('#monitor');
    if(ui.source!=='screen'||ui.status?.running)return;
    monitor.classList.toggle('window-paused',Boolean(result.minimized||result.unavailable));
    if(result.minimized){monitor.classList.remove('source-preview');monitorPlaceholder('Окно свёрнуто','В эфире заглушка, звук продолжает идти','minus');}
    else if(result.unavailable){monitor.classList.remove('source-preview');monitorPlaceholder('Окно недоступно','Откройте приложение или обновите список','alert');}
    else{$('#capturePreview').src=`${result.url}&cache=${Date.now()}`;monitor.classList.add('source-preview');}
    setText($('#monitorBadge'),result.minimized?'Окно свёрнуто':result.unavailable?'Окно не найдено':previewAllowed()?'Предпросмотр':'Снимок');
    scheduleCaptureFrames();
  } catch(error){
    if(!$('#monitor').classList.contains('source-preview')){monitorPlaceholder('Нет предпросмотра',error.message||'Обновите список источников','alert');setText($('#monitorBadge'),'Нет кадра');}
    throw error;
  } finally { ui.previewBusy=false; }
}
function highlightSelected() { const rect=selectedRect(); if(!rect?.width||!rect?.height)return toast('Сначала выберите источник',true); window.location.href=`vrcast://highlight?x=${rect.x}&y=${rect.y}&width=${rect.width}&height=${rect.height}`; }

$$('.nav-item').forEach(button=>button.addEventListener('click',()=>chooseSource(button.dataset.tab)));
$$('.broadcast-mode button').forEach(button=>button.addEventListener('click',async()=>{chooseOutput(button.dataset.output);try{render(await saveConfig(false));}catch(error){toast(error.message,true);}}));
$('#captureMode').addEventListener('change',event=>{chooseCaptureMode(event.target.value);refreshCapturePreview().catch(error=>toast(error.message,true));});
$('#audioMode').addEventListener('change',event=>chooseAudioMode(event.target.value));
$('#localAppVolume').addEventListener('change',async()=>{try{const live=ui.status?.activeKind==='screen';render(await saveConfig(live));toast(live?'Громкость изменена, в эфире прежняя':'Сохранено');}catch(error){toast(error.message,true);}});
$('#monitorSource').addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true)));
$('#windowSource').addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true)));

$('#refreshSources').addEventListener('click',async()=>{try{await loadCaptureSources();toast('Список обновлён');}catch(error){toast(error.message,true);}});
$('#refreshPreview').addEventListener('click',()=>{
  if(ui.status?.running)return toast('Идёт эфир — картинка источника видна в самом эфире',true);
  refreshCapturePreview(true,true).catch(error=>toast(error.message,true));
});
// Координаты области, введённые руками, тоже должны сразу попадать в кадр.
for(const id of ['#regionX','#regionY','#regionWidth','#regionHeight'])$(id).addEventListener('change',()=>refreshCapturePreview().catch(error=>toast(error.message,true))); $('#highlightSource').addEventListener('click',highlightSelected);
$('#applyCapture').addEventListener('click',async()=>{const button=$('#applyCapture');button.disabled=true;try{await saveConfig();$('#monitor').classList.remove('source-preview','window-paused');render(await api('/api/start/screen',{method:'POST'}));toast('Источник применён');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
$('#selectRegion').addEventListener('click',()=>{window.location.href='vrcast://select-region';}); $('#pickLocal').addEventListener('click',()=>{window.location.href='vrcast://pick-media';});
window.applySelectedRegion=region=>{$('#regionX').value=region.x;$('#regionY').value=region.y;$('#regionWidth').value=region.width;$('#regionHeight').value=region.height;refreshCapturePreview().catch(()=>{});toast(`Выбрано ${region.width}×${region.height}`);};
window.addLocalFiles=async paths=>{try{const result=await api('/api/queue/local',{method:'POST',body:JSON.stringify({paths})});render(result.status);toast(`Добавлено: ${result.added.length}`);}catch(error){toast(error.message,true);}};

$('#addForm').addEventListener('submit',async event=>{event.preventDefault();const button=$('#addButton');button.disabled=true;button.textContent='…';try{const result=await api('/api/queue',{method:'POST',body:JSON.stringify({url:$('#mediaUrl').value})});$('#mediaUrl').value='';render(result.status);toast(`Добавлено: ${result.added.length}`);}catch(error){toast(error.message,true);}finally{button.disabled=false;button.textContent='Добавить';}});
$('#queueList').addEventListener('click',async event=>{
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
// Enter/пробел делают то же, что щелчок. Раньше клавиша всегда слала «jump»,
// и без эфира это молча запускало трансляцию вместо предпросмотра.
$('#queueList').addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('.queue-item')){event.preventDefault();event.target.click();}});
$('#clearQueue').addEventListener('click',async()=>{try{очиститьЛокальныйПредпросмотр();ui.localNote=null;render(await api('/api/queue',{method:'DELETE'}));}catch(error){toast(error.message,true);}});
$('#templateSelect').addEventListener('change',event=>{const item=ui.status?.templates?.find(entry=>entry.id===event.target.value);if(item)$('#templateName').value=item.name;$('#loadTemplate').disabled=!item;$('#appendTemplate').disabled=!item;$('#deleteTemplate').disabled=!item;});
$('#saveTemplate').addEventListener('click',async()=>{const button=$('#saveTemplate');button.disabled=true;try{const result=await api('/api/templates',{method:'POST',body:JSON.stringify({id:$('#templateSelect').value,name:$('#templateName').value})});render(result.status);$('#templateSelect').value=result.id;$('#templateSelect').dispatchEvent(new Event('change'));toast('Набор сохранён');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
async function loadTemplate(append){const id=$('#templateSelect').value;if(!id)return;try{render(await api(`/api/templates/${encodeURIComponent(id)}/load`,{method:'POST',body:JSON.stringify({append})}));toast(append?'Набор добавлен к списку':'Набор загружен');}catch(error){toast(error.message,true);}}
$('#loadTemplate').addEventListener('click',()=>loadTemplate(false)); $('#appendTemplate').addEventListener('click',()=>loadTemplate(true));
$('#deleteTemplate').addEventListener('click',async()=>{const id=$('#templateSelect').value;if(!id)return;try{render(await api(`/api/templates/${encodeURIComponent(id)}`,{method:'DELETE'}));$('#templateName').value='';toast('Набор удалён');}catch(error){toast(error.message,true);}});
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
$('#copyAltUrl').addEventListener('click',async()=>{const value=$('#altLink').textContent;if(!value)return;const ok=await copyText(value);toast(ok?'Запасная ссылка скопирована':'Не удалось скопировать',!ok);});
$('#playerMode').addEventListener('change',()=>{if(ui.status)render(ui.status);});
$('#prepareUnityQueue').addEventListener('click',async()=>{const button=$('#prepareUnityQueue');button.disabled=true;try{render(await api('/api/unity/queue/build',{method:'POST',body:JSON.stringify({id:ui.unitySelectedId})}));toast('Подготовка выбранного трека началась');}catch(error){toast(error.message,true);}finally{if(ui.status?.compatibility?.unity?.queue?.state!=='building')button.disabled=false;}});
$('#recordUnityCapture').addEventListener('click',async()=>{const recording=ui.status?.compatibility?.unity?.capture?.state==='recording';try{render(await api(recording?'/api/unity/capture/stop':'/api/unity/capture/start',{method:'POST'}));toast(recording?'Завершаю MP4…':'Запись Unity-клипа началась');}catch(error){toast(error.message,true);}});

async function playback(action,extra={}){try{render(await api('/api/playback',{method:'POST',body:JSON.stringify({action,...extra})}));return true;}catch(error){toast(error.message,true);return false;}}
$('#togglePause').addEventListener('click',()=>{
  if(!ui.status?.running){ переключитьЛокальнуюПаузу(); return; }
  return ui.status?.playback?.paused?playback('resume'):playback('pause',{position:ui.seekPending?ui.seekDraft:progressPosition(ui.status)});
});
$('#previousTrack').addEventListener('click',()=>playback('previous')); $('#nextTrack').addEventListener('click',()=>playback('next')); $('#skipTrack').addEventListener('click',()=>playback('next'));
$('#cacheRoot').addEventListener('change',async()=>{
  try{ render(await api('/api/config',{method:'POST',body:JSON.stringify({...configPayload(),cacheRoot:$('#cacheRoot').value})}));
    toast('Кеш переехал, треки перекачаются на новое место'); }
  catch(error){ toast(error.message,true); }
});
$('#previewToggle').addEventListener('click',()=>{
  ui.previewOn=!ui.previewOn;
  localStorage.setItem('previewOn',ui.previewOn?'1':'0');
  paintPreviewToggle();
  if (!ui.previewOn) stopPreview();
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
document.addEventListener('vrcast-hidden',()=>setWindowHidden(true));
document.addEventListener('vrcast-shown',()=>setWindowHidden(document.hidden));
$('#clearCache').addEventListener('click',async()=>{
  try{ render(await api('/api/cache/clear',{method:'POST'})); toast('Скачанное удалено — играющий трек не тронут'); }
  catch(error){ toast(error.message,true); }
});
$('#seekBar').addEventListener('input',event=>{ui.seeking=true;event.target._step=undefined;const percent=Number(event.target.value)/10;event.target.style.setProperty('--seek',`${percent}%`);const total=Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*percent/100;setText($('#elapsedTime'),formatTime(ui.seekDraft));});
$('#seekBar').addEventListener('change',async event=>{const total=Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*Number(event.target.value)/1000;ui.seeking=false;ui.seekPending=true;ui.seekRevision=Number(ui.status?.playback?.revision||0)+1;if(!await playback('seek',{position:ui.seekDraft})){ui.seekPending=false;renderProgress();}});
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
$('#speedSelect').addEventListener('click',async()=>{const current=Number($('#speedSelect').dataset.value)||1;
  const next=SPEED_STEPS[(SPEED_STEPS.indexOf(current)+1)%SPEED_STEPS.length];
  paintSpeed(next);ui.speedPendingUntil=Date.now()+1500;const ok=await playback('speed',{speed:next});ui.speedPendingUntil=0;paintSpeed(ok?next:(ui.status?.playback?.speed||1));});
$('#loopSelect').addEventListener('click',async()=>{const current=$('#loopSelect').dataset.value||'once';
  const next=LOOP_STEPS[(LOOP_STEPS.findIndex(item=>item[0]===current)+1)%LOOP_STEPS.length][0];
  paintLoop(next);ui.loopPendingUntil=Date.now()+1500;const ok=await playback('loop',{mode:next});ui.loopPendingUntil=0;paintLoop(ok?next:(ui.status?.playback?.loopMode||'once'));});
// Сегменты: один клик — одно изменение, без второго выпадающего списка
// поверх первого. Значение продолжает жить в скрытом select, поэтому весь
// остальной код (сохранение настроек, восстановление при запуске) не менялся.
function paintSegments(select) {
  const box=document.querySelector(`.seg[data-for="${select.id}"]`);
  if(!box)return;
  for(const button of box.children){const on=String(button.dataset.value===select.value);if(button.getAttribute('aria-checked')!==on)button.setAttribute('aria-checked',on);}
}

function buildSegments() {
  for(const box of $$('.seg[data-for]')){
    const select=document.getElementById(box.dataset.for);
    if(!select)continue;
    box.innerHTML=[...select.options].map(option=>
      `<button type="button" role="radio" aria-checked="false" data-value="${escapeHtml(option.value)}">${escapeHtml(option.dataset.short||option.textContent)}</button>`).join('');
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
$('#mediaVolume').addEventListener('input',event=>paintVolume(event.target,$('#mediaVolumeValue')));
$('#mediaVolume').addEventListener('change',async event=>{if(ui.status?.activeKind==='queue')playback('volume',{volume:Number(event.target.value)/100});else try{render(await saveConfig());}catch(error){toast(error.message,true);}});
$('#captureVolume').addEventListener('input',event=>paintVolume(event.target,$('#captureVolumeValue')));
// Громкость экрана раньше только рисовалась: в настройки она попадала лишь при
// следующем пуске, а в идущем эфире не менялась вовсе.
$('#captureVolume').addEventListener('change',async()=>{
  try{ const live=ui.status?.activeKind==='screen'; render(await saveConfig(live)); toast(live?'Громкость эфира изменена':'Громкость сохранена'); }
  catch(error){ toast(error.message,true); }
});

$('#goLive').addEventListener('click',async()=>{const button=$('#goLive');button.disabled=true;try{await saveConfig();const тело=ui.source==='queue'&&ui.localPreviewId?JSON.stringify({id:ui.localPreviewId}):undefined;
  $('#monitor').classList.remove('source-preview','window-paused');
  render(await api(`/api/start/${ui.source}`,{method:'POST',body:тело}));ui.localPreviewId='';ui.localNote=null;toast(ui.output==='tunnel'?'Запускаю эфир и получаю публичную ссылку':'Эфир запускается');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
$('#stopLive').addEventListener('click',async()=>{try{render(await api('/api/stop',{method:'POST'}));}catch(error){toast(error.message,true);}});
$('#updateButton').addEventListener('click',()=>{const update=ui.status?.update;if(!update?.available)return;ui.offeredVersion=update.version;paintUpdateDialog(update);if(!updateDialog.open)updateDialog.showModal();});
$('#showLogs').addEventListener('click',()=>{paintLogs();$('#logDialog').showModal();const журнал=$('#logs');журнал.scrollTop=журнал.scrollHeight;schedulePoll(0);});
$('#openLogFolder').addEventListener('click',()=>{window.location.href='vrcast://open-folder';});
$('#appSoundSettings').addEventListener('click',()=>{window.location.href='vrcast://app-sound';}); $('#closeLogs').addEventListener('click',()=>$('#logDialog').close());

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
    // Ничего не поменялось — и рисовать нечего. На простое это почти каждый опрос.
    if(text===ui.lastPollText&&ui.status)return;
    const state=JSON.parse(text);
    render(state);
    ui.lastPollText=text;
  }catch{
    // Одно сообщение на обрыв, а не тост на каждый опрос.
    if(ui.status&&!ui.offline){ui.offline=true;toast('Нет связи с программой — она перезапускается. Подождите пару секунд.',true);}
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

async function init(){const state=await api('/api/status');ui.output=state.config.outputMode;chooseOutput(ui.output);$('#quality').value=state.config.quality;$('#fps').value=String(state.config.fps);$('#mediaQuality').value=state.config.mediaQuality||'720p';$('#mediaFps').value=String(state.config.mediaFps||30);$('#videoBitrate').value=String(state.config.videoBitrate??0);$('#encoderMode').value=state.config.encoderMode||'auto';$('#tunnelProviderSelect').value=state.config.tunnelProvider||'auto';$('#captureMode').value=state.config.captureMode;$('#regionX').value=state.config.regionX;$('#regionY').value=state.config.regionY;$('#regionWidth').value=state.config.regionWidth;$('#regionHeight').value=state.config.regionHeight;$('#audioMode').value=state.config.audioMode;$('#localAppVolume').value=String(state.config.localAppVolume??1);paintLoop(state.config.loopMode||'once');paintSpeed(state.config.playbackSpeed||1);$('#mediaVolume').value=String(Math.round((state.config.mediaVolume??1)*100));$('#captureVolume').value=String(Math.round((state.config.captureVolume??1.5)*100));paintVolume($('#mediaVolume'),$('#mediaVolumeValue'));paintVolume($('#captureVolume'),$('#captureVolumeValue'));chooseCaptureMode(state.config.captureMode,false);chooseAudioMode(state.config.audioMode);открытьДобавление(!state.config.servers?.length);paintPreviewToggle();buildSegments();
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

// Свёрнутые разделы левой колонки остаются свёрнутыми при следующем запуске.
for(const card of document.querySelectorAll('details.rail-card')){
  const key=`rail:${card.id}`;
  const saved=localStorage.getItem(key);
  if(saved!==null)card.open=saved==='1';
  card.addEventListener('toggle',()=>localStorage.setItem(key,card.open?'1':'0'));
}

// Предпросмотр по умолчанию беззвучный: звук уже идёт в наушниках напрямую,
// а вторая копия с задержкой сбивает. Громкость запоминается между запусками.
const preview=$('#streamPreview');
function paintPreviewSound(){
  const level=Number($('#previewVolume').value)||0;
  preview.muted=level===0; preview.volume=level/100;
  $('#previewMute').innerHTML=icon(level===0?'mute':'sound');
  $('#previewMute').title=level===0?'Включить звук предпросмотра':'Выключить звук предпросмотра';
  $('#previewVolume').style.setProperty('--fill',`${level}%`);
  localStorage.setItem('previewVolume',String(level));
}
$('#previewVolume').value=localStorage.getItem('previewVolume')||'0';
$('#previewVolume').addEventListener('input',paintPreviewSound);
$('#previewMute').addEventListener('click',()=>{
  const level=Number($('#previewVolume').value)||0;
  $('#previewVolume').value=level===0?(Number(localStorage.getItem('previewVolumeLast'))||60):0;
  if(level>0)localStorage.setItem('previewVolumeLast',String(level));
  paintPreviewSound();
});
paintPreviewSound();

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

document.addEventListener('click',event=>{ if(!event.target.closest('#playerMenu, #playerSettings'))togglePlayerMenu(false); });
document.addEventListener('keydown',event=>{ if(event.key==='Escape')togglePlayerMenu(false); });

$('#copyLogs').addEventListener('click',async()=>{
  const text=$('#logs').textContent||'';
  const ok=await copyText(text);
  toast(ok?'Журнал скопирован':'Не удалось скопировать',!ok);
});


// Обновление: окно появляется само, когда на GitHub вышла версия новее.
// «Позже» откладывает на сутки, «Пропустить» — до следующей версии.
const updateDialog=$('#updateDialog');
function updateBlocked(version){
  if(localStorage.getItem('skipVersion')===version)return true;
  const снова=Number(localStorage.getItem('updateSnooze')||0);
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
  localStorage.setItem('updateSnooze',String(Date.now()+24*60*60*1000));
  updateDialog.close(); toast('Напомню завтра');
});
$('#updateSkip').addEventListener('click',()=>{
  if(ui.offeredVersion)localStorage.setItem('skipVersion',ui.offeredVersion);
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
  try{
    ui.rtc?.close();
    const rtc=new RTCPeerConnection({iceServers:[]});
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
    ui.rtc?.close(); ui.rtc=null; ui.webrtcFailed=true;setTimeout(()=>{ui.webrtcFailed=false;},60000); ui.previewUrl='';
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
