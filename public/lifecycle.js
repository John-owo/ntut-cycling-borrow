import {lifecycle,currentAdmin,date} from './api.js?v=lifecycle1008';
import {confirmedFleet} from './fleet-catalog.js';

const $=id=>document.getElementById(id);
const memberPage=!!$('lc-calendar');
const slots={left:'左側全景',right:'右側全景',drivetrain:'傳動系統',damage:'損傷部位（無損傷也須拍攝）'};
const slotHints={left:'車身左側完整入鏡',right:'車身右側完整入鏡',drivetrain:'大盤、鏈條與後變速器',damage:'既有損傷特寫；沒有損傷也拍一張'};
const checks={frame:'車架',tires:'輪胎',brakes:'煞車',gears:'變速',accessories:'配件'};
const statusNames={reserved:'已預約',in_use:'使用中',returned:'已歸還',inspection:'待檢查',cancelled:'已取消'};
const stateNames={available:'可借用',inspection:'待檢查',maintenance:'維修中',retired:'已停用'};
const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
// kind: true/'error' marks a failure, 'ok' a server-confirmed success.
const say=(id,value,kind=false)=>{const e=$(id);if(e){e.textContent=value;e.classList.toggle('error',kind===true||kind==='error');e.classList.toggle('success',kind==='ok');}};
const requestId=()=>crypto.randomUUID();
const localDateTime=d=>new Date(d.getTime()+8*3600000).toISOString().slice(0,16);
const taipeiDateTime=value=>new Date(`${value}+08:00`);
const dayMs=86400000,hourMs=3600000,taipeiOffset=8*hourMs,maxSpan=5*dayMs;
const taipeiMidnight=value=>{const d=new Date(+value+taipeiOffset);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-taipeiOffset);};
const taipeiDayKey=value=>localDateTime(taipeiMidnight(value)).slice(0,10);
const getToken=()=>($('lc-token')?.value||'').trim().toLowerCase();
const hasToken=()=>/^[a-f0-9]{64}$/.test(getToken());
const fmt=value=>date(value);
const shortDate=value=>new Date(value).toLocaleDateString('zh-TW',{month:'numeric',day:'numeric',weekday:'short',timeZone:'Asia/Taipei'});
const monthDay=value=>new Date(value).toLocaleDateString('zh-TW',{month:'numeric',day:'numeric',timeZone:'Asia/Taipei'});
const weekdayName=value=>new Date(value).toLocaleDateString('zh-TW',{weekday:'short',timeZone:'Asia/Taipei'});
const clock=value=>new Date(value).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Taipei'});
const when=value=>value?`${shortDate(value)} ${clock(value)}`:'—';
const range=(a,b)=>taipeiDayKey(new Date(a))===taipeiDayKey(new Date(b))?`${when(a)}–${clock(b)}`:`${when(a)} → ${when(b)}`;
const span=ms=>{const m=Math.max(0,Math.round(ms/60000)),d=Math.floor(m/1440),h=Math.floor(m%1440/60),n=m%60;return [d&&`${d} 天`,h&&`${h} 小時`,n&&`${n} 分`].filter(Boolean).join(' ')||'不到 1 分鐘';};
const details=(label,value)=>{const line=make('p');line.append(make('strong',`${label}：`),make('span',value??'—'));return line;};
const parsedChecks=value=>{try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}};
const button=(text,onClick,cls='secondary')=>{const b=make('button',text,cls);b.type='button';b.addEventListener('click',onClick);return b;};
const pill=(text,tone='')=>make('span',text,`lc-pill${tone?` ${tone}`:''}`);
const overdue=r=>r.status==='in_use'&&new Date(r.end)<new Date();
// Keep a button disabled with progress text until the server answers.
const busy=(b,text)=>{const label=b.textContent;b.disabled=true;b.setAttribute('aria-busy','true');b.textContent=text;return ()=>{b.disabled=false;b.removeAttribute('aria-busy');b.textContent=label;};};
const scrollTo=el=>el?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
const statusTone={reserved:'info',in_use:'busy',inspection:'warn',returned:'done',cancelled:'muted'};

if(memberPage){
 let calendar={assets:[],bookings:[],settings:{}},calendarKey='',me=null,selectedDay=taipeiMidnight(new Date()),selectedBike=null,selectedReservation=null,weekOffset=0,readingPhotos=false,loading=false,calendarQueued=false,memberGeneration=0,privacyGeneration=0,unavailableOpen=false,justReserved=null,cancelling=null,cancelReason='',loaded=false,timeEdited=false,applyDraft=null;
 const pendingMutations=new Map(),previews=new Map(),retryFiles=new Map(),uploading=new Set();
 // Each booking is reached with its own random key, kept only in this browser (the server stores a hash).
 const storeKey='lc-booking-keys',keyOf=new Map();
 const savedKeys=()=>{try{const list=JSON.parse(localStorage.getItem(storeKey)||'[]');return Array.isArray(list)?list.filter(k=>/^[a-f0-9]{64}$/.test(k)):[];}catch{return [];}};
 const saveKeys=list=>{try{localStorage.setItem(storeKey,JSON.stringify([...new Set(list)].slice(-20)));}catch{}};
 const newKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 const tokenFor=r=>keyOf.get(r.id);
 const signerOf=r=>r?.borrower?.name||me?.member?.name||'';
 async function mutate(name,payload,key,token=null){const generation=privacyGeneration,fingerprint=JSON.stringify(payload);let pending=pendingMutations.get(key);if(pending&&pending.fingerprint!==fingerprint)throw new Error('上一筆操作的結果尚未確認。請先更新借車紀錄，再重試相同內容。');if(!pending){pending={requestId:requestId(),fingerprint};pendingMutations.set(key,pending);}try{const result=await lifecycle(name,{...payload,requestId:pending.requestId},token);pendingMutations.delete(key);if(generation!==privacyGeneration)throw Object.assign(new Error('資格碼已切換'),{code:'TOKEN_CHANGED'});return result;}catch(e){if(e.status||e.code==='TOKEN_CHANGED')pendingMutations.delete(key);throw e;}}
 const weekStart=()=>{const d=taipeiMidnight(new Date());const weekday=(new Date(+d+taipeiOffset).getUTCDay()+6)%7;return new Date(+d+(-weekday+weekOffset*7)*dayMs);};
 const intersects=(a,b,c,d)=>new Date(a)<new Date(d)&&new Date(c)<new Date(b);
 // An unreturned loan keeps blocking its assets after the planned end.
 const blockingEnd=b=>b.status==='in_use'&&new Date(b.end)<new Date()?new Date(8.64e15):new Date(b.end);
 const activeBookings=()=>(calendar?.bookings||[]).filter(b=>['reserved','in_use'].includes(b.status));
 function bookingFor(asset,day){const start=taipeiMidnight(day),end=new Date(+start+dayMs);return activeBookings().filter(b=>b.assetIds?.includes(asset.id)&&intersects(b.start,blockingEnd(b),start,end));}
 const assetById=id=>(calendar?.assets||[]).find(a=>a.id===id);
 const bikeOf=r=>(calendar?.assets||[]).find(a=>a.kind==='bike'&&r.assetIds.includes(a.id));
 const accessoriesOf=r=>(calendar?.assets||[]).filter(a=>a.kind==='accessory'&&r.assetIds.includes(a.id));
 const ready=()=>!!calendar?.settings?.termsVersion;
 const uploadKey=slot=>selectedReservation?`${selectedReservation.record.id}:${selectedReservation.phase}:${slot}`:slot;
 function fleet(){const assets=calendar.assets||[],numbered=new Map(assets.filter(a=>a.kind==='bike').map(a=>[a.code,a]));return [...confirmedFleet.map(ref=>({...numbered.get(ref.code),code:ref.code,name:ref.name,state:numbered.get(ref.code)?.state||'inspection',reference:ref})),...assets.filter(a=>a.kind==='bike'&&!confirmedFleet.some(ref=>ref.code===a.code))];}
 function dayState(a,d){if(!a.id)return {mark:'off',label:'待建檔'};if(a.state!=='available')return {mark:'off',label:stateNames[a.state]||a.state};const booked=bookingFor(a,d);if(booked.some(b=>b.status==='in_use'))return {mark:'busy',label:'使用中',booked};if(booked.length)return {mark:'partial',label:'部分時段已預約',booked};return {mark:'free',label:'可借用',booked};}
 const bookable=(a,d)=>['free','partial'].includes(dayState(a,d).mark);
 function clearPrivate(){memberGeneration++;privacyGeneration++;pendingMutations.clear();me=null;keyOf.clear();selectedReservation=null;justReserved=null;cancelling=null;cancelReason='';retryFiles.clear();uploading.clear();for(const url of previews.values())URL.revokeObjectURL(url);previews.clear();$('lc-records').replaceChildren();$('lc-flow').hidden=true;$('lc-flow-form').reset();$('lc-photo-inputs').replaceChildren();$('lc-checks').replaceChildren();$('lc-missing').replaceChildren();for(const id of ['lc-flow-title','lc-flow-subtitle','lc-location','lc-instructions','lc-terms','lc-policy-version','lc-flow-message','lc-member-message','lc-name-hint','lc-photo-state','lc-check-state','lc-sign-state'])$(id).textContent='';clearSignature();$('lc-comparison').replaceChildren();$('lc-comparison').hidden=true;closeLightbox();updateBooking();}

 function renderCalendar(){
  const root=$('lc-calendar');root.replaceChildren();if(!calendar)return;
  const start=weekStart(),today=taipeiMidnight(new Date()),bikes=fleet();
  if(+selectedDay<+today)selectedDay=today;
  $('lc-week-label').textContent=`${monthDay(start)}—${monthDay(new Date(+start+6*dayMs))}`;$('lc-prev-week').disabled=weekOffset<=0;$('lc-next-week').disabled=weekOffset>=5;
  $('lc-gate').hidden=!loaded||ready();
  const days=make('div',undefined,'lc-days');days.setAttribute('role','group');days.setAttribute('aria-label','選擇日期');
  for(let i=0;i<7;i++){const d=new Date(+start+i*dayMs),count=bikes.filter(a=>bookable(a,d)).length,past=+d<+today;const b=button('',()=>pickDay(d),'lc-day');b.append(make('span',weekdayName(d),'lc-day-name'),make('strong',monthDay(d)),make('small',past?'已過':`可借 ${count}`));b.disabled=past;b.classList.toggle('none',!past&&!count);if(taipeiDayKey(d)===taipeiDayKey(new Date()))b.classList.add('today');b.setAttribute('aria-label',`${shortDate(d)}，${past?'已過':`可借 ${count} 台`}`);b.setAttribute('aria-pressed',taipeiDayKey(d)===taipeiDayKey(selectedDay));days.append(b);}
  root.append(days);
  if(selectedBike&&!bikes.some(a=>a.id===selectedBike))selectedBike=null;
  const open=bikes.filter(a=>bookable(a,selectedDay)),closed=bikes.filter(a=>!bookable(a,selectedDay));
  const heading=make('div',undefined,'lc-list-title');heading.append(make('h3',`${shortDate(selectedDay)} 可預約的車`),make('span',`${open.length} 台`));root.append(heading);
  if(!bikes.length)root.append(make('p','尚無已編號的社車。請洽幹部確認。','lc-empty'));
  else if(!open.length)root.append(make('p',ready()?'這天沒有可預約的車。請換一天，或展開下方查看全部車輛狀態。':'目前沒有開放預約的車輛。幹部完成盤點後會在這裡顯示。','lc-empty'));
  for(const a of open)root.append(bikeCard(a,start));
  if(closed.length){const more=make('details',undefined,'lc-unavailable');more.open=unavailableOpen||!open.length&&bikes.length<=3;more.addEventListener('toggle',()=>{unavailableOpen=more.open;});const summary=make('summary');summary.append(make('span',`其他 ${closed.length} 台目前無法預約`),make('small',closed.map(a=>a.code).join('、')));more.append(summary);for(const a of closed)more.append(bikeCard(a,start));root.append(more);}
  renderAccessories();updateBooking();
 }
 function bikeCard(a,start){
  const state=dayState(a,selectedDay),row=make('article',undefined,'lc-asset');row.dataset.state=state.mark;if(a.id&&a.id===selectedBike)row.classList.add('is-selected');
  const thumb=make('div',undefined,'lc-thumb'),photo=a.reference?.photos?.[0];
  if(photo){const link=make('a');link.href=photo.src;link.target='_blank';link.rel='noopener noreferrer';link.title='開啟原始車輛參考照片';const img=make('img');img.src=photo.src;img.alt=photo.alt;img.loading='lazy';img.decoding='async';link.append(img);thumb.append(link);}else thumb.append(make('span','照片待補','lc-photo-pending'));
  const body=make('div',undefined,'lc-asset-body'),head=make('div',undefined,'lc-asset-head');head.append(make('strong',`${a.code} · ${a.name}`),pill(state.label,state.mark));body.append(head);
  if(state.booked?.length)for(const b of state.booked)body.append(make('p',`${b.pending?'待確認':statusNames[b.status]} ${b.status==='in_use'&&new Date(b.end)<new Date()?`${when(b.start)} 起，尚未歸還`:range(b.start,b.end)}`,'lc-booking'));
  else body.append(make('p',!a.id?'幹部尚未完成此車的系統建檔與實車盤點。':a.state==='available'?'這天全天尚無預約。':'目前暫停預約，請洽幹部確認車況。','lc-note'));
  const strip=make('div',undefined,'lc-availability-strip');
  for(let i=0;i<7;i++){const d=new Date(+start+i*dayMs),s=dayState(a,d);const day=button('',()=>pickDay(d),`lc-availability-day ${s.mark}`);day.append(make('span',weekdayName(d).replace('週','')),make('i','','lc-mark '+s.mark));day.disabled=+d<+taipeiMidnight(new Date());day.setAttribute('aria-label',`${a.code} ${shortDate(d)} ${s.label}`);day.setAttribute('aria-pressed',taipeiDayKey(d)===taipeiDayKey(selectedDay));strip.append(day);}
  body.append(strip);
  const choose=button(a.id&&a.id===selectedBike?'已選這台車':'選這台車',()=>{selectedBike=a.id;renderCalendar();say('lc-reserve-message','');},a.id&&a.id===selectedBike?'lc-choose':'secondary lc-choose');choose.disabled=!a.id||!bookable(a,selectedDay);choose.setAttribute('aria-pressed',String(!!a.id&&a.id===selectedBike));body.append(choose);
  row.append(thumb,body);return row;
 }
 function pickDay(d){selectedDay=d;const previous=$('lc-start').value,length=taipeiDateTime($('lc-end').value)-taipeiDateTime(previous);setDefaultTime(timeEdited&&previous?previous.slice(11):null,Number.isFinite(length)&&length>0&&length<=maxSpan?length:null);renderCalendar();}
 function renderAccessories(){
  const box=$('lc-accessories'),accessories=(calendar.assets||[]).filter(a=>a.kind==='accessory'),previouslySelected=new Set([...box.querySelectorAll('input:checked')].map(input=>input.value)),w=chosenWindow();box.replaceChildren();if(!accessories.length)return;
  const set=make('fieldset');set.append(make('legend','加借配件（選填）'));
  for(const a of accessories){const line=make('label',undefined,'lc-checkline lc-accessory');const input=make('input');input.type='checkbox';input.value=a.id;input.disabled=a.state!=='available';input.checked=previouslySelected.has(a.id)&&!input.disabled;input.addEventListener('change',updateBooking);const taken=w?activeBookings().filter(b=>b.assetIds?.includes(a.id)&&intersects(b.start,blockingEnd(b),w.start,w.end)):bookingFor(a,selectedDay);const text=make('span');text.append(make('strong',`${a.code} · ${a.name}`),make('small',a.state!=='available'?stateNames[a.state]||a.state:taken.length?`${w?'此時段':'這天'}已有預約：${taken.map(b=>range(b.start,b.end)).join('；')}`:'可借用'));line.append(input,text);set.append(line);}
  box.append(set);
 }
 // Default to the selected day; keep the member's chosen clock time and length when switching days.
 function setDefaultTime(time=null,length=null){const day=taipeiDayKey(selectedDay),now=new Date(),soon=new Date(Math.ceil((+now+hourMs)/(30*60000))*30*60000);let start=`${day}T${time||'09:00'}`;if(taipeiDateTime(start)<=now)start=taipeiDayKey(soon)===day?localDateTime(soon):`${day}T${time||'09:00'}`;if(day===taipeiDayKey(now)&&!time){start=localDateTime(soon);if(taipeiDayKey(soon)!==day)selectedDay=taipeiMidnight(soon);}$('lc-start').value=start;$('lc-end').value=localDateTime(new Date(+taipeiDateTime(start)+(length||3*hourMs)));limitTimes();}
 function limitTimes(){const now=localDateTime(new Date()),start=$('lc-start').value;$('lc-start').min=now;if(start){$('lc-end').min=start;$('lc-end').max=localDateTime(new Date(+taipeiDateTime(start)+maxSpan));}}
 function chosenWindow(){const start=taipeiDateTime($('lc-start').value),end=taipeiDateTime($('lc-end').value);return Number.isFinite(+start)&&Number.isFinite(+end)?{start,end}:null;}
 const chosenAssets=()=>[selectedBike,...[...$('lc-accessories').querySelectorAll('input:checked')].map(i=>i.value)].filter(Boolean);
 // Client checks only explain likely refusals; the server remains the authority.
 function bookingIssues(){const issues=[],w=chosenWindow();if(loaded&&!ready())issues.push('預約尚未開放：幹部尚未完成取車地點、指引及規範設定。');if(!selectedBike)issues.push('請先在日曆選一台車。');const student=$('lc-student').value.trim();if(!/^[A-Za-z0-9-]{1,30}$/.test(student))issues.push('請填寫學號（英數字）。');if(!$('lc-name').value.trim())issues.push('請填寫姓名。');if(!$('lc-ig-ack').checked)issues.push('請勾選：送出後會私訊社團 Instagram。');if(!w)issues.push('請填寫借用與歸還時間。');else{if(w.start<=new Date())issues.push('借用時間必須晚於現在。');if(w.end<=w.start)issues.push('歸還時間必須晚於借用時間。');else if(w.end-w.start>maxSpan)issues.push('最多借用五天，請縮短借用時間。');for(const id of chosenAssets()){const clash=activeBookings().find(b=>b.assetIds?.includes(id)&&intersects(b.start,blockingEnd(b),w.start,w.end));if(clash)issues.push(`${assetById(id)?.code||'所選車輛'} 與日曆上已有的${statusNames[clash.status]}時段重疊（${clash.status==='in_use'&&new Date(clash.end)<new Date()?'尚未歸還':range(clash.start,clash.end)}），請調整時間。`);}}return issues;}
 function updateBooking(){
  if(!$('lc-booking-check'))return;
  const w=chosenWindow(),bike=assetById(selectedBike),box=$('lc-booking-check'),issues=bookingIssues(),extras=chosenAssets().slice(1).map(id=>assetById(id)?.code).filter(Boolean);
  const selected=$('lc-selected');selected.replaceChildren();if(bike){selected.append(make('span','已選'),make('strong',`${bike.code} · ${bike.name}`));selected.append(button('換一台',()=>scrollTo($('lc-calendar-panel')),'text-button'));}else selected.append(make('span','請先在日曆選一台車。'));
  $('lc-duration').textContent=w&&w.end>w.start?`共 ${span(w.end-w.start)}${w.end-w.start>maxSpan?'（超過五天上限）':''}`:'';
  for(const b of document.querySelectorAll('.lc-durations button'))b.setAttribute('aria-pressed',String(!!w&&+w.end-+w.start===Number(b.dataset.hours)*hourMs));
  box.replaceChildren();
  if(bike&&w&&w.end>w.start){const list=make('dl',undefined,'lc-summary');for(const [k,v] of [['車輛',`${bike.code} · ${bike.name}`],['配件',extras.join('、')||'無'],['借用',when(w.start)],['歸還',when(w.end)]]){list.append(make('dt',k),make('dd',v));}box.append(list);}
  const active=(me?.reservations||[]).find(r=>['reserved','in_use','inspection'].includes(r.status));
  if(issues.length){const ul=make('ul',undefined,'lc-issues');for(const text of issues)ul.append(make('li',text));box.append(ul);}
  else if(active)box.append(make('p','這支手機已有進行中的預約或借用；同一學號一次只能有一筆。','lc-hint'));
  $('lc-reserve-form').querySelector('button[type=submit]').disabled=!ready();
  updateDock();
 }
 const dock=$('lc-dock');let bookVisible=false;
 function updateDock(){const bike=assetById(selectedBike);const show=!!bike&&!bookVisible&&$('lc-flow').hidden&&innerWidth<900;dock.hidden=!show;document.body.classList.toggle('lc-dock-on',show);if(bike)$('lc-dock-text').textContent=`已選 ${bike.code} · ${shortDate(selectedDay)}`;}
 if('IntersectionObserver' in window)new IntersectionObserver(entries=>{bookVisible=entries.some(e=>e.isIntersecting);updateDock();},{threshold:.15}).observe($('lc-book'));
 addEventListener('resize',updateDock);$('lc-dock-go').addEventListener('click',()=>{scrollTo($('lc-book'));$('lc-start').focus({preventScroll:true});});
 async function loadCalendar(force=false){if(loading){calendarQueued=true;return;}loading=true;try{const start=weekStart(),end=new Date(+start+7*dayMs);const next=await lifecycle('calendar',{start:start.toISOString(),end:end.toISOString()});const key=JSON.stringify(next,(k,v)=>k==='updatedAt'?undefined:v);calendar=next;loaded=true;if(force||key!==calendarKey){calendarKey=key;renderCalendar();if(me)renderRecords();}say('lc-calendar-message',`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour12:false,timeZone:'Asia/Taipei'})}`);}catch(e){calendar={assets:[],bookings:[],settings:{}};calendarKey='';loaded=false;renderCalendar();say('lc-calendar-message',`日曆更新失敗：${e.message}`,true);}finally{loading=false;if(calendarQueued){calendarQueued=false;loadCalendar(force);}}}
 // Read every booking this device remembers; a key replaced by an officer is forgotten.
 async function loadMe(quiet=false){const keys=savedKeys(),generation=++memberGeneration,privacy=privacyGeneration;if(!keys.length){me=null;keyOf.clear();renderRecords();updateBooking();return true;}if(!quiet)say('lc-member-message','正在讀取這支手機的借車紀錄…');const results=await Promise.all(keys.map(k=>lifecycle('me',{},k).then(v=>({k,v}),e=>({k,e}))));if(generation!==memberGeneration||privacy!==privacyGeneration)return false;const lost=results.filter(x=>x.e?.status===401).map(x=>x.k);if(lost.length)saveKeys(savedKeys().filter(k=>!lost.includes(k)));const failed=results.filter(x=>x.e&&x.e.status!==401),found=new Map();keyOf.clear();let member=null,settings=null;for(const {k,v} of results.filter(x=>x.v)){settings=v.settings||settings;member=member||v.member;for(const r of v.reservations||[])if(!found.has(r.id)){found.set(r.id,r);keyOf.set(r.id,k);}}me={member,settings,reservations:[...found.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))};renderRecords();updateBooking();if(failed.length){say('lc-member-message',`有借車紀錄暫時無法讀取：${failed[0].e.message}`,true);return false;}if(!quiet)say('lc-member-message','已更新這支手機的借車紀錄。','ok');return true;}

 const pending=r=>r.status==='reserved'&&r.approval==='pending';
 function progress(r){const steps=[['送出預約',true],['幹部同意',r.approval!=='pending'],['取車使用',!!r.pickedUpAt],['還車',!!r.returnedAt||r.status==='inspection']];const current=pending(r)?1:r.status==='reserved'?2:r.status==='in_use'?2:-1;const ol=make('ol',undefined,'lc-progress');steps.forEach(([label,done],i)=>{const li=make('li',label);if(done)li.classList.add('done');if(i===current)li.setAttribute('aria-current','step');ol.append(li);});return ol;}
 function nextStep(r){const now=new Date(),start=new Date(r.start),end=new Date(r.end);
  if(pending(r))return ['已送出，等待幹部同意。請私訊社團 Instagram，告知學號、姓名、車號與借用時間；幹部同意後才能取車。','warn'];
  if(r.status==='reserved'){if(now<start)return [`可於 ${when(r.start)} 起開始取車檢查（還有 ${span(start-now)}）。到社辦後依序拍照、檢查並簽署。`,'info'];if(now<end)return ['現在可以取車：到社辦後依序拍照、檢查並簽署，完成後借用才正式開始。','go'];return ['預約時段已結束，無法再取車。請聯絡幹部或取消此預約。','warn'];}
  if(r.status==='in_use')return now<end?[`請於 ${when(r.end)} 前歸還（還有 ${span(end-now)}）。還車時同樣需要拍照與檢查。`,'info']:[`已逾期 ${span(now-end)}。請盡快歸還並主動聯絡幹部。`,'warn'];
  if(r.status==='inspection')return ['已送交幹部檢查；車輛暫停預約，處理結果會更新在這裡。','warn'];
  return null;}
 function recordCard(r){
  const box=make('article',undefined,'lc-record');box.dataset.status=r.status;if(r.id===justReserved)box.classList.add('is-new');const bike=bikeOf(r),extras=accessoriesOf(r);
  const title=make('div',undefined,'lc-asset-head');title.append(make('strong',`${bike?`${bike.code} · ${bike.name}`:'車輛'}`),pill(overdue(r)?'已逾期':pending(r)?'待幹部同意':statusNames[r.status]||r.status,overdue(r)||pending(r)?'warn':statusTone[r.status]));box.append(title);
  if(r.id===justReserved)box.append(make('p','剛送出預約','lc-new-badge'));
  if(r.borrower?.name)box.append(details('借用人',`${r.borrower.name}${r.borrower.studentId?`（${r.borrower.studentId}）`:''}`));
  if(['reserved','in_use','inspection','returned'].includes(r.status))box.append(progress(r));
  box.append(details('預約時段',range(r.start,r.end)));if(extras.length)box.append(details('配件',extras.map(a=>`${a.code} ${a.name}`).join('、')));if(r.pickedUpAt)box.append(details('實際取車',fmt(r.pickedUpAt)));if(r.returnedAt)box.append(details('實際歸還',fmt(r.returnedAt)));
  const next=nextStep(r);if(next)box.append(make('p',next[0],`lc-next ${next[1]}`));
  const actions=make('div',undefined,'lc-actions');
  if(pending(r)){const ig=make('a','私訊社團 Instagram ↗','button');ig.href='https://www.instagram.com/ntut_cyclingclub/';ig.target='_blank';ig.rel='noopener noreferrer';actions.append(ig);}
  if(r.status==='reserved'){if(!pending(r))actions.append(button('前往取車檢查',()=>showFlow(r,'pickup'),''));actions.append(button('取消預約',()=>{cancelling=cancelling===r.id?null:r.id;cancelReason='';renderRecords();},'text-button'));}
  if(r.status==='in_use')actions.append(button('開始還車',()=>showFlow(r,'return'),''));
  if(r.photos?.length)actions.append(button('比較借還照片',()=>comparePhotos(r)));
  box.append(actions);
  if(cancelling===r.id)box.append(cancelForm(r));
  return box;
 }
 function cancelForm(r){const form=make('form',undefined,'lc-inline-form');const label=make('label','取消原因');const reason=make('textarea');reason.required=true;reason.rows=2;reason.maxLength=500;reason.placeholder='例如：行程改期';reason.value=cancelReason;reason.addEventListener('input',()=>{cancelReason=reason.value;});label.append(reason);const row=make('div',undefined,'lc-actions');const confirm=make('button','確認取消預約','danger');confirm.type='submit';row.append(confirm,button('返回',()=>{cancelling=null;renderRecords();}));form.append(label,row);form.addEventListener('submit',e=>{e.preventDefault();if(!reason.value.trim()){reason.focus();say('lc-member-message','請填寫取消原因。',true);return;}cancelOwn(r,reason.value.trim(),confirm);});if(!cancelReason)setTimeout(()=>reason.focus(),0);return form;}
 function renderRecords(){const root=$('lc-records');root.replaceChildren();const records=me?.reservations||[];
  if(!records.length){root.append(make('p','這支手機還沒有借車紀錄。在下方選車並送出預約後，會自動顯示在這裡。','lc-empty'));return;}
  const active=records.filter(r=>['reserved','in_use','inspection'].includes(r.status)),past=records.filter(r=>!active.includes(r));const shown=active.length?active:past.slice(0,1),older=past.filter(r=>!shown.includes(r));
  if(!active.length)root.append(make('h3','最近一筆紀錄','lc-subhead'));for(const r of shown)root.append(recordCard(r));
  if(older.length){const more=make('details',undefined,'lc-history');more.append(make('summary',`${active.length?'過去':'更早'}的紀錄（${older.length}）`));for(const r of older)more.append(recordCard(r));root.append(more);}
 }
 async function cancelOwn(r,reason,b){const generation=privacyGeneration,restore=busy(b,'取消中…');try{await mutate('cancel',{reservationId:r.id,reason},`cancel:${r.id}`,tokenFor(r));cancelling=null;await Promise.all([loadMe(true),loadCalendar(true)]);if(generation===privacyGeneration)say('lc-member-message','預約已取消。','ok');}catch(e){if(e.code!=='TOKEN_CHANGED'&&generation===privacyGeneration)say('lc-member-message',`無法取消：${e.message}`,true);}finally{if(b.isConnected)restore();}}

 // Pickup/return flow: refresh first so the window and photo state come from the server.
 async function showFlow(r,phase){const generation=privacyGeneration;resetFlow();say('lc-member-message','正在確認最新狀態…');if(!await loadMe(true)||generation!==privacyGeneration)return;const fresh=me.reservations.find(x=>x.id===r.id);if(!fresh)return;const now=new Date();
  if(phase==='pickup'&&fresh.status!=='reserved'||phase==='return'&&fresh.status!=='in_use'){say('lc-member-message',`這筆紀錄目前是「${statusNames[fresh.status]||fresh.status}」，無法進行此步驟。`,true);return;}
  if(phase==='pickup'&&pending(fresh)){say('lc-member-message','幹部尚未同意這筆預約。請先私訊社團 Instagram，同意後才能取車。',true);return;}
  if(phase==='pickup'&&now<new Date(fresh.start)){say('lc-member-message',`取車時間尚未開始：可於 ${when(fresh.start)} 起操作。`,true);return;}
  if(phase==='pickup'&&now>=new Date(fresh.end)){say('lc-member-message','預約時段已結束，無法取車。請聯絡幹部。',true);return;}
  say('lc-member-message','');
  if(selectedReservation?.record.id!==fresh.id||selectedReservation?.phase!==phase){for(const url of previews.values())URL.revokeObjectURL(url);previews.clear();retryFiles.clear();}
  selectedReservation={record:fresh,phase};const flow=$('lc-flow'),form=$('lc-flow-form');flow.hidden=false;form.reset();flow.dataset.phase=phase;
  const bike=bikeOf(fresh);$('lc-flow-title').textContent=phase==='pickup'?'取車檢查與電子簽署':'歸還車況檢查';$('lc-flow-subtitle').textContent=`${bike?`${bike.code} · ${bike.name}`:'車輛'}｜${range(fresh.start,fresh.end)}`;
  const settings=me?.settings||calendar?.settings||{};$('lc-location').textContent=settings.location||'幹部尚未設定社辦位置';$('lc-instructions').textContent=settings.instructions||'請聯絡幹部確認取車指引';$('lc-terms').textContent=settings.terms||'幹部尚未設定借車規範';$('lc-policy-version').textContent=settings.termsVersion?settings.termsVersion.slice(0,12):'—';$('lc-policy-version').title=settings.termsVersion||'';$('lc-guide').open=phase==='pickup';$('lc-guide').querySelector('summary').textContent=phase==='pickup'?'社辦位置與取車指引':'社辦位置與指引';
  $('lc-signature-block').hidden=phase!=='pickup';$('lc-abnormal-line').hidden=phase!=='return';$('lc-check-hint').textContent=phase==='pickup'?'每一項都要確認為「正常」才能取車；若有異常，請停止取車並聯絡幹部。':'逐項選擇實際狀況。任一項異常會送交幹部檢查，車輛暫停預約。';$('lc-name-hint').textContent=signerOf(fresh)?`須與預約時填寫的姓名相同：${signerOf(fresh)}`:'';
  renderChecks();renderSlots();clearSignature();$('lc-flow-message').textContent='';updateFlow();updateDock();scrollTo(flow);}
 // Drop the previous step's inputs at once so a late file choice cannot reach a stale form.
 function resetFlow(){selectedReservation=null;$('lc-flow').hidden=true;$('lc-photo-inputs').replaceChildren();$('lc-checks').replaceChildren();$('lc-missing').replaceChildren();}
 function closeFlow(){resetFlow();updateDock();scrollTo($('lc-records'));}
 function renderChecks(){const box=$('lc-checks');box.replaceChildren();for(const [key,label] of Object.entries(checks)){const row=make('div',undefined,'lc-check');row.setAttribute('role','radiogroup');const id=`lc-check-${key}`;const name=make('span',label);name.id=id;row.setAttribute('aria-labelledby',id);row.append(name);for(const [value,text] of [['ok','正常'],['bad','異常']]){const option=make('label',undefined,`lc-choice ${value}`);const input=make('input');input.type='radio';input.name=key;input.value=value;input.addEventListener('change',updateFlow);option.append(input,make('span',text));row.append(option);}box.append(row);}}
 function slotPhotos(slot){const flow=selectedReservation;return (flow?.record.photos||[]).filter(p=>p.phase===flow.phase&&p.slot===slot);}
 function renderSlots(){const board=$('lc-photo-inputs');board.replaceChildren();for(const [slot,label] of Object.entries(slots)){const card=make('div',undefined,'lc-slot');card.dataset.slotCard=slot;const preview=make('div',undefined,'lc-slot-preview');const body=make('div',undefined,'lc-slot-body');body.append(make('strong',label),make('small',slotHints[slot]),make('span','','lc-slot-status'));const pick=make('label',undefined,'button secondary lc-slot-pick');const input=make('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.capture='environment';input.dataset.slot=slot;input.className='lc-file';input.addEventListener('change',()=>{const file=input.files?.[0];input.value='';if(file)uploadPhoto(slot,file);});pick.append(make('span','拍攝'),input);const retry=button('重試上傳',()=>{const file=retryFiles.get(slot);if(file)uploadPhoto(slot,file);},'secondary lc-slot-retry');retry.hidden=true;card.append(preview,body,pick,retry);board.append(card);paintSlot(slot);}}
 function paintSlot(slot,error=''){const card=$('lc-photo-inputs').querySelector(`[data-slot-card="${slot}"]`);if(!card)return;const uploaded=slotPhotos(slot),status=card.querySelector('.lc-slot-status'),preview=card.querySelector('.lc-slot-preview'),state=uploading.has(uploadKey(slot))?'uploading':error?'error':uploaded.length?'done':'empty';card.dataset.state=state;preview.replaceChildren();const url=previews.get(slot);if(url){const img=make('img');img.src=url;img.alt=`${slots[slot]}預覽`;preview.append(img);}else preview.append(make('span',uploaded.length?'✓':'＋','lc-slot-icon'));status.textContent=state==='uploading'?'上傳中…請勿關閉頁面':state==='error'?`上傳失敗：${error}`:uploaded.length?`已上傳 ${uploaded.length} 張 · 最近 ${clock(uploaded.at(-1).uploadedAt)}`:'尚未拍攝';status.classList.toggle('error',state==='error');card.querySelector('.lc-slot-pick span').textContent=uploaded.length?'重拍':'拍攝';card.querySelector('.lc-slot-pick input').disabled=state==='uploading';card.querySelector('.lc-slot-retry').hidden=state!=='error'||!retryFiles.has(slot);}
 async function uploadPhoto(slot,file){const flow=selectedReservation,token=flow&&tokenFor(flow.record),generation=privacyGeneration;if(!flow||uploading.has(uploadKey(slot)))return;const key=uploadKey(slot);if(file.size>8*1024*1024){paintSlot(slot,'單張不可超過 8 MiB，請調低相機解析度後重拍。');return;}if(!['image/jpeg','image/png','image/webp'].includes(file.type)){paintSlot(slot,'僅接受 JPEG、PNG、WebP 照片。');return;}
  const old=previews.get(slot);if(old)URL.revokeObjectURL(old);previews.set(slot,URL.createObjectURL(file));retryFiles.set(slot,file);uploading.add(key);paintSlot(slot);updateFlow();
  try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});if(generation!==privacyGeneration||selectedReservation!==flow)return;const bike=bikeOf(flow.record);await mutate('photo',{reservationId:flow.record.id,assetId:bike?.id,phase:flow.phase,slot,mime:file.type,data},`photo:${flow.record.id}:${flow.phase}:${slot}`,token);retryFiles.delete(slot);await loadMe(true);const fresh=me?.reservations.find(x=>x.id===flow.record.id);if(generation!==privacyGeneration||!fresh||selectedReservation!==flow)return;selectedReservation.record=fresh;uploading.delete(key);for(const s of Object.keys(slots))paintSlot(s);say('lc-flow-message',`${slots[slot]}已上傳；原始照片會保留在借車紀錄中。`,'ok');}
  catch(e){if(e.code==='TOKEN_CHANGED'||generation!==privacyGeneration)return;uploading.delete(key);if(selectedReservation===flow)paintSlot(slot,e.message);}finally{if(generation===privacyGeneration){uploading.delete(key);if(selectedReservation===flow)updateFlow();}}}
 function flowState(){const flow=selectedReservation,form=$('lc-flow-form');if(!flow)return null;const names=Object.keys(checks),values=Object.fromEntries(names.map(k=>[k,form.elements[k]?.value||'']));const photos=Object.keys(slots).filter(slot=>slotPhotos(slot).length),answered=names.filter(k=>values[k]),bad=names.filter(k=>values[k]==='bad'),pickup=flow.phase==='pickup',abnormal=!pickup&&(bad.length>0||form.elements.abnormal.checked),missing=[];
  const lacking=Object.keys(slots).filter(slot=>!photos.includes(slot));if(Object.keys(slots).some(slot=>uploading.has(uploadKey(slot))))missing.push('照片上傳中，請稍候。');if(lacking.length)missing.push(`尚缺照片：${lacking.map(s=>slots[s].replace(/（.*/,'')).join('、')}`);
  if(answered.length<names.length)missing.push(`尚未檢查：${names.filter(k=>!values[k]).map(k=>checks[k]).join('、')}`);
  if(pickup&&bad.length)missing.push(`${bad.map(k=>checks[k]).join('、')}異常：請停止取車並聯絡幹部。`);
  if(abnormal&&!form.elements.notes.value.trim())missing.push('有異常時請在車況備註說明狀況。');
  let signed=true;if(pickup){const name=form.elements.signatureName.value.trim();if(!form.elements.accepted.checked){missing.push('請勾選同意借車規範。');signed=false;}if(!name){missing.push('請填寫簽署姓名。');signed=false;}else if(name!==signerOf(selectedReservation.record)){missing.push('簽署姓名須與預約時填寫的姓名相同。');signed=false;}if(strokes<8){missing.push('請在簽名框手寫簽名。');signed=false;}}
  return {values,photos,answered,bad,abnormal,missing,signed,pickup};}
 function updateFlow(){const s=flowState();if(!s)return;
  $('lc-photo-state').textContent=`${s.photos.length}/4`;$('lc-check-state').textContent=`${s.answered.length}/5${s.bad.length?` · ${s.bad.length} 項異常`:''}`;$('lc-sign-state').textContent=s.signed?'完成':'未完成';
  for(const [id,done] of [['lc-photo-state',s.photos.length===4],['lc-check-state',s.answered.length===5&&!(s.pickup&&s.bad.length)],['lc-sign-state',s.signed]])$(id).classList.toggle('done',done);
  const progressList=$('lc-flow-progress');progressList.replaceChildren();for(const [label,done] of [['拍照',s.photos.length===4],['檢查',s.answered.length===5],...(s.pickup?[['簽署',s.signed]]:[]),['送出',false]]){const li=make('li',label);if(done)li.classList.add('done');progressList.append(li);}
  const list=$('lc-missing');list.replaceChildren();for(const text of s.missing)list.append(make('li',text));
  $('lc-flow-submit').textContent=s.pickup?'確認取車，開始借用':s.abnormal?'送出異常還車，交由幹部檢查':'確認歸還';$('lc-flow-submit').classList.toggle('danger',!s.pickup&&s.abnormal);
  document.querySelector('.lc-sign-pad')?.classList.toggle('signed',strokes>=8);
 }
 $('lc-flow-form').addEventListener('input',updateFlow);$('lc-flow-form').addEventListener('change',updateFlow);$('lc-flow-close').addEventListener('click',closeFlow);

 async function comparePhotos(r){if(readingPhotos)return;readingPhotos=true;const generation=memberGeneration,token=tokenFor(r);const box=$('lc-comparison');box.replaceChildren();box.hidden=false;const head=make('div',undefined,'lc-flow-head');head.append(make('h3',`借車前後照片${bikeOf(r)?` · ${bikeOf(r).code}`:''}`),button('關閉',()=>{box.hidden=true;box.replaceChildren();},'text-button'));box.append(head,make('p','點照片可放大檢視。顯示每個項目最近一次上傳的原始照片。','fine'));
  const jobs=[];for(const [slot,label] of Object.entries(slots)){const row=make('section',undefined,'lc-compare-row');row.append(make('h4',label));const pair=make('div',undefined,'lc-photo-pair');for(const phase of ['pickup','return']){const photo=(r.photos||[]).filter(p=>p.phase===phase&&p.slot===slot).at(-1);const cell=make('figure');cell.append(make('figcaption',phase==='pickup'?'取車前':'歸還時'));if(photo){const slotBox=make('div','讀取中…','lc-photo-loading');cell.append(slotBox,make('small',fmt(photo.uploadedAt)));jobs.push({photo,slotBox,alt:`${label}，${phase==='pickup'?'取車前':'歸還時'}`});}else cell.append(make('p','尚無照片','lc-photo-none'));pair.append(cell);}row.append(pair);box.append(row);}
  scrollTo(box);
  try{for(const job of jobs){const response=await lifecycle('photo_read',{id:job.photo.id},token);if(generation!==memberGeneration)return;const img=make('img');img.alt=job.alt;img.src=`data:${response.photo.mime};base64,${response.photo.data}`;img.tabIndex=0;img.addEventListener('click',()=>openLightbox(img.src,job.alt));img.addEventListener('keydown',e=>{if(e.key==='Enter')openLightbox(img.src,job.alt);});job.slotBox.replaceWith(img);}}catch(e){if(generation===memberGeneration)box.append(make('p',`照片讀取失敗：${e.message}`,'error'));}finally{readingPhotos=false;}}
 const lightbox=make('dialog',undefined,'lc-lightbox');lightbox.setAttribute('aria-label','照片放大檢視');document.body.append(lightbox);lightbox.addEventListener('click',e=>{if(e.target===lightbox)closeLightbox();});
 function openLightbox(src,alt){lightbox.replaceChildren();const img=make('img');img.src=src;img.alt=alt;const bar=make('div',undefined,'lc-lightbox-bar');bar.append(make('span',alt),button('關閉',closeLightbox,''));lightbox.append(bar,img);if(!lightbox.open)lightbox.showModal();}
 function closeLightbox(){if(lightbox.open)lightbox.close();lightbox.replaceChildren();}

 const canvas=$('lc-signature'),ctx=canvas.getContext('2d');let drawing=false,strokes=0;
 function clearSignature(){const width=Math.min(1000,Math.round((canvas.clientWidth||600)*Math.min(devicePixelRatio||1,2)));if(width>0&&canvas.width!==width){canvas.width=width;canvas.height=Math.round(width*.4);}ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#172c68';ctx.lineWidth=Math.max(3,canvas.width/200);ctx.lineCap='round';ctx.lineJoin='round';strokes=0;document.querySelector('.lc-sign-pad')?.classList.remove('signed');}
 const point=e=>{const b=canvas.getBoundingClientRect();return [(e.clientX-b.left)*canvas.width/b.width,(e.clientY-b.top)*canvas.height/b.height];};
 canvas.addEventListener('pointerdown',e=>{drawing=true;canvas.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(...point(e));});canvas.addEventListener('pointermove',e=>{if(!drawing)return;ctx.lineTo(...point(e));ctx.stroke();strokes++;});canvas.addEventListener('pointerup',()=>{drawing=false;updateFlow();});canvas.addEventListener('pointercancel',()=>drawing=false);$('lc-signature-clear').addEventListener('click',()=>{clearSignature();updateFlow();});clearSignature();
 $('lc-flow-form').addEventListener('submit',async e=>{e.preventDefault();const flow=selectedReservation;if(!flow)return;const form=e.currentTarget;const fresh=me?.reservations.find(r=>r.id===flow.record.id);if(!fresh)return;const s=flowState();if(s.missing.length){say('lc-flow-message',s.missing[0],true);$('lc-missing').scrollIntoView({block:'nearest'});return;}
  const payload={reservationId:fresh.id,checks:Object.fromEntries(Object.entries(s.values).map(([k,v])=>[k,v==='ok'])),notes:form.elements.notes.value.trim()};
  if(flow.phase==='pickup'){payload.signature={name:form.elements.signatureName.value.trim(),accepted:true,termsVersion:me.settings?.termsVersion||calendar?.settings?.termsVersion,image:canvas.toDataURL('image/png')};if(payload.signature.image.length>350000){say('lc-flow-message','簽名資料過大，請清除後重新簽署。',true);return;}}else payload.abnormal=s.abnormal;
  const submit=$('lc-flow-submit'),generation=privacyGeneration,restore=busy(submit,'送出中…');say('lc-flow-message','正在送出，請等待系統確認…');try{await mutate(flow.phase,payload,`${flow.phase}:${fresh.id}`,tokenFor(fresh));resetFlow();await Promise.all([loadMe(true),loadCalendar(true)]);if(generation===privacyGeneration){say('lc-member-message',flow.phase==='pickup'?'已記錄實際取車時間，借用正式開始。':payload.abnormal?'已送交幹部檢查，車輛暫停預約。':'歸還已結案，車輛恢復可借。','ok');scrollTo($('lc-member'));}}catch(err){if(err.code!=='TOKEN_CHANGED'&&generation===privacyGeneration)say('lc-flow-message',`無法完成：${err.message}`,true);}finally{restore();updateFlow();updateDock();}});

 // Accept a pasted officer message: keep only the 64-character credential.
 function normalizeToken(){const input=$('lc-token'),raw=input.value,match=raw.match(/[a-f0-9]{64}/i),value=match?match[0].toLowerCase():raw.replace(/\s+/g,'');if(value!==raw)input.value=value;const length=getToken().length;$('lc-token-count').textContent=hasToken()?'格式正確':`${length}/64`;$('lc-token-count').classList.toggle('done',hasToken());input.setAttribute('aria-invalid',String(length>0&&!hasToken()&&length>=64));}
 async function addCode(){normalizeToken();if(!hasToken()){say('lc-member-message','請貼上幹部傳給你的 64 字元取還車碼。',true);return;}const code=getToken(),submit=$('lc-token-form').querySelector('button[type=submit]'),restore=busy(submit,'確認中…');try{await lifecycle('me',{},code);saveKeys([...savedKeys(),code]);$('lc-token').value='';normalizeToken();await loadMe(true);say('lc-member-message','已把這筆借車加入這支手機。','ok');$('lc-transfer').open=false;}catch(e){say('lc-member-message',`取還車碼無法使用：${e.message}`,true);}finally{restore();}}
 $('lc-token-form').addEventListener('submit',e=>{e.preventDefault();addCode();});
 $('lc-token').addEventListener('input',()=>{normalizeToken();if(hasToken())addCode();});
 $('lc-token-clear').addEventListener('click',()=>{saveKeys([]);$('lc-token').value='';clearPrivate();normalizeToken();renderRecords();say('lc-member-message','已從這支手機移除所有借車紀錄；伺服器上的紀錄不受影響。');});
 if(navigator.clipboard?.readText){$('lc-token-paste').hidden=false;$('lc-token-paste').addEventListener('click',async()=>{try{$('lc-token').value=await navigator.clipboard.readText();addCode();}catch{say('lc-member-message','無法讀取剪貼簿，請長按輸入框貼上。',true);}});}
 // Remember the borrower's own student ID and name on this device for the next booking.
 try{const saved=JSON.parse(localStorage.getItem('lc-borrower')||'{}');if(saved.studentId)$('lc-student').value=saved.studentId;if(saved.name)$('lc-name').value=saved.name;}catch{}
 for(const id of ['lc-student','lc-name','lc-ig-ack'])$(id).addEventListener('input',updateBooking);
 $('lc-reserve-form').addEventListener('submit',async e=>{e.preventDefault();const issues=bookingIssues();if(issues.length){say('lc-reserve-message',issues[0],true);return;}const w=chosenWindow(),assetIds=chosenAssets(),studentId=$('lc-student').value.trim().toUpperCase(),name=$('lc-name').value.trim();const draft=JSON.stringify({assetIds,start:w.start.toISOString(),end:w.end.toISOString(),studentId,name});if(applyDraft?.draft!==draft)applyDraft={draft,key:newKey()};const key=applyDraft.key;saveKeys([...savedKeys(),key]);try{localStorage.setItem('lc-borrower',JSON.stringify({studentId,name}));}catch{}
  const submit=e.currentTarget.querySelector('button[type=submit]'),generation=privacyGeneration,restore=busy(submit,'送出中…');say('lc-reserve-message','正在向系統確認時段…');try{const result=await mutate('apply',{studentId,name,assetIds,start:w.start.toISOString(),end:w.end.toISOString(),key},'apply');applyDraft=null;justReserved=result?.reservation?.id||null;await Promise.all([loadCalendar(true),loadMe(true)]);if(generation===privacyGeneration){say('lc-reserve-message','預約已送出，等待幹部同意。請現在私訊社團 Instagram 告知借車。','ok');say('lc-member-message','預約已送出。請私訊社團 Instagram，幹部同意後就能在取車時間自行取車。','ok');selectedBike=null;$('lc-ig-ack').checked=false;renderCalendar();scrollTo($('lc-member'));}}catch(err){if(err.status){saveKeys(savedKeys().filter(k=>k!==key));applyDraft=null;}if(err.code!=='TOKEN_CHANGED'&&generation===privacyGeneration)say('lc-reserve-message',`預約失敗：${err.message}`,true);await loadCalendar(true);}finally{restore();updateBooking();}});
 $('lc-start').addEventListener('input',()=>{timeEdited=true;});for(const id of ['lc-start','lc-end'])$(id).addEventListener('input',()=>{limitTimes();renderAccessories();updateBooking();});
 for(const b of document.querySelectorAll('.lc-durations button'))b.addEventListener('click',()=>{const start=taipeiDateTime($('lc-start').value);if(!Number.isFinite(+start))return;$('lc-end').value=localDateTime(new Date(+start+Number(b.dataset.hours)*hourMs));limitTimes();renderAccessories();updateBooking();});
 $('lc-prev-week').addEventListener('click',()=>{weekOffset=Math.max(0,weekOffset-1);selectedDay=weekStart();setDefaultTime();loadCalendar(true);});$('lc-next-week').addEventListener('click',()=>{weekOffset=Math.min(5,weekOffset+1);selectedDay=weekStart();setDefaultTime();loadCalendar(true);});$('lc-refresh').addEventListener('click',()=>loadCalendar(true));
 normalizeToken();setDefaultTime();if(+selectedDay>=+weekStart()+7*dayMs)weekOffset=1;renderCalendar();loadCalendar(true);loadMe(true);document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadCalendar();});setInterval(()=>{if(!document.hidden)loadCalendar();},30000);
}

if($('lc-admin')){
 let staff=null,staffKey='',loading=false,staffQueued=false,adminGeneration=0,policyDirty=false,tab='todo',bookingFilter='active';
 const ui={open:new Set(),forms:new Map(),compare:new Set(),issued:new Map()},photoCache=new Map(),pendingStaff=new Map();
 const adminAction=(name,payload={})=>lifecycle(name,payload,null,true);
 const guard=()=>!!currentAdmin()&&!$('workspace').hidden&&$('mfa-panel').hidden;
 const lists=['lc-todo','lc-bookings','lc-fleet','lc-members'];
 function resetAsset(){const f=$('lc-asset-form');f.reset();f.elements.id.value='';$('lc-asset-heading').textContent='新增車輛／配件';}
 function resetMember(){const f=$('lc-member-form');f.reset();f.elements.id.value='';$('lc-member-heading').textContent='編輯借用人';$('lc-member-card').hidden=true;}
 function clearToken(){const box=$('lc-new-token');box.replaceChildren();box.hidden=true;}
 function clearStaff(){adminGeneration++;staff=null;staffKey='';$('lc-admin-updated').textContent='';policyDirty=false;ui.open.clear();ui.forms.clear();ui.compare.clear();ui.issued.clear();photoCache.clear();pendingStaff.clear();for(const id of lists)$(id).replaceChildren();$('lc-admin').hidden=true;clearToken();resetAsset();resetMember();$('lc-policy-form').reset();$('lc-current-version').textContent='尚未發布';for(const c of document.querySelectorAll('.lc-count'))c.textContent='';}
 async function loadStaff(force=false){if(!guard()){clearStaff();return;}if(loading){staffQueued=true;return;}loading=true;const generation=adminGeneration;try{const next=await adminAction('list');if(generation!==adminGeneration||!guard())return;const key=JSON.stringify(next);staff=next;$('lc-admin').hidden=false;if(force||key!==staffKey){staffKey=key;renderStaff();}$('lc-admin-updated').textContent=`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour12:false,timeZone:'Asia/Taipei'})}`;}catch(e){if(generation!==adminGeneration)return;clearStaff();say('lc-admin-message',`借還車工作區無法更新：${e.message}`,true);}finally{loading=false;if(staffQueued){staffQueued=false;loadStaff(force);}}}
 // Reuse the request id while an outcome is unknown, so a retry cannot double-apply.
 async function write(action,payload,success,key=null){if(!guard()){clearStaff();return false;}let body=payload;if(key){const fingerprint=JSON.stringify(payload);let pending=pendingStaff.get(key);if(!pending||pending.fingerprint!==fingerprint){pending={fingerprint,requestId:requestId()};pendingStaff.set(key,pending);}body={...payload,requestId:pending.requestId};}try{await adminAction(action,body);if(key)pendingStaff.delete(key);say('lc-admin-message',success,'ok');await loadStaff(true);return true;}catch(e){if(key&&e.status)pendingStaff.delete(key);say('lc-admin-message',`${actionNames[action]||action}失敗：${e.message}`,true);return false;}}
 const actionNames={approve:'同意預約',access:'重新產生取還車碼',asset:'儲存車輛',cancel:'取消預約',resolve:'異常審核',settings:'發布規範',member:'儲存社員資格'};

 function switchTab(next,focus=false){tab=next;for(const b of document.querySelectorAll('.lc-tabs [role=tab]')){const on=b.dataset.tab===tab;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on&&focus)b.focus();}for(const p of document.querySelectorAll('.lc-panel'))p.hidden=p.id!==`lc-panel-${tab}`;document.querySelector('.lc-tabs [aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});}
 for(const b of document.querySelectorAll('.lc-tabs [role=tab]')){b.addEventListener('click',()=>switchTab(b.dataset.tab));b.addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('.lc-tabs [role=tab]')],i=tabs.indexOf(b);const j=e.key==='ArrowRight'?i+1:e.key==='ArrowLeft'?i-1:e.key==='Home'?0:e.key==='End'?tabs.length-1:null;if(j===null)return;e.preventDefault();switchTab(tabs[(j+tabs.length)%tabs.length].dataset.tab,true);});}
 const memberOf=r=>(staff?.members||[]).find(m=>m.id===r.memberId);
 const borrowerOf=r=>{const member=memberOf(r),b=r.borrower&&typeof r.borrower==='object'?r.borrower:{};return {name:b.name||member?.name||'社員',studentId:b.studentId||member?.studentId||'—',contact:b.contact||member?.contact||'—'};};
 const codes=r=>r.assetIds.map(id=>(staff?.assets||[]).find(a=>a.id===id)||{code:id}).sort((a,b)=>(a.kind==='bike'?0:1)-(b.kind==='bike'?0:1)).map(a=>a.code).join('、');
 function keep(el,key){el.dataset.key=key;if(ui.open.has(key))el.open=true;el.addEventListener('toggle',()=>{if(el.open)ui.open.add(key);else ui.open.delete(key);});return el;}

 function renderStaff(){
  const focus=document.activeElement?.closest?.('[data-draft]')?.dataset.draft,caret=document.activeElement?.selectionStart;
  const assets=staff.assets||[],members=staff.members||[],reservations=staff.reservations||[],notifications=staff.notifications||[],now=new Date();
  const awaiting=reservations.filter(r=>r.status==='reserved'&&r.approval==='pending').sort((a,b)=>new Date(a.start)-new Date(b.start));
  const waitingReview=reservations.filter(r=>r.status==='inspection'),late=reservations.filter(overdue),upcoming=reservations.filter(r=>r.status==='reserved'&&r.approval!=='pending').sort((a,b)=>new Date(a.start)-new Date(b.start)),inUse=reservations.filter(r=>r.status==='in_use'&&!overdue(r)).sort((a,b)=>new Date(a.end)-new Date(b.end));
  const setup=[['取車地點、指引與規範已發布',!!staff.settings?.termsVersion,'policy','前往設定規範'],['至少一台車輛已盤點為「可借用」（須先設定下方原登記的社車總數）',assets.some(a=>a.kind==='bike'&&a.state==='available'),'fleet','前往車輛配件']];
  const counts={todo:awaiting.length+waitingReview.length+late.length,bookings:reservations.filter(r=>['reserved','in_use','inspection'].includes(r.status)).length,fleet:assets.length,members:members.length,policy:staff.settings?.termsVersion?'':'!'};
  for(const c of document.querySelectorAll('.lc-count')){const v=counts[c.dataset.count];c.textContent=v?String(v):'';c.classList.toggle('alert',c.dataset.count==='todo'&&v>0||c.dataset.count==='policy'&&v==='!');}
  // To-do: what needs an officer now.
  const todo=$('lc-todo');todo.replaceChildren();
  if(setup.some(([,done])=>!done)){const box=make('section',undefined,'lc-setup');box.append(make('h3','預約開放前檢查'),make('p','兩項都完成後，社員才能線上預約。請依實車盤點的結果設定，不要填入推測資料。','fine'));const ol=make('ol');for(const [label,done,target,action] of setup){const li=make('li',undefined,done?'done':'');li.append(make('span',done?'✓':'○','lc-setup-mark'),make('span',label));if(!done)li.append(button(action,()=>switchTab(target),'text-button'));ol.append(li);}box.append(ol);todo.append(box);}
  const stats=make('div',undefined,'lc-stats');for(const [label,count,tone] of [['待同意',awaiting.length,'warn'],['可借用車輛',assets.filter(a=>a.kind==='bike'&&a.state==='available').length],['已同意待取車',upcoming.length],['使用中',inUse.length+late.length],['待處理異常',notifications.filter(n=>!n.resolvedAt).length,'warn'],['逾期未還',late.length,'warn']]){const item=make('div');if(tone&&count)item.className=tone;item.append(make('strong',String(count)),make('span',label));stats.append(item);}todo.append(stats);
  const group=(title,items,render,empty)=>{const s=make('section',undefined,'lc-admin-section');const h=make('h3',title);if(items.length)h.append(make('span',String(items.length),'lc-count alert'));s.append(h);if(!items.length&&empty)s.append(make('p',empty,'lc-empty'));for(const r of items)s.append(render(r));todo.append(s);};
  group('待同意預約',awaiting,r=>reservationCard(r,'todo',false),'目前沒有等待同意的預約。請對照社團 Instagram 私訊與社員名單後同意。');
  group('異常待審',waitingReview,r=>reservationCard(r,'todo',true),'目前沒有待審的異常還車。');
  group('逾期未還',late,r=>reservationCard(r,'todo',false),null);
  group('已同意、即將取車',upcoming.slice(0,8),r=>reservationCard(r,'todo',false),null);
  group('使用中',inUse,r=>reservationCard(r,'todo',false),null);
  if(!awaiting.length&&!waitingReview.length&&!late.length&&!upcoming.length&&!inUse.length)todo.append(make('p','目前沒有預約或借用中的車輛。','lc-empty'));
  if(staff.storage){const {usedBytes=0,reservedBytes=0,budgetBytes=0}=staff.storage,storage=make('section',undefined,'lc-storage'),pct=budgetBytes?Math.min(100,Math.round((usedBytes+reservedBytes)/budgetBytes*100)):0;storage.append(make('strong','原始照片儲存量'));const meter=make('div',undefined,'lc-meter');meter.setAttribute('role','img');meter.setAttribute('aria-label',`已使用與預留 ${pct}%`);const fill=make('i');fill.style.width=`${pct}%`;meter.append(fill);storage.append(meter,details('已存原圖',`${(usedBytes/1048576).toFixed(1)} MiB`),details('已預留必要歸還照片',`${(reservedBytes/1048576).toFixed(1)} MiB`),details('應用照片預算',`${(budgetBytes/1048576).toFixed(1)} MiB`));if(budgetBytes&&usedBytes+reservedBytes>=budgetBytes)storage.append(make('p','照片容量已滿。請先由管理者規劃容量；已留存原圖與歷史紀錄不可直接刪除。','error'));todo.append(storage);}
  renderBookings();
  // Fleet.
  const fleet=$('lc-fleet');fleet.replaceChildren();if(!assets.length)fleet.append(make('p','尚未建立任何車輛或配件。','lc-empty'));
  for(const kind of ['bike','accessory']){const items=assets.filter(a=>a.kind===kind);if(!items.length)continue;fleet.append(make('h4',kind==='bike'?'車輛':'配件','lc-group-title'));for(const a of items){const row=make('article',undefined,'lc-list-row');const active=reservations.filter(r=>r.assetIds.includes(a.id)&&['reserved','in_use','inspection'].includes(r.status));const info=make('div');info.append(make('strong',`${a.code} · ${a.name}`),make('small',active.length?active.map(r=>`${statusNames[r.status]} ${range(r.start,r.end)}`).join('；'):'目前無預約'));row.append(info,pill(stateNames[a.state]||a.state,a.state==='available'?'free':'off'),button('編輯',()=>fillAsset(a),'text-button'));fleet.append(row);}}
  renderMembers();
  const policy=staff.settings||{};if(!policyDirty){$('lc-policy-form').elements.location.value=policy.location||'';$('lc-policy-form').elements.instructions.value=policy.instructions||'';$('lc-policy-form').elements.terms.value=policy.terms||'';}$('lc-current-version').textContent=policy.termsVersion?policy.termsVersion.slice(0,12):'尚未發布';$('lc-current-version').title=policy.termsVersion||'';
  if(focus){const el=document.querySelector(`.lc-panel:not([hidden]) [data-draft="${focus}"]`);if(el){el.focus({preventScroll:true});if(typeof caret==='number'&&el.setSelectionRange)try{el.setSelectionRange(caret,caret);}catch{}}}
 }
 function renderBookings(){if(!staff)return;const root=$('lc-bookings'),query=$('lc-booking-search').value.trim().toLowerCase();root.replaceChildren();const matches=(staff.reservations||[]).filter(r=>(bookingFilter==='all'||bookingFilter==='active'&&['reserved','in_use','inspection'].includes(r.status)||r.status===bookingFilter)&&(!query||[borrowerOf(r).name,borrowerOf(r).studentId,codes(r)].join(' ').toLowerCase().includes(query)));root.append(make('p',`${matches.length} 筆`,'fine lc-result-count'));if(!matches.length)root.append(make('p',(staff.reservations||[]).length?'沒有符合條件的紀錄。':'尚無預約紀錄。','lc-empty'));for(const r of matches)root.append(reservationCard(r,'bookings',r.status==='inspection'));}
 function renderMembers(){if(!staff)return;const root=$('lc-members'),query=$('lc-member-search').value.trim().toLowerCase(),members=(staff.members||[]).filter(m=>!query||`${m.name} ${m.studentId}`.toLowerCase().includes(query));root.replaceChildren();if(!members.length)root.append(make('p',(staff.members||[]).length?'沒有符合條件的借用人。':'還沒有借用人。社員送出預約後會出現在這裡。','lc-empty'));for(const m of members){const row=make('article',undefined,'lc-list-row');const info=make('div');info.append(make('strong',`${m.name} · ${m.studentId}`),make('small',m.contact||'未填聯絡方式'));row.append(info,pill(m.active?'可預約':'已停用',m.active?'free':'off'),button('編輯',()=>fillMember(m),'text-button'));root.append(row);}}

 function reservationCard(r,panel,review){
  const card=make('article',undefined,'lc-record'),who=borrowerOf(r);card.dataset.status=r.status;
  const head=make('div',undefined,'lc-asset-head');head.append(make('strong',`${who.name} · ${codes(r)}`),pill(overdue(r)?'已逾期':r.approval==='pending'&&r.status==='reserved'?'待同意':statusNames[r.status]||r.status,overdue(r)||r.approval==='pending'&&r.status==='reserved'?'warn':statusTone[r.status]));card.append(head);
  card.append(details('學號',who.studentId),details('預約',range(r.start,r.end)));
  if(r.approval==='pending'&&r.status==='reserved')card.append(make('p','請確認此人已私訊社團 Instagram，並對照社員名單後再同意。','lc-next warn'));
  if(r.status==='reserved')card.append(details('取車',new Date(r.start)>new Date()?`${span(new Date(r.start)-new Date())}後開始`:'已可取車'));
  if(r.pickedUpAt)card.append(details('實際取車',fmt(r.pickedUpAt)));
  if(overdue(r))card.append(make('p',`已逾期 ${span(new Date()-new Date(r.end))}，請聯絡借用人。`,'lc-next warn'));
  if(r.returnedAt)card.append(details('實際歸還',fmt(r.returnedAt)));
  if(['in_use','inspection'].includes(r.status)||overdue(r))card.append(details('借用人聯絡方式',who.contact));
  const returned=(r.inspections||[]).filter(i=>i.phase==='return').at(-1);
  if(review&&returned){const values=parsedChecks(returned.checks),bad=Object.entries(checks).filter(([k])=>values[k]===false).map(([,label])=>label);card.append(make('p',`還車回報異常：${bad.length?bad.join('、'):'其他異常'}；備註：${returned.notes||'無'}`,'lc-next warn'));}
  const more=keep(make('details',undefined,'lc-more'),`${panel}:more:${r.id}`);more.append(make('summary','學號、車況檢查與簽署紀錄'));more.append(details('借用當時學號',who.studentId),details('借用當時聯絡方式',who.contact));
  for(const i of r.inspections||[]){const box=make('section',undefined,'lc-inspection');box.append(make('strong',`${i.phase==='pickup'?'取車車況':'歸還車況'} · ${i.abnormal?'異常':'正常'}`),details('時間',fmt(i.createdAt)),details('備註',i.notes||'無'));const values=parsedChecks(i.checks),grid=make('ul',undefined,'lc-check-grid');for(const [key,label] of Object.entries(checks)){const li=make('li',`${label}：${values[key]===true?'正常':values[key]===false?'異常':'未記錄'}`);if(values[key]===false)li.className='error';grid.append(li);}box.append(grid);more.append(box);}
  if(r.signature){more.append(details('電子簽署',`${r.signature.name} · ${fmt(r.signature.signedAt)} · 規範 ${String(r.signature.termsVersion).slice(0,12)}`));const policy=keep(make('details'),`${panel}:terms:${r.id}`);policy.append(make('summary','查看簽署時的規範全文'),make('pre',r.signature.terms||'無規範快照','lc-policy-snapshot'));more.append(policy);if(r.signature.image){const b=button('查看簽名',()=>{const img=make('img');img.src=r.signature.image;img.alt=`${r.signature.name} 的電子簽名`;img.className='lc-signature-image';b.replaceWith(img);},'text-button');more.append(b);}}
  if(!(r.inspections||[]).length&&!r.signature)more.append(make('p','尚無車況檢查或簽署。','fine'));
  card.append(more);
  const actions=make('div',undefined,'lc-actions'),compareKey=`${panel}:${r.id}`;
  if(r.photos?.length)actions.append(button(ui.compare.has(compareKey)?'收起照片':`比較照片（${r.photos.length} 張）`,()=>{if(ui.compare.has(compareKey))ui.compare.delete(compareKey);else ui.compare.add(compareKey);renderStaff();}));
  if(r.status==='reserved'&&r.approval==='pending')actions.append(button('同意預約',e=>approve(r,e.currentTarget),''));
  if(r.status==='reserved')actions.append(button(r.approval==='pending'?'拒絕':'取消預約',()=>toggleForm(`${panel}:cancel:${r.id}`),'danger'));
  if(r.selfService&&['reserved','in_use'].includes(r.status))actions.append(button('重新產生取還車碼',e=>reissueAccess(r,e.currentTarget),'text-button'));
  if(r.status==='inspection')actions.append(button('完成異常審核',()=>toggleForm(`${panel}:resolve:${r.id}`),''));
  card.append(actions);
  if(ui.forms.has(`${panel}:cancel:${r.id}`))card.append(staffForm(r,panel,'cancel'));
  if(ui.forms.has(`${panel}:resolve:${r.id}`))card.append(staffForm(r,panel,'resolve'));
  if(ui.issued.has(r.id))card.append(issuedCode(r));
  if(ui.compare.has(compareKey))card.append(compareStaffPhotos(r));
  return card;
 }
 async function approve(r,b){const restore=busy(b,'同意中…');if(!await write('approve',{reservationId:r.id},`已同意 ${borrowerOf(r).name} 的預約；社員可在取車時間自行取車。`,`approve:${r.id}`)&&b.isConnected)restore();}
 // A lost phone: the officer issues a new booking code once and sends it on Instagram; the old code stops working.
 async function reissueAccess(r,b){if(!confirm(`要為 ${borrowerOf(r).name} 重新產生取還車碼嗎？舊的碼會立即失效。`))return;const key=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');const restore=busy(b,'產生中…');if(await write('access',{reservationId:r.id,key},'已產生新的取還車碼；請用 Instagram 私訊傳給本人。',`access:${r.id}:${key}`)){ui.issued.set(r.id,key);renderStaff();}else if(b.isConnected)restore();}
 function issuedCode(r){const key=ui.issued.get(r.id),box=make('div',undefined,'lc-token-output');box.append(make('strong','新的取還車碼只顯示這一次'),make('p','請用 Instagram 私訊傳給本人，請對方在借車頁「換了手機？」貼上。','fine'),make('code',key,'lc-token-value'));const row=make('div',undefined,'lc-actions');if(navigator.clipboard?.writeText)row.append(button('複製',async()=>{try{await navigator.clipboard.writeText(key);say('lc-admin-message','已複製；傳送後請清除剪貼簿。','ok');}catch{say('lc-admin-message','無法複製，請手動選取。',true);}},''));row.append(button('已傳送，隱藏',()=>{ui.issued.delete(r.id);renderStaff();}));box.append(row);return box;}
 function toggleForm(key){if(ui.forms.has(key))ui.forms.delete(key);else ui.forms.set(key,{reason:'',state:''});renderStaff();setTimeout(()=>document.querySelector(`.lc-panel:not([hidden]) [data-draft="${key}:reason"]`)?.focus(),0);}
 function staffForm(r,panel,action){const key=`${panel}:${action}:${r.id}`,draft=ui.forms.get(key),form=make('form',undefined,'lc-inline-form');const rejecting=action==='cancel'&&r.approval==='pending';form.append(make('h4',rejecting?'拒絕這筆預約':action==='cancel'?'取消這筆預約':'異常審核結案'));
  const label=make('label',rejecting?'拒絕原因（社員會在自己的手機看到狀態）':action==='cancel'?'取消原因':'處理經過與車況判定原因');const reason=make('textarea');reason.rows=3;reason.maxLength=500;reason.required=true;reason.value=draft.reason;reason.dataset.draft=`${key}:reason`;reason.addEventListener('input',()=>{draft.reason=reason.value;});label.append(reason);form.append(label);
  if(action==='resolve'){const set=make('fieldset',undefined,'lc-state-choice');set.append(make('legend','結案後車況'));for(const [value,text] of [['available','可借用（已檢修完成）'],['maintenance','維修中（暫停預約）']]){const option=make('label',undefined,'lc-checkline');const input=make('input');input.type='radio';input.name=`state-${key}`;input.value=value;input.checked=draft.state===value;input.addEventListener('change',()=>{draft.state=value;});option.append(input,make('span',text));set.append(option);}form.append(set);}
  const row=make('div',undefined,'lc-actions'),submit=make('button',rejecting?'確認拒絕':action==='cancel'?'確認取消預約':'確認結案',action==='cancel'?'danger':'');submit.type='submit';row.append(submit,button('返回',()=>{ui.forms.delete(key);renderStaff();}));form.append(row);
  form.addEventListener('submit',async e=>{e.preventDefault();if(!draft.reason.trim()){say('lc-admin-message','請填寫原因。',true);reason.focus();return;}if(action==='resolve'&&!draft.state){say('lc-admin-message','請選擇結案後車況。',true);return;}const restore=busy(submit,'處理中…');const payload=action==='cancel'?{reservationId:r.id,reason:draft.reason.trim()}:{reservationId:r.id,reason:draft.reason.trim(),state:draft.state};const ok=await write(action,payload,rejecting?'已拒絕這筆預約。':action==='cancel'?'預約已取消。':'異常已結案，車況已更新。',`${action}:${r.id}`);if(ok){ui.forms.delete(key);renderStaff();}else if(submit.isConnected)restore();});
  return form;}
 function readPhoto(photo,generation){if(!photoCache.has(photo.id))photoCache.set(photo.id,adminAction('photo_read',{id:photo.id}).then(r=>r.photo).catch(e=>{photoCache.delete(photo.id);throw e;}));return photoCache.get(photo.id).then(p=>{if(generation!==adminGeneration||!guard())throw new Error('幹部登入已失效');return p;});}
 function compareStaffPhotos(r){const generation=adminGeneration,box=make('div',undefined,'lc-photo-pair-list');
  const fill=(target,photo,alt)=>readPhoto(photo,generation).then(source=>{const img=make('img');img.src=`data:${source.mime};base64,${source.data}`;img.alt=alt;target.replaceWith(img);}).catch(e=>{if(generation===adminGeneration)target.replaceWith(make('p',e.message,'error'));});
  for(const [slot,label] of Object.entries(slots)){const row=make('section',undefined,'lc-compare-row');row.append(make('h4',label));const pair=make('div',undefined,'lc-photo-pair');for(const phase of ['pickup','return']){const photo=(r.photos||[]).filter(p=>p.phase===phase&&p.slot===slot).at(-1);const figure=make('figure');figure.append(make('figcaption',phase==='pickup'?'取車前':'歸還時'));if(photo){const wait=make('div','讀取中…','lc-photo-loading');figure.append(wait,make('small',fmt(photo.uploadedAt)));fill(wait,photo,`${label}，${phase==='pickup'?'取車前':'歸還時'}`);}else figure.append(make('p','尚無照片','lc-photo-none'));pair.append(figure);}row.append(pair);
   const all=(r.photos||[]).filter(p=>p.slot===slot);if(all.length>2){const history=keep(make('details'),`history:${r.id}:${slot}`);history.append(make('summary',`查看此項全部 ${all.length} 張原始照片`));const gallery=make('div',undefined,'lc-photo-history');const load=()=>{if(gallery.childElementCount)return;for(const photo of all){const figure=make('figure');figure.append(make('figcaption',`${photo.phase==='pickup'?'取車前':'歸還時'} · ${fmt(photo.uploadedAt)} · ${photo.sha256.slice(0,12)}`));const wait=make('div','讀取中…','lc-photo-loading');figure.append(wait);fill(wait,photo,`${label} 照片歷史`);gallery.append(figure);}};history.addEventListener('toggle',()=>{if(history.open)load();});if(history.open)load();history.append(gallery);row.append(history);}
   box.append(row);}
  return box;}
 function fillAsset(a){const f=$('lc-asset-form');f.elements.id.value=a.id;f.elements.code.value=a.code;f.elements.name.value=a.name;f.elements.kind.value=a.kind;f.elements.state.value=a.state;f.elements.reason.value='';$('lc-asset-heading').textContent=`編輯 ${a.code}`;scrollTo(f.closest('.lc-form-card'));f.elements.state.focus({preventScroll:true});}
 function fillMember(m){const f=$('lc-member-form');f.elements.id.value=m.id;f.elements.studentId.value=m.studentId;f.elements.name.value=m.name;f.elements.contact.value=m.contact||'';f.elements.validUntil.value=localDateTime(new Date(m.validUntil));f.elements.active.checked=!!m.active;f.elements.reason.value='';$('lc-member-card').hidden=false;$('lc-member-heading').textContent=`編輯 ${m.name}`;clearToken();scrollTo(f.closest('.lc-form-card'));}
 $('lc-admin-refresh').addEventListener('click',()=>loadStaff(true));
 for(const b of document.querySelectorAll('#lc-booking-filter button'))b.addEventListener('click',()=>{bookingFilter=b.dataset.status;for(const x of document.querySelectorAll('#lc-booking-filter button'))x.setAttribute('aria-pressed',String(x===b));renderBookings();});
 $('lc-booking-search').addEventListener('input',renderBookings);$('lc-member-search').addEventListener('input',renderMembers);
 $('lc-asset-new').addEventListener('click',()=>{resetAsset();scrollTo($('lc-asset-form').closest('.lc-form-card'));$('lc-asset-form').elements.code.focus({preventScroll:true});});
  $('lc-asset-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,v=Object.fromEntries(new FormData(f));if(!f.reportValidity()||!v.reason?.trim())return;const restore=busy(f.querySelector('button[type=submit]'),'儲存中…');try{if(await write('asset',{...v,id:v.id||undefined},`${v.code} 已儲存。`))resetAsset();}finally{restore();}});$('lc-asset-reset').addEventListener('click',resetAsset);
 $('lc-member-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget;if(!f.reportValidity())return;const v=Object.fromEntries(new FormData(f));v.active=f.elements.active.checked;v.validUntil=taipeiDateTime(v.validUntil).toISOString();const reissue=f.elements.reissue.checked;delete v.reissue;if(!v.id||reissue){const bytes=crypto.getRandomValues(new Uint8Array(32));v.token=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}const restore=busy(f.querySelector('button[type=submit]'),'儲存中…');try{await adminAction('member',{...v,id:v.id||undefined});clearToken();if(v.token){const box=$('lc-new-token');box.hidden=false;box.append(make('strong',`${v.name} 的資格碼只顯示這一次`),make('p',`請立即以安全方式交給已核對身分的社員。${reissue?'舊碼已失效。':''}`),make('code',v.token,'lc-token-value'));const row=make('div',undefined,'lc-actions');if(navigator.clipboard?.writeText)row.append(button('複製資格碼',async()=>{try{await navigator.clipboard.writeText(v.token);say('lc-admin-message','資格碼已複製；交付後請清除剪貼簿。','ok');}catch{say('lc-admin-message','無法複製，請手動選取。',true);}},''));row.append(button('已交付，隱藏資格碼',clearToken));box.append(row);}resetMember();await loadStaff(true);say('lc-admin-message','借用人資料已儲存。','ok');}catch(err){say('lc-admin-message',`借用人資料儲存失敗：${err.message}`,true);}finally{restore();}});$('lc-member-reset').addEventListener('click',()=>{resetMember();clearToken();});
 $('lc-policy-form').addEventListener('input',()=>policyDirty=true);
 $('lc-policy-form').addEventListener('submit',async e=>{e.preventDefault();if(!guard())return;const v=Object.fromEntries(new FormData(e.currentTarget));const restore=busy(e.currentTarget.querySelector('button[type=submit]'),'發布中…');try{await adminAction('settings',v);policyDirty=false;await loadStaff(true);say('lc-admin-message','取車指引與借車規範已發布；新簽署須使用最新版本。','ok');}catch(err){say('lc-admin-message',`規範儲存失敗：${err.message}`,true);}finally{restore();}});
 $('lc-export').addEventListener('click',async()=>{if(!guard())return;const generation=adminGeneration,restore=busy($('lc-export'),'匯出中…');try{const result=await adminAction('export');if(generation!==adminGeneration||!guard())return;const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=make('a');a.href=url;a.download=`ntut-cycling-lifecycle-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);say('lc-admin-message','完整借還車備份已下載。請妥善保管私人照片與簽署。','ok');}catch(e){say('lc-admin-message',`匯出失敗：${e.message}`,true);}finally{restore();}});
 resetMember();
 const observer=new MutationObserver(()=>{if(guard())loadStaff(true);else clearStaff();});observer.observe($('workspace'),{attributes:true,attributeFilter:['hidden']});observer.observe($('mfa-panel'),{attributes:true,attributeFilter:['hidden']});window.addEventListener('focus',()=>{if(guard())loadStaff();else clearStaff();});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&guard())loadStaff();});setInterval(()=>{if(guard()&&!document.hidden)loadStaff();else if(!guard())clearStaff();},30000);if(guard())loadStaff(true);
}
