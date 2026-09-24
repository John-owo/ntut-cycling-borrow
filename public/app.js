import {confirmLocalized} from './i18n.js?v=security0924';
import {api,safeContact,node,date} from './api.js?v=security0924';
const $=id=>document.getElementById(id);
let savedToken='',pendingToken='',summary=null,lastSuccess=0,busy=false,refreshing=false,lookupSequence=0;
let registrationReady=false,termsRead=false;
const terms=$('borrow-terms-text'),agree=$('terms-agree'),registrationFields=$('registration-fields');
function updateRegisterButton(){
  $('register-button').disabled=busy||!registrationReady||!summary||summary.total===null||Date.now()-lastSuccess>45000||!termsRead||!agree.checked;
}
function updateTermsRead(){
  if(termsRead||terms.scrollTop+terms.clientHeight<terms.scrollHeight-4)return;
  termsRead=true;agree.disabled=false;
  $('terms-progress').textContent='已閱讀至須知末尾，請勾選確認。';
  updateRegisterButton();
}
function updateRegistrationFields(){
  registrationFields.hidden=!agree.checked;
  registrationFields.disabled=!agree.checked;
  updateRegisterButton();
}
terms.addEventListener('scroll',updateTermsRead);
agree.addEventListener('change',updateRegistrationFields);
requestAnimationFrame(updateTermsRead);
try { savedToken=localStorage.getItem('bike-query-token')||'';pendingToken=localStorage.getItem('bike-pending-token')||''; }catch{}
function save(key,value) {try{value?localStorage.setItem(key,value):localStorage.removeItem(key);}catch{}}
function message(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
function renderSummary(s) { summary=s;lastSuccess=Date.now();$('total').textContent=s.total??'待設定';$('borrowed').textContent=s.borrowed;$('remaining').textContent=s.available??'待設定';$('waiting').textContent=s.waiting;
  message('sync-status',`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour12:false})}`);
  const p=s.waiting+1,r=s.available;
  $('estimate').textContent=r===null?'車數待幹部設定，目前尚未開放登記。':`現在登記預估排隊第 ${p} 位${p>r?`，依目前總數估算為備取第 ${p-r} 位`:'，目前數量可能涵蓋此順位'}。正式順位以成功登記為準。`;
  registrationReady=true;updateRegisterButton();
  const url=safeContact(s.contactUrl);$('contact-link').hidden=!url;$('contact-empty').hidden=!!url;if(url)$('contact-link').href=url;
}
function stale(error) {message('sync-status',`${error || '更新失敗'}${lastSuccess?'，顯示上次取得資料。':'。'}`,true);registrationReady=false;updateRegisterButton();}
function showCode(token){$('forget').hidden=false;$('recovery').hidden=false;$('recovery-code').textContent=token;}
function personal(r){const root=$('personal-result');root.replaceChildren();root.hidden=false;root.className='personal';const names={waiting:'登記等候中',borrowed:'借用中',returned:'已歸還',cancelled:'已取消'};root.append(node('h3',names[r.status]||r.status));if(r.status==='waiting'){root.append(node('p',`排隊第 ${r.position} 位`,'rank'),node('p',`前面有 ${r.position-1} 人。`),node('p',r.standby>0?`依目前數量估算：備取第 ${r.standby} 位。`:'目前數量可能涵蓋你的順位，仍需現場確認車款與尺寸。'));}else if(r.status==='borrowed'){root.append(node('p','已由幹部確認交車。歸還後請由幹部確認收車。'));}else root.append(node('p','這筆紀錄已退出等候佇列，不會因歸還而重新排隊。'));
 const dl=node('dl');for(const [label,value]of [['姓名',r.name],['學號',r.studentId],['登記時間',date(r.createdAt)],['狀態更新',date(r.updatedAt)]]){dl.append(node('dt',label),node('dd',value));}root.append(dl);$('forget').hidden=false;
}
async function lookup(token,manual=false){const seq=++lookupSequence;try{const data=await api('/api/me',{token});if(seq!==lookupSequence)return; if(token===pendingToken){pendingToken='';save('bike-pending-token','');}savedToken=token;save('bike-query-token',token);if(manual||document.activeElement!==$('lookup-token'))$('lookup-token').value=token;personal(data.record);renderSummary(data.summary);message('lookup-message','已取得最新狀態。');if(manual)showCode(token);}catch(e){if(seq!==lookupSequence)return;message('lookup-message',`查詢失敗：${e.message}${$('personal-result').hidden?'':' 下方為上次查詢結果。'}`,true);if(e.status===404){$('personal-result').hidden=true;}throw e;}}
async function refresh(){if(refreshing||busy)return;refreshing=true;try{if(savedToken&&!pendingToken){try{await lookup(savedToken);}catch{renderSummary(await api('/api/summary'));}}else renderSummary(await api('/api/summary'));}catch(e){stale(e.message);}finally{refreshing=false;}}
$('refresh').addEventListener('click',refresh);
$('register-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;if(!termsRead||!agree.checked){message('register-message','請先讀完借車須知並勾選確認。',true);return;}updateRegisterButton();if($('register-button').disabled)return;lookupSequence++;busy=true;$('lookup-form').querySelector('button').disabled=true;$('forget').disabled=true;updateRegisterButton();const values=Object.fromEntries(new FormData(e.currentTarget));if(!pendingToken){pendingToken=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');save('bike-pending-token',pendingToken);}showCode(pendingToken);message('register-message','正在保存登記，請保留查詢碼…');
 try{const d=await api('/api/register',{...values,token:pendingToken});savedToken=pendingToken;save('bike-query-token',savedToken);pendingToken='';save('bike-pending-token','');$('lookup-token').value=savedToken;personal(d.record);renderSummary(d.summary);message('lookup-message','已取得最新狀態。');message('register-message','登記已保存。請保存查詢碼，再與幹部約時間。');$('register-form').reset();updateRegistrationFields();}
 catch(err){message('register-message',err.message+' 若剛才送出後斷線，請先用上方查詢碼查詢，避免重複登記。',true);$('lookup-token').value=pendingToken;}
 finally{busy=false;$('lookup-form').querySelector('button').disabled=false;$('forget').disabled=false;updateRegisterButton();}});
$('lookup-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;const token=$('lookup-token').value.trim().toLowerCase();if(!/^[a-f0-9]{64}$/.test(token)){message('lookup-message','請貼上完整的 64 字元查詢碼。',true);return;}try{await lookup(token,true);}catch{}});
$('copy-code').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('recovery-code').textContent);message('copy-message','已複製，請存到自己的私人筆記。');}catch{message('copy-message','無法自動複製，請長按上方查詢碼選取並保存。',true);}});
$('forget').addEventListener('click',()=>{if(busy)return;if(!confirmLocalized('請先確認已另存查詢碼。清除此裝置的查詢碼，不會取消登記。'))return;lookupSequence++;savedToken='';pendingToken='';save('bike-query-token','');save('bike-pending-token','');$('lookup-token').value='';$('personal-result').replaceChildren();$('personal-result').hidden=true;$('recovery-code').textContent='';$('recovery').hidden=true;$('forget').hidden=true;message('lookup-message','已清除此裝置的查詢碼。');refresh();});
window.addEventListener('offline',()=>stale('目前離線'));window.addEventListener('online',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(()=>{if(!document.hidden)refresh();},15000);setInterval(()=>{if(lastSuccess&&Date.now()-lastSuccess>45000)stale('資料超過 45 秒未更新');},5000);
// An uncertain newer submission must remain recoverable even when an older
// registration is saved on this device. Poll only the public summary until resolved.
if(pendingToken){$('lookup-token').value=pendingToken;showCode(pendingToken);message('register-message','先前的送出結果尚未確認。請用保存的查詢碼查詢。');}else if(savedToken){$('lookup-token').value=savedToken;$('forget').hidden=false;}refresh();
