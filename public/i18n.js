import {english} from './translations.js?v=terms0924';
let language='zh';
try{language=localStorage.getItem('bike-language')==='en'?'en':'zh';}catch{}
const patterns=[
 [/^線上借用 (\d+) 台，未建明細 (\d+) 台；可設定範圍 (\d+)～(\d+) 台。$/,m=>`Online loans: ${m[1]}; loans without details: ${m[2]}. Allowed range: ${m[3]}–${m[4]} bikes.`],
 [/^更新於 (.+)$/,m=>`Updated ${m[1]}`],
 [/^目前登入：(.+)$/,m=>`Signed in: ${m[1]}`],
 [/^排隊第 (\d+) 位$/,m=>`Queue position ${m[1]}`],
 [/^前面有 (\d+) 人。$/,m=>`${m[1]} people ahead of you.`],
 [/^依目前數量估算：備取第 (\d+) 位。$/,m=>`Estimated standby position: ${m[1]}.`],
 [/^現在登記預估排隊第 (\d+) 位，目前數量可能涵蓋此順位。正式順位以成功登記為準。$/,m=>`Registering now: estimated queue position ${m[1]}. The current count may cover this position. Your confirmed position is assigned when registration succeeds.`],
 [/^現在登記預估排隊第 (\d+) 位，依目前總數估算為備取第 (\d+) 位。正式順位以成功登記為準。$/,m=>`Registering now: estimated queue position ${m[1]}, standby ${m[2]}. Your confirmed position is assigned when registration succeeds.`],
 [/^排隊第 (\d+) 位(.*?)，登記於 (.+)$/,m=>`Queue ${m[1]}${m[2].includes('備取')?`, estimated standby ${m[2].match(/\d+/)?.[0]}`:', current count may cover this position'} · Registered ${m[3]}`],
 [/^登記 (.+) · 狀態更新 (.+)$/,m=>`Registered ${m[1]} · Updated ${m[2]}`],
 [/^確認已將車輛交給 (.+)（(.+)）？完成後才會計入已借出。$/,m=>`Confirm that a bike was handed to ${m[1]} (${m[2]})? It will then count as on loan.`],
 [/^確認已實際收到 (.+) 歸還的車輛？$/,m=>`Confirm that you have received the bike returned by ${m[1]}?`],
 [/^確認取消 (.+) 的等候登記？這不會改變已借出車數。$/,m=>`Cancel the waiting registration for ${m[1]}? The on-loan count will not change.`],
 [/^尚未歸還 (\d+) 台。借用人資料尚未提供，請搭配原紙本紀錄核對。$/,m=>`${m[1]} bikes remain on loan. Borrower details have not been entered; check the original paper records.`],
 [/^預計歸還：(.+)。這只是提醒，實際收車後才更新數量。$/,m=>`Expected return: ${m[1]}. Reminder only; the count changes after receipt is confirmed.`],
 [/^重試確認歸還 (\d+) 台$/,m=>`Retry return of ${m[1]} bikes`],
 [/^確認已實際收到 (\d+) 台既有借用的社車？請核對原紙本紀錄。$/,m=>`Confirm receipt of ${m[1]} opening-loan bikes? Check the original paper records.`],
 [/^(確認借出|確認歸還|取消登記)已保存。$/,m=>`${english[m[1]]}: saved.`],
 [/^(.+) · (.+) · (確認借出|確認歸還|取消登記|lend|return|cancel)$/,m=>`${m[1]} · ${m[2]} · ${english[m[3]]||m[3]}`],
 [/^(.+) · (.+) · 確認既有借用歸還 (.+) 台$/,m=>`${m[1]} · ${m[2]} · Opening-loan return: ${m[3]} bikes`],
 [/^已選取 (\d+) 筆$/,m=>`${m[1]} selected`],
 [/^確認取消 (\d+) 筆等候登記？這不會改變已借出車數。$/,m=>`Cancel ${m[1]} waiting registrations? The on-loan count will not change.`],
 [/^已取消 (\d+) 筆登記(?:，(\d+) 筆已不在等候中)?。$/,m=>`Cancelled ${m[1]} registrations${m[2]?`; ${m[2]} were no longer waiting`:''}.`],
 [/^車號／備註：([\s\S]*)$/,m=>`Bike / notes: ${m[1]}`],
 [/^查詢失敗：([\s\S]*)$/,m=>`Lookup failed: ${translate(m[1])}`],
 [/^更新失敗：([\s\S]*)，資料可能已過期。$/,m=>`Update failed: ${translate(m[1])}. Data may be out of date.`],
 [/^([\s\S]*)，顯示上次取得資料。$/,m=>`${translate(m[1])}. Showing previously loaded data.`],
 [/^([\s\S]*) 下方為上次查詢結果。$/,m=>`${translate(m[1])} The result below is from the previous lookup.`],
 [/^([\s\S]*) 請更新清單確認狀態後再操作。$/,m=>`${translate(m[1])} Refresh the list and check the status before trying again.`],
 [/^([\s\S]*) 已保留操作碼，請更新後重試確認。$/,m=>`${translate(m[1])} The operation ID was kept. Refresh and retry.`],
 [/^([\s\S]*) 若剛才送出後斷線，請先用上方查詢碼查詢，避免重複登記。$/,m=>`${translate(m[1])} If you lost connection after submitting, check using the code above before registering again.`],
];
export function translate(text){if(language!=='en')return text;const key=text.trim();if(Object.hasOwn(english,key))return text.replace(key,english[key]);for(const [regex,render]of patterns){const m=key.match(regex);if(m)return render(m);}return text;}
export function confirmLocalized(text){return window.confirm(translate(text));}
// Preserve the original strings and DOM nodes: switching never resets form values.
const originals=new WeakMap(),attributes=new WeakMap();
function render(){observer.disconnect();document.documentElement.lang=language==='en'?'en':'zh-Hant';document.title=language==='en'?(document.body.classList.contains('admin-page')?'Officer desk | NTUT Cycling Club':'Bike registration | NTUT Cycling Club'):(document.body.classList.contains('admin-page')?'幹部管理｜北科大自由車社':'借車登記｜北科大自由車社');
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
 while(n=walker.nextNode()){if(n.parentElement?.closest('script,style,code,textarea,dd,.record-head h3,[data-no-translate],.user-content,.language-switch'))continue;
 const previous=originals.get(n);const source=previous&&n.data===previous.rendered?previous.source:n.data;const rendered=translate(source);originals.set(n,{source,rendered});if(n.data!==rendered)n.data=rendered;}
 document.querySelectorAll('[placeholder],[aria-label]').forEach(el=>{const stored=attributes.get(el)||{};for(const attr of ['placeholder','aria-label']){if(!el.hasAttribute(attr))continue;const current=el.getAttribute(attr),old=stored[attr];const source=old&&current===old.rendered?old.source:current;const rendered=translate(source);stored[attr]={source,rendered};if(current!==rendered)el.setAttribute(attr,rendered);}attributes.set(el,stored);});
 document.querySelectorAll('[data-language]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.language===language)));
 observer.observe(document.body,{subtree:true,childList:true,characterData:true});
}
const observer=new MutationObserver(render);
if(typeof document!=='undefined'){document.querySelectorAll('[data-language]').forEach(button=>button.addEventListener('click',()=>{language=button.dataset.language;try{localStorage.setItem('bike-language',language);}catch{}render();}));render();}
