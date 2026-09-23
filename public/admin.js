import {confirmLocalized} from './i18n.js?v=purpose0924';
import {api,login,logout,clearAdmin,currentAdmin,cloud,node,date} from './api.js?v=purpose0924';
// GitHub Pages cannot send frame-ancestors, so the officer desk refuses to run inside another site's frame (clickjacking defense in depth).
if(window.self!==window.top){document.documentElement.hidden=true;try{window.top.location.replace(location.href);}catch{}throw new Error('Officer desk must not be framed');}
const $=id=>document.getElementById(id);let data=null,filter='waiting',refreshing=false,lastSuccess=0,pending=null,mutating=false,settingsDirty=false,authGeneration=0;
let borrowedDirty=false,borrowedSnapshot=null,refreshTask=null;
const names={waiting:'等候中',borrowed:'借用中',returned:'已歸還',cancelled:'已取消'};const actions={lend:'確認借出',return:'確認歸還',cancel:'取消登記'};const contactNames={phone:'手機',line:'LINE',instagram:'Instagram'};const purposeNames={group_ride:'參加社團團騎',personal_ride:'自己私底下騎'};const selected=new Set();let waitingCount=0;
function message(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
function locked(){return !lastSuccess||Date.now()-lastSuccess>45000;}
function signedOut(){authGeneration++;selected.clear();pending=null;data=null;lastSuccess=0;$('workspace').hidden=true;$('login-panel').hidden=false;$('records').replaceChildren();$('identity').textContent='';$('action-dialog').close();$('action-form').reset();$('settings-form').reset();settingsDirty=false;borrowedDirty=false;borrowedSnapshot=null;$('borrowed-form').reset();message('borrowed-message','');$('borrowed-history').replaceChildren();}
function showRecords(){renderBorrowed();const root=$('records');root.replaceChildren();showOpening(root);const rows=(data?.records||[]).filter(r=>filter==='history'?['returned','cancelled'].includes(r.status):r.status===filter);
 if(filter==='waiting'){const ids=new Set(rows.map(r=>r.id));for(const id of selected)if(!ids.has(id))selected.delete(id);waitingCount=rows.length;if(rows.length>1)root.append(bulkBar(rows));}else selected.clear();
 if(!rows.length){root.append(node('p',filter==='waiting'?'目前沒有等候登記。':filter==='borrowed'?(data?.opening?.outstanding>0?'目前沒有線上登記的借用紀錄；既有借出請見上方。':'目前沒有借用中的車輛。'):'目前沒有已歸還或取消的紀錄。','empty'));return;}
 for(const r of rows){const card=node('article',undefined,'record');const head=node('div',undefined,'record-head');const person=node('div');person.append(node('h3',`${r.name} · ${r.studentId}`));const contact=node('p',undefined,'contact');contact.append(node('span',contactNames[r.contactType]||r.contactType,'contact-type'),node('span',r.contact,'user-content'));person.append(contact,node('p',`借車目的：${purposeNames[r.purpose]||'未記錄'}`));
  const side=node('div',undefined,'record-side');side.append(node('span',names[r.status],'tag'));
  if(r.status==='waiting'){const pick=node('label',undefined,'pick');const box=node('input');box.type='checkbox';box.checked=selected.has(r.id);box.setAttribute('aria-label','選取此筆');box.addEventListener('change',()=>{box.checked?selected.add(r.id):selected.delete(r.id);updateBulk();});pick.append(box,node('span','選取'));side.append(pick);}
  head.append(person,side);card.append(head);if(r.status==='waiting')card.append(node('p',`排隊第 ${r.position} 位${r.standby>0?`／估算備取第 ${r.standby} 位`:'／目前數量可能涵蓋'}，登記於 ${date(r.createdAt)}`));else card.append(node('p',`登記 ${date(r.createdAt)} · 狀態更新 ${date(r.updatedAt)}`));if(r.bikeNote)card.append(node('p',`車號／備註：${r.bikeNote}`));const history=(data.audit||[]).filter(a=>Number(a.recordId)===Number(r.id));for(const a of history.slice(0,5))card.append(node('p',`${date(a.at)} · ${a.actor} · ${actions[a.action]||a.action}`,'audit'));
  const controls=node('div',undefined,'record-actions');for(const action of r.status==='waiting'?['lend','cancel']:r.status==='borrowed'?['return']:[]){const b=node('button',actions[action],action==='cancel'?'danger':'');b.type='button';b.disabled=locked()||mutating||(action==='lend'&&(data.summary.available??0)<1);b.addEventListener('click',()=>openAction(r,action));controls.append(b);}card.append(controls);root.append(card);}}
// Bulk cancellation of waiting registrations (spam cleanup). Selection is device-local and dropped for ids that stop waiting.
function bulkBar(rows){const bar=node('div',undefined,'bulk-bar');const count=node('span',`已選取 ${selected.size} 筆`,'bulk-count');count.id='bulk-count';const all=node('button',selected.size===rows.length?'清除選取':'全選等候中','text-button');all.type='button';all.id='bulk-all';all.addEventListener('click',()=>{if(selected.size===rows.length)selected.clear();else rows.forEach(r=>selected.add(r.id));showRecords();});const cancel=node('button','取消選取的登記','danger');cancel.type='button';cancel.id='bulk-cancel';cancel.disabled=!selected.size||locked()||mutating;cancel.addEventListener('click',bulkCancel);bar.append(count,all,cancel);return bar;}
function updateBulk(){const c=$('bulk-count');if(c)c.textContent=`已選取 ${selected.size} 筆`;const a=$('bulk-all');if(a)a.textContent=selected.size===waitingCount&&waitingCount>0?'清除選取':'全選等候中';const b=$('bulk-cancel');if(b)b.disabled=!selected.size||locked()||mutating;}
async function bulkCancel(){if(mutating||!selected.size)return;const ids=[...selected];if(!confirmLocalized(`確認取消 ${ids.length} 筆等候登記？這不會改變已借出車數。`))return;mutating=true;updateBulk();
 try{const result=await api('/api/admin/cancel-many',{ids},true);selected.clear();message('action-message',`已取消 ${result.cancelled.length} 筆登記${result.skipped.length?`，${result.skipped.length} 筆已不在等候中`:''}。`);}
 catch(err){message('action-message',`${err.message} 請更新清單確認狀態後再操作。`,true);}
 finally{mutating=false;await refresh();showRecords();}}
function render(next){data=next;lastSuccess=Date.now();$('workspace').hidden=false;$('login-panel').hidden=true;$('identity').textContent=`目前登入：${currentAdmin()}`;for(const key of ['total','borrowed','available','waiting'])$(key).textContent=next.summary[key]??'待設定';message('sync-status',`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour12:false})}`);if(!settingsDirty){$('settings-form').elements.total.value=next.summary.total??'';$('settings-form').elements.contactUrl.value=next.summary.contactUrl||'';}showRecords();}
function refresh(){
 if(refreshing||!currentAdmin())return refreshTask;
 refreshing=true;const generation=authGeneration;
 refreshTask=(async()=>{try{const result=await api('/api/admin/records',undefined,true);if(generation!==authGeneration||!currentAdmin())return;render(result);}catch(e){if(generation!==authGeneration)return;message('sync-status',`更新失敗：${e.message}，資料可能已過期。`,true);lastSuccess=0;showRecords();if(e.status===401||e.status===403){clearAdmin();signedOut();message('login-message','登入失效或沒有幹部權限，請重新登入。',true);}}finally{refreshing=false;}})();
 return refreshTask;
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;const f=new FormData(e.currentTarget);try{await login(f.get('username'),f.get('password'));$('login-form').reset();message('login-message','');await refresh();}catch(err){message('login-message',err.message,true);}finally{button.disabled=false;}});
$('export').addEventListener('click',async()=>{const button=$('export'),generation=authGeneration;button.disabled=true;try{const dump=await api('/api/admin/export',undefined,true);if(generation!==authGeneration)return;const blob=new Blob([JSON.stringify(dump,null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`ntut-cycling-borrow-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);message('action-message','備份已下載，檔案內含個資，請妥善保存。');await refresh();}catch(err){message('action-message',err.message,true);}finally{button.disabled=false;}});
$('logout').addEventListener('click',async()=>{const task=logout();signedOut();try{await task;}catch{message('login-message','此裝置已登出；遠端登出未確認，請勿在共用裝置保留登入。',true);}});
$('refresh').addEventListener('click',refresh);document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));showRecords();}));
function openAction(record,action){pending={record,action};$('action-form').reset();$('dialog-title').textContent=actions[action];$('dialog-description').textContent=action==='lend'?`確認已將車輛交給 ${record.name}（${record.studentId}）？完成後才會計入已借出。`:action==='return'?`確認已實際收到 ${record.name} 歸還的車輛？`:`確認取消 ${record.name} 的等候登記？這不會改變已借出車數。`;$('note-label').hidden=action!=='lend';$('action-form').elements.bikeNote.value=record.bikeNote||'';message('dialog-message','');$('action-dialog').showModal();}
$('dialog-cancel').addEventListener('click',()=>{if(!mutating)$('action-dialog').close();});$('action-dialog').addEventListener('cancel',e=>{if(mutating)e.preventDefault();});
$('action-form').addEventListener('submit',async e=>{e.preventDefault();if(!pending||mutating)return;mutating=true;$('dialog-confirm').disabled=true;$('dialog-cancel').disabled=true;const {record,action}=pending;try{await api('/api/admin/action',{id:record.id,action,bikeNote:action==='lend'?e.currentTarget.elements.bikeNote.value:record.bikeNote},true);$('action-dialog').close();message('action-message',`${actions[action]}已保存。`);await refresh();}catch(err){message('dialog-message',`${err.message} 請更新清單確認狀態後再操作。`,true);await refresh();}finally{mutating=false;$('dialog-confirm').disabled=false;$('dialog-cancel').disabled=false;showRecords();}});
$('settings-form').addEventListener('input',()=>settingsDirty=true);$('settings-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;const f=new FormData(e.currentTarget);try{await api('/api/admin/settings',{total:Number(f.get('total')),contactUrl:f.get('contactUrl').trim()},true);settingsDirty=false;message('settings-message','設定已保存。');await refresh();}catch(err){message('settings-message',err.message,true);}finally{button.disabled=false;}});
if(cloud){$('username-label').firstChild.textContent='管理員電子郵件';$('login-form').elements.username.type='email';}
window.addEventListener('offline',()=>{lastSuccess=0;message('sync-status','目前離線，資料可能已過期。',true);showRecords();});window.addEventListener('online',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(()=>{if(!document.hidden)refresh();},15000);setInterval(()=>{if(currentAdmin()&&locked()){message('sync-status','資料未更新，請更新後再操作。',true);showRecords();}},5000);if(currentAdmin())refresh();
// Shared club devices: polling keeps the token fresh, so sign out after 30 minutes without any interaction.
const idleLimit=30*60*1000;let lastActivity=Date.now();
for(const type of ['pointerdown','keydown','touchstart','wheel'])window.addEventListener(type,()=>{lastActivity=Date.now();},{passive:true});
setInterval(async()=>{if(!currentAdmin()||mutating||Date.now()-lastActivity<idleLimit)return;lastActivity=Date.now();const task=logout();signedOut();try{await task;}catch{}message('login-message','閒置超過 30 分鐘，已自動登出。',true);},30000);

// Only a pending operation key is device-local; the authoritative count stays in the database.
let openingDraft = 1;
function pendingOpening() { try {return JSON.parse(localStorage.getItem('bike-opening-return') || 'null');}catch{return null;} }
function showOpening(root) {
  if(!data || filter==='waiting') return;
  const opening=data.opening;
  const events=(data.audit||[]).filter(a=>a.action==='opening-return');
  const retry=pendingOpening();
  if(!opening || (!(opening.outstanding>0)&&!events.length&&!retry)) return;
  const card=node('article',undefined,'record');card.append(node('h3','未建社員明細的借用'),node('p',`尚未歸還 ${opening.outstanding} 台。借用人資料尚未提供，請搭配原紙本紀錄核對。`));
  if(opening.expectedReturn)card.append(node('p',`預計歸還：${opening.expectedReturn}。這只是提醒，實際收車後才更新數量。`));
  if(opening.note)card.append(node('p',opening.note,'user-content'));
  for(const event of events){let details=event.details;if(typeof details==='string'){try{details=JSON.parse(details);}catch{details={};}}card.append(node('p',`${date(event.at)} · ${event.actor} · 確認既有借用歸還 ${details?.count??'—'} 台`,'audit'));}
  if(filter==='borrowed' && (opening.outstanding>0||retry)){
    const form=node('form');const label=node('label','這次實際收到幾台車？');const input=node('input');input.type='number';input.min='1';input.max=String(Math.max(opening.outstanding,retry?.count||0));input.step='1';input.required=true;input.value=String(retry?.count||openingDraft);input.disabled=!!retry;input.addEventListener('input',()=>openingDraft=Number(input.value));label.append(input);
    const button=node('button',retry?`重試確認歸還 ${retry.count} 台`:'確認既有借用歸還');button.type='submit';button.disabled=locked()||mutating;form.append(label,button);
    if(retry)form.append(node('p','上次送出結果待確認；重試會使用相同操作碼，不會重複增加可借車數。','fine'));
    form.addEventListener('submit',async e=>{e.preventDefault();if(mutating)return;const count=retry?.count||Number(input.value);if(!Number.isSafeInteger(count)||count<1)return;if(!confirmLocalized(`確認已實際收到 ${count} 台既有借用的社車？請核對原紙本紀錄。`))return;
      const operation=retry||{count,requestId:crypto.randomUUID()};
      try{localStorage.setItem('bike-opening-return',JSON.stringify(operation));}catch{message('action-message','無法保存操作碼，請允許此網站儲存資料後重試。',true);return;}
      mutating=true;button.disabled=true;
      try{await api('/api/admin/opening-return',operation,true);localStorage.removeItem('bike-opening-return');openingDraft=1;message('action-message','既有借用歸還已保存。');}
      catch(err){message('action-message',`${err.message} 已保留操作碼，請更新後重試確認。`,true);}
      finally{mutating=false;await refresh();showRecords();}
    });card.append(form);
  }
  root.append(card);
}

// Keep the count a server-derived sum; corrections change only loans without member details.
function borrowedKey(){return `bike-borrowed-adjustment:${location.pathname}:${currentAdmin()}`;}
function pendingBorrowed(){try{return JSON.parse(localStorage.getItem(borrowedKey())||'null');}catch{return null;}}
function renderBorrowed(){
 if(!data)return;
 if(!borrowedSnapshot)borrowedSnapshot={expectedBorrowed:data.summary.borrowed,expectedOpening:data.opening.outstanding};
 const form=$('borrowed-form'),retry=pendingBorrowed(),online=data.summary.borrowed-data.opening.outstanding;
 $('borrowed-breakdown').textContent=`線上借用 ${online} 台，未建明細 ${data.opening.outstanding} 台；可設定範圍 ${online}～${data.summary.total??0} 台。`;
 if(retry){form.elements.borrowed.value=retry.borrowed;form.elements.reason.value=retry.reason;}
 else if(!borrowedDirty){form.elements.borrowed.value=data.summary.borrowed;borrowedSnapshot={expectedBorrowed:data.summary.borrowed,expectedOpening:data.opening.outstanding};}
 form.elements.borrowed.min=String(retry?0:online);form.elements.borrowed.max=String(retry?10000:data.summary.total??0);
 form.elements.borrowed.disabled=!!retry||mutating;form.elements.reason.disabled=!!retry||mutating;
 $('borrowed-save').textContent=retry?'重試確認數量':'儲存已借出數量';
 $('borrowed-save').disabled=locked()||mutating||data.summary.total===null;
 $('borrowed-reset').disabled=mutating||!!retry;
 if(retry&&!mutating)message('borrowed-message','上次調整結果待確認，請按「重試確認數量」。重試不會重複修改。');
 const history=$('borrowed-history');history.replaceChildren();
 for(const event of (data.audit||[]).filter(a=>a.action==='borrowed-adjustment').slice(0,5)){
  let d=event.details;try{if(typeof d==='string')d=JSON.parse(d);}catch{continue;}
  const item=node('p',undefined,'audit');item.append(node('span',`${date(event.at)} · ${event.actor} · ${d.oldBorrowed} → ${d.newBorrowed} `),node('span',d.reason,'user-content'));history.append(item);
 }
}
$('borrowed-form').addEventListener('input',()=>borrowedDirty=true);
$('borrowed-reset').addEventListener('click',async()=>{if(mutating||pendingBorrowed())return;borrowedDirty=false;$('borrowed-form').reset();message('borrowed-message','');await refresh();});
$('borrowed-form').addEventListener('submit',async e=>{
 e.preventDefault();if(mutating||locked()||!borrowedSnapshot)return;
 const form=e.currentTarget,retry=pendingBorrowed(),borrowed=Number(form.elements.borrowed.value),reason=form.elements.reason.value.trim();
 if(!retry&&(!Number.isSafeInteger(borrowed)||!reason)){message('borrowed-message','請輸入整數車數與調整原因。',true);return;}
 const operation=retry||{borrowed,...borrowedSnapshot,reason,requestId:crypto.randomUUID()},key=borrowedKey(),generation=authGeneration;
 try{localStorage.setItem(key,JSON.stringify(operation));}catch{message('borrowed-message','無法保存操作碼，請允許此網站儲存資料後重試。',true);return;}
 mutating=true;showRecords();
 try{
  await api('/api/admin/borrowed',operation,true);localStorage.removeItem(key);
  if(generation===authGeneration){borrowedDirty=false;form.reset();message('borrowed-message','已借出數量已保存。');}
 }catch(err){
  // A validation/conflict response means this attempt did not write. Unknown outcomes retain the exact operation for retry.
  if([400,409,422].includes(err.status)){localStorage.removeItem(key);borrowedDirty=false;}
  if(generation===authGeneration)message('borrowed-message',`${err.message} 請更新清單確認狀態後再操作。`,true);
 }finally{await refreshTask;mutating=false;if(generation===authGeneration){await refresh();showRecords();}}
});
