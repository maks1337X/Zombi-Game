const canvas = document.getElementById('gc');
const ctx = canvas.getContext('2d');

// ===== CONSTANTS =====
const TILE = 64;
const MAPSZ = 41;
const AMMO_MAX = 5;
const MINE_RADIUS = 88;
const BARREL_HP = 100;
const BARREL_R = 20;
const MAX_AMMO_P = 6;
const MAX_MED_P = 4;
const BASE_DEPOT_R = 170;
// Босс: физический размер как у обычного зомби
const BOSS_SIZE = 28;

// ===== STATE =====
let gState = 'MENU';
let currentPlayers = 2; // 1 или 2
let players = [];
let zombies = [];
let bullets = [];
let bossProj = [];
let droppedCoins = [];
let mines = [];
let barrels = [];
let poisonPools = [];
let ammoPickups = [];
let medPickups = [];
let dmgNums = [];
let airdrops = []; // система воздушных дропов
let wave = 10000;
let waveSpawning = true;
let waveTotal = 10000;
let waveSpawned = 100000;
let gCoins = 0;
let depotAmmo = 0;
let depotMed = 0;
let cam = { x: 0, y: 0 };
let audioCtx = null;
let flowP = [], flowB = [];
let tick = 0;
let tpQueue = [];
let lastTP = 0;
let ammoCD = 0, medCD = 0;
let musicTmr = null, ambTmr = null;
let fpsCnt = 0, fpsVal = 0, fpsLast = performance.now();
let listeningFor = null;
let listeningCtx = 'menu';
const maze = [];
const tileRnd = [];
const keys = {};
let mDown = false;
let floorCache = null;
// ====================== MQTT МУЛЬТИПЛЕЕР (добавлено) ======================
let mqttClient = null;
let roomId = null;
let isHost = false;
let myPlayerId = 1;
let multiplayerMode = false;
let lastWorldSync = 0;
let lastInputSend = 0;

const MQTT_BROKER = "broker.hivemq.com";
const MQTT_PORT = 8884;

function startOnlineLobby() {
  document.getElementById('ui-menu').classList.add('hidden');
  document.getElementById('ui-lobby').classList.remove('hidden');
  document.getElementById('lobby-info').innerHTML = 'Готовы к бою?<br>Создайте комнату или введите ID от друга.';
}

function closeLobby() {
  if (mqttClient) mqttClient.disconnect();
  mqttClient = null;
  roomId = null;
  document.getElementById('ui-lobby').classList.add('hidden');
  document.getElementById('ui-menu').classList.remove('hidden');
}

function createMQTTGame() {
  roomId = String(100000 + Math.floor(Math.random() * 900000));
  isHost = true;
  myPlayerId = 1;
  document.getElementById('lobby-info').innerHTML = `
    <b>Комната создана!</b><br>
    ID: <span style="font-size:1.6rem;color:#ff0">${roomId}</span><br>
    Отправьте этот ID другу и нажмите «Присоединиться» у него.<br>
    <span style="color:#88ff88">Ожидаем второго игрока...</span>
  `;
  connectMQTT();
}

function joinMQTTGame() {
  const input = document.getElementById('room-id-input').value.trim();
  if (!input || input.length !== 6) {
    alert('Введите 6-значный ID комнаты!');
    return;
  }
  roomId = input;
  isHost = false;
  myPlayerId = 2;
  document.getElementById('lobby-info').innerHTML = `Присоединяемся к комнате <b>${roomId}</b>...`;
  connectMQTT();
}

function connectMQTT() {
  const clientId = `zombie_${myPlayerId}_${Date.now()}`;
  mqttClient = new Paho.MQTT.Client(MQTT_BROKER, Number(MQTT_PORT), clientId);
  
  mqttClient.onConnectionLost = (resp) => {
    console.warn('MQTT соединение потеряно:', resp.errorMessage || resp);
    
    // Автопереподключение
    setTimeout(() => {
      if (mqttClient && !mqttClient.isConnected() && roomId) {
        console.log("Повторное подключение к комнате " + roomId + "...");
        connectMQTT();
      }
    }, 1800);
  };
  
  mqttClient.onMessageArrived = handleMQTTMessage;
  
  mqttClient.connect({
    useSSL: true,
    keepAliveInterval: 30,     // увеличил до 30 секунд
    cleanSession: true,
    onSuccess: () => {
      console.log(`✅ MQTT подключён к комнате ${roomId} (WSS)`);
      mqttClient.subscribe(`zombie/room/${roomId}/#`);
      
      sendMQTT({ 
        type: 'join', 
        id: myPlayerId, 
        name: pNames[myPlayerId-1] || ('Игрок ' + myPlayerId), 
        costume: pCostumes[myPlayerId-1] ? pCostumes[myPlayerId-1].id : 'soldier' 
      });
    },
    onFailure: (err) => {
      console.error("Ошибка подключения MQTT:", err);
      setTimeout(connectMQTT, 3000); // повторная попытка
    }
  });
}

function sendMQTT(payload) {
  if (!mqttClient || !mqttClient.isConnected()) {
    //console.warn("MQTT не подключён, сообщение пропущено");
    return;
  }
  try {
    const msg = new Paho.MQTT.Message(JSON.stringify(payload));
    msg.destinationName = `zombie/room/${roomId}/data`;
    mqttClient.send(msg);
  } catch (e) {
    //console.warn("Ошибка отправки:", e);
  }
}

function handleMQTTMessage(message) {
  let data;
  try { 
    data = JSON.parse(message.payloadString); 
  } catch(e) { 
    return; 
  }

  if (typeof onlinePlayers === 'undefined') onlinePlayers = {};

  if (data.type === 'join') {
    onlinePlayers[data.id] = data;
    console.log(`Игрок ${data.id} присоединился`);

    // === КРИТИЧНОЕ ИСПРАВЛЕНИЕ ===
    // Если в комнате уже 2 игрока — запускаем игру У ВСЕХ
    if (Object.keys(onlinePlayers).length >= 2) {
      console.log("✅ В комнате 2 игрока. Запускаем игру для всех...");
      
      if (gState !== 'PLAYING') {
        initGame(2, true);
      }
    }
  }
  
  else if (data.type === 'playerState' && !isHost) {
    const p = players.find(pl => pl.id === data.id);
    if (p && p.id !== myPlayerId) {
      p.x = data.x || p.x;
      p.y = data.y || p.y;
      p.hp = data.hp || p.hp;
    }
  }
  
  else if (data.type === 'worldState' && !isHost) {
    applyRemoteWorldState(data.state);
  }
  
  else if (data.type === 'playerAction' && isHost) {
    executeRemoteAction(data);
  }
}

const base = { x: 20.5*TILE, y: 20.5*TILE, size: 76, hp: 360, maxHp: 360, alive: true, radius: 42 };

// ===== COSTUMES =====
const COSTUMES = [
 { id:'soldier', name:'Воин', body:'#556b2f', head:'#8b7355', helm:'#3a4a2a', det:'#8fbc8f', icon:'🗡' },
 { id:'medic', name:'Медик', body:'#e0e0e0', head:'#fdbcb4', helm:'#cccccc', det:'#ff4444', icon:'⚕️' },
 { id:'scout', name:'Разведчик', body:'#8b4513', head:'#cd853f', helm:'#654321', det:'#d2691e', icon:'🕵️' },
 { id:'heavy', name:'Тяжёлый', body:'#445566', head:'#c0a080', helm:'#2a2a44', det:'#6677aa', icon:'🛡️' },
 { id:'punk', name:'Панк', body:'#1a0030', head:'#fdbcb4', helm:'#8800cc', det:'#ff00ff', icon:'🎸' },
 { id:'ranger', name:'Рейнджер', body:'#2d5a27', head:'#d2a679', helm:'#1a3a15', det:'#88cc55', icon:'🌲' },
];
let pCostumes = [COSTUMES[0], COSTUMES[3]];
let pNames = ['ИГРОК 1', 'ИГРОК 2'];

// ===== CONTROLS =====
const DEF_CTRL = [
 { up:'KeyW', down:'KeyS', left:'KeyA', right:'KeyD', shoot:'Space', mine:'ShiftLeft', barrel:'KeyE', reload:'KeyR', interact:'KeyF' },
 { up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', shoot:'ControlRight', mine:'ShiftRight', barrel:'Numpad0', reload:'NumpadSubtract', interact:'NumpadAdd' }
];
const CTRL_LBL = { up:'Вверх', down:'Вниз', left:'Влево', right:'Вправо', shoot:'Стрельба', mine:'Мина', barrel:'Бочка', reload:'Перезарядка', interact:'Взаимодействие' };
let pCtrl = [ {...DEF_CTRL[0]}, {...DEF_CTRL[1]} ];

function keyName(code) {
 const m = { Space:'Пробел',ShiftLeft:'L.Shift',ShiftRight:'R.Shift',ControlLeft:'L.Ctrl',ControlRight:'R.Ctrl',AltLeft:'L.Alt',AltRight:'R.Alt',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',NumpadSubtract:'Num-',NumpadAdd:'Num+',Numpad0:'Num0',Enter:'Enter' };
 if(m[code]) return m[code];
 if(code.startsWith('Key')) return code.slice(3);
 if(code.startsWith('Digit')) return code.slice(5);
 if(code.startsWith('Numpad')) return 'Num'+code.slice(6);
 return code;
}

function buildCtrlUI(cid, ctx2) {
 cid = cid||'ctrl-ui'; ctx2 = ctx2||'menu';
 const c = document.getElementById(cid);
 if(!c) return;
 c.innerHTML = '';
 const numPlayers = currentPlayers || 2;
 for(let pi=0;pi<numPlayers;pi++){
 const box=document.createElement('div');
 box.className='ctrl-box';
 const ttl=document.createElement('div');
 ttl.className='ctrl-title '+(pi===0?'p1-c':'p2-c');
 ttl.textContent=pi===0?'⚡ ИГРОК 1':'⚡ ИГРОК 2';
 box.appendChild(ttl);
 for(const a in CTRL_LBL){
 const row=document.createElement('div');row.className='ctrl-row';
 const lbl=document.createElement('span');lbl.className='ctrl-lbl';lbl.textContent=CTRL_LBL[a];
 const btn=document.createElement('button');btn.className='key-btn';
 btn.id='kb-'+ctx2+'-'+pi+'-'+a;
 btn.textContent=keyName(pCtrl[pi][a]);
 btn.onclick=()=>startListen(pi,a,ctx2);
 row.appendChild(lbl);row.appendChild(btn);box.appendChild(row);
 }
 const rb=document.createElement('button');
 rb.style.cssText='margin-top:5px;width:100%;padding:3px;background:rgba(60,0,0,0.42);border:1px solid #844;border-radius:5px;color:#faa;font-size:0.68rem;cursor:pointer;';
 rb.textContent='↺ Сброс';
 rb.onclick=()=>{pCtrl[pi]={...DEF_CTRL[pi]};buildCtrlUI(cid,ctx2);};
 box.appendChild(rb);
 c.appendChild(box);
 }
}

function startListen(pi, action, ctx2) {
 if(listeningFor){
 const b=document.getElementById('kb-'+listeningCtx+'-'+listeningFor.pi+'-'+listeningFor.a);
 if(b){b.classList.remove('listening');b.textContent=keyName(pCtrl[listeningFor.pi][listeningFor.a]);}
 }
 listeningFor={pi,a:action};listeningCtx=ctx2;
 const btn=document.getElementById('kb-'+ctx2+'-'+pi+'-'+action);
 if(btn){btn.classList.add('listening');btn.textContent='...';}
}

function buildCostUI() {
 const c=document.getElementById('cost-ui');
 if(!c) return;
 c.innerHTML='';
 
 for(let pi=0;pi<2;pi++){
   const box=document.createElement('div');
   box.className='cost-box';
   box.style.cssText='background:rgba(6,18,3,0.92);border:1.5px solid rgba(70,140,35,0.4);border-radius:14px;padding:14px 16px;text-align:center;';
   
   // Заголовок игрока
   const nameRow=document.createElement('div');
   nameRow.innerHTML='<div class="'+(pi===0?'p1-c':'p2-c')+'" style="font-weight:800;font-size:0.9rem;margin-bottom:6px;">'+(pi===0?'⚡ ИГРОК 1':'⚡ ИГРОК 2')+'</div>';
   box.appendChild(nameRow);
   
   // Поле ввода имени
   const ni=document.createElement('input');
   ni.type='text';
   ni.className='name-inp';
   ni.placeholder='Введи имя...';
   ni.maxLength=16;
   ni.value=pNames[pi];
   ni.addEventListener('input',()=>{pNames[pi]=ni.value||'ИГРОК '+(pi+1);});
   ni.addEventListener('keydown',e=>e.stopPropagation());
   box.appendChild(ni);
   
   // Большое превью персонажа
   const prevWrap=document.createElement('div');
   prevWrap.style.cssText='position:relative;margin:10px auto;width:120px;height:150px;';
   
   const cvs=document.createElement('canvas');
   cvs.width=120;
   cvs.height=150;
   cvs.style.cssText='display:block;border-radius:10px;background:linear-gradient(180deg,rgba(10,30,5,0.9),rgba(5,15,2,0.95));border:2px solid '+(pi===0?'rgba(0,200,255,0.5)':'rgba(255,0,255,0.5)')+';box-shadow:0 0 15px '+(pi===0?'rgba(0,200,255,0.2)':'rgba(255,0,255,0.2)')+';';
   cvs.id='cprev-'+pi;
   prevWrap.appendChild(cvs);
   
   // Метка игрока поверх превью
   const badge=document.createElement('div');
   badge.style.cssText='position:absolute;top:4px;right:4px;background:'+(pi===0?'rgba(0,200,255,0.8)':'rgba(255,0,255,0.8)')+';color:#fff;font-size:0.6rem;font-weight:900;padding:2px 5px;border-radius:4px;';
   badge.textContent='П'+(pi+1);
   prevWrap.appendChild(badge);
   
   box.appendChild(prevWrap);
   drawCostPrevLarge(pi,cvs);
   
   // Название костюма
   const lbl=document.createElement('div');
   lbl.style.cssText='font-size:0.85rem;color:#ccff88;margin:4px 0 8px;font-weight:700;letter-spacing:0.05em;';
   lbl.textContent=pCostumes[pi].name;
   lbl.id='costlbl-'+pi;
   box.appendChild(lbl);
   
   // Описание костюма
   const desc=document.createElement('div');
   desc.style.cssText='font-size:0.65rem;color:#88aa66;margin-bottom:8px;min-height:1.4em;';
   desc.id='costdesc-'+pi;
   desc.textContent=getCostumeDesc(pCostumes[pi].id);
   box.appendChild(desc);
   
   // Кнопки выбора скинов
   const optsLabel=document.createElement('div');
   optsLabel.style.cssText='font-size:0.65rem;color:#667;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.1em;';
   optsLabel.textContent='Выбери скин:';
   box.appendChild(optsLabel);
   
   const opts=document.createElement('div');
   opts.className='cost-opts';
   opts.style.cssText='display:flex;flex-wrap:wrap;gap:6px;justify-content:center;';
   
   COSTUMES.forEach(co=>{
     const opt=document.createElement('div');
     opt.style.cssText='width:40px;height:40px;border-radius:8px;border:2px solid '+(pCostumes[pi].id===co.id?'#ffcc00':'#444')+';cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:0.75rem;transition:all 0.15s;background:'+co.body+';position:relative;overflow:hidden;';
     opt.title=co.name;
     
     // Мини иконка
     const iconSpan=document.createElement('span');
     iconSpan.textContent=co.icon;
     iconSpan.style.cssText='font-size:1.1rem;line-height:1;';
     opt.appendChild(iconSpan);
     
     // Подпись
     const nameSpan=document.createElement('span');
     nameSpan.textContent=co.name.substring(0,4);
     nameSpan.style.cssText='font-size:0.42rem;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.9);font-weight:700;margin-top:1px;';
     opt.appendChild(nameSpan);
     
     opt.onclick=()=>{
       pCostumes[pi]=co;
       
       // Обновляем название и описание
       const lbl2=document.getElementById('costlbl-'+pi);
       if(lbl2)lbl2.textContent=co.name;
       const desc2=document.getElementById('costdesc-'+pi);
       if(desc2)desc2.textContent=getCostumeDesc(co.id);
       
       // Перерисовываем превью
       const cv2=document.getElementById('cprev-'+pi);
       if(cv2)drawCostPrevLarge(pi,cv2);
       
       // Обновляем все кнопки
       opts.querySelectorAll('div').forEach((o,idx)=>{
         if(idx<COSTUMES.length){
           const isSelected=COSTUMES[idx].id===co.id;
           o.style.border='2px solid '+(isSelected?'#ffcc00':'#444');
           // Удаляем старую галочку
           const oldCheck=o.querySelector('.sel-check');
           if(oldCheck)oldCheck.remove();
           // Добавляем новую
           if(isSelected){
             const newCheck=document.createElement('div');
             newCheck.className='sel-check';
             newCheck.style.cssText='position:absolute;top:1px;right:2px;color:#ffcc00;font-size:0.55rem;font-weight:900;';
             newCheck.textContent='✓';
             o.appendChild(newCheck);
           }
         }
       });
     };
     
     // Hover эффект
     opt.addEventListener('mouseenter',()=>{
       if(pCostumes[pi].id!==co.id){
         opt.style.transform='scale(1.15)';
         opt.style.border='2px solid #88bb66';
         // Показываем превью при наведении
         const cv2=document.getElementById('cprev-'+pi);
         if(cv2){
           const tempCo=co;
           drawCostPrevLargeTemp(pi,cv2,tempCo);
         }
       }
     });
     
     opt.addEventListener('mouseleave',()=>{
       if(pCostumes[pi].id!==co.id){
         opt.style.transform='scale(1)';
         opt.style.border='2px solid #444';
         // Возвращаем текущий скин
         const cv2=document.getElementById('cprev-'+pi);
         if(cv2)drawCostPrevLarge(pi,cv2);
       }
     });
     
     opts.appendChild(opt);
   });
   
   box.appendChild(opts);
   
   // Стрелки навигации влево/вправо
   const navRow=document.createElement('div');
   navRow.style.cssText='display:flex;gap:8px;justify-content:center;margin-top:10px;';
   
   const btnPrev=document.createElement('button');
   btnPrev.style.cssText='background:rgba(70,140,35,0.3);border:1px solid #88bb66;border-radius:6px;color:#ccff88;padding:4px 12px;cursor:pointer;font-size:0.8rem;transition:all 0.15s;';
   btnPrev.textContent='◀ Пред.';
   btnPrev.onclick=()=>{
     const idx=COSTUMES.findIndex(co=>co.id===pCostumes[pi].id);
     const newIdx=(idx-1+COSTUMES.length)%COSTUMES.length;
     pCostumes[pi]=COSTUMES[newIdx];
     buildCostUI();
   };
   
   const btnNext=document.createElement('button');
   btnNext.style.cssText='background:rgba(70,140,35,0.3);border:1px solid #88bb66;border-radius:6px;color:#ccff88;padding:4px 12px;cursor:pointer;font-size:0.8rem;transition:all 0.15s;';
   btnNext.textContent='След. ▶';
   btnNext.onclick=()=>{
     const idx=COSTUMES.findIndex(co=>co.id===pCostumes[pi].id);
     const newIdx=(idx+1)%COSTUMES.length;
     pCostumes[pi]=COSTUMES[newIdx];
     buildCostUI();
   };
   
   navRow.appendChild(btnPrev);
   navRow.appendChild(btnNext);
   box.appendChild(navRow);
   
   c.appendChild(box);
 }
}

function getCostumeDesc(id){
 const descs={
   'soldier':'Опытный боец. Военная форма защитного цвета.',
   'medic':'Полевой медик. Белый халат с красным крестом.',
   'scout':'Разведчик. Коричневый камуфляж для скрытности.',
   'heavy':'Тяжёлый боец. Тёмная броня выдержит многое.',
   'punk':'Панк. Фиолетовый шлем и неоновые детали.',
   'ranger':'Рейнджер. Лесной камуфляж, один с природой.'
 };
 return descs[id]||'';
}

function drawCostPrevLarge(pi,cvs){
 drawCostPrevLargeTemp(pi,cvs,pCostumes[pi]);
}

function drawCostPrevLargeTemp(pi,cvs,co){
 const c2=cvs.getContext('2d');
 const W=cvs.width,H=cvs.height;
 c2.clearRect(0,0,W,H);
 
 // Фон с градиентом
 const bg=c2.createLinearGradient(0,0,0,H);
 bg.addColorStop(0,'rgba(10,30,5,0.95)');
 bg.addColorStop(1,'rgba(5,15,2,0.98)');
 c2.fillStyle=bg;
 c2.fillRect(0,0,W,H);
 
 // Сетка на фоне
 c2.strokeStyle='rgba(70,140,35,0.08)';
 c2.lineWidth=1;
 for(let gx=0;gx<W;gx+=12){
   c2.beginPath();c2.moveTo(gx,0);c2.lineTo(gx,H);c2.stroke();
 }
 for(let gy=0;gy<H;gy+=12){
   c2.beginPath();c2.moveTo(0,gy);c2.lineTo(W,gy);c2.stroke();
 }
 
 // Свечение под персонажем
 const glow=c2.createRadialGradient(W/2,H*0.85,0,W/2,H*0.85,40);
 glow.addColorStop(0,pi===0?'rgba(0,200,255,0.15)':'rgba(255,0,255,0.15)');
 glow.addColorStop(1,'rgba(0,0,0,0)');
 c2.fillStyle=glow;
 c2.fillRect(0,0,W,H);
 
 const cx=W/2;
 const cy=H*0.65;
 const scale=1.7;
 
 c2.save();
 c2.translate(cx,cy);
 c2.scale(scale,scale);
 c2.translate(-cx,-cy);
 
 // Тень
 c2.fillStyle='rgba(0,0,0,0.4)';
 c2.beginPath();
 c2.ellipse(cx,cy+18,16,5,0,0,Math.PI*2);
 c2.fill();
 
 // Ноги
 c2.fillStyle=co.det;
 c2.fillRect(cx-8,cy+4,6,14);
 c2.fillRect(cx+2,cy+4,6,14);
 
 // Ботинки
 c2.fillStyle='#1a0a05';
 c2.fillRect(cx-9,cy+16,8,5);
 c2.fillRect(cx+1,cy+16,8,5);
 
 // Тело
 c2.fillStyle=co.body;
 c2.fillRect(cx-11,cy-8,22,14);
 
 // Детали на теле
 c2.fillStyle=co.det;
 c2.fillRect(cx-3,cy-6,6,2);
 c2.fillRect(cx-3,cy-2,6,2);
 
 // Тень на теле
 c2.fillStyle='rgba(0,0,0,0.15)';
 c2.fillRect(cx-11,cy-8,22,4);
 
 // Руки
 c2.fillStyle=co.body;
 c2.fillRect(cx-16,cy-7,5,12);
 c2.fillRect(cx+11,cy-7,5,12);
 
 // Перчатки
 c2.fillStyle=co.det;
 c2.beginPath();
 c2.arc(cx-13,cy+5,3.5,0,Math.PI*2);
 c2.fill();
 c2.beginPath();
 c2.arc(cx+13,cy+5,3.5,0,Math.PI*2);
 c2.fill();
 
 // Оружие
 c2.fillStyle='#555';
 c2.fillRect(cx+13,cy+3,11,4);
 c2.fillStyle='#777';
 c2.fillRect(cx+21,cy+2,3,3);
 c2.fillStyle='#222';
 c2.fillRect(cx+15,cy+4,6,2);
 
 // Шея
 c2.fillStyle=co.head;
 c2.fillRect(cx-3,cy-14,6,8);
 
 // Голова
 c2.fillStyle=co.head;
 c2.beginPath();
 c2.arc(cx,cy-22,11,0,Math.PI*2);
 c2.fill();
 
 // Шлем
 c2.fillStyle=co.helm;
 c2.fillRect(cx-13,cy-34,26,14);
 
 // Блик на шлеме
 c2.fillStyle='rgba(255,255,255,0.09)';
 c2.fillRect(cx-10,cy-33,12,4);
 
 // Визор
 c2.fillStyle='rgba(100,200,255,0.15)';
 c2.fillRect(cx-10,cy-28,20,6);
 
 // Глаза
 c2.fillStyle='#fff';
 c2.fillRect(cx-9,cy-24,6,6);
 c2.fillRect(cx+3,cy-24,6,6);
 
 c2.fillStyle='#0a0a22';
 c2.fillRect(cx-8,cy-23,4,4);
 c2.fillRect(cx+4,cy-23,4,4);
 
 c2.fillStyle='rgba(255,255,255,0.6)';
 c2.fillRect(cx-8,cy-23,1.5,1.5);
 c2.fillRect(cx+4,cy-23,1.5,1.5);
 
 c2.restore();
 
 // Название скина внизу
 const col=pi===0?'#0cf':'#f0f';
 c2.fillStyle='rgba(0,0,0,0.6)';
 c2.fillRect(0,H-28,W,28);
 
 c2.fillStyle=col;
 c2.font='bold 10px sans-serif';
 c2.textAlign='center';
 c2.shadowBlur=8;
 c2.shadowColor=col;
 c2.fillText(co.name,W/2,H-15);
 c2.shadowBlur=0;
 
 // Иконка костюма
 c2.font='16px sans-serif';
 c2.fillText(co.icon,W/2,H-30);
 
 // Метка П1/П2 вверху
 c2.fillStyle='rgba(0,0,0,0.5)';
 c2.fillRect(0,0,W,20);
 c2.fillStyle=col;
 c2.font='bold 9px sans-serif';
 c2.textAlign='center';
 c2.shadowBlur=6;
 c2.shadowColor=col;
 c2.fillText('ИГРОК '+(pi+1),W/2,14);
 c2.shadowBlur=0;
 
 // Цвет тела
 c2.fillStyle='rgba(0,0,0,0.4)';
 c2.fillRect(4,H-52,W-8,18);
 c2.strokeStyle='rgba(255,255,255,0.1)';
 c2.lineWidth=0.5;
 c2.strokeRect(4,H-52,W-8,18);
 
 c2.fillStyle='rgba(255,255,255,0.5)';
 c2.font='7px sans-serif';
 c2.textAlign='left';
 c2.fillText('Тело:',8,H-41);
 c2.fillText('Шлем:',52,H-41);
 
 c2.fillStyle=co.body;
 c2.fillRect(28,H-50,12,10);
 c2.strokeStyle='rgba(255,255,255,0.2)';
 c2.lineWidth=0.5;
 c2.strokeRect(28,H-50,12,10);
 
 c2.fillStyle=co.helm;
 c2.fillRect(72,H-50,12,10);
 c2.strokeRect(72,H-50,12,10);
}

// ===== MENU TABS =====
document.querySelectorAll('.menu-tab').forEach(t=>{
 t.addEventListener('click',()=>{
 document.querySelectorAll('.menu-tab').forEach(x=>x.classList.remove('active'));
 document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
 t.classList.add('active');
 document.getElementById('tab-'+t.dataset.tab).classList.add('active');
 });
});
buildCtrlUI('ctrl-ui','menu');
buildCostUI();

// ===== WEAPONS =====
const WEAPONS = {
 pistol: { name:'Пистолет', cost:0, dmg:35, clip:12, reload:800, rate:350, spread:0.05, spd:18, pel:1, owned:true },
 smg: { name:'ПП', cost:25, dmg:20, clip:35, reload:1200, rate:90, spread:0.12, spd:20, pel:1, owned:false },
 shotgun: { name:'Дробовик', cost:35, dmg:35, clip:8, reload:1000, rate:550, spread:0.28, spd:17, pel:8, owned:false },
 rifle: { name:'Винтовка', cost:65, dmg:85, clip:20, reload:2000, rate:380, spread:0.02, spd:28, pel:1, owned:false },
 minigun: { name:'Миниган', cost:160, dmg:22, clip:120, reload:3500, rate:45, spread:0.20, spd:22, pel:1, owned:false }
};

// ===== MAZE =====
function makeGrid(){ for(let r=0;r<MAPSZ;r++){maze[r]=[];for(let c=0;c<MAPSZ;c++)maze[r][c]=1;} }
function generateMaze(){
 makeGrid();
 const stack=[]; maze[1][1]=0; stack.push({r:1,c:1});
 const dirs=[[0,-2],[0,2],[-2,0],[2,0]];
 while(stack.length){
 const cur=stack[stack.length-1];const nb=[];
 for(const [dr,dc] of dirs){const nr=cur.r+dr,nc=cur.c+dc;if(nr>0&&nr<MAPSZ-1&&nc>0&&nc<MAPSZ-1&&maze[nr][nc]===1)nb.push({r:nr,c:nc,dr:dr/2,dc:dc/2});}
 if(nb.length){const nx=nb[Math.floor(Math.random()*nb.length)];maze[nx.r][nx.c]=0;maze[cur.r+nx.dr][cur.c+nx.dc]=0;stack.push({r:nx.r,c:nx.c});}
 else stack.pop();
 }
 const cr=20,cc=20;
 for(let r=cr-5;r<=cr+5;r++) for(let c=cc-5;c<=cc+5;c++) if(maze[r]) maze[r][c]=0;
 for(let d=-9;d<=9;d++){if(maze[cr+d])maze[cr+d][cc]=0;if(maze[cr])maze[cr][cc+d]=0;}
 for(let i=0;i<25;i++){
 const r=2+Math.floor(Math.random()*(MAPSZ-4)),c=2+Math.floor(Math.random()*(MAPSZ-4));
 if(maze[r][c]===1){let w=0;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++)if(maze[r+dr]&&maze[r+dr][c+dc]===1)w++;if(w>=6)maze[r][c]=0;}
 }
}
function buildTileRnd(){ for(let r=0;r<MAPSZ;r++){tileRnd[r]=[];for(let c=0;c<MAPSZ;c++)tileRnd[r][c]=Math.random();} }

// ===== FLOOR CACHE =====
function buildFloorCache(){
 floorCache=document.createElement('canvas');
 floorCache.width=MAPSZ*TILE;floorCache.height=MAPSZ*TILE;
 const fc=floorCache.getContext('2d');
 for(let r=0;r<MAPSZ;r++){
 for(let c=0;c<MAPSZ;c++){
 const wx=c*TILE,wy=r*TILE,v=tileRnd[r][c];
 if(maze[r][c]===0){
 const cols=['#14200e','#1a2812','#162010','#1e2a14','#121e0c'];
 fc.fillStyle=cols[Math.floor(v*5)];fc.fillRect(wx,wy,TILE,TILE);
 if(v>0.62){fc.fillStyle='rgba(45,100,20,0.18)';fc.beginPath();fc.ellipse(wx+(v*31%TILE),wy+(v*47%TILE),11,4,0,0,Math.PI*2);fc.fill();}
 if(v>0.85){fc.fillStyle='rgba(180,220,80,0.2)';fc.beginPath();fc.arc(wx+(v*53%TILE),wy+(v*37%TILE),3,0,Math.PI*2);fc.fill();}
 if(v>0.92){fc.fillStyle='rgba(80,55,20,0.14)';fc.beginPath();fc.ellipse(wx+v*30,wy+v*38,13,6,v,0,Math.PI*2);fc.fill();}
 fc.strokeStyle='rgba(0,0,0,0.05)';fc.lineWidth=0.5;fc.strokeRect(wx,wy,TILE,TILE);
 } else {
 fc.fillStyle='#0c1406';fc.fillRect(wx,wy,TILE,TILE);
 if(v<0.40){
 const cx2=wx+TILE/2,cy2=wy+TILE*0.76;
 fc.fillStyle='#5c3317';fc.fillRect(cx2-4,cy2-4,8,20);
 const layers=[{y:cy2-30,r:23,col:'#1a4a0a'},{y:cy2-42,r:17,col:'#1e5e0e'},{y:cy2-52,r:11,col:'#25781a'}];
 for(const l of layers){fc.fillStyle=l.col;fc.beginPath();fc.moveTo(cx2,l.y-l.r);fc.lineTo(cx2-l.r,l.y+l.r*0.6);fc.lineTo(cx2+l.r,l.y+l.r*0.6);fc.closePath();fc.fill();}
 } else if(v<0.68){
 const cx2=wx+TILE/2,cy2=wy+TILE*0.72;
 fc.fillStyle='#6b3a1a';fc.fillRect(cx2-5,cy2-4,10,18);
 fc.fillStyle='#1a5010';fc.beginPath();fc.arc(cx2,cy2-18,22,0,Math.PI*2);fc.fill();
 fc.fillStyle='#258020';fc.beginPath();fc.arc(cx2-4,cy2-22,15,0,Math.PI*2);fc.fill();
 } else {
 const cx2=wx+TILE/2,cy2=wy+TILE/2;
 const rks=[{ox:-7,oy:5,rx:13,ry:9,col:'#3a3a3e'},{ox:7,oy:7,rx:10,ry:7,col:'#4a4a50'},{ox:1,oy:-3,rx:9,ry:6,col:'#2e2e33'}];
 for(const rk of rks){fc.fillStyle=rk.col;fc.beginPath();fc.ellipse(cx2+rk.ox,cy2+rk.oy,rk.rx,rk.ry,0,0,Math.PI*2);fc.fill();}
 }
 }
 }
 }
}

function isWall(x,y){const r=Math.floor(y/TILE),c=Math.floor(x/TILE);if(r<0||r>=MAPSZ||c<0||c>=MAPSZ)return true;return maze[r][c]===1;}
function colCheck(x,y,sz){const p=3;return isWall(x+p,y+p)||isWall(x+sz-p,y+p)||isWall(x+p,y+sz-p)||isWall(x+sz-p,y+sz-p);}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

// ===== AUDIO =====
function ensAudio(){
 if(!audioCtx){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;audioCtx=new AC();}
 if(audioCtx.state==='suspended')audioCtx.resume();
}
function playTone(type,freq,endFreq,gain,dur,filtType,filtFreq){
 ensAudio();if(!audioCtx)return;
 try{
 const now=audioCtx.currentTime;
 const osc=audioCtx.createOscillator(),amp=audioCtx.createGain();
 osc.type=type;osc.frequency.setValueAtTime(freq,now);
 if(endFreq)osc.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),now+dur);
 amp.gain.setValueAtTime(gain,now);amp.gain.exponentialRampToValueAtTime(0.0001,now+dur);
 let node=osc;
 if(filtType){const bq=audioCtx.createBiquadFilter();bq.type=filtType;bq.frequency.setValueAtTime(filtFreq||1200,now);osc.connect(bq);node=bq;}
 node.connect(amp);amp.connect(audioCtx.destination);
 osc.start(now);osc.stop(now+dur+0.03);
 }catch(e){}
}
function sndShoot(wk){
 ensAudio();if(!audioCtx)return;
 const p={pistol:[300,110,0.065,0.09],smg:[430,160,0.044,0.05],shotgun:[170,60,0.11,0.12],rifle:[540,200,0.075,0.08],minigun:[370,140,0.03,0.035]}[wk]||[300,110,0.065,0.09];
 playTone('square',p[0],p[1],p[2],p[3],'lowpass',2600);
}
function sndMineExplode(){
 ensAudio();if(!audioCtx)return;
 playTone('sine',130,28,0.28,0.55,'lowpass',400);
 setTimeout(()=>playTone('sawtooth',700,90,0.12,0.28),30);
 setTimeout(()=>playTone('triangle',440,80,0.08,0.2),60);
}
function sndReload(){
 ensAudio();if(!audioCtx)return;
 [0,0.1,0.22].forEach((d,i)=>{setTimeout(()=>playTone('square',i===2?750:480,180,0.055,0.05),d*1000);});
}
function sndHeal(){
 ensAudio();if(!audioCtx)return;
 [440,660,880].forEach((f,i)=>setTimeout(()=>playTone('sine',f,f*0.98,0.044,0.14),i*90));
}
function sndPickup(){
 ensAudio();if(!audioCtx)return;
 playTone('triangle',520,620,0.04,0.12);
}
function sndBaseHit(){playTone('sawtooth',85,38,0.055,0.18,'lowpass',380);}
function sndZombieHit(){playTone('sawtooth',130+Math.random()*40,50,0.022,0.13,'bandpass',260+Math.random()*80);}
function sndBarrelBreak(){
 ensAudio();if(!audioCtx)return;
 [0,0.06,0.14].forEach(d=>setTimeout(()=>playTone('sawtooth',320+Math.random()*180,75,0.055,0.08),d*1000));
}
function sndPlayerHit(){playTone('triangle',380,140,0.06,0.1,'lowpass',900);}
function sndWaveAlert(){
 ensAudio();if(!audioCtx)return;
 playTone('sawtooth',40,180,0.18,1.4,'lowpass',500);
 setTimeout(()=>playTone('sawtooth',60,260,0.14,1.2,'lowpass',600),200);
 setTimeout(()=>playTone('sawtooth',80,350,0.10,1.0,'lowpass',700),400);
 setTimeout(()=>playTone('sine',220,440,0.08,0.8,'lowpass',800),600);
 [0,0.28,0.56].forEach(d=>setTimeout(()=>playTone('sawtooth',92,44,0.07,0.22),d*1000));
}
function sndGroan(intensity){
 intensity=intensity||1;
 playTone('sawtooth',78+Math.random()*26,34+Math.random()*14,0.01+intensity*0.016,0.2+Math.random()*0.14,'bandpass',255+Math.random()*100);
}
function startAmbient(){
 ensAudio();if(!audioCtx||musicTmr)return;
 let step=0;const scale=[0,3,5,7,10];const root=110;
 musicTmr=setInterval(()=>{
 if(!audioCtx||gState!=='PLAYING')return;
 const ns=step++;const note=scale[ns%scale.length];const oct=ns%8===0?0:1;
 const freq=root*Math.pow(2,oct)*Math.pow(2,note/12);
 playTone('sine',root*0.5,root*0.48,0.014,0.55,'lowpass',175);
 if(ns%2===0)playTone('triangle',freq,freq*0.97,0.011,0.30,'lowpass',880);
 if(ns%4===0)playTone('sine',freq*0.5,null,0.008,0.22,'lowpass',490);
 },650);
 ambTmr=setInterval(()=>{
 if(gState!=='PLAYING')return;
 ensAudio();if(!audioCtx)return;
 if(Math.random()<0.65)[0,0.09,0.18].forEach(d=>setTimeout(()=>playTone('sine',3100+Math.random()*500,null,0.004+Math.random()*0.002,0.07),d*1000));
 if(!zombies.length)return;
 const lp=getLiving();
 const fx=lp.length?lp.reduce((s,p)=>s+p.x,0)/lp.length:base.x;
 const fy=lp.length?lp.reduce((s,p)=>s+p.y,0)/lp.length:base.y;
 let nz=null,nd=Infinity;
 for(const z of zombies){const d=Math.hypot((z.x+z.size/2)-fx,(z.y+z.size/2)-fy);if(d<nd){nd=d;nz=z;}}
 if(nz&&nd<900&&Math.random()<0.7)sndGroan(nz.type==='boss'?1.4:1);
 },2200);
}
function stopAmbient(){if(musicTmr){clearInterval(musicTmr);musicTmr=null;}if(ambTmr){clearInterval(ambTmr);ambTmr=null;}}

// ===== FLOW FIELD =====
function updateFF(field,goals){
 field.length=0;
 for(let r=0;r<MAPSZ;r++){field[r]=[];for(let c=0;c<MAPSZ;c++)field[r][c]={d:99999,dx:0,dy:0};}
 const q=[];
 for(const g of goals){const gr=Math.floor(g.y/TILE),gc=Math.floor(g.x/TILE);if(gr>=0&&gr<MAPSZ&&gc>=0&&gc<MAPSZ&&maze[gr][gc]===0){field[gr][gc].d=0;q.push({r:gr,c:gc});}}
 let qh=0;const dirs=[[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
 while(qh<q.length){
 const cur=q[qh++];const cd=field[cur.r][cur.c].d;
 for(let i=0;i<8;i++){
 const nc=cur.c+dirs[i][0],nr=cur.r+dirs[i][1],dist=i<4?1:1.414;
 if(nr>=0&&nr<MAPSZ&&nc>=0&&nc<MAPSZ&&maze[nr][nc]===0&&field[nr][nc].d>cd+dist){field[nr][nc].d=cd+dist;field[nr][nc].dx=cur.c-nc;field[nr][nc].dy=cur.r-nr;q.push({r:nr,c:nc});}
 }
 }
}
function sampleFF(field,x,y){const r=Math.floor(y/TILE),c=Math.floor(x/TILE);if(r<0||r>=MAPSZ||c<0||c>=MAPSZ)return{x:0,y:0,d:99999};const cl=field[r]&&field[r][c];if(!cl||cl.d>=99999)return{x:0,y:0,d:99999};return{x:cl.dx,y:cl.dy,d:cl.d};}
function wallAvoid(x,y,radius){
 radius=radius||88;let ax=0,ay=0;
 const cr=Math.floor(y/TILE),cc=Math.floor(x/TILE);
 for(let r=cr-2;r<=cr+2;r++)for(let c=cc-2;c<=cc+2;c++){
 if(r<0||c<0||r>=MAPSZ||c>=MAPSZ)continue;
 if(maze[r][c]!==1)continue;
 const wx=c*TILE+TILE/2,wy=r*TILE+TILE/2,dx=x-wx,dy=y-wy,dist=Math.hypot(dx,dy);
 if(dist>0&&dist<radius){const w=(radius-dist)/radius;ax+=(dx/dist)*w;ay+=(dy/dist)*w;}
 }
 return{x:ax,y:ay};
}

// ===== HELPERS =====
function getLiving(){return players.filter(p=>p.hp>0);}
function setSt(p,t,ms){p.stText=t;p.stUntil=Date.now()+(ms||1200);}
function cntWalls(r,c){let n=0;for(const[dr,dc]of[[0,-1],[0,1],[-1,0],[1,0]]){const nr=r+dr,nc=c+dc;if(nr<0||nc<0||nr>=MAPSZ||nc>=MAPSZ||maze[nr][nc]===1)n++;}return n;}
function randOpenTile(minD,maxD){
 minD=minD||420;maxD=maxD||1320;
 for(let i=0;i<600;i++){
 const r=1+Math.floor(Math.random()*(MAPSZ-2)),c=1+Math.floor(Math.random()*(MAPSZ-2));
 if(maze[r][c]!==0)continue;
 const x=c*TILE+TILE/2,y=r*TILE+TILE/2;
 const d=Math.hypot(x-base.x,y-base.y);
 if(d<minD||d>maxD)continue;
 if(cntWalls(r,c)>4)continue;
 let close=false;
 for(const p of [...ammoPickups,...medPickups])if(Math.hypot(x-p.x,y-p.y)<110){close=true;break;}
 if(!close)return{x,y};
 }
 return null;
}
function safeTeleport(){
 const lp=getLiving();
 for(let i=0;i<700;i++){
 const r=1+Math.floor(Math.random()*(MAPSZ-2)),c=1+Math.floor(Math.random()*(MAPSZ-2));
 if(maze[r][c]!==0)continue;
 const x=c*TILE+TILE/2,y=r*TILE+TILE/2;
 if(Math.hypot(x-base.x,y-base.y)<500)continue;
 if(cntWalls(r,c)>3)continue;
 let close=false;
 for(const p of lp)if(Math.hypot(x-(p.x+p.size/2),y-(p.y+p.size/2))<280){close=true;break;}
 if(!close)return{x,y};
 }
 return null;
}
function spawnSupply(type){
 const s=randOpenTile(type==='ammo'?300:380,type==='ammo'?1360:1380);
 if(!s)return false;
 if(type==='ammo')ammoPickups.push({x:s.x,y:s.y,bob:Math.random()*Math.PI*2});
 else medPickups.push({x:s.x,y:s.y,bob:Math.random()*Math.PI*2});
 return true;
}
function spawnInitSupplies(){ammoPickups=[];medPickups=[];for(let i=0;i<5;i++)spawnSupply('ammo');for(let i=0;i<3;i++)spawnSupply('medkit');}

// ===== AIRDROP SYSTEM =====
// Типы дропов: 'bomb','heal','coins','zombie_drop'
let airdropPlane = null; // {x, y, targetX, targetY, type, speed, phase, parachute, land}
let fartFogTimer = 0;

function triggerAirdrop(){
 // Рандомный тип
 const types = ['bomb','heal','coins','zombie_drop','ration','fart'];
 const type = types[Math.floor(Math.random()*types.length)];
 // Самолёт летит сверху экрана слева направо, скидывает над базой
 const flyOffset = 140 + Math.random()*80;
const startX = -200;
const startY = base.y - flyOffset;
const targetX = base.x + (Math.random()-0.5)*160;
const targetY = base.y + (Math.random()-0.5)*80;
airdropPlane = {
x: startX,
y: base.y - flyOffset,
 targetX: targetX,
 targetY: targetY,
 type: type,
 speed: 5,
 phase: 'flying', // flying -> dropping -> landing
 dropped: false,
 // Контейнер на парашюте
 containerX: null,
 containerY: null,
 containerVY: 0,
 containerLanded: false,
 landTimer: 0,
 zombieDropped: false,
 };
 // Показ уведомления
 const isEnemy = type === 'zombie_drop';
 const ann = document.getElementById('airdrop-ann');
 if(isEnemy){
 ann.innerHTML='<span style="color:#ff4444;text-shadow:0 0 20px #f00;">✈️ ЗАХВАЧЕННЫЙ САМОЛЁТ!<br><span style="font-size:0.7em;">☠ НА НАС ЛЕТЯТ ЗОМБИ! ☠</span></span>';
 } else {
 ann.innerHTML='<span style="color:#ffdd00;text-shadow:0 0 20px #ff0;">✈️ ВОЗДУШНЫЙ ДЕСАНТ!<br><span style="font-size:0.7em;">Дроп летит на базу!</span></span>';
 }
 ann.classList.add('show');
 setTimeout(()=>ann.classList.remove('show'),3500);
}

function updateAirdrop(){
 if(!airdropPlane)return;
 const ap = airdropPlane;
 if(ap.phase === 'flying'){
 ap.x += ap.speed;
 // Когда самолёт над целью - скидываем контейнер
 if(ap.x >= ap.targetX - 60 && !ap.dropped){
 ap.dropped = true;
 ap.containerX = ap.x;
 ap.containerY = ap.y;
 ap.containerVY = 1;
 ap.phase = 'dropping';
 }
 if(ap.x > MAPSZ*TILE+300){
 // Самолёт улетел
 if(ap.phase === 'flying') airdropPlane = null;
 }
 }
 if(ap.phase === 'dropping' && ap.containerX !== null){
 ap.containerVY += 0.08; // гравитация
 if(ap.containerVY > 2.5) ap.containerVY = 2.5; // парашют тормозит
 ap.containerY += ap.containerVY;
 // Приземление
 if(ap.containerY >= ap.targetY){
 ap.containerY = ap.targetY;
 ap.phase = 'landed';
 ap.landTimer = 120; // 2 секунды на земле
 executeDrop(ap);
 }
 }
 if(ap.phase === 'landed'){
 ap.landTimer--;
 if(ap.landTimer <= 0) airdropPlane = null;
 }
 // Самолёт продолжает лететь даже после сброса
 if(ap.phase !== 'flying') ap.x += ap.speed;
}

function executeDrop(ap){
 const cx = ap.containerX;
 const cy = ap.targetY;
 switch(ap.type){
 case 'bomb':
 // Ракета — взрыв! -100 хп базе, половина хп игрокам рядом
 base.hp = Math.max(0, base.hp - 100);
 if(base.hp <= 0){base.hp=0;base.alive=false;endGame('Ракетный удар уничтожил базу!');}
 for(const p of players){
 if(p.hp>0){
 const dist = Math.hypot((p.x+p.size/2)-cx,(p.y+p.size/2)-cy);
 if(dist < 180){
 p.hp = Math.max(1, Math.floor(p.hp/2));
 setSt(p,'💥 РАКЕТНЫЙ УДАР!',1500);
 dmgNums.push({x:p.x+p.size/2,y:p.y-10,val:Math.floor(p.hp),life:80,max:80,crit:true,isPlayer:true});
 }
 }
 }
 // Взрыв визуально
 for(let i=0;i<15;i++){
 droppedCoins.push({x:cx+(Math.random()-0.5)*80,y:cy+(Math.random()-0.5)*80,val:0,hover:0,isExplosion:true,life:40});
 }
 sndMineExplode();
 updateBaseUI();updateUI();
 showAirdropResult('💥 РАКЕТНЫЙ УДАР! База получила урон!','#ff4444');
 break;
 case 'heal':
 // Аптечка для базы — полное лечение
 base.hp = base.maxHp;
 base.alive = true;
 updateBaseUI();
 sndHeal();
 showAirdropResult('💊 База полностью восстановлена!','#44ff88');
 break;
 case 'coins':
 // 40 монет по области
 for(let i=0;i<40;i++){
 droppedCoins.push({
 x:cx+(Math.random()-0.5)*220,
 y:cy+(Math.random()-0.5)*220,
 val:1,hover:0
 });
 }
 sndPickup();
 showAirdropResult('💰 40 монет рассыпалось!','#ffd700');
 break;
 case 'zombie_drop':
 // 5 зомби прилетают
 for(let i=0;i<5;i++){
 setTimeout(()=>{
 const angle = Math.random()*Math.PI*2;
 const r2 = 60+Math.random()*80;
 const zx = cx+Math.cos(angle)*r2;
 const zy = cy+Math.sin(angle)*r2;
 const zr = Math.floor(zy/TILE), zc = Math.floor(zx/TILE);
 if(zr>=0&&zr<MAPSZ&&zc>=0&&zc<MAPSZ&&maze[zr][zc]===0){
 zombies.push({x:zx-14,y:zy-14,hp:60+wave*8,maxHp:60+wave*8,spd:1.4+wave*0.02,type:'normal',size:28,lastLeap:0,leaping:false,leapVx:0,leapVy:0,lastSpit:0,rew:1,stuckT:0,lastX:zx,lastY:zy,wOff:Math.random()*Math.PI*2,aggroTimer:240});
 }
 },i*300);
 }
 showAirdropResult('☠ 5 ЗОМБИ ДЕСАНТИРОВАНЫ!','#ff8800');
 break;
 case 'ration':
// Сух-паёк: 2 пачки патронов + 2 аптечки на склад
depotAmmo += 2;
depotMed += 2;
sndPickup();
setTimeout(()=>sndHeal(),200);
updateDepotUI();
updateUI();
showAirdropResult('🍱 СУХ-ПАЁК! +2 патрона и +2 аптечки на склад!','#88ff44');
break;
case 'fart':
// Пук с воздуха — затуманивает экран на 3 секунды!
fartFogTimer = 180;
ensAudio();
if(audioCtx){
playTone('sawtooth',50,22,0.22,1.0,'lowpass',160);
setTimeout(()=>playTone('square',120,40,0.08,0.4,'lowpass',300),200);
setTimeout(()=>playTone('sawtooth',80,15,0.12,0.8,'lowpass',120),500);
}
showAirdropResult('💨 ПУК С ВОЗДУХА! 💨<br>Кто-то навалил с самолёта!','#55ff00');
break;
 }
}

function showAirdropResult(text, color){
 const ann = document.getElementById('airdrop-ann');
 ann.innerHTML='<span style="color:'+color+';text-shadow:0 0 15px '+color+';">'+text+'</span>';
 ann.classList.add('show');
 setTimeout(()=>ann.classList.remove('show'),3000);
}

function drawAirdrop(){
if(!airdropPlane)return;
const ap=airdropPlane;
const isEnemy=ap.type==='zombie_drop';
const isFart=ap.type==='fart';
const isRation=ap.type==='ration';
ctx.save();

// ====== КРАСИВЫЙ САМОЛЁТ (вид сверху, летит вправо) ======
ctx.save();
ctx.translate(ap.x,ap.y);

// Тень самолёта на уровне земли
ctx.save();
ctx.globalAlpha=0.12;
ctx.fillStyle='#000';
ctx.beginPath();
ctx.ellipse(30,480,50,10,0,0,Math.PI*2);
ctx.fill();
ctx.restore();

// --- Корпус (фюзеляж) ---
const bc1=isEnemy?'#b04040':isFart?'#55bb33':'#7a9a6a';
const bc2=isEnemy?'#6a2020':isFart?'#337722':'#4a6a3a';
const bGrad=ctx.createLinearGradient(0,-15,0,15);
bGrad.addColorStop(0,bc1);bGrad.addColorStop(1,bc2);
ctx.fillStyle=bGrad;
ctx.beginPath();ctx.ellipse(0,0,56,14,0,0,Math.PI*2);ctx.fill();
ctx.strokeStyle='rgba(255,255,255,0.18)';ctx.lineWidth=1;ctx.stroke();

// Нос
ctx.fillStyle=isEnemy?'#cc5555':isFart?'#66dd44':'#8aaa7a';
ctx.beginPath();ctx.moveTo(56,0);ctx.quadraticCurveTo(74,-3,74,0);ctx.quadraticCurveTo(74,3,56,0);ctx.fill();

// Кабина пилота
ctx.fillStyle='rgba(120,220,255,0.55)';
ctx.beginPath();ctx.ellipse(46,-3,10,6,0.08,Math.PI,2*Math.PI);ctx.fill();
ctx.strokeStyle='rgba(200,240,255,0.35)';ctx.lineWidth=1;ctx.stroke();
ctx.fillStyle='rgba(255,255,255,0.28)';
ctx.beginPath();ctx.ellipse(48,-6,4,2,-0.3,0,Math.PI*2);ctx.fill();

// Окна (иллюминаторы)
ctx.fillStyle='rgba(150,220,255,0.4)';
for(let wi=0;wi<7;wi++){ctx.beginPath();ctx.arc(28-wi*8,-6,2.5,0,Math.PI*2);ctx.fill();}

// --- Крылья ---
const wc1=isEnemy?'#884444':isFart?'#4a9932':'#5a7a4a';
const wc2=isEnemy?'#662222':isFart?'#337722':'#3a5a2a';
// Левое крыло
let wg=ctx.createLinearGradient(0,-10,0,-52);wg.addColorStop(0,wc1);wg.addColorStop(1,wc2);
ctx.fillStyle=wg;
ctx.beginPath();ctx.moveTo(20,-11);ctx.lineTo(-6,-50);ctx.lineTo(-20,-46);ctx.lineTo(4,-11);ctx.closePath();ctx.fill();
ctx.strokeStyle='rgba(0,0,0,0.18)';ctx.lineWidth=1;ctx.stroke();
// Правое крыло
wg=ctx.createLinearGradient(0,10,0,52);wg.addColorStop(0,wc1);wg.addColorStop(1,wc2);
ctx.fillStyle=wg;
ctx.beginPath();ctx.moveTo(20,11);ctx.lineTo(-6,50);ctx.lineTo(-20,46);ctx.lineTo(4,11);ctx.closePath();ctx.fill();
ctx.strokeStyle='rgba(0,0,0,0.18)';ctx.lineWidth=1;ctx.stroke();

// Законцовки крыльев (антикрылья)
ctx.fillStyle=isEnemy?'#ff6644':isFart?'#88ff55':'#aaccaa';
ctx.fillRect(-21,-50,4,8);ctx.fillRect(-21,42,4,8);

// --- Двигатели ---
ctx.fillStyle='#555';
ctx.beginPath();ctx.ellipse(8,-30,9,5,0.15,0,Math.PI*2);ctx.fill();
ctx.strokeStyle='#333';ctx.lineWidth=1;ctx.stroke();
ctx.beginPath();ctx.ellipse(8,30,9,5,-0.15,0,Math.PI*2);ctx.fill();ctx.stroke();
// Воздухозаборники
ctx.fillStyle='#333';
ctx.beginPath();ctx.ellipse(16,-30,3,4,0,0,Math.PI*2);ctx.fill();
ctx.beginPath();ctx.ellipse(16,30,3,4,0,0,Math.PI*2);ctx.fill();

// Пропеллеры (вращаются)
const propA=(Date.now()*0.035)%(Math.PI*2);
ctx.strokeStyle='#ccc';ctx.lineWidth=2;
[{x:8,y:-30},{x:8,y:30}].forEach(eng=>{
ctx.save();ctx.translate(eng.x+9,eng.y);ctx.rotate(propA);
ctx.beginPath();ctx.moveTo(-9,0);ctx.lineTo(9,0);ctx.stroke();
ctx.beginPath();ctx.moveTo(0,-9);ctx.lineTo(0,9);ctx.stroke();
// Центр пропеллера
ctx.fillStyle='#888';ctx.beginPath();ctx.arc(0,0,2,0,Math.PI*2);ctx.fill();
ctx.restore();
});

// --- Хвостовое оперение ---
const tc=isEnemy?'#773333':isFart?'#448822':'#4a6a3a';
ctx.fillStyle=tc;
// Вертикальный стабилизатор
ctx.beginPath();ctx.moveTo(-46,-4);ctx.lineTo(-64,-24);ctx.lineTo(-58,-22);ctx.lineTo(-44,-4);ctx.closePath();ctx.fill();
// Горизонтальные
ctx.beginPath();ctx.moveTo(-44,-2);ctx.lineTo(-60,-16);ctx.lineTo(-56,-13);ctx.lineTo(-42,0);ctx.closePath();ctx.fill();
ctx.beginPath();ctx.moveTo(-44,2);ctx.lineTo(-60,16);ctx.lineTo(-56,13);ctx.lineTo(-42,0);ctx.closePath();ctx.fill();

// --- Маркировка ---
if(isEnemy){
ctx.strokeStyle='rgba(255,100,0,0.7)';ctx.lineWidth=2.5;
ctx.beginPath();ctx.moveTo(-8,-7);ctx.lineTo(2,7);ctx.stroke();
ctx.beginPath();ctx.moveTo(2,-7);ctx.lineTo(-8,7);ctx.stroke();
ctx.fillStyle='rgba(255,0,0,0.6)';ctx.font='bold 11px sans-serif';ctx.textAlign='center';
ctx.fillText('☠',16,5);
} else if(isFart){
// Зелёные облачка выхлопа
ctx.fillStyle='rgba(100,255,50,0.3)';
for(let ci=0;ci<5;ci++){const co=Math.sin(Date.now()/220+ci*1.7)*5;
ctx.beginPath();ctx.arc(-60-ci*11+co,ci*5-8,6+ci*2,0,Math.PI*2);ctx.fill();}
} else {
// Звезда
ctx.fillStyle='rgba(255,255,255,0.35)';ctx.beginPath();
for(let si=0;si<5;si++){const a1=-Math.PI/2+si*Math.PI*2/5,a2=a1+Math.PI/5;
ctx.lineTo(12+Math.cos(a1)*7,Math.sin(a1)*7);ctx.lineTo(12+Math.cos(a2)*3,Math.sin(a2)*3);}
ctx.closePath();ctx.fill();
}
// Полоска
ctx.strokeStyle=isEnemy?'rgba(255,60,60,0.35)':'rgba(255,255,255,0.15)';
ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-34,0);ctx.lineTo(34,0);ctx.stroke();
// Выхлоп
ctx.fillStyle=isEnemy?'rgba(255,80,0,0.2)':'rgba(180,200,255,0.12)';
ctx.beginPath();ctx.ellipse(-58,0,14,6,0,0,Math.PI*2);ctx.fill();

ctx.restore(); // конец трансформации самолёта

// ====== КОНТЕЙНЕР НА ПАРАШЮТЕ ======
if(ap.phase==='dropping'||ap.phase==='landed'){
const cx2=ap.containerX,cy2=ap.containerY;
const landed=ap.phase==='landed';

// Тень ящика
ctx.fillStyle='rgba(0,0,0,0.18)';
ctx.beginPath();ctx.ellipse(cx2,ap.targetY+18,18,5,0,0,Math.PI*2);ctx.fill();

// Парашют (если в воздухе)
if(!landed){
const pR=32,pY=cy2-38,nP=8;
const pCols=isEnemy
?['#dd4444','#bb3333','#dd4444','#bb3333','#dd4444','#bb3333','#dd4444','#bb3333']
:isFart
?['#44cc22','#66dd44','#44cc22','#66dd44','#44cc22','#66dd44','#44cc22','#66dd44']
:['#ff9944','#ffbb55','#44bb44','#ffbb55','#ff9944','#44bb44','#ffbb55','#ff9944'];
// Купол
for(let pi=0;pi<nP;pi++){
const a1=Math.PI+(pi/nP)*Math.PI,a2=Math.PI+((pi+1)/nP)*Math.PI;
ctx.fillStyle=pCols[pi%pCols.length];
ctx.beginPath();ctx.moveTo(cx2,pY+7);ctx.arc(cx2,pY,pR,a1,a2);ctx.closePath();ctx.fill();
}
// Блик
ctx.fillStyle='rgba(255,255,255,0.2)';
ctx.beginPath();ctx.ellipse(cx2-7,pY-5,11,7,-0.3,0,Math.PI*2);ctx.fill();
// Обводка
ctx.strokeStyle='rgba(0,0,0,0.25)';ctx.lineWidth=1.5;
ctx.beginPath();ctx.arc(cx2,pY,pR,Math.PI,2*Math.PI);ctx.stroke();
// Стропы
ctx.strokeStyle='#998877';ctx.lineWidth=0.8;
for(let si=0;si<=nP;si++){const sa=Math.PI+(si/nP)*Math.PI;
ctx.beginPath();ctx.moveTo(cx2+Math.cos(sa)*pR,pY+Math.sin(sa)*pR);ctx.lineTo(cx2,cy2-4);ctx.stroke();}
}

// Ящик
const bw=28,bh=22,bx=cx2-bw/2,by=cy2-bh/2+2;
const bxG=ctx.createLinearGradient(bx,by,bx,by+bh);
if(isEnemy){bxG.addColorStop(0,'#993333');bxG.addColorStop(1,'#662222');}
else if(isRation){bxG.addColorStop(0,'#6a8a4a');bxG.addColorStop(1,'#4a6a3a');}
else if(isFart){bxG.addColorStop(0,'#55bb33');bxG.addColorStop(1,'#338822');}
else{bxG.addColorStop(0,'#9a8a50');bxG.addColorStop(1,'#6a5a30');}
ctx.fillStyle=bxG;ctx.fillRect(bx,by,bw,bh);
// Обводка ящика
ctx.strokeStyle=isEnemy?'#ff5544':'#bbaa66';ctx.lineWidth=2;ctx.strokeRect(bx,by,bw,bh);
// Ремни
ctx.strokeStyle=isEnemy?'#aa3333':'#887744';ctx.lineWidth=1.5;
ctx.beginPath();ctx.moveTo(bx,cy2+2);ctx.lineTo(bx+bw,cy2+2);ctx.stroke();
ctx.beginPath();ctx.moveTo(cx2,by);ctx.lineTo(cx2,by+bh);ctx.stroke();
// Замочек
ctx.fillStyle='#c8a040';ctx.beginPath();ctx.arc(cx2,cy2+2,2.5,0,Math.PI*2);ctx.fill();
// Значок
ctx.textAlign='center';ctx.font='bold 13px sans-serif';
if(isEnemy){ctx.fillStyle='#ff4444';ctx.fillText('☠',cx2,cy2-2);}
else if(ap.type==='heal'){ctx.fillStyle='#ff3333';ctx.fillText('✚',cx2,cy2-2);}
else if(ap.type==='coins'){ctx.fillStyle='#ffd700';ctx.fillText('$',cx2,cy2-2);}
else if(ap.type==='bomb'){ctx.fillStyle='#ff6600';ctx.fillText('!',cx2,cy2-2);}
else if(isRation){ctx.fillStyle='#ffee88';ctx.font='11px sans-serif';ctx.fillText('П',cx2,cy2-1);}
else if(isFart){ctx.fillStyle='#88ff44';ctx.fillText('?',cx2,cy2-2);}
else{ctx.fillStyle='#ffdd00';ctx.fillText('?',cx2,cy2-2);}

// Свечение при приземлении
if(landed){
const ga=0.15+Math.sin(Date.now()/200)*0.08;
const gc=isEnemy?'rgba(255,50,50,':isFart?'rgba(50,255,50,':'rgba(255,200,50,';
ctx.fillStyle=gc+ga+')';ctx.beginPath();ctx.arc(cx2,cy2+5,30,0,Math.PI*2);ctx.fill();
}
}
ctx.restore();
}
// ===== WAVES =====
function showWaveAnn(txt){
 const el=document.getElementById('wave-ann');
 el.innerHTML=txt;el.classList.add('show');
 setTimeout(()=>el.classList.remove('show'),2600);
 setTimeout(()=>sndWaveAlert(),100);
}
function zombieCount(w){return Math.min(Math.floor(5 + w*1.4 + Math.pow(w,0.65)), 58);}
function bossCount(w){if(w%10!==0)return 0;if(w>=50)return 3;if(w>=30)return 2;return 1;}

function nextWave(){
 wave++;
 waveSpawning=true;
 waveSpawned=0;
 showWaveAnn('🌊 ВОЛНА '+wave+(wave%10===0?'<br><span style="font-size:1.4rem;color:#ff8800;">⚠️ ВОЛНА БОССОВ!</span>':''));
 const bc=bossCount(wave);
 const isSpec=wave>=5;
 let cnt=zombieCount(wave);
 if(bc>0){
 for(let b=0;b<bc;b++) setTimeout(()=>spawnBoss(), b*800);
 cnt=Math.max(4, Math.floor(cnt*0.5));
 }
 waveTotal=cnt;
 for(let i=0;i<cnt;i++){
 const delay=Math.floor(i/3)*700+Math.random()*200;
 setTimeout(()=>{
 if(gState!=='PLAYING'&&gState!=='SHOP')return;
 let t='normal';
 if(isSpec&&Math.random()<0.14) t=Math.random()<0.5?'freezer':'spitter';
 else if(wave%4===0&&Math.random()<0.18) t='leaper';
 spawnZombie(t);
 waveSpawned++;
 if(waveSpawned>=waveTotal) waveSpawning=false;
 },delay);
 }
 if(wave%2===1)spawnSupply('ammo');
 if(wave%3===0)spawnSupply('ammo');
 if(wave%4===0)spawnSupply('medkit');
 // Каждую 5-ю волну — воздушный дроп (через 8 секунд после начала волны)
 if(wave%5===0){
 setTimeout(()=>{
 if(gState==='PLAYING'||gState==='SHOP') triggerAirdrop();
 },8000);
 }
 updateUI();
}

function spawnZombie(type){
 type=type||'normal';
 let zx,zy,ok=false,att=0;
 while(!ok&&att<100){
 att++;
 const side=Math.floor(Math.random()*4);
 let tx,ty;
 if(side===0){tx=1+Math.random()*(MAPSZ-2);ty=1;}
 else if(side===1){tx=1+Math.random()*(MAPSZ-2);ty=MAPSZ-2;}
 else if(side===2){tx=1;ty=1+Math.random()*(MAPSZ-2);}
 else{tx=MAPSZ-2;ty=1+Math.random()*(MAPSZ-2);}
 zx=Math.floor(tx)*TILE+TILE/2;zy=Math.floor(ty)*TILE+TILE/2;
 const r=Math.floor(zy/TILE),c=Math.floor(zx/TILE);
 if(r>=0&&r<MAPSZ&&c>=0&&c<MAPSZ&&maze[r][c]===0)ok=true;
 }
 if(!ok)return;
 let hp=40+wave*9,spd=1.35+wave*0.03,sz=28,rew=1;
 if(type==='leaper'){hp=Math.floor(hp*0.7);spd=1.85+wave*0.035;sz=22;rew=2;}
 else if(type==='freezer'){hp=Math.floor(hp*1.1);spd=1.2+wave*0.025;sz=30;rew=4;}
 else if(type==='spitter'){hp=Math.floor(hp*0.88);spd=1.22+wave*0.025;sz=26;rew=4;}
 zombies.push({x:zx,y:zy,hp,maxHp:hp,spd,type,size:sz,lastLeap:0,leaping:false,leapVx:0,leapVy:0,lastSpit:0,rew,stuckT:0,lastX:zx,lastY:zy,wOff:Math.random()*Math.PI*2,aggroTimer:0});
}

function spawnBoss(){
 let bx,by,ok=false,att=0;
 while(!ok&&att<200){
 att++;
 const side=Math.floor(Math.random()*4);
 if(side===0){bx=(1+Math.random()*(MAPSZ-2))*TILE;by=TILE*2;}
 else if(side===1){bx=(1+Math.random()*(MAPSZ-2))*TILE;by=(MAPSZ-3)*TILE;}
 else if(side===2){bx=TILE*2;by=(1+Math.random()*(MAPSZ-2))*TILE;}
 else{bx=(MAPSZ-3)*TILE;by=(1+Math.random()*(MAPSZ-2))*TILE;}
 const r=Math.floor(by/TILE),c=Math.floor(bx/TILE);
 if(r>=0&&r<MAPSZ&&c>=0&&c<MAPSZ&&maze[r][c]===0){ok=true;}
 else {
 // Ищем ближайший открытый тайл
 for(let dr=-2;dr<=2&&!ok;dr++)for(let dc=-2;dc<=2&&!ok;dc++){
 const nr=r+dr,nc=c+dc;
 if(nr>=0&&nr<MAPSZ&&nc>=0&&nc<MAPSZ&&maze[nr][nc]===0){
 bx=nc*TILE+TILE/2;by=nr*TILE+TILE/2;ok=true;
 }
 }
 }
 }
 if(!ok)return;
 zombies.push({x:bx-BOSS_SIZE/2,y:by-BOSS_SIZE/2,hp:1100+wave*160,maxHp:1100+wave*160,spd:1.05+wave*0.022,type:'boss',size:BOSS_SIZE,lastAttack:0,rew:10,stuckT:0,lastX:bx,lastY:by,wOff:0,lastSpit:0,leaping:false,leapVx:0,leapVy:0,aggroTimer:0});
}

// ===== INIT =====
function initGame(numPlayers, isOnline = false){
 numPlayers = numPlayers || 2;
 currentPlayers = numPlayers;
 generateMaze();buildTileRnd();buildFloorCache();
 const n1=document.querySelector('#cost-ui input:nth-of-type(1)');
 const n2=document.querySelector('#cost-ui input:nth-of-type(2)');
 if(n1&&n1.value)pNames[0]=n1.value;
 if(n2&&n2.value)pNames[1]=n2.value;

 // Показать/скрыть HUD игрока 2
 document.getElementById('hud-p2').style.display = (numPlayers>=2)?'':'none';

 players=[
 {id:1,x:base.x-52,y:base.y-20,hp:100,maxHp:100,spd:3.5,size:28,color:'#0cf',weapon:'pistol',ammo:12,lastFire:0,reloading:false,reserve:AMMO_MAX,mines:0,barrels:0,controls:pCtrl[0],frozen:0,slow:1,stText:'',stUntil:0,costume:pCostumes[0],walk:0,carryAmmo:0,carryMed:0,name:pNames[0]},
 ];
 if(numPlayers>=2){
 players.push(
 {id:2,x:base.x+24,y:base.y-20,hp:100,maxHp:100,spd:3.5,size:28,color:'#f0f',weapon:'pistol',ammo:12,lastFire:0,reloading:false,reserve:AMMO_MAX,mines:0,barrels:0,controls:pCtrl[1],frozen:0,slow:1,stText:'',stUntil:0,costume:pCostumes[1],walk:0,carryAmmo:0,carryMed:0,name:pNames[1]}
 );
 }
 zombies=[];bullets=[];droppedCoins=[];bossProj=[];mines=[];barrels=[];poisonPools=[];tpQueue=[];dmgNums=[];airdrops=[];airdropPlane=null;
 wave=0;gCoins=0;tick=0;lastTP=0;ammoCD=0;medCD=0;fartFogTimer=0;
 waveSpawning=false;waveTotal=0;waveSpawned=0;
 depotAmmo=0;depotMed=0;
 base.hp=base.maxHp;base.alive=true;
 cam.x=base.x;cam.y=base.y;
 for(const k in WEAPONS)WEAPONS[k].owned=(k==='pistol');
 gState='PLAYING';
   multiplayerMode = isOnline;
  
  // === ОНЛАЙН РЕЖИМ ===
  if (isOnline) {
    document.getElementById('ui-lobby').classList.add('hidden');
  }
  document.getElementById('ui-menu').classList.add('hidden');
  
  console.log(`🎮 Игра запущена: ${isOnline ? 'ОНЛАЙН МУЛЬТИПЛЕЕР' : 'ЛОКАЛЬНЫЙ РЕЖИМ'}`);
 ensAudio();startAmbient();
 document.getElementById('ui-menu').classList.add('hidden');
 document.getElementById('ui-death').classList.add('hidden');
 document.getElementById('ui-shop').classList.add('hidden');
 document.getElementById('ui-pause').classList.add('hidden');
 document.getElementById('ui-pause-ctrl').classList.add('hidden');
 document.getElementById('base-ui').classList.remove('dead');
 document.getElementById('base-ttl').classList.remove('dead');
 spawnInitSupplies();
 nextWave();
 updateUI();
 renderShop();
}

function goMainMenu(){
 gState='MENU';stopAmbient();
 airdropPlane=null;fartFogTimer=0;
 document.getElementById('ui-menu').classList.remove('hidden');
 document.getElementById('ui-death').classList.add('hidden');
 document.getElementById('ui-pause').classList.add('hidden');
 document.getElementById('ui-pause-ctrl').classList.add('hidden');
 document.getElementById('ui-shop').classList.add('hidden');
 document.getElementById('hud-p2').style.display='';
}
function openPause(){if(gState!=='PLAYING')return;gState='PAUSE';document.getElementById('ui-pause').classList.remove('hidden');}
function closePause(){document.getElementById('ui-pause').classList.add('hidden');document.getElementById('ui-pause-ctrl').classList.add('hidden');gState='PLAYING';}
function showPauseControls(){buildCtrlUI('pause-ctrl-ui','pause');document.getElementById('ui-pause-ctrl').classList.remove('hidden');}
function closePauseControls(){document.getElementById('ui-pause-ctrl').classList.add('hidden');}

// ===== COMBAT =====
function shoot(p,tx,ty){
 if(gState!=='PLAYING'||p.reloading||p.hp<=0)return;
 const now=Date.now();const w=WEAPONS[p.weapon];
 if(now-p.lastFire<w.rate)return;
 if(p.ammo<=0){doReload(p);return;}
 p.lastFire=now;
 const cx=p.x+p.size/2,cy=p.y+p.size/2-10;
 const angle=Math.atan2(ty-cy,tx-cx);
 for(let i=0;i<w.pel;i++){
 const fa=angle+(Math.random()-0.5)*w.spread;
 bullets.push({x:cx,y:cy,vx:Math.cos(fa)*w.spd,vy:Math.sin(fa)*w.spd,dmg:w.dmg,owner:p.id});
 }
 p.ammo--;sndShoot(p.weapon);updateUI();
}

function doReload(p){
 if(p.reloading||p.hp<=0)return;
 const w=WEAPONS[p.weapon];
 if(p.ammo===w.clip)return;
 if(p.reserve<=0){setSt(p,'НУЖЕН ЯЩИК С ПАТРОНАМИ!',1500);updateUI();return;}
 p.reloading=true;p.reserve--;updateUI();
 sndReload();
 setTimeout(()=>{if(p.hp>0){p.ammo=w.clip;p.reloading=false;updateUI();}},w.reload);
}

function placeMine(p){
 if(p.hp<=0||gState!=='PLAYING')return;
 if(p.mines>0){mines.push({x:p.x+p.size/2,y:p.y+p.size/2,timer:0});p.mines--;updateUI();}
 else setSt(p,'НЕТ МИН!',700);
}

function placeBarrel(p){
 if(p.hp<=0||gState!=='PLAYING')return;
 if(p.barrels>0){
 barrels.push({x:p.x+p.size/2,y:p.y+p.size/2,hp:BARREL_HP,maxHp:BARREL_HP});
 p.barrels--;updateUI();
 } else setSt(p,'НЕТ БОЧЕК!',700);
}

// ===== СКЛАД — РАЗДЕЛЬНЫЙ ПО ТИПАМ =====
function interactDepot(p){
 if(p.hp<=0||gState!=='PLAYING')return;
 const dist=Math.hypot((p.x+p.size/2)-base.x,(p.y+p.size/2)-base.y);
 if(dist>BASE_DEPOT_R){setSt(p,'ПОДОЙДИ К БАЗЕ!',900);return;}

 // Определяем, к какому складу ближе игрок
 const h2 = base.size/2;
 const bx1=base.x-h2-48+16; // центр синего склада (патроны)
 const bx2=base.x+h2+20+16; // центр красного склада (аптечки)
 const distAmmoDepot = Math.abs((p.x+p.size/2) - bx1);
 const distMedDepot = Math.abs((p.x+p.size/2) - bx2);

 let acted = false;

 // СИНИЙ СКЛАД (патроны) — только патроны!
 if(distAmmoDepot < distMedDepot){
 // Игрок ближе к синему складу
 if(p.carryAmmo>0){
 // Кладём патроны в синий склад
 depotAmmo+=p.carryAmmo;p.carryAmmo=0;acted=true;
 sndPickup();setSt(p,'🔫 ПАТРОНЫ СДАНЫ В СИНИЙ СКЛАД',1000);
 } else if(p.carryMed>0){
 // Попытка положить аптечку в склад патронов — НЕЛЬЗЯ
 setSt(p,'❌ АПТЕЧКИ → В КРАСНЫЙ СКЛАД!',1200);acted=true;
 } else if(depotAmmo>0&&p.reserve<AMMO_MAX){
 // Берём патроны из синего склада
 depotAmmo--;p.reserve=AMMO_MAX;p.ammo=WEAPONS[p.weapon].clip;p.reloading=false;
 sndPickup();setSt(p,'🔫 ВЗЯЛ ПАТРОНЫ ИЗ СИНЕГО СКЛАДА',1000);acted=true;
 } else if(depotAmmo===0){
 setSt(p,'СИНИЙ СКЛАД ПУСТ!',900);acted=true;
 } else {
 setSt(p,'ПАТРОНЫ УЖЕ ПОЛНЫЕ!',900);acted=true;
 }
 } else {
 // Игрок ближе к красному складу
 if(p.carryMed>0){
 // Кладём аптечки в красный склад
 depotMed+=p.carryMed;p.carryMed=0;acted=true;
 sndPickup();setSt(p,'💊 АПТЕЧКИ СДАНЫ В КРАСНЫЙ СКЛАД',1000);
 } else if(p.carryAmmo>0){
 // Попытка положить патроны в склад аптечек — НЕЛЬЗЯ
 setSt(p,'❌ ПАТРОНЫ → В СИНИЙ СКЛАД!',1200);acted=true;
 } else if(depotMed>0&&p.hp<p.maxHp){
 // Берём аптечку из красного склада
 depotMed--;p.hp=Math.min(p.maxHp,p.hp+60);
 sndHeal();setSt(p,'💊 ВЗЯЛ АПТЕЧКУ ИЗ КРАСНОГО СКЛАДА',1000);acted=true;
 } else if(depotMed===0){
 setSt(p,'КРАСНЫЙ СКЛАД ПУСТ!',900);acted=true;
 } else {
 setSt(p,'ЗДОРОВЬЕ УЖЕ ПОЛНОЕ!',900);acted=true;
 }
 }
 if(!acted) setSt(p,'НЕЧЕГО ДЕЛАТЬ',900);
 updateUI();
}

function endGame(reason){
 if(gState==='DEAD')return;
 gState='DEAD';stopAmbient();
 airdropPlane=null;fartFogTimer=0;
 document.getElementById('ui-death').classList.remove('hidden');
 document.getElementById('ui-pause').classList.add('hidden');
 document.getElementById('death-reason').innerText=reason;
 document.getElementById('death-score').innerText='ВОЛНА: '+wave+' | МОНЕТ: '+gCoins;
 document.getElementById('base-ui').classList.add('dead');
 document.getElementById('base-ttl').classList.add('dead');
}

function toggleShop(){
 if(gState==='PLAYING'){gState='SHOP';document.getElementById('ui-shop').classList.remove('hidden');renderShop();}
 else if(gState==='SHOP'){gState='PLAYING';document.getElementById('ui-shop').classList.add('hidden');}
}

function renderShop(){
 const cont=document.getElementById('shop-items');cont.innerHTML='';
 for(const key in WEAPONS){
 const w=WEAPONS[key];const item=document.createElement('div');
 item.className='shop-item '+(w.owned?'owned':'');
 const numP = currentPlayers||2;
 let eqBtns='';
 if(w.owned){
 eqBtns='<div class="eb">';
 for(let pi=1;pi<=numP;pi++){
 const col=pi===1?'#33ccff':'#ff66ff';
 eqBtns+=`<button style="background:linear-gradient(180deg,${col},${col}88);" onclick="equip('${key}',${pi})">И${pi}</button>`;
 }
 eqBtns+='</div>';
 } else {
 eqBtns=`<button onclick="buyWeapon('${key}')" ${gCoins<w.cost?'disabled':''}>КУПИТЬ ${w.cost}💰</button>`;
 }
 item.innerHTML='<div style="font-weight:bold;font-size:0.88rem;color:'+(w.owned?'#ffd700':'#fff')+'">'+w.name+'</div>'
 +'<div style="font-size:0.7rem;color:#aaa;text-align:left;">Урон: '+w.dmg+' | Обойма: '+w.clip+' | Скорость: '+w.rate+'мс</div>'
 +eqBtns;
 cont.appendChild(item);
 }
 // Extra items
 const extra = document.getElementById('shop-extra');
 extra.innerHTML='';
 const numP2 = currentPlayers||2;
 // Мины
 const mineItem=document.createElement('div');
 mineItem.className='shop-item';mineItem.style.cssText='background:rgba(36,16,0,0.52);border-color:#f80;';
 let mineBtns='<div class="eb">';
 for(let pi=1;pi<=numP2;pi++) mineBtns+=`<button style="background:linear-gradient(180deg,#ffa500,#cc7700);color:#fff;" onclick="buyMines(12,${pi})">И${pi} — 12💰</button>`;
 mineBtns+='</div>';
 mineItem.innerHTML='<span style="font-weight:bold;color:#ffbf66;font-size:0.83rem;">💣 Мины (×3)</span><div style="font-size:0.7rem;color:#ddd;text-align:left;">Убивают до 3 зомби мгновенно в радиусе!</div>'+mineBtns;
 extra.appendChild(mineItem);
 // Бочки
 const barrelItem=document.createElement('div');
 barrelItem.className='shop-item';barrelItem.style.cssText='background:rgba(10,20,32,0.52);border-color:#68a;';
 let barrelBtns='<div class="eb">';
 for(let pi=1;pi<=numP2;pi++) barrelBtns+=`<button style="background:linear-gradient(180deg,#4488aa,#226688);color:#fff;" onclick="buyBarrels(8,${pi})">И${pi} — 8💰</button>`;
 barrelBtns+='</div>';
 barrelItem.innerHTML='<span style="font-weight:bold;color:#9ac;font-size:0.83rem;">🛢️ Бочки (×2)</span><div style="font-size:0.7rem;color:#acd;text-align:left;">100 ударов зомби. Игроки проходят насквозь.</div>'+barrelBtns;
 extra.appendChild(barrelItem);
}

function buyWeapon(key){if(gCoins>=WEAPONS[key].cost){gCoins-=WEAPONS[key].cost;WEAPONS[key].owned=true;updateUI();renderShop();}}
function buyMines(cost,pid){const p=players.find(pl=>pl.id===pid);if(!p)return;if(gCoins>=cost&&p.mines<9){gCoins-=cost;p.mines+=3;updateUI();renderShop();}}
function buyBarrels(cost,pid){const p=players.find(pl=>pl.id===pid);if(!p)return;if(gCoins>=cost&&p.barrels<8){gCoins-=cost;p.barrels+=2;updateUI();renderShop();}}
function equip(key,pid){const p=players.find(pl=>pl.id===pid);if(!p)return;p.weapon=key;p.reloading=false;updateUI();}

// ===== UI =====
function updateBaseUI(){
 const ratio=Math.max(0,base.hp/base.maxHp);
 for(let i=0;i<4;i++){
 const ss=i/4,se=(i+1)/4,fill=Math.max(0,Math.min(1,(ratio-ss)/(se-ss)));
 const el=document.getElementById('bs'+i);if(!el)continue;
 el.style.width=fill*100+'%';
 el.classList.toggle('low',ratio>0&&ratio<0.35);
 el.classList.toggle('empty',fill<=0);
 }
 document.getElementById('base-lbl').innerText=Math.max(0,Math.ceil(base.hp))+' / '+base.maxHp;
 document.getElementById('base-ui').classList.toggle('dead',base.hp<=0);
 document.getElementById('base-ttl').classList.toggle('dead',base.hp<=0);
}
function updateDepotUI(){
 document.getElementById('depot-ammo').innerText=depotAmmo;
 document.getElementById('depot-med').innerText=depotMed;
}
function updateUI(){
 document.getElementById('val-coins').innerText=gCoins;
 document.getElementById('val-wave').innerText=wave;
 document.getElementById('shop-coins').innerText=gCoins;
 for(const p of players){
 const px='p'+p.id;
 document.getElementById(px+'-name').innerText=p.name||('ИГРОК '+p.id);
 document.getElementById(px+'-hp').style.width=Math.max(0,(p.hp/p.maxHp)*100)+'%';
 const w=WEAPONS[p.weapon];
 document.getElementById(px+'-weapon').innerText=w.name+' ('+(p.reloading?'перезарядка...':p.ammo+'/'+w.clip)+')';
 document.getElementById(px+'-res').innerText='Резерв: '+p.reserve+'/'+AMMO_MAX;
 document.getElementById(px+'-mines').innerText='💣 Мины: '+p.mines;
 document.getElementById(px+'-barrels').innerText='🛢️ Бочки: '+p.barrels+(p.carryAmmo?' | 🔫×'+p.carryAmmo:'')+(p.carryMed?' | 💊×'+p.carryMed:'');
 let st='';
 if(p.frozen>0)st='❄️ ЗАМОРОЖЕН!';
 else if(p.stUntil>Date.now())st=p.stText||'';
 else if(p.ammo===0&&p.reserve<=0)st='ПАТРОНЫ КОНЧИЛИСЬ!';
 document.getElementById(px+'-st').innerText=st;
 }
 updateBaseUI();
 updateDepotUI();
}

// ===== INPUT =====
window.addEventListener('keydown',e=>{
 if(listeningFor){
 e.preventDefault();
 pCtrl[listeningFor.pi][listeningFor.a]=e.code;
 if(players.length>listeningFor.pi)players[listeningFor.pi].controls=pCtrl[listeningFor.pi];
 const wasCtx=listeningCtx;listeningFor=null;
 buildCtrlUI(wasCtx==='pause'?'pause-ctrl-ui':'ctrl-ui',wasCtx);
 return;
 }
 const stop=['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
 if(stop.includes(e.code))e.preventDefault();
 keys[e.code]=true;
 if(e.code==='Escape'){
 if(gState==='PLAYING')openPause();
 else if(gState==='PAUSE')closePause();
 else if(gState==='SHOP')toggleShop();
 return;
 }
 if(e.code==='KeyB'){toggleShop();return;}
 if(gState==='PLAYING'||gState==='SHOP'){
 for(let pi=0;pi<players.length;pi++){
 const p=players[pi];
 if(e.code===pCtrl[pi].reload)doReload(p);
 if(e.code===pCtrl[pi].mine){keys[pCtrl[pi].mine]=false;placeMine(p);}
 if(e.code===pCtrl[pi].barrel){keys[pCtrl[pi].barrel]=false;placeBarrel(p);}
 if(e.code===pCtrl[pi].interact){keys[pCtrl[pi].interact]=false;interactDepot(p);}
 }
 }
});
window.addEventListener('keyup',e=>{keys[e.code]=false;});
canvas.addEventListener('mousedown',e=>{if(e.button===0)mDown=true;});
canvas.addEventListener('mouseup',()=>mDown=false);
canvas.addEventListener('mouseleave',()=>mDown=false);

// ===== ZOMBIE MOVE =====
function moveZ(z,vx,vy){
 if(!colCheck(z.x+vx,z.y+vy,z.size)){z.x+=vx;z.y+=vy;return true;}
 let m=false;
 if(!colCheck(z.x+vx,z.y,z.size)){z.x+=vx;m=true;}
 if(!colCheck(z.x,z.y+vy,z.size)){z.y+=vy;m=true;}
 if(!m){const sx=-vy*0.5,sy=vx*0.5;if(!colCheck(z.x+sx,z.y+sy,z.size)){z.x+=sx;z.y+=sy;m=true;}else if(!colCheck(z.x-sx,z.y-sy,z.size)){z.x-=sx;z.y-=sy;m=true;}}
 return m;
}

function trySpawn(){
 if(ammoPickups.length<MAX_AMMO_P&&ammoCD<=0){if(spawnSupply('ammo'))ammoCD=150;}
 if(medPickups.length<MAX_MED_P&&medCD<=0){if(spawnSupply('medkit'))medCD=200;}
}

// ===== UPDATE =====
function update(){
 if(gState!=='PLAYING')return;
 tick++;
    // ====================== MQTT МУЛЬТИПЛЕЕР ЛОГИКА ======================
  if (multiplayerMode && gState === 'PLAYING') {
    const myPlayer = players.find(p => p.id === myPlayerId);
    
    if (myPlayer) {
      // Отправляем позицию и HP своего игрока каждые 50мс
      if (Date.now() - lastInputSend > 50) {
        lastInputSend = Date.now();
        sendMQTT({
          type: 'playerState',
          id: myPlayerId,
          x: Math.round(myPlayer.x),
          y: Math.round(myPlayer.y),
          hp: Math.round(myPlayer.hp)
        });
      }
    }
    
        // Хост отправляет состояние мира каждые 150мс
    if (isHost && Date.now() - lastWorldSync > 150) {
      lastWorldSync = Date.now();
      
      const worldState = {
        type: 'worldState',                    // ← обязательно!
        zombies: zombies.map(z => ({
          id: z.id || Math.random().toString(36).slice(2, 8),
          x: Math.round(z.x),
          y: Math.round(z.y),
          hp: Math.round(z.hp || 100),
          type: z.type || 'normal'
        })),
        baseHp: Math.round(base.hp),
        wave: wave
      };
      sendMQTT(worldState);
    }
    
    // Не-хост только применяет данные от хоста
    if (!isHost) {
      if (myPlayer) updateSinglePlayer(myPlayer);
      updateUI();
      return; 
    }
  }
 fpsCnt++;
 const nowT=performance.now();
 if(nowT-fpsLast>=1000){fpsVal=fpsCnt;fpsCnt=0;fpsLast=nowT;}
 document.getElementById('fps-c').textContent='FPS: '+fpsVal;
 if(ammoCD>0)ammoCD--;
 if(medCD>0)medCD--;
 if(fartFogTimer>0)fartFogTimer--;
 // Обновляем воздушный дроп
 updateAirdrop();
 if(tick%14===0){
 const lp=getLiving();
 updateFF(flowP,lp.map(p=>({x:p.x+p.size/2,y:p.y+p.size/2})));
 if(base.hp>0)updateFF(flowB,[{x:base.x,y:base.y}]);
 }
 for(const p of players){if(p.frozen>0){p.frozen--;p.slow=0.6;}else p.slow=1;}
 // Движение игроков
 for(const p of players){
 if(p.hp<=0)continue;
 const spd=p.spd*p.slow;
 let moved=false;
 let nx=p.x,ny=p.y;
 if(keys[p.controls.up]){ny-=spd;moved=true;}
 if(keys[p.controls.down]){ny+=spd;moved=true;}
 if(!colCheck(p.x,ny,p.size))p.y=clamp(ny,0,MAPSZ*TILE-p.size);
 if(keys[p.controls.left]){nx-=spd;moved=true;}
 if(keys[p.controls.right]){nx+=spd;moved=true;}
 if(!colCheck(nx,p.y,p.size))p.x=clamp(nx,0,MAPSZ*TILE-p.size);
 if(moved)p.walk=(p.walk||0)+0.2;
 const doShoot=keys[p.controls.shoot]||(p.id===1&&currentPlayers===1&&mDown);
 if(doShoot){
 let target=null,minD=Infinity;
 for(const z of zombies){const d=Math.hypot((p.x+p.size/2)-(z.x+z.size/2),(p.y+p.size/2)-(z.y+z.size/2));if(d<minD&&d<580){minD=d;target=z;}}
 if(target)shoot(p,target.x+target.size/2,target.y+target.size/2);
 else shoot(p,p.x+90,p.y);
 }
 }
 // Камера
 const lv=getLiving();
 if(lv.length>0){
 const ax=lv.reduce((s,p)=>s+p.x+p.size/2,0)/lv.length;
 const ay=lv.reduce((s,p)=>s+p.y+p.size/2,0)/lv.length;
 cam.x+=(ax-canvas.width/2-cam.x)*0.09;
 cam.y+=(ay-canvas.height/2-cam.y)*0.09;
 }
 // Монеты
 for(let i=droppedCoins.length-1;i>=0;i--){
 const c=droppedCoins[i];
 if(c.isExplosion){c.life--;if(c.life<=0){droppedCoins.splice(i,1);}continue;}
 c.hover=Math.sin(Date.now()/150+i)*3;
 for(const p of players){if(p.hp>0&&Math.hypot((p.x+p.size/2)-c.x,(p.y+p.size/2)-c.y)<40&&c.val>0){gCoins+=c.val;droppedCoins.splice(i,1);updateUI();break;}}
 }
 // ПАТРОНЫ — сохраняем carryAmmo И carryMed одновременно!
 for(let i=ammoPickups.length-1;i>=0;i--){
 const a=ammoPickups[i];a.bob+=0.04;
 let taken=false;
 for(const p of players){
 if(p.hp<=0)continue;
 if(Math.hypot((p.x+p.size/2)-a.x,(p.y+p.size/2)-a.y)<34){
 if(p.reserve<AMMO_MAX||p.ammo<WEAPONS[p.weapon].clip){
 p.reserve=AMMO_MAX;p.ammo=WEAPONS[p.weapon].clip;p.reloading=false;
 ammoPickups.splice(i,1);ammoCD=120;taken=true;
 sndPickup();setSt(p,'🔫 ПАТРОНЫ ПОПОЛНЕНЫ ПОЛНОСТЬЮ!',900);updateUI();
 } else if(p.carryAmmo<3){
 // Можно нести патроны даже если уже несёшь аптечки!
 p.carryAmmo++;
 ammoPickups.splice(i,1);ammoCD=80;taken=true;
 sndPickup();setSt(p,'🔫 НЕСУ НА СКЛАД ('+p.carryAmmo+')',900);updateUI();
 } else {
 setSt(p,'ПОЛНО! ОТНЕСИ НА СКЛАД',700);
 }
 break;
 }
 }
 if(taken)continue;
 }
 // Аптечки — carryMed не сбрасывает carryAmmo!
 for(let i=medPickups.length-1;i>=0;i--){
 const m=medPickups[i];m.bob+=0.03;
 let taken=false;
 for(const p of players){
 if(p.hp<=0)continue;
 if(Math.hypot((p.x+p.size/2)-m.x,(p.y+p.size/2)-m.y)<34){
 if(p.hp<p.maxHp){
 p.hp=Math.min(p.maxHp,p.hp+45);
 medPickups.splice(i,1);medCD=180;taken=true;
 sndHeal();setSt(p,'💊 +45 ХП',800);updateUI();
 } else if(p.carryMed<2){
 // Можно нести аптечки даже если уже несёшь патроны!
 p.carryMed++;
 medPickups.splice(i,1);medCD=120;taken=true;
 sndPickup();setSt(p,'💊 НЕСУ НА СКЛАД ('+p.carryMed+')',900);updateUI();
 } else {
 setSt(p,'УЖЕ НЕСУ АПТЕЧКУ!',700);
 }
 break;
 }
 }
 if(taken)continue;
 }
 // Пули
 for(let i=bullets.length-1;i>=0;i--){
 const b=bullets[i];b.x+=b.vx;b.y+=b.vy;
 if(isWall(b.x,b.y)||b.x<0||b.x>MAPSZ*TILE||b.y<0||b.y>MAPSZ*TILE){bullets.splice(i,1);continue;}
 let hit=false;
 for(let j=zombies.length-1;j>=0;j--){
 const z=zombies[j];
 if(Math.hypot(b.x-(z.x+z.size/2),b.y-(z.y+z.size/2))<z.size/2+5){
 z.hp-=b.dmg;z.aggroTimer=220;
 dmgNums.push({x:z.x+z.size/2+(Math.random()-0.5)*10,y:z.y-8,val:Math.round(b.dmg),life:50,max:50,crit:b.dmg>60,isPlayer:false});
 if(Math.random()<0.26)sndZombieHit();
 hit=true;
 if(z.hp<=0){for(let k=0;k<z.rew;k++)droppedCoins.push({x:z.x+z.size/2+(Math.random()-0.5)*18,y:z.y+z.size/2+(Math.random()-0.5)*18,val:1,hover:0});zombies.splice(j,1);}
 break;
 }
 }
 if(hit)bullets.splice(i,1);
 }
 // Снаряды босса/spitter
 for(let i=bossProj.length-1;i>=0;i--){
 const bp=bossProj[i];bp.x+=bp.vx;bp.y+=bp.vy;let rm=false;
 for(const p of players){
 if(p.hp>0&&Math.hypot(bp.x-(p.x+p.size/2),bp.y-(p.y+p.size/2))<22){
 const dmg=bp.dmg||24;p.hp-=dmg;
 dmgNums.push({x:p.x+p.size/2+(Math.random()-0.5)*8,y:p.y-4,val:Math.round(dmg),life:48,max:48,crit:false,isPlayer:true});
 sndPlayerHit();rm=true;updateUI();
 }
 }
 if(!rm&&(isWall(bp.x,bp.y)||bp.x<0||bp.x>MAPSZ*TILE||bp.y<0||bp.y>MAPSZ*TILE)){
 if(bp.type==='poison')poisonPools.push({x:bp.x,y:bp.y,timer:180});rm=true;
 }
 if(rm)bossProj.splice(i,1);
 }
 // Ядовитые лужи
 for(let i=poisonPools.length-1;i>=0;i--){
 const pool=poisonPools[i];pool.timer--;
 for(const p of players){if(p.hp>0&&Math.hypot((p.x+p.size/2)-pool.x,(p.y+p.size/2)-pool.y)<34&&tick%20===0){p.hp-=2;updateUI();}}
 if(pool.timer<=0)poisonPools.splice(i,1);
 }
 // Мины
 for(let i=mines.length-1;i>=0;i--){
 const m=mines[i];m.timer++;
 let exploded=false,killCount=0;
 for(let j=zombies.length-1;j>=0;j--){
 const z=zombies[j];
 if(Math.hypot(m.x-(z.x+z.size/2),m.y-(z.y+z.size/2))<MINE_RADIUS){
 dmgNums.push({x:z.x+z.size/2+(Math.random()-0.5)*12,y:z.y-10,val:Math.round(z.hp),life:65,max:65,crit:true,isPlayer:false});
 for(let k=0;k<z.rew;k++)droppedCoins.push({x:z.x+z.size/2+(Math.random()-0.5)*18,y:z.y+z.size/2+(Math.random()-0.5)*18,val:1,hover:0});
 zombies.splice(j,1);exploded=true;killCount++;
 if(killCount>=3)break;
 }
 }
 if(exploded){sndMineExplode();mines.splice(i,1);}
 }
 // Цифры урона
 for(let i=dmgNums.length-1;i>=0;i--){const d=dmgNums[i];d.y-=0.5;d.life--;if(d.life<=0)dmgNums.splice(i,1);}
 // ===== ЗОМБИ AI =====
 const lp2=getLiving();
 for(const z of zombies){
 const zcx=z.x+z.size/2,zcy=z.y+z.size/2;
 let np=null,npd=Infinity;
 for(const p of lp2){const d=Math.hypot(p.x+p.size/2-zcx,p.y+p.size/2-zcy);if(d<npd){npd=d;np=p;}}
 const bd=Math.hypot(base.x-zcx,base.y-zcy);
 if(z.aggroTimer>0)z.aggroTimer--;
 const aggroed=z.aggroTimer>0;
 const bias=z.type==='boss'?280:z.type==='spitter'?220:180;
 const chasePlayer=!!np&&(aggroed||(npd<bias&&(npd<100||Math.random()<0.22)));
 const target=chasePlayer?np:base;
 const field=chasePlayer?flowP:flowB;
 const tcx=target.x+(target.size||TILE)/2,tcy=target.y+(target.size||TILE)/2;
 const td=Math.max(1,Math.hypot(tcx-zcx,tcy-zcy));
 const fl=sampleFF(field,zcx,zcy);
 let vx=0,vy=0;
 if(fl.d<99999&&(fl.x!==0||fl.y!==0)){const mg=Math.hypot(fl.x,fl.y)||1;const noise=Math.sin(tick*0.04+z.wOff)*(chasePlayer?0.05:0.02);vx=fl.x/mg+noise;vy=fl.y/mg+noise;}
 else{vx=(tcx-zcx)/td;vy=(tcy-zcy)/td;}
 const wp=wallAvoid(zcx,zcy,100);
 const ws=chasePlayer?(npd<120?0.18:0.5):1.1;
 vx+=wp.x*ws;vy+=wp.y*ws;
 const mm=Math.hypot(vx,vy)||1;
 vx=(vx/mm)*z.spd;vy=(vy/mm)*z.spd;
 if(z.type==='leaper'&&chasePlayer&&npd<200&&Date.now()-z.lastLeap>2400&&!z.leaping){
 z.leapVx=(tcx-zcx)/td*z.spd*4.2;z.leapVy=(tcy-zcy)/td*z.spd*4.2;
 z.leaping=true;z.lastLeap=Date.now();
 setTimeout(()=>{if(z)z.leaping=false;},230);
 }
 if(z.type==='spitter'&&Date.now()-z.lastSpit>3000){
 const spitTgt=chasePlayer?np:null;
 const sd=chasePlayer?npd:bd;
 if(spitTgt&&sd<220&&sd>55){
 z.lastSpit=Date.now();
 const tpx=spitTgt.x+spitTgt.size/2,tpy=spitTgt.y+spitTgt.size/2;
 const ang=Math.atan2(tpy-zcy,tpx-zcx);
 bossProj.push({x:zcx,y:zcy,vx:Math.cos(ang)*3.6,vy:Math.sin(ang)*3.6,type:'poison',dmg:10});
 } else if(!chasePlayer&&bd<240&&bd>65){
 z.lastSpit=Date.now();
 const ang=Math.atan2(base.y-zcy,base.x-zcx);
 bossProj.push({x:zcx,y:zcy,vx:Math.cos(ang)*3.6,vy:Math.sin(ang)*3.6,type:'poison',dmg:10});
 }
 }
 if(z.type==='freezer'&&chasePlayer&&npd<105&&tick%65===0){np.frozen=130;}
 if(z.type==='boss'&&Date.now()-z.lastAttack>2200){
 const tgt=chasePlayer?np:base;const dist2=chasePlayer?npd:bd;
 if(tgt&&dist2<360&&dist2>80){
 z.lastAttack=Date.now();
 for(let ai=0;ai<3;ai++){
 const ang=Math.atan2((tgt.y+(tgt.size||TILE)/2)-zcy,(tgt.x+(tgt.size||TILE)/2)-zcx)+(ai-1)*0.26;
 bossProj.push({x:zcx,y:zcy,vx:Math.cos(ang)*5.2,vy:Math.sin(ang)*5.2,type:'fire',dmg:20});
 }
 }
 }
 if(z.leaping){if(!colCheck(z.x+z.leapVx,z.y,z.size))z.x+=z.leapVx;if(!colCheck(z.x,z.y+z.leapVy,z.size))z.y+=z.leapVy;}
 else moveZ(z,vx,vy);
 // БОЧКИ
 for(let bi=barrels.length-1;bi>=0;bi--){
 const bar=barrels[bi];
 const bd2=Math.hypot(zcx-bar.x,zcy-bar.y);
 if(bd2<BARREL_R+z.size/2){
 const pushAngle=Math.atan2(zcy-bar.y,zcx-bar.x);
 const overlap=BARREL_R+z.size/2-bd2+1;
 z.x+=Math.cos(pushAngle)*overlap;z.y+=Math.sin(pushAngle)*overlap;
 if(tick%6===0){
 const fdmg=z.type==='boss'?8:z.type==='leaper'?3:2;
 bar.hp-=fdmg;
 if(bar.hp<=0){sndBarrelBreak();barrels.splice(bi,1);}
 }
 }
 }
 // Атака базы
 if(base.alive&&bd<base.radius+z.size*0.55&&tick%6===0){
 const dmg=z.type==='boss'?2.5:z.type==='leaper'?1.1:z.type==='freezer'?0.7:z.type==='spitter'?0.9:1.0;
 base.hp-=dmg;if(tick%28===0)sndBaseHit();
 if(base.hp<=0){base.hp=0;base.alive=false;endGame('Домик и раненый уничтожены');break;}
 }
 // Атака игроков
 for(const p of lp2){
 const d=Math.hypot(p.x+p.size/2-zcx,p.y+p.size/2-zcy);
 if(d<z.size/2+18&&tick%6===0){
 let dmg=z.type==='boss'?2.0:z.type==='leaper'?1.3:z.type==='freezer'?0.65:z.type==='spitter'?0.8:0.9;
 p.hp-=dmg;
 dmgNums.push({x:p.x+p.size/2+(Math.random()-0.5)*8,y:p.y-4,val:Math.round(dmg*10)/10,life:44,max:44,crit:false,isPlayer:true});
 sndPlayerHit();
 }
 }
 // Застревание
 const mv=Math.abs(z.x-z.lastX)+Math.abs(z.y-z.lastY);
 if(mv<0.4)z.stuckT++;else z.stuckT=0;
 z.lastX=z.x;z.lastY=z.y;
 if(z.stuckT>380&&!tpQueue.includes(z)){tpQueue.push(z);z.stuckT=0;}
 }
 // Телепорт застрявших
 if(tpQueue.length>0&&Date.now()-lastTP>3000){
 for(let i=0;i<Math.min(2,tpQueue.length);i++){
 const z=tpQueue.shift();
 if(z&&zombies.includes(z)){const sp=safeTeleport();if(sp){z.x=sp.x;z.y=sp.y;z.stuckT=0;z.lastX=z.x;z.lastY=z.y;}}
 }
 lastTP=Date.now();
 }
 if(players.every(p=>p.hp<=0))endGame(currentPlayers===1?'Боец погиб':'Оба бойца погибли');
 if(gState!=='PLAYING'){updateUI();return;}
 if(zombies.length===0&&!waveSpawning) nextWave();
 trySpawn();
 updateUI();
}

// ===== DRAW BASE =====
function drawBase(){
 const hr=Math.max(0,base.hp/base.maxHp);
 const x=base.x,y=base.y,s=base.size,h2=s/2;
 ctx.save();
 ctx.fillStyle='rgba(0,0,0,0.33)';ctx.beginPath();ctx.ellipse(x,y+40,s*0.62,s*0.2,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(28,42,12,0.5)';ctx.fillRect(x-h2-24,y-h2-24,s+48,s+56);
 ctx.fillStyle='#6b4f2a';
 for(let fx=-h2-18;fx<=h2+18;fx+=16){ctx.fillRect(x+fx-3,y-h2-24,4,11);ctx.fillRect(x+fx-3,y+h2+22,4,11);}
 ctx.fillStyle=hr>0.5?'#7b3f2a':'#9a4534';
 ctx.beginPath();ctx.moveTo(x-h2-10,y-h2+12);ctx.lineTo(x,y-h2-50);ctx.lineTo(x+h2+10,y-h2+12);ctx.closePath();ctx.fill();
 ctx.fillStyle=hr>0.5?'#4c3628':'#5a342f';ctx.fillRect(x-h2,y-h2+12,s,s*0.65);
 ctx.fillStyle='#2a1c18';ctx.fillRect(x-h2,y+16,s,15);
 ctx.fillStyle='rgba(80,200,255,0.16)';ctx.fillRect(x-h2+12,y-4,22,14);ctx.fillRect(x+h2-34,y-4,22,14);
 ctx.strokeStyle='#777';ctx.lineWidth=1;
 ctx.beginPath();ctx.moveTo(x-h2+23,y-4);ctx.lineTo(x-h2+23,y+10);ctx.stroke();
 ctx.beginPath();ctx.moveTo(x+h2-23,y-4);ctx.lineTo(x+h2-23,y+10);ctx.stroke();
 ctx.fillStyle='#241410';ctx.fillRect(x-16,y+10,32,30);
 ctx.fillStyle='#7c5133';ctx.fillRect(x-12,y+13,7,23);
 ctx.fillStyle='#c8a040';ctx.beginPath();ctx.arc(x-1,y+26,2,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#fff';ctx.fillRect(x-10,y-38,20,16);
 ctx.fillStyle='#ff2222';ctx.fillRect(x-8,y-36,16,6);ctx.fillRect(x-3,y-38,6,16);
 // Синий склад (патроны)
 const bx1=x-h2-48, by1=y+8;
 ctx.fillStyle='#1a2a5a';ctx.fillRect(bx1-2,by1-2,36,28);
 ctx.fillStyle='#2244aa';ctx.fillRect(bx1,by1,32,24);
 ctx.strokeStyle='#4488ff';ctx.lineWidth=2;ctx.strokeRect(bx1,by1,32,24);
 ctx.fillStyle='#88bbff';ctx.fillRect(bx1+2,by1+2,28,4);
 ctx.fillStyle='rgba(255,255,255,0.7)';ctx.font='bold 9px sans-serif';ctx.textAlign='center';
 ctx.fillText('🔫',bx1+16,by1+18);
 ctx.fillStyle='rgba(100,180,255,0.4)';ctx.shadowBlur=8;ctx.shadowColor='#4488ff';ctx.strokeRect(bx1,by1,32,24);ctx.shadowBlur=0;
 // Красный склад (аптечки)
 const bx2=x+h2+20, by2=y+8;
 ctx.fillStyle='#5a1a1a';ctx.fillRect(bx2-2,by2-2,36,28);
 ctx.fillStyle='#aa2244';ctx.fillRect(bx2,by2,32,24);
 ctx.strokeStyle='#ff4488';ctx.lineWidth=2;ctx.strokeRect(bx2,by2,32,24);
 ctx.fillStyle='#ffbbcc';ctx.fillRect(bx2+2,by2+2,28,4);
 ctx.fillStyle='rgba(255,255,255,0.7)';ctx.font='bold 9px sans-serif';ctx.textAlign='center';
 ctx.fillText('💊',bx2+16,by2+18);
 ctx.fillStyle='rgba(255,100,160,0.4)';ctx.shadowBlur=8;ctx.shadowColor='#ff4488';ctx.strokeRect(bx2,by2,32,24);ctx.shadowBlur=0;
 // Подписи
 ctx.fillStyle='rgba(150,200,255,0.9)';ctx.font='bold 7px sans-serif';ctx.textAlign='center';
 ctx.fillText('ПАТРОНЫ',bx1+16,by1+32);
 ctx.fillStyle='rgba(255,150,180,0.9)';
 ctx.fillText('АПТЕЧКИ',bx2+16,by2+32);
 if(hr<0.35&&base.hp>0){
 ctx.strokeStyle='rgba(255,80,80,'+(0.5+Math.sin(Date.now()/120)*0.3)+')';
 ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,base.radius+10+Math.sin(Date.now()/120)*2,0,Math.PI*2);ctx.stroke();
 }
 const bW=116,bH=9,bX=x-bW/2,bY=y-h2-64;
 ctx.fillStyle='rgba(0,0,0,0.65)';ctx.fillRect(bX,bY,bW,bH);
 ctx.fillStyle=hr>0.35?'#5fe56e':'#ff7240';ctx.fillRect(bX,bY,bW*hr,bH);
 ctx.strokeStyle='rgba(255,255,255,0.42)';ctx.lineWidth=1;ctx.strokeRect(bX,bY,bW,bH);
 ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.fillText('🏠 ДОМ',x,bY-3);
 ctx.restore();
}

// ===== DRAW PLAYER =====
function drawPlayer(p){
 const co=p.costume||COSTUMES[0];
 const cx=p.x+p.size/2,cy=p.y+p.size/2+4,ph=p.walk||0;
 ctx.fillStyle='rgba(0,0,0,0.26)';ctx.beginPath();ctx.ellipse(cx,cy+14,13,4,0,0,Math.PI*2);ctx.fill();
 const lg=Math.sin(ph)*5;
 ctx.fillStyle=co.det;ctx.fillRect(cx-8,cy+4+lg,6,13);ctx.fillRect(cx+2,cy+4-lg,6,13);
 ctx.fillStyle='#1a0a05';ctx.fillRect(cx-9,cy+15+lg,8,5);ctx.fillRect(cx+1,cy+15-lg,8,5);
 ctx.fillStyle=co.body;ctx.fillRect(cx-11,cy-8,22,14);
 ctx.fillStyle=co.det;ctx.fillRect(cx-3,cy-6,6,2);ctx.fillRect(cx-3,cy-2,6,2);
 ctx.fillStyle='rgba(0,0,0,0.15)';ctx.fillRect(cx-11,cy-8,22,4);
 const ag=Math.cos(ph)*4;
 ctx.fillStyle=co.body;ctx.fillRect(cx-16,cy-7+ag,5,12);ctx.fillRect(cx+11,cy-7-ag,5,12);
 ctx.fillStyle=co.det;
 ctx.beginPath();ctx.arc(cx-13,cy+5+ag,3.5,0,Math.PI*2);ctx.fill();
 ctx.beginPath();ctx.arc(cx+13,cy+5-ag,3.5,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#555';ctx.save();ctx.translate(cx+13,cy+5-ag);
 ctx.fillRect(0,-2,14,4);ctx.fillStyle='#777';ctx.fillRect(11,-3,4,3);
 ctx.fillStyle='#222';ctx.fillRect(2,-1,6,2);ctx.restore();
 ctx.fillStyle=co.head;ctx.fillRect(cx-4,cy-14,8,8);
 ctx.fillStyle=co.head;ctx.beginPath();ctx.arc(cx,cy-22,11,0,Math.PI*2);ctx.fill();
 ctx.fillStyle=co.helm;ctx.fillRect(cx-13,cy-34,26,14);
 ctx.fillStyle='rgba(255,255,255,0.09)';ctx.fillRect(cx-10,cy-33,12,4);
 ctx.fillStyle='rgba(100,200,255,0.15)';ctx.fillRect(cx-10,cy-28,20,6);
 ctx.fillStyle='#fff';ctx.fillRect(cx-9,cy-24,6,6);ctx.fillRect(cx+3,cy-24,6,6);
 ctx.fillStyle='#0a0a22';ctx.fillRect(cx-8,cy-23,4,4);ctx.fillRect(cx+4,cy-23,4,4);
 ctx.fillStyle='rgba(255,255,255,0.55)';ctx.fillRect(cx-8,cy-23,1.5,1.5);ctx.fillRect(cx+4,cy-23,1.5,1.5);
 const nm=p.name||('П'+p.id);
 ctx.fillStyle=p.color;ctx.font='bold 9px sans-serif';ctx.textAlign='center';
 ctx.shadowBlur=5;ctx.shadowColor=p.color;ctx.fillText(nm,cx,cy-37);ctx.shadowBlur=0;
 if(p.reloading){ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.fillText('⟳',cx,cy-44);}
 if(p.frozen>0){ctx.fillStyle='rgba(100,200,255,0.26)';ctx.beginPath();ctx.arc(cx,cy-8,22,0,Math.PI*2);ctx.fill();ctx.font='10px sans-serif';ctx.fillText('❄',cx,cy-18);}
 if(p.carryAmmo>0||p.carryMed>0){
 ctx.font='9px sans-serif';ctx.textAlign='center';
 const txt=(p.carryAmmo>0?'🔫':'')+(p.carryMed>0?'💊':'');
 ctx.fillText(txt,cx,cy-50);
 }
}

// ===== DRAW ZOMBIE =====
function drawZombie(z){
 const cx=z.x+z.size/2,cy=z.y+z.size/2+2,ph=tick*0.26+z.wOff;
 let bC,hC,eC,dC;
 if(z.type==='boss'){bC='#8b0000';hC='#5a0000';eC='#ffff00';dC='#aa2020';}
 else if(z.type==='leaper'){bC='#7a4800';hC='#5c3800';eC='#ff8800';dC='#cc7700';}
 else if(z.type==='freezer'){bC='#1a4080';hC='#122e60';eC='#88ffff';dC='#4488cc';}
 else if(z.type==='spitter'){bC='#1a5010';hC='#0e3508';eC='#88ff44';dC='#33bb22';}
 else{bC='#2e5c10';hC='#1e3e08';eC='#ff3300';dC='#4a9020';}
 // Босс рисуется крупнее через scale, но физический размер как у обычных зомби
 const sc=z.type==='boss'?1.4:1;
 ctx.save();
 if(sc!==1){ctx.translate(cx,cy);ctx.scale(sc,sc);ctx.translate(-cx,-cy);}
 ctx.fillStyle='rgba(0,0,0,0.34)';ctx.beginPath();ctx.ellipse(cx,cy+(z.size/2+4)/sc,z.size/sc*0.5,5/sc,0,0,Math.PI*2);ctx.fill();
 const lg=Math.sin(ph)*4;
 ctx.fillStyle=dC;ctx.fillRect(cx-8,cy+4+lg,6,13);ctx.fillRect(cx+2,cy+4-lg,6,13);
 ctx.fillStyle='#111';ctx.fillRect(cx-10,cy+15+lg,9,4);ctx.fillRect(cx,cy+15-lg,9,4);
 ctx.fillStyle=bC;ctx.fillRect(cx-11,cy-8,22,16);
 ctx.fillStyle='rgba(0,0,0,0.2)';ctx.fillRect(cx-5,cy-6,3,10);ctx.fillRect(cx+3,cy-2,3,8);
 const ag=Math.sin(ph+0.5)*5;
 ctx.fillStyle=bC;ctx.fillRect(cx-17,cy-8+ag,7,14);ctx.fillRect(cx+10,cy-8-ag,7,14);
 ctx.fillStyle=hC;
 for(let fi=0;fi<3;fi++){ctx.beginPath();ctx.arc(cx-13+fi*2,cy+6+ag+fi,2.2,0,Math.PI*2);ctx.arc(cx+14-fi*2,cy+6-ag+fi,2.2,0,Math.PI*2);ctx.fill();}
 ctx.fillStyle=hC;ctx.fillRect(cx-11,cy-8,8,4);ctx.fillRect(cx+3,cy-8,8,4);
 ctx.fillStyle=hC;ctx.beginPath();ctx.arc(cx,cy-20,11,0,Math.PI*2);ctx.fill();
 ctx.strokeStyle='rgba(180,0,0,0.33)';ctx.lineWidth=1.5;
 ctx.beginPath();ctx.moveTo(cx-4,cy-26);ctx.lineTo(cx-2,cy-18);ctx.stroke();
 ctx.beginPath();ctx.moveTo(cx+5,cy-22);ctx.lineTo(cx+3,cy-16);ctx.stroke();
 ctx.shadowBlur=9;ctx.shadowColor=eC;ctx.fillStyle=eC;
 ctx.beginPath();ctx.arc(cx-4,cy-21,3.5,0,Math.PI*2);ctx.arc(cx+4,cy-21,3.5,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 ctx.fillStyle='#000';ctx.beginPath();ctx.arc(cx-4,cy-21,1.5,0,Math.PI*2);ctx.arc(cx+4,cy-21,1.5,0,Math.PI*2);ctx.fill();
 ctx.strokeStyle='rgba(200,40,40,0.65)';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(cx,cy-13,5.5,0.1*Math.PI,0.9*Math.PI);ctx.stroke();
 if(z.type==='boss'){ctx.fillStyle='#cc8800';for(let bi=0;bi<5;bi++){const bx=cx-10+bi*5,by2=cy-31;ctx.fillRect(bx,by2-4-(bi%2)*5,3,8+(bi%2)*5);}}
 if(z.type==='leaper'&&z.leaping){ctx.fillStyle='rgba(255,140,0,0.24)';ctx.beginPath();ctx.arc(cx,cy,18,0,Math.PI*2);ctx.fill();}
 if(z.type==='freezer'){ctx.strokeStyle='rgba(140,210,255,0.38)';ctx.lineWidth=1;for(let ii=0;ii<4;ii++){const ang=ii*Math.PI/2+tick*0.04;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ang)*22,cy+Math.sin(ang)*22);ctx.stroke();}}
 ctx.restore();
 if(z.hp<z.maxHp){
 const bw=z.size+6,bh=5,bx=z.x-3,by=z.y-22;
 ctx.fillStyle='rgba(0,0,0,0.65)';ctx.fillRect(bx,by,bw,bh);
 const hrz=Math.max(0,z.hp/z.maxHp);
 ctx.fillStyle=z.type==='boss'?'hsl('+Math.floor(hrz*120)+',100%,40%)':hrz>0.5?'#ee3333':'#ff7700';
 ctx.fillRect(bx,by,bw*hrz,bh);
 ctx.strokeStyle='rgba(255,255,255,0.22)';ctx.lineWidth=0.5;ctx.strokeRect(bx,by,bw,bh);
 }
}

// ===== DRAW MINE =====
function drawMine(m){
 const x=m.x,y=m.y;
 const al=0.6+Math.sin(Date.now()/200)*0.4;
 const t=Date.now()/1000;
 ctx.save();
 ctx.fillStyle='rgba(0,0,0,0.3)';ctx.beginPath();ctx.ellipse(x,y+4,12,4,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#3a3a3a';ctx.beginPath();ctx.ellipse(x,y-2,12,8,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#555';ctx.beginPath();ctx.ellipse(x,y-4,11,7,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(255,80,0,'+al+')';ctx.shadowBlur=10;ctx.shadowColor='#f80';
 ctx.beginPath();ctx.arc(x,y-4,4,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 ctx.strokeStyle='#888';ctx.lineWidth=1.5;
 ctx.beginPath();ctx.moveTo(x+4,y-6);ctx.lineTo(x+7,y-13);ctx.stroke();
 ctx.fillStyle='#ff4400';ctx.beginPath();ctx.arc(x+7,y-13,2,0,Math.PI*2);ctx.fill();
 for(let i=0;i<4;i++){
 const ang=i*Math.PI/2+0.3;
 ctx.fillStyle='#888';ctx.beginPath();ctx.arc(x+Math.cos(ang)*9,y-4+Math.sin(ang)*5,1.5,0,Math.PI*2);ctx.fill();
 }
 ctx.strokeStyle='rgba(255,136,0,'+al*0.5+')';ctx.lineWidth=1;
 ctx.beginPath();ctx.arc(x,y-4,14+Math.sin(t*5)*2,0,Math.PI*2);ctx.stroke();
 ctx.restore();
}

// ===== DRAW BARREL =====
function drawBarrel(bar){
 const x=bar.x,y=bar.y;
 const hr=Math.max(0,bar.hp/bar.maxHp);
 ctx.save();
 ctx.fillStyle='rgba(0,0,0,0.32)';ctx.beginPath();ctx.ellipse(x,y+BARREL_R+2,BARREL_R*0.9,BARREL_R*0.3,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle=hr>0.5?'#8b4a1a':'#7a3a14';
 ctx.beginPath();ctx.ellipse(x,y,BARREL_R,BARREL_R*0.45,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle=hr>0.5?'#a05820':'#8a4418';
 ctx.fillRect(x-BARREL_R,y,BARREL_R*2,BARREL_R*1.6);
 ctx.fillStyle=hr>0.5?'#8b4a1a':'#7a3a14';
 ctx.beginPath();ctx.ellipse(x,y+BARREL_R*1.6,BARREL_R,BARREL_R*0.45,0,0,Math.PI*2);ctx.fill();
 ctx.strokeStyle='#444';ctx.lineWidth=3;
 ctx.beginPath();ctx.ellipse(x,y+BARREL_R*0.4,BARREL_R,BARREL_R*0.3,0,0,Math.PI*2);ctx.stroke();
 ctx.beginPath();ctx.ellipse(x,y+BARREL_R*1.2,BARREL_R,BARREL_R*0.3,0,0,Math.PI*2);ctx.stroke();
 ctx.fillStyle='rgba(255,220,100,0.9)';ctx.font='bold 10px sans-serif';ctx.textAlign='center';
 ctx.fillText('🛢',x,y+BARREL_R*0.9);
 const bw=BARREL_R*2+4;
 ctx.fillStyle='rgba(0,0,0,0.6)';ctx.fillRect(x-BARREL_R-2,y-BARREL_R*0.6-8,bw,5);
 ctx.fillStyle=hr>0.5?'#5fe56e':'#ff7240';ctx.fillRect(x-BARREL_R-2,y-BARREL_R*0.6-8,bw*hr,5);
 ctx.restore();
}

// ===== RENDER WORLD =====
function renderWorld(vp){
 const{x,y,w,h,camX,camY,zoom,showArrow}=vp;
 ctx.save();
 ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
 ctx.fillStyle='#0d1507';ctx.fillRect(x,y,w,h);
 ctx.translate(x+w/2,y+h/2);ctx.scale(zoom,zoom);ctx.translate(-camX,-camY);
 if(floorCache)ctx.drawImage(floorCache,0,0);
 const rq=[];
 rq.push({type:'base',sy:base.y+base.size});
 droppedCoins.forEach(c=>rq.push({type:'coin',sy:c.y,o:c}));
 ammoPickups.forEach(a=>rq.push({type:'ammo',sy:a.y,o:a}));
 medPickups.forEach(m=>rq.push({type:'med',sy:m.y,o:m}));
 mines.forEach(m=>rq.push({type:'mine',sy:m.y,o:m}));
 barrels.forEach(b=>rq.push({type:'barrel',sy:b.y+BARREL_R,o:b}));
 poisonPools.forEach(p=>rq.push({type:'poison',sy:p.y,o:p}));
 players.forEach(p=>{if(p.hp>0)rq.push({type:'player',sy:p.y+p.size,o:p});});
 zombies.forEach(z=>rq.push({type:'zombie',sy:z.y+z.size,o:z}));
 bossProj.forEach(bp=>rq.push({type:'proj',sy:bp.y,o:bp}));
 rq.sort((a,b)=>a.sy-b.sy);
 ctx.shadowBlur=7;ctx.shadowColor='#ffe000';ctx.fillStyle='#ffe800';
 for(const b of bullets){ctx.beginPath();ctx.arc(b.x,b.y,3.5,0,Math.PI*2);ctx.fill();}
 ctx.shadowBlur=0;
 for(const item of rq){
 if(item.type==='base'){drawBase();}
 else if(item.type==='coin'){
 const c=item.o;
 if(c.isExplosion){
 ctx.fillStyle='rgba(255,100,0,0.5)';ctx.beginPath();ctx.arc(c.x,c.y,8,0,Math.PI*2);ctx.fill();
 continue;
 }
 ctx.fillStyle='rgba(0,0,0,0.18)';ctx.beginPath();ctx.ellipse(c.x,c.y+4,7,3,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#ffd700';ctx.shadowBlur=8;ctx.shadowColor='#ffd700';
 ctx.beginPath();ctx.arc(c.x,c.y-6+c.hover,7,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 ctx.fillStyle='rgba(255,255,255,0.7)';ctx.font='bold 8px sans-serif';ctx.textAlign='center';ctx.fillText('₽',c.x,c.y-3+c.hover);
 }
 else if(item.type==='ammo'){
 const a=item.o;const bob=Math.sin(Date.now()/180+a.bob)*3;
 ctx.fillStyle='rgba(0,0,0,0.18)';ctx.beginPath();ctx.ellipse(a.x,a.y+6,12,4,0,0,Math.PI*2);ctx.fill();
 ctx.shadowBlur=8;ctx.shadowColor='#cc9900';
 ctx.fillStyle='#4c3210';ctx.fillRect(a.x-13,a.y-11+bob,26,18);
 ctx.fillStyle='#c8800a';ctx.fillRect(a.x-11,a.y-7+bob,22,2);ctx.fillRect(a.x-11,a.y-2+bob,22,2);ctx.fillRect(a.x-11,a.y+3+bob,22,2);
 ctx.fillStyle='rgba(255,200,100,0.26)';ctx.fillRect(a.x-11,a.y-9+bob,10,14);
 ctx.shadowBlur=0;
 ctx.fillStyle='#ffee88';ctx.font='bold 7px sans-serif';ctx.textAlign='center';ctx.fillText('ПАТР.',a.x,a.y-13+bob);
 }
 else if(item.type==='med'){
 const m=item.o;const bob=Math.sin(Date.now()/170+m.bob)*3;
 ctx.fillStyle='rgba(0,0,0,0.18)';ctx.beginPath();ctx.ellipse(m.x,m.y+6,11,4,0,0,Math.PI*2);ctx.fill();
 ctx.shadowBlur=10;ctx.shadowColor='#ff4444';
 ctx.fillStyle='#ffdddd';ctx.fillRect(m.x-11,m.y-11+bob,22,22);
 ctx.fillStyle='#ff2f2f';ctx.fillRect(m.x-4,m.y-8+bob,8,16);ctx.fillRect(m.x-9,m.y-3+bob,18,7);
 ctx.shadowBlur=0;
 }
 else if(item.type==='mine'){drawMine(item.o);}
 else if(item.type==='barrel'){drawBarrel(item.o);}
 else if(item.type==='poison'){
 const p=item.o;const al=p.timer/180;
 ctx.fillStyle='rgba(0,255,0,'+(al*0.34)+')';ctx.shadowBlur=9;ctx.shadowColor='#0f0';
 ctx.beginPath();ctx.arc(p.x,p.y,30,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 }
 else if(item.type==='proj'){
 const bp=item.o;
 ctx.fillStyle=bp.type==='poison'?'#00ff44':'#ff6600';
 ctx.shadowBlur=9;ctx.shadowColor=bp.type==='poison'?'#0f0':'#f60';
 ctx.beginPath();ctx.arc(bp.x,bp.y,7,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 }
 else if(item.type==='player'){drawPlayer(item.o);}
 else if(item.type==='zombie'){drawZombie(item.o);}
 }
 // Рисуем самолёт и дроп в мировых координатах
 drawAirdrop();
 // Цифры урона
 ctx.textAlign='center';
 for(const dn of dmgNums){
 'const t=dn.life/dn.maxctx.globalAlpha=t;ctx.shadowBlur=dn.crit?12:5';
		if(dn.isPlayer){ctx.font='bold 13px sans-serif';ctx.shadowColor='#ff4400';ctx.fillStyle='#ffaa55';}
		else if(dn.crit){ctx.font='bold 17px sans-serif';ctx.shadowColor='#ff8800';ctx.fillStyle='#ffcc00';}
		else{ctx.font='bold 12px sans-serif';ctx.shadowColor='#ff2222';ctx.fillStyle='#ff6666';}
		ctx.fillText((dn.isPlayer?'-':dn.crit?'💥':'-')+dn.val,dn.x,dn.y);
		ctx.shadowBlur=0;ctx.globalAlpha=1;
	}
	// Стрелка на базу (split screen)
	if(showArrow){
		const bsx=(base.x-camX)*zoom+w/2,bsy=(base.y-camY)*zoom+h/2;
		if(bsx<-10||bsx>w+10||bsy<-10||bsy>h+10){
			const ang=Math.atan2(bsy-h/2,bsx-w/2);
			const margin=44;
			const edgeX=clamp(w/2+Math.cos(ang)*(Math.min(w,h)/2-margin),margin,w-margin);
			const edgeY=clamp(h/2+Math.sin(ang)*(Math.min(w,h)/2-margin),margin,h-margin);
			ctx.restore();ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
			ctx.save();ctx.translate(x+edgeX,y+edgeY);ctx.rotate(ang);
			ctx.fillStyle='rgba(255,215,0,0.92)';
			ctx.beginPath();ctx.moveTo(20,0);ctx.lineTo(-9,11);ctx.lineTo(-9,-11);ctx.closePath();ctx.fill();
			ctx.strokeStyle='rgba(0,0,0,0.6)';ctx.lineWidth=1.5;ctx.stroke();
			ctx.restore();
			ctx.fillStyle='rgba(255,215,0,0.9)';ctx.font='bold 9px sans-serif';ctx.textAlign='center';
			ctx.fillText('🏠',x+edgeX,y+edgeY+20);
			ctx.restore();return;
		}
	}
	// Туман по краям
	const mp=MAPSZ*TILE;
	const fog=ctx.createRadialGradient(mp/2,mp/2,mp*0.28,mp/2,mp/2,mp*0.7);
	fog.addColorStop(0,'rgba(0,0,0,0)');fog.addColorStop(1,'rgba(0,0,0,0.58)');
	ctx.fillStyle=fog;ctx.fillRect(0,0,mp,mp);
	ctx.restore();
}

// ===== DRAW =====
function draw(){
	ctx.fillStyle='#0d1507';ctx.fillRect(0,0,canvas.width,canvas.height);
	if(gState!=='MENU'){
		if(currentPlayers>=2&&players.length>=2){
			const lv=getLiving();
			const p1=players[0],p2=players[1];
			const p1cx=p1.x+p1.size/2,p1cy=p1.y+p1.size/2;
			const p2cx=p2.x+p2.size/2,p2cy=p2.y+p2.size/2;
			const dist=Math.hypot(p1cx-p2cx,p1cy-p2cy);
			const split=lv.length>=2&&dist>860;
			if(split){
				renderWorld({x:0,y:0,w:canvas.width/2,h:canvas.height,camX:p1cx,camY:p1cy,zoom:0.92,showArrow:true});
				renderWorld({x:canvas.width/2,y:0,w:canvas.width/2,h:canvas.height,camX:p2cx,camY:p2cy,zoom:0.92,showArrow:true});
				ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(canvas.width/2-1,0,2,canvas.height);
				ctx.fillStyle='rgba(14,36,6,0.84)';ctx.fillRect(canvas.width/2-92,6,184,22);
				ctx.strokeStyle='rgba(70,140,35,0.5)';ctx.lineWidth=1;ctx.strokeRect(canvas.width/2-92,6,184,22);
				ctx.fillStyle='#88cc55';ctx.font='bold 10px sans-serif';ctx.textAlign='center';
				ctx.fillText('⚡ РАЗДЕЛЕНИЕ ЭКРАНА ⚡',canvas.width/2,21);
			} else {
				const zoom=clamp(1.08-Math.min(0.28,dist/2600),0.82,1.08);
				const fx=lv.length?lv.reduce((s,p)=>s+p.x+p.size/2,0)/lv.length:base.x;
				const fy=lv.length?lv.reduce((s,p)=>s+p.y+p.size/2,0)/lv.length:base.y;
				renderWorld({x:0,y:0,w:canvas.width,h:canvas.height,camX:fx,camY:fy,zoom,showArrow:false});
			}
		} else if(currentPlayers===1&&players.length>=1){
			// Одиночная игра — камера следует за игроком 1
			const p=players[0];
			const pcx=p.x+p.size/2,pcy=p.y+p.size/2;
			renderWorld({x:0,y:0,w:canvas.width,h:canvas.height,camX:pcx,camY:pcy,zoom:1.05,showArrow:false});
		}
		// Рисуем самолёт/дроп поверх всего (в экранных координатах)
		// drawAirdrop вызывается внутри renderWorld в мировых координатах, это нормально
	}
// ===== ЗЕЛЁНЫЙ ТУМАН ОТ ПУКА С ВОЗДУХА =====
if(fartFogTimer>0&&gState!=='MENU'){
var fogA;
if(fartFogTimer>165)fogA=(180-fartFogTimer)/15;
else if(fartFogTimer<30)fogA=fartFogTimer/30;
else fogA=1.0;
fogA=Math.max(0,Math.min(1,fogA));

// 1-й слой — почти чёрно-зелёный, очень плотный
ctx.fillStyle='rgba(3,18,0,'+(fogA*0.94)+')';
ctx.fillRect(0,0,canvas.width,canvas.height);

// 2-й слой — тёмно-зелёный
ctx.fillStyle='rgba(8,40,2,'+(fogA*0.88)+')';
ctx.fillRect(0,0,canvas.width,canvas.height);

// 3-й слой — ядовитый зелёный поверх
ctx.fillStyle='rgba(15,60,0,'+(fogA*0.7)+')';
ctx.fillRect(0,0,canvas.width,canvas.height);

// Густые тёмные клубы
for(var fi=0;fi<20;fi++){
var fcx=(Math.sin(Date.now()/1300+fi*3.7)*0.55+0.5)*canvas.width;
var fcy=(Math.cos(Date.now()/950+fi*2.3)*0.55+0.5)*canvas.height;
var fr=80+Math.sin(Date.now()/650+fi*1.1)*40;
ctx.fillStyle='rgba(5,35,0,'+(fogA*0.55)+')';
ctx.beginPath();ctx.arc(fcx,fcy,fr,0,Math.PI*2);ctx.fill();
}

// Едва видимые зелёные пятна (создают ощущение газа)
for(var fi2=0;fi2<30;fi2++){
var fx2=(Math.sin(Date.now()/550+fi2*4.1)*0.65+0.5)*canvas.width;
var fy2=(Math.cos(Date.now()/420+fi2*3.3)*0.65+0.5)*canvas.height;
var fr2=30+Math.sin(Date.now()/340+fi2)*22;
ctx.fillStyle='rgba(30,100,5,'+(fogA*0.35)+')';
ctx.beginPath();ctx.arc(fx2,fy2,fr2,0,Math.PI*2);ctx.fill();
}

// Совсем мелкие частицы газа
for(var fi3=0;fi3<18;fi3++){
var fx3=(Math.sin(Date.now()/380+fi3*6.7)*0.7+0.5)*canvas.width;
var fy3=(Math.cos(Date.now()/310+fi3*5.1)*0.7+0.5)*canvas.height;
var fr3=10+Math.sin(Date.now()/270+fi3)*8;
ctx.fillStyle='rgba(60,180,15,'+(fogA*0.18)+')';
ctx.beginPath();ctx.arc(fx3,fy3,fr3,0,Math.PI*2);ctx.fill();
}

// Текст — еле проглядывает через газ
var tA=Math.min(1,fogA*1.2);
ctx.fillStyle='rgba(80,200,20,'+tA+')';
var fSz=32+Math.sin(Date.now()/220)*6;
ctx.font='bold '+Math.floor(fSz)+'px sans-serif';
ctx.textAlign='center';ctx.shadowBlur=30;ctx.shadowColor='rgba(0,255,0,0.5)';
var fTxts=['💨 ПУУУК!','💨 ГАЗОВАЯ АТАКА!','💩 КТО НАВАЛИЛ?!','🤢 ВОЗДУШНАЯ БОМБА!','💨 ТОКСИЧНО!','🤮 ОТРАВЛЕНИЕ!'];
var fTi=Math.floor(Date.now()/700)%fTxts.length;
ctx.fillText(fTxts[fTi],canvas.width/2,canvas.height/2-15);

ctx.font='bold 16px sans-serif';
ctx.fillStyle='rgba(120,220,50,'+(tA*0.8)+')';
ctx.shadowBlur=15;ctx.shadowColor='rgba(0,180,0,0.4)';
ctx.fillText('👃 Видимость: '+Math.ceil(fartFogTimer/60)+' сек...',canvas.width/2,canvas.height/2+40);

// Рамка экрана — токсичная
ctx.shadowBlur=0;
var edgeW=40+Math.sin(Date.now()/400)*15;
ctx.fillStyle='rgba(0,30,0,'+(fogA*0.85)+')';
ctx.fillRect(0,0,edgeW,canvas.height);
ctx.fillRect(canvas.width-edgeW,0,edgeW,canvas.height);
ctx.fillRect(0,0,canvas.width,edgeW);
ctx.fillRect(0,canvas.height-edgeW,canvas.width,edgeW);

ctx.shadowBlur=0;
}
	requestAnimationFrame(draw);
}

function resizeCanvas(){canvas.width=window.innerWidth;canvas.height=window.innerHeight;}
window.addEventListener('resize',resizeCanvas);
resizeCanvas();
draw();
// ====================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ОНЛАЙН ======================
function updateSinglePlayer(p) {
  if (!p) return;
  const ctrl = pCtrl[p.id-1];
  const speed = 4.2;
  
  let newX = p.x;
  let newY = p.y;

  if (keys[ctrl.up]) newY -= speed;
  if (keys[ctrl.down]) newY += speed;
  if (keys[ctrl.left]) newX -= speed;
  if (keys[ctrl.right]) newX += speed;

  // Для не-хоста временно отключаем коллизию со стенами (пока лабиринт не синхронизирован)
  if (!isHost) {
    p.x = newX;
    p.y = newY;
  } else {
    // Хост проверяет стены как обычно
    if (!colCheck(newX, p.y, p.size)) p.x = newX;
    if (!colCheck(p.x, newY, p.size)) p.y = newY;
  }

  // Стрельба...
  if (keys[ctrl.shoot] && !p.reloading && p.ammo > 0) {
    keys[ctrl.shoot] = false;
    if (multiplayerMode && !isHost) {
      sendMQTT({ type: 'playerAction', action: 'shoot', playerId: p.id });
      return;
    }
    if (typeof createBullet === 'function') createBullet(p);
  }
}

function executeRemoteAction(data) {
  const p = players.find(pl => pl.id === data.playerId);
  if (!p) return;
  if (data.action === 'shoot' && typeof createBullet === 'function') {
    createBullet(p);
  }
}

function applyRemoteWorldState(state) {
  if (!state) return;

  // Защита от undefined
  if (state.zombies && Array.isArray(state.zombies)) {
    zombies = state.zombies.map(s => {
      let z = zombies.find(zz => zz.id === s.id);
      if (!z) {
        z = { 
          id: s.id, 
          size: 28, 
          lastX: s.x, 
          lastY: s.y,
          type: s.type || 'normal',
          hp: s.hp || 100,
          maxHp: s.hp || 100
        };
      }
      Object.assign(z, s);
      return z;
    });
  }

  if (typeof state.baseHp === 'number') base.hp = state.baseHp;
  if (typeof state.wave === 'number') wave = state.wave;
}
setInterval(update,1000/60);