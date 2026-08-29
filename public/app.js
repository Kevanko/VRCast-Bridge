const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ui = { previewOn: localStorage.getItem('previewOn')!=='0', windowHidden: false, source: 'queue', output: 'local', status: null, sources: { windows: [], monitors: [], audioDevices: [], audioOutputs: [] }, hls: null, previewUrl: '', progressAt: 0, seeking: false, seekPending: false, seekDraft: 0, seekRevision: 0, previewBusy: false, previewTimer: null, speedPendingUntil: 0, loopPendingUntil: 0, liveApplyTimer: null, queueSignature: '', unitySelectedId: '' };

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
    $('#elapsedTime').textContent='0:00'; $('#totalTime').textContent=state?.activeKind==='screen'&&state.running?'LIVE':'0:00';
    if (!ui.seeking&&!ui.seekPending) { $('#seekBar').value='0'; $('#seekBar').style.setProperty('--seek','0%'); }
    return;
  }
  const position=(ui.seeking||ui.seekPending)?ui.seekDraft:progressPosition(state), total=Number(state?.progress?.duration)||0, percent=total?Math.min(100,position/total*100):0;
  $('#elapsedTime').textContent=formatTime(position); $('#totalTime').textContent=total?formatTime(total):'LIVE';
  if (!ui.seeking&&!ui.seekPending) { $('#seekBar').value=String(Math.round(percent*10)); $('#seekBar').style.setProperty('--seek',`${percent}%`); }
}

function renderNowPlaying(state) {
  const item=currentItem(state), cover=$('#nowCover');
  if (item) {
    $('#nowTitle').textContent=item.title; $('#nowSource').textContent=item.local?'Файл с компьютера':'Медиа по ссылке';
    cover.innerHTML=item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${icon('note').replace(/'/g,"\\'")}'}))">`:`<span>${icon('note')}</span>`;
  } else if (state.running && state.activeKind==='screen') {
    $('#nowTitle').textContent=captureLabel(); $('#nowSource').textContent=audioLabel(); cover.innerHTML=`<span>${icon('display')}</span>`;
  } else { $('#nowTitle').textContent='Эфир не запущен'; $('#nowSource').textContent=ui.source==='queue'?'Добавьте видео справа':'Выберите экран или окно справа'; cover.innerHTML=`<span>${icon('note')}</span>`; }
  // Иконка паузы: в эфире — по состоянию плеера, в локальном предпросмотре — по video.
  $('#togglePause').innerHTML=icon((ui.localPreviewId&&!state.running)?($('#streamPreview').paused?'play':'pause'):(state.playback?.paused?'play':'pause'));
  if(Date.now()>ui.speedPendingUntil)paintSpeed(state.playback?.speed||1);
  if(Date.now()>ui.loopPendingUntil)paintLoop(state.playback?.loopMode||'once');
  $('#playerUi').classList.toggle('disabled',ui.source==='queue'&&(state.activeKind!=='queue'||!state.running));
  $('#monitor').classList.toggle('capture',ui.source==='screen');
  $('#monitor').classList.toggle('idle',!state.running);
}

const SPEED_STEPS=[0.5,0.75,1,1.25,1.5,2];
const icon=name=>`<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const LOOP_STEPS=[['once','repeat','Без повтора'],['all','repeat','Повтор очереди'],['one','repeat-one','Повтор трека']];
function paintSpeed(value){const button=$('#speedSelect');button.dataset.value=String(value);button.textContent=`${value}×`;
  button.classList.toggle('on',Number(value)!==1);button.title=`Скорость ${value}× — нажмите, чтобы изменить`;}
function paintLoop(mode){const button=$('#loopSelect');const step=LOOP_STEPS.find(item=>item[0]===mode)||LOOP_STEPS[0];
  button.dataset.value=step[0];button.innerHTML=icon(step[1]);button.classList.toggle('on',step[0]!=='once');button.title=`${step[2]} — нажмите, чтобы изменить`;}

function monitorPlaceholder(title, text, name = 'broadcast') {
  $('#monitorPlaceholderTitle').textContent=title; $('#monitorPlaceholderText').textContent=text; $('#monitorPlaceholderIcon').innerHTML=icon(name);
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
  video.pause(); video.srcObject=null; video.removeAttribute('src'); video.load?.();
  // Кадр захвата — отдельная картинка: без этого при выключении оставался экран.
  const снимок=$('#capturePreview');
  снимок.removeAttribute('src');
  $('#monitor').classList.remove('previewing','source-preview');
}

// Локальный предпросмотр: трек играет прямо в браузере, без эфира. Так видео
// можно посмотреть и подготовить, а трансляция начнётся только по «Начать эфир».
function показатьЛокальныйПредпросмотр(id){
  const item=(ui.status?.queue||[]).find(x=>x.id===id);
  if(!item)return;
  ui.localPreviewId=id;
  ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl='';
  const video=$('#streamPreview'), monitor=$('#monitor');
  video.srcObject=null;
  video.src=`/api/local-media/${encodeURIComponent(id)}?t=${Date.now()}`;
  video.load?.();
  monitor.classList.add('previewing'); monitor.classList.remove('source-preview');
  video.play().then(()=>video.pause()).catch(()=>{
    // Формат браузер не тянет (mkv, удалённое видео) — показываем обложку и
    // подсказку: смотреть можно только в эфире.
    очиститьЛокальныйПредпросмотр();
    monitorPlaceholder(item.title,'Смотреть можно в эфире — нажмите «Начать эфир видео»','broadcast');
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
  if(ui.localPreviewId&&!ui.status?.running) $('#togglePause').innerHTML=icon($('#streamPreview').paused?'play':'pause');
});

function очиститьЛокальныйПредпросмотр(){
  ui.localPreviewId='';
  const video=$('#streamPreview');
  try{ video.pause(); }catch{}
  video.removeAttribute('src'); video.load?.();
  $('#monitor').classList.remove('previewing');
}

function paintPreviewToggle() {
  const button=$('#previewToggle');
  button.classList.toggle('off',!ui.previewOn);
  button.title=ui.previewOn?'Выключить предпросмотр — освободит процессор':'Включить предпросмотр';
  button.innerHTML=icon(ui.previewOn?'eye':'eye-off');
  $('#monitorPlaceholderIcon').innerHTML=icon(ui.previewOn?'broadcast':'eye-off');
}

function startPreview(state) {
  const video=$('#streamPreview'), monitor=$('#monitor');
  if (!previewAllowed()) {
    if (ui.hls||ui.previewUrl) stopPreview();
    if (state.running && ui.previewOn===false) monitorPlaceholder('Картинка выключена','Эфир идёт, окно не тратит процессор','eye-off');
    return;
  }
  if (!state.running) {
    // Локальный предпросмотр трогать нельзя — он живёт своей жизнью до эфира.
    if (ui.localPreviewId) return;
    ui.hls?.destroy(); ui.hls=null; ui.rtc?.close(); ui.rtc=null; ui.previewUrl=''; video.removeAttribute('src'); video.srcObject=null; monitor.classList.remove('previewing'); return;
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
  $('#cacheSize').textContent=`${cache.sizeMb||0} МБ из ${лимит}`;
  if(document.activeElement!==$('#cacheLimit'))$('#cacheLimit').value=String(cache.limitGb||0);
  const free=state.disk?.freeMb;
  const всего=state.disk?.totalMb;
  const место=free!==null&&free!==undefined&&всего
    ? ` · свободно ${(free/1024).toFixed(1)} из ${(всего/1024).toFixed(0)} ГБ`
    : '';
  $('#cacheHint').textContent=cache.path?`${cache.path}${место}`:'';
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
  $('#serverHint').textContent=!servers.length?'Есть свой VPS — подключите его, и ссылка перестанет меняться.'
    :remote.reachable===false?'Сервер не отвечает. Проверьте, что машина включена и порт 8554 открыт.'
    :state.config.outputMode!=='remote'?'Выберите сервер, чтобы вещать через него.'
    :'';
}

// «Этот ПК»: одна ссылка для своей сети (друзьям рядом) и, если есть белый IP,
// ссылка через интернет. Подпись над ссылкой, в самой ссылке — только адрес.
function заполнитьСсылку(строкаId, подписьId, url){
  const строка=$(строкаId), подпись=$(подписьId);
  строка.hidden=!url; подпись.hidden=!url;
  if(url){ строка.querySelector('code').textContent=url; строка.querySelector('.direct-copy').dataset.url=url; }
}
function renderLocalOutput(state){
  const d=state.rtsp?.direct||{};
  заполнитьСсылку('#localLinkRow','#localLinkCaption',d.local||'');
  заполнитьСсылку('#whiteLinkRow','#whiteLinkCaption',d.white||'');
  const поле=$('#whiteIp');
  if(document.activeElement!==поле) поле.value=state.config.whiteIp||'';
  $('#localHint').textContent=d.white
    ?'Ссылка через интернет откроется у друзей, если на роутере открыт порт 8554.'
    :d.local
      ?'Эту ссылку открывают друзья в одной сети с вами. Есть белый IP — впишите, дам ссылку для интернета.'
      :'Пока видно только этот ПК. Друзьям рядом — впишите адрес своей сети, из интернета — белый IP.';
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
serverDialog.addEventListener('click',event=>{ if(event.target===serverDialog)закрытьДиалогСервера(); });
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
  select.innerHTML='<option value="">Новый набор…</option>'+templates.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.count}</option>`).join('');
  if(selected&&templates.some(item=>item.id===selected))select.value=selected;
  $('#templateCount').textContent=String(templates.length);
  const has=Boolean(select.value); $('#loadTemplate').disabled=!has; $('#appendTemplate').disabled=!has; $('#deleteTemplate').disabled=!has;
}

function render(state) {
  ui.status=state; ui.progressAt=Date.now();  const ready=state.tools.ffmpeg&&state.tools.ytdlp;
  if(ui.seekPending&&!state.playback?.busy&&Number(state.playback?.revision)>=ui.seekRevision)ui.seekPending=false;
  const streamReady=Boolean(state.stream?.ready), streamStalled=state.stream?.state==='stalled';
  $('#stateDot').className=`state-dot ${state.disk?.low||streamStalled?'error':state.running?'live':ready?'ready':''}`;
  $('#systemState').textContent=state.disk?.low?`Мало места на диске · ${Math.max(0,Math.round(state.disk.freeMb/1024*10)/10)} ГБ`:state.playback?.buffering?'Загружаю видео':streamStalled?'Не успевает':state.running&&streamReady?'В эфире':state.running?'Запускаю…':streamReady?'Готово':ready?'Готов к эфиру':'Нужен FFmpeg';
  const tunnelMode=state.config.outputMode==='tunnel', tunnelReady=tunnelMode&&state.tunnel?.ready, tunnelStarting=tunnelMode&&state.tunnel?.state==='starting';
  const unityMode=$('#playerMode').value==='unity', unity=state.compatibility?.unity||{};
  if(!ui.unitySelectedId||!state.queue.some(item=>item.id===ui.unitySelectedId))ui.unitySelectedId=unity.queue?.itemId||state.currentId||state.queue[0]?.id||'';
  const storedUnitySource=ui.source==='screen'?unity.capture||{}:unity.queue||{};
  const unitySource=ui.source==='queue'&&ui.unitySelectedId&&storedUnitySource.itemId!==ui.unitySelectedId
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
      :state.running?'Подключаюсь…':'Сервер на связи';
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
    linkText=streamStalled?'Поток отстаёт':rtspLive?'Готово':tunnelMode&&tunnelReady?`Готово · ${state.tunnel.provider}`:tunnelStarting?'Получаю ссылку…':'Канал поднимается…';
    linkGood=(tunnelMode?tunnelReady:rtspLive);
    linkError=streamStalled||state.tunnel?.state==='error';
  }
  $('#playbackUrl').textContent=shownUrl||(linkError?'Ссылка пока недоступна':'Подготовка ссылки…'); $('#trustHint').textContent=hint;
  $('#altLinkRow').hidden=true;
  $('#copyUrl').disabled=!shownUrl;
  const linkState=$('#linkState'); linkState.className=`link-state ${linkGood?'public':linkError?'error':''}`; linkState.querySelector('span').textContent=linkText;
  // Транспорт имеет смысл только для RTSP-ссылки
  $('#unityTools').hidden=!unityMode;
  if(unityMode){
    const storedQueueTask=unity.queue||{}, queueTask=ui.unitySelectedId&&storedQueueTask.itemId!==ui.unitySelectedId?{...storedQueueTask,available:false,stale:true}:storedQueueTask, captureTask=unity.capture||{}, task=ui.source==='screen'?captureTask:queueTask;
    const progress=ui.source==='screen'?(task.state==='ready'?1:task.state==='recording'||task.state==='finalizing'?Math.min(.95,(Number(task.elapsed)||0)/60):0):Number(task.progress)||0;
    $('#unityTaskText').textContent=task.stale?'Выбран другой трек — подготовьте его':task.message||(ui.source==='screen'?'Запись ещё не создана':'Трек ещё не подготовлен');
    $('#unityTaskPercent').textContent=task.state==='recording'?formatTime(task.elapsed):task.state==='finalizing'?'…':`${Math.round(progress*100)}%`;
    $('#unityTaskBar').style.width=`${Math.round(progress*100)}%`;
    $('#prepareUnityQueue').hidden=ui.source!=='queue'; $('#prepareUnityQueue').disabled=queueTask.state==='building'||state.running||!state.queue.length;
    $('#prepareUnityQueue').textContent=queueTask.state==='building'?'Подготовка трека…':queueTask.available&&!queueTask.stale?'Подготовить этот трек заново':'Подготовить выбранный трек';
    $('#recordUnityCapture').hidden=ui.source!=='screen'; $('#recordUnityCapture').disabled=captureTask.state==='finalizing'||(captureTask.state!=='recording'&&state.activeKind!=='screen');
    $('#recordUnityCapture').textContent=captureTask.state==='recording'?'Завершить запись и создать MP4':captureTask.state==='finalizing'?'Завершаю MP4…':'Записать Unity-клип из эфира';
  }
  $('#appVersion').textContent=state.appVersion||'';
  const update=state.update||{};
  const качается=Object.values(state.toolDownloads||{}).find(item=>item.state==='work');
  $('#toolProgress').hidden=!качается;
  if(качается){
    const мегабайты=качается.totalMb?` · ${качается.doneMb} из ${качества(качается)} МБ`:'';
    $('#toolProgress').innerHTML=`<i style="width:${качается.percent}%"></i><span>${качается.label} ${качается.percent}%${мегабайты}</span>`;
  }
  offerUpdate(update);
  $('#updateButton').hidden=!update.available;
  if(update.available)$('#updateButton').textContent=update.ready?`Обновить до ${update.version}`:`Скачиваю ${update.version} — ${Number(update.percent)||0}%`;
  $('#updateButton').disabled=!update.ready;
  $('#encoderLabel').textContent=state.performance?.encoder||'неизвестно';
  const реж=state.performance?.encoderMode||'auto', гпу=state.performance?.gpuLabel||'';
  $('#encoderNote').textContent=
    реж==='cpu'?'Считает процессор: качество чуть выше, но нагрузка на CPU. Берите, когда видеокарта занята игрой.'
    :реж==='gpu'?(гпу?`${гпу} — кодирование уходит на видеокарту, процессор свободнее.`:'Видеокарты не нашлось — эфир считает процессор.')
    :(гпу?`Авто: сейчас ${гпу}. Программа сама берёт видеокарту, если она есть.`:'Авто: видеокарты не нашлось — считает процессор.');
  const слабый=state.performance&&state.performance.hardware===false;
  const тяжело=слабый&&(ui.source==='screen'?(state.config.quality==='1080p'||Number(state.config.fps)>30):(state.config.mediaQuality==='1080p'||Number(state.config.mediaFps)>30));
  const ratio=Number(state.performance?.realtimeRatio||0); $('#streamHealth').textContent=тяжело?'видеокарта не кодирует — поставьте 720p и 30 кадров':streamReady?(ratio&&ratio<0.97?`отстаёт на ${Math.round((1-ratio)*100)}%`:'идёт вовремя'):streamStalled?'не успевает — снизьте качество':'набирает буфер';
  $('#queueCount').textContent=state.queue.length; $('#logs').textContent=state.logs.join('\n')||'Журнал пуст';
  // Показания выхода всегда на виду: что уходит в эфир, какая чёткость и
  // сколько кадров. Раньше это было спрятано под шестерёнкой, и автопонижение
  // качества человек замечал только в журнале.
  const выход=state.activeKind==='screen'?'screen':'queue';
  const чёткость=выход==='screen'?state.config.quality:state.config.mediaQuality;
  const кадры=выход==='screen'?state.config.fps:state.config.mediaFps;
  $('#monitorBadge').textContent=state.running
    ?`${state.activeKind==='screen'?'Экран':'Видео'} · ${чёткость} · ${кадры} к/с`
    :'Нет эфира';
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
  const queueSignature=JSON.stringify([state.currentId,ui.unitySelectedId,$('#playerMode').value,state.queue.map(item=>[item.id,item.title,item.thumbnail,item.duration,item.unavailable])]);
  if(queueSignature!==ui.queueSignature){ui.queueSignature=queueSignature;list.innerHTML=state.queue.length?state.queue.map((item,index)=>`<div class="queue-item ${state.currentId===item.id?'playing':''} ${item.unavailable?'unavailable':''} ${$('#playerMode').value==='unity'&&ui.unitySelectedId===item.id?'unity-selected':''}" data-id="${item.id}" ${item.unavailable?'data-unavailable="1"':''} role="button" tabindex="0" title="${$('#playerMode').value==='unity'?'Выбрать для подготовки Unity':'Включить этот трек'}"><span class="queue-art">${item.thumbnail?`<img src="${escapeHtml(item.thumbnail)}" alt="" onerror="this.replaceWith('${String(index+1).padStart(2,'0')}')">`:String(index+1).padStart(2,'0')}</span><span class="queue-title"><b title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</b><small>${item.unavailable?'⚠ недоступен — пропускается':`${item.local?'Локальный файл · ':''}${item.duration?formatTime(item.duration):'длительность неизвестна'}`}</small></span><button class="remove-item" aria-label="Удалить из очереди" title="Удалить">×</button></div>`).join(''):'<div class="empty-state">Очередь пуста</div>';}
  const screenSource=ui.source==='screen';
  $('#menuMediaQuality').hidden=screenSource; $('#menuMediaFps').hidden=screenSource;
  $('#menuScreenQuality').hidden=!screenSource; $('#menuScreenFps').hidden=!screenSource;
  renderNowPlaying(state); renderProgress(); renderTemplates(state); renderServers(state); renderLocalOutput(state); renderStorage(state); startPreview(state);
  // Пуск и остановка — отдельная явная кнопка, и её название прямо говорит,
  // что именно начнётся или прекратится. Раньше кнопка пуска была спрятана
  // всегда, и запустить эфир экрана можно было только через «Показать экран
  // в эфире» в настройках источника — это находили не сразу.
  const экран=ui.source==='screen';
  $('#goLive').hidden=state.running;
  $('#goLive').textContent=экран?'Начать эфир экрана':'Начать эфир видео';
  $('#stopLive').hidden=!state.running;
  $('#stopLive').textContent=state.activeKind==='screen'?'Остановить эфир экрана':'Остановить эфир';
  $('#skipTrack').hidden=!(state.running&&state.activeKind==='queue');
  // Пока эфир экрана идёт, эта кнопка применяет смену источника или настроек.
  // Когда эфира нет, её работу делает кнопка пуска — двух одинаковых не нужно.
  $('#applyCapture').hidden=!(экран&&state.activeKind==='screen');
  $('#applyCapture').textContent='Применить изменения';
  $$('.broadcast-mode button').forEach(node=>node.disabled=state.running);
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
function chooseCaptureMode(mode) { $('#monitorFields').hidden=mode!=='monitor'; $('#windowFields').hidden=mode!=='window'&&$('#audioMode').value!=='process'; $('#regionFields').hidden=mode!=='region'; if(mode==='window'&&$('#audioMode').value==='system'){$('#audioMode').value='process';chooseAudioMode('process');} }
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
  fillSelect($('#monitorSource'),ui.sources.monitors,saved.captureMonitorId,'Выберите монитор',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.width}×${item.height}</option>`);
  fillWindowPicker(ui.sources.windows,saved.captureWindowHandle);
  fillSelect($('#audioOutput'),ui.sources.audioOutputs,saved.audioOutputId,'Выберите выход',item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`);
  fillSelect($('#audioDevice'),ui.sources.audioDevices,saved.captureAudioDevice,'Выберите вход',name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
}

async function refreshWindows() {
  const selected=$('#windowSource').value, windows=await api('/api/windows');
  ui.sources.windows=windows;
  fillWindowPicker(windows,selected);
}

function configPayload() {
  const selectedWindow=ui.sources.windows.find(item=>item.handle===$('#windowSource').value);
  return { outputMode:ui.output,activeServerId:ui.status?.config?.activeServerId||'',quality:$('#quality').value,fps:Number($('#fps').value),mediaQuality:$('#mediaQuality').value,mediaFps:Number($('#mediaFps').value),videoBitrate:Number($('#videoBitrate').value),encoderMode:$('#encoderMode').value,captureMode:$('#captureMode').value,captureMonitorId:$('#monitorSource').value,captureWindowHandle:$('#windowSource').value,regionX:Number($('#regionX').value),regionY:Number($('#regionY').value),regionWidth:Number($('#regionWidth').value),regionHeight:Number($('#regionHeight').value),audioMode:$('#audioMode').value,audioOutputId:$('#audioOutput').value,audioProcessId:selectedWindow?.id||'',captureAudioDevice:$('#audioDevice').value,localAppVolume:Number($('#localAppVolume').value),loopMode:$('#loopSelect').dataset.value,playbackSpeed:Number($('#speedSelect').dataset.value),captureVolume:Number($('#captureVolume').value)/100,mediaVolume:Number($('#mediaVolume').value)/100,whiteIp:$('#whiteIp').value.trim(),tunnelProvider:$('#tunnelProviderSelect').value };
}
async function saveConfig(applyLive = false) { return api('/api/config',{method:'POST',body:JSON.stringify({...configPayload(),applyLive})}); }

function selectedRect() {
  const mode=$('#captureMode').value;
  if(mode==='window')return ui.sources.windows.find(item=>item.handle===$('#windowSource').value)||null;
  if(mode==='monitor')return ui.sources.monitors.find(item=>item.id===$('#monitorSource').value)||ui.sources.monitors.find(item=>item.primary)||null;
  if(mode==='region')return{x:Number($('#regionX').value),y:Number($('#regionY').value),width:Number($('#regionWidth').value),height:Number($('#regionHeight').value)};
  if(mode==='desktop'&&ui.sources.monitors.length){const left=Math.min(...ui.sources.monitors.map(x=>x.x)),top=Math.min(...ui.sources.monitors.map(x=>x.y)),right=Math.max(...ui.sources.monitors.map(x=>x.x+x.width)),bottom=Math.max(...ui.sources.monitors.map(x=>x.y+x.height));return{x:left,y:top,width:right-left,height:bottom-top};} return null;
}
async function refreshCapturePreview(save = true) {
  if (ui.source!=='screen'||ui.previewBusy||ui.status?.running||!previewAllowed()) return; ui.previewBusy=true;
  try {
    if(save)await saveConfig(); const result=await api('/api/capture-preview',{method:'POST'}); const monitor=$('#monitor');
    monitor.classList.toggle('window-paused',Boolean(result.minimized||result.unavailable));
    if(result.minimized){monitor.classList.remove('source-preview');monitorPlaceholder('ОКНО СВЁРНУТО','В эфире заглушка, звук продолжает идти','minus');}
    else if(result.unavailable){monitor.classList.remove('source-preview');monitorPlaceholder('ОКНО НЕДОСТУПНО','Откройте приложение или обновите список','alert');}
    else{$('#capturePreview').src=`${result.url}&cache=${Date.now()}`;monitor.classList.add('source-preview');monitorPlaceholder('ИСТОЧНИК НЕ ВЫБРАН','Выберите медиа, окно, монитор или область');}
    $('#monitorBadge').textContent=result.minimized?'PAUSED':result.unavailable?'MISSING':'PREVIEW';
  } catch(error){
    if(!$('#monitor').classList.contains('source-preview')){monitorPlaceholder('НЕТ ПРЕДПРОСМОТРА',error.message||'Обновите список источников','alert');$('#monitorBadge').textContent='RETRY';}
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
$('#refreshPreview').addEventListener('click',()=>refreshCapturePreview().catch(error=>toast(error.message,true))); $('#highlightSource').addEventListener('click',highlightSelected);
$('#applyCapture').addEventListener('click',async()=>{const button=$('#applyCapture');button.disabled=true;try{await saveConfig();$('#monitor').classList.remove('source-preview','window-paused');render(await api('/api/start/screen',{method:'POST'}));toast('Источник применён');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
$('#selectRegion').addEventListener('click',()=>{window.location.href='vrcast://select-region';}); $('#pickLocal').addEventListener('click',()=>{window.location.href='vrcast://pick-media';});
window.applySelectedRegion=region=>{$('#regionX').value=region.x;$('#regionY').value=region.y;$('#regionWidth').value=region.width;$('#regionHeight').value=region.height;refreshCapturePreview().catch(()=>{});toast(`Выбрано ${region.width}×${region.height}`);};
window.addLocalFiles=async paths=>{try{const result=await api('/api/queue/local',{method:'POST',body:JSON.stringify({paths})});render(result.status);toast(`Добавлено: ${result.added.length}`);}catch(error){toast(error.message,true);}};

$('#addForm').addEventListener('submit',async event=>{event.preventDefault();const button=$('#addButton');button.disabled=true;button.textContent='…';try{const result=await api('/api/queue',{method:'POST',body:JSON.stringify({url:$('#mediaUrl').value})});$('#mediaUrl').value='';render(result.status);toast(`Добавлено: ${result.added.length}`);}catch(error){toast(error.message,true);}finally{button.disabled=false;button.textContent='Добавить';}});
$('#queueList').addEventListener('click',async event=>{
  const row=event.target.closest('.queue-item'); if(!row)return;
  const id=row.dataset.id;
  try{
    if(event.target.closest('.remove-item')){ if(id===ui.localPreviewId)очиститьЛокальныйПредпросмотр(); render(await api(`/api/queue/${id}`,{method:'DELETE'})); return; }
    if($('#playerMode').value==='unity'){ ui.unitySelectedId=id; if(ui.status)render(ui.status); toast('Трек выбран — нажмите «Подготовить».'); return; }
    // Эфир идёт — переключаемся на этот трек прямо в эфире.
    if(ui.status?.running){ await playback('jump',{id}); return; }
    // Эфира нет — открываем трек в предпросмотре, ничего не вещая. Стрим
    // начнётся только по кнопке «Начать эфир видео».
    показатьЛокальныйПредпросмотр(id);
  }catch(error){toast(error.message,true);}
});
$('#queueList').addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('.queue-item')){event.preventDefault();playback('jump',{id:event.target.dataset.id});}});
$('#clearQueue').addEventListener('click',async()=>{try{render(await api('/api/queue',{method:'DELETE'}));}catch(error){toast(error.message,true);}});
$('#templateSelect').addEventListener('change',event=>{const item=ui.status?.templates?.find(entry=>entry.id===event.target.value);if(item)$('#templateName').value=item.name;$('#loadTemplate').disabled=!item;$('#appendTemplate').disabled=!item;$('#deleteTemplate').disabled=!item;});
$('#saveTemplate').addEventListener('click',async()=>{const button=$('#saveTemplate');button.disabled=true;try{const result=await api('/api/templates',{method:'POST',body:JSON.stringify({id:$('#templateSelect').value,name:$('#templateName').value})});render(result.status);$('#templateSelect').value=result.id;$('#templateSelect').dispatchEvent(new Event('change'));toast('Шаблон очереди сохранён');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
async function loadTemplate(append){const id=$('#templateSelect').value;if(!id)return;try{render(await api(`/api/templates/${encodeURIComponent(id)}/load`,{method:'POST',body:JSON.stringify({append})}));toast(append?'Шаблон добавлен к очереди':'Шаблон загружен');}catch(error){toast(error.message,true);}}
$('#loadTemplate').addEventListener('click',()=>loadTemplate(false)); $('#appendTemplate').addEventListener('click',()=>loadTemplate(true));
$('#deleteTemplate').addEventListener('click',async()=>{const id=$('#templateSelect').value;if(!id)return;try{render(await api(`/api/templates/${encodeURIComponent(id)}`,{method:'DELETE'}));$('#templateName').value='';toast('Шаблон удалён');}catch(error){toast(error.message,true);}});
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
  if (ui.previewOn) { if (ui.status) startPreview(ui.status); }
  else { stopPreview(); if (ui.status?.running) monitorPlaceholder('Картинка выключена','Эфир идёт, окно не тратит процессор','eye-off'); }
  toast(ui.previewOn?'Предпросмотр включён':'Предпросмотр выключен — процессор свободнее');
});
// Свёрнутое окно программы не должно ничего декодировать.
document.addEventListener('visibilitychange',()=>{
  ui.windowHidden=document.hidden;
  if (document.hidden) stopPreview(); else if (ui.status) startPreview(ui.status);
});
for (const [event,hidden] of [['vrcast-hidden',true],['vrcast-shown',false]]) {
  document.addEventListener(event,()=>{
    ui.windowHidden=hidden;
    if (hidden) stopPreview(); else if (ui.status) startPreview(ui.status);
  });
}
$('#clearCache').addEventListener('click',async()=>{
  try{ render(await api('/api/cache/clear',{method:'POST'})); toast('Кеш очищен'); }
  catch(error){ toast(error.message,true); }
});
$('#seekBar').addEventListener('input',event=>{ui.seeking=true;const percent=Number(event.target.value)/10;event.target.style.setProperty('--seek',`${percent}%`);const total=Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*percent/100;$('#elapsedTime').textContent=formatTime(ui.seekDraft);});
$('#seekBar').addEventListener('change',async event=>{const total=Number(ui.status?.progress?.duration)||0;ui.seekDraft=total*Number(event.target.value)/1000;ui.seeking=false;ui.seekPending=true;ui.seekRevision=Number(ui.status?.playback?.revision||0)+1;if(!await playback('seek',{position:ui.seekDraft}))ui.seekPending=false;});
function applyQualityLive(kind,что='Качество'){clearTimeout(ui.liveApplyTimer);ui.liveApplyTimer=setTimeout(async()=>{try{const live=ui.status?.activeKind===kind;render(await saveConfig(live));toast(live?`${что} применён${что==='Качество'?'о':''}`:`${что} сохранён${что==='Качество'?'о':''}`);}catch(error){toast(error.message,true);}},350);}
$('#quality').addEventListener('change',()=>applyQualityLive('screen'));$('#fps').addEventListener('change',()=>applyQualityLive('screen'));
// Битрейт применяется к тому, что идёт прямо сейчас: раньше выбор просто лежал
// в настройках до следующего запуска, и казалось, что регулятор ничего не делает.
$('#videoBitrate').addEventListener('change',()=>applyQualityLive(ui.status?.activeKind||'screen','Битрейт'));
$('#encoderMode').addEventListener('change',()=>applyQualityLive(ui.status?.activeKind||'screen','Кодировщик'));
$('#tunnelProviderSelect').addEventListener('change',async()=>{try{render(await saveConfig(false));toast('Быстрая ссылка переподключается');}catch(error){toast(error.message,true);}});
$('#mediaQuality').addEventListener('change',()=>applyQualityLive('queue'));$('#mediaFps').addEventListener('change',()=>applyQualityLive('queue'));
$('#speedSelect').addEventListener('click',async()=>{const current=Number($('#speedSelect').dataset.value)||1;
  const next=SPEED_STEPS[(SPEED_STEPS.indexOf(current)+1)%SPEED_STEPS.length];
  paintSpeed(next);ui.speedPendingUntil=Date.now()+1500;await playback('speed',{speed:next});paintSpeed(next);ui.speedPendingUntil=0;});
$('#loopSelect').addEventListener('click',async()=>{const current=$('#loopSelect').dataset.value||'once';
  const next=LOOP_STEPS[(LOOP_STEPS.findIndex(item=>item[0]===current)+1)%LOOP_STEPS.length][0];
  paintLoop(next);ui.loopPendingUntil=Date.now()+1500;await playback('loop',{mode:next});paintLoop(next);ui.loopPendingUntil=0;});
// Сегменты: один клик — одно изменение, без второго выпадающего списка
// поверх первого. Значение продолжает жить в скрытом select, поэтому весь
// остальной код (сохранение настроек, восстановление при запуске) не менялся.
function paintSegments(select) {
  const box=document.querySelector(`.seg[data-for="${select.id}"]`);
  if(!box)return;
  for(const button of box.children)button.setAttribute('aria-checked',String(button.dataset.value===select.value));
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
$('#mediaVolume').addEventListener('change',async event=>{if(ui.status?.activeKind==='queue')playback('volume',{volume:Number(event.target.value)/100});else try{await saveConfig();}catch(error){toast(error.message,true);}});
$('#captureVolume').addEventListener('input',event=>paintVolume(event.target,$('#captureVolumeValue')));

$('#goLive').addEventListener('click',async()=>{const button=$('#goLive');button.disabled=true;try{await saveConfig();const тело=ui.source==='queue'&&ui.localPreviewId?JSON.stringify({id:ui.localPreviewId}):undefined;
  render(await api(`/api/start/${ui.source}`,{method:'POST',body:тело}));ui.localPreviewId='';toast(ui.output==='tunnel'?'Запускаю эфир и получаю публичную ссылку':'Эфир запускается');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
$('#stopLive').addEventListener('click',async()=>{try{render(await api('/api/stop',{method:'POST'}));}catch(error){toast(error.message,true);}});
$('#updateButton').addEventListener('click',()=>{const update=ui.status?.update;if(!update?.available)return;ui.offeredVersion=update.version;paintUpdateDialog(update);if(!updateDialog.open)updateDialog.showModal();});
$('#showLogs').addEventListener('click',()=>$('#logDialog').showModal());
$('#openLogFolder').addEventListener('click',()=>{window.location.href='vrcast://open-folder';});
$('#appSoundSettings').addEventListener('click',()=>{window.location.href='vrcast://app-sound';}); $('#closeLogs').addEventListener('click',()=>$('#logDialog').close());

async function refresh(){try{render(await api('/api/status'));}catch(error){if(ui.status)toast(error.message,true);}}
async function init(){const state=await api('/api/status');ui.output=state.config.outputMode;chooseOutput(ui.output);$('#quality').value=state.config.quality;$('#fps').value=String(state.config.fps);$('#mediaQuality').value=state.config.mediaQuality||'720p';$('#mediaFps').value=String(state.config.mediaFps||30);$('#videoBitrate').value=String(state.config.videoBitrate??0);$('#encoderMode').value=state.config.encoderMode||'auto';$('#tunnelProviderSelect').value=state.config.tunnelProvider||'auto';$('#captureMode').value=state.config.captureMode;$('#regionX').value=state.config.regionX;$('#regionY').value=state.config.regionY;$('#regionWidth').value=state.config.regionWidth;$('#regionHeight').value=state.config.regionHeight;$('#audioMode').value=state.config.audioMode;$('#localAppVolume').value=String(state.config.localAppVolume??1);paintLoop(state.config.loopMode||'once');paintSpeed(state.config.playbackSpeed||1);$('#mediaVolume').value=String(Math.round((state.config.mediaVolume??1)*100));$('#captureVolume').value=String(Math.round((state.config.captureVolume??1.5)*100));paintVolume($('#mediaVolume'),$('#mediaVolumeValue'));paintVolume($('#captureVolume'),$('#captureVolumeValue'));chooseCaptureMode(state.config.captureMode);chooseAudioMode(state.config.audioMode);открытьДобавление(!state.config.servers?.length);paintPreviewToggle();buildSegments();render(state);await loadCaptureSources();setInterval(refresh,800);setInterval(renderProgress,200);// Снимок источника обновляем только когда открыта вкладка «Экран», окно видно и эфир не идёт: раньше программа бесконечно порождала ffmpeg каждые две секунды даже на простое.
// Пока открыта вкладка «Экран» и эфир не идёт, сервер держит живой поток
// картинки — забираем её пятнадцать раз в секунду. Раз в две секунды просим
// сервер поддержать поток: без этого он гаснет сам через пять секунд.
ui.previewTimer=setInterval(()=>{if(ui.source!=='screen'||document.hidden||ui.windowHidden||ui.status?.activeKind==='screen')return;refreshCapturePreview(false).catch(()=>{});},2000);
ui.previewFrameTimer=setInterval(()=>{
  if(ui.source!=='screen'||document.hidden||ui.windowHidden||ui.status?.activeKind==='screen')return;
  const снимок=$('#capturePreview');
  if(!снимок.getAttribute('src'))return;
  снимок.src=`/api/capture-preview?time=${Date.now()}`;
},66);
const stall={time:0,strikes:0};
setInterval(()=>{const video=$('#streamPreview');
  if(!ui.hls||!ui.status?.running||ui.status?.stream?.state!=='ready'){stall.strikes=0;stall.time=video.currentTime;return;}
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
  toast(ok?'Журнал скопирован':'Не удалось скопировать');
});

// Эфир поднимается сам при запуске программы: ссылка работает сразу, в кадре
// стоит заставка. Видео включает пользователь — кнопкой в плеере.
async function startSource(){
  const button=$('#togglePause');
  button.disabled=true;
  try{ await saveConfig(); render(await api(`/api/start/${ui.source}`,{method:'POST'})); }
  catch(error){ toast(error.message,true); }
  finally{ button.disabled=false; }
}


// Обновление: окно появляется само, когда на GitHub вышла версия новее.
// «Позже» откладывает на сутки, «Пропустить» — до следующей версии.
const updateDialog=$('#updateDialog');
function updateBlocked(version){
  if(localStorage.getItem('skipVersion')===version)return true;
  const снова=Number(localStorage.getItem('updateSnooze')||0);
  return Date.now()<снова;
}

function paintUpdateDialog(update){
  $('#updateVersion').textContent=update.version||'';
  $('#updateNotes').textContent=(update.notes||'').replace(/^#{1,6}\s*/gm,'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/`/g,'').trim()||'Исправления и улучшения.';
  // Видно, что именно качается и сколько осталось: раньше здесь висело
  // «Скачиваю…» без единой цифры на все пятьдесят мегабайт.
  const процент=Number(update.percent)||0;
  const строка=update.error?`Не удалось скачать: ${update.error}`
    :update.ready?`Загружено, ${update.totalMb||0} МБ — можно устанавливать`
    :update.totalMb?`Скачиваю VRCast Bridge ${update.version} — ${update.doneMb||0} МБ из ${update.totalMb} МБ`
    :'Начинаю загрузку…';
  $('#updateProgress').textContent=строка;
  $('#updateBar').hidden=Boolean(update.ready||update.error);
  $('#updateBar').firstElementChild.style.width=`${update.ready?100:процент}%`;
  $('#updateNow').disabled=!update.ready;
  $('#updateNow').textContent=update.ready?'Обновить':(процент?`Скачиваю ${процент}%`:'Скачиваю…');
}
function offerUpdate(update){
  if(!update?.available||!update.version)return;
  paintUpdateDialog(update);
  if(updateDialog.open||updateBlocked(update.version))return;
  ui.offeredVersion=update.version;
  updateDialog.showModal();
}
$('#updateLater').addEventListener('click',()=>{
  localStorage.setItem('updateSnooze',String(Date.now()+24*60*60*1000));
  updateDialog.close(); toast('Напомню завтра');
});
$('#updateSkip').addEventListener('click',()=>{
  if(ui.offeredVersion)localStorage.setItem('skipVersion',ui.offeredVersion);
  updateDialog.close(); toast('Эта версия пропущена');
});
$('#updateNow').addEventListener('click',async()=>{
  $('#updateNow').disabled=true; $('#updateProgress').textContent='Устанавливаю, программа перезапустится…';
  // Сервер закрывается сразу после ответа, поэтому оборванный запрос здесь
  // означает «пошла установка», а не сбой.
  try{ await api('/api/update/apply',{method:'POST'}); }
  catch(error){ if(!/fetch|network|Failed/i.test(String(error.message))){ toast(error.message,true); $('#updateNow').disabled=false; } }
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
