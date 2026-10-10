import {english} from './translations.js?v=notice1011';
let language='zh';
try{language=localStorage.getItem('bike-language')==='en'?'en':'zh';}catch{}
const weekdays={一:'Mon',二:'Tue',三:'Wed',四:'Thu',五:'Fri',六:'Sat',日:'Sun'};
// Converts zh date, time and duration fragments produced by the booking page.
const enDates=text=>text.replace(/(\d{1,2}\/\d{1,2})（週([一二三四五六日])）/g,(m,d,w)=>`${weekdays[w]} ${d}`).replace(/週([一二三四五六日])/g,(m,w)=>weekdays[w]).replace(/ 起，尚未歸還/g,' onward, not yet returned').replace(/ 整天/g,' all day').replace(/不到 1 分鐘/g,'under 1 min').replace(/(\d+) 天/g,'$1 d').replace(/(\d+) 小時/g,'$1 h').replace(/(\d+) 分/g,'$1 min').replace(/；/g,'; ');
const enList=text=>text.split('、').map(item=>translate(item)).join(', ');
const patterns=[
 [/^確認 (.+) 已主動聯絡，且雙方已確認上述預計時間？$/,m=>`Confirm that ${m[1]} has contacted the club and both parties agreed to the proposed times?`],
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
 [/^(確認聯絡與時間|確認借出|確認歸還|取消登記)已保存。$/,m=>`${english[m[1]]}: saved.`],
 [/^(.+) · (.+) · (確認聯絡與時間|確認借出|確認歸還|取消登記|lend|return|cancel)$/,m=>`${m[1]} · ${m[2]} · ${english[m[3]]||m[3]}`],
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

 // Numbered-bike booking: zh dates such as 10/11（週日） become Sun 10/11; durations and lists are converted.
 [/^(\d{1,2}\/\d{1,2}（週.）[\d:\/\s–→（）週一二三四五六日起，尚未歸還整天]*)$/,m=>enDates(m[1])],
 [/^可借 (\d+)$/,m=>`${m[1]} free`],
 [/^([A-Za-z0-9-]+(?:、[A-Za-z0-9-]+)+)$/,m=>m[1].split('、').join(', ')],
 [/^(\d+) 台$/,m=>`${m[1]} ${m[1]==='1'?'bike':'bikes'}`],
 [/^(.+) 可預約的車$/,m=>`Bikes for ${enDates(m[1])}`],
 [/^其他 (\d+) 台目前無法預約$/,m=>`${m[1]} other ${m[1]==='1'?'bike is':'bikes are'} unavailable now`],
 [/^(已預約|使用中|待確認) (.+)$/,m=>`${translate(m[1])} ${enDates(m[2])}`],
 [/^(此時段|這天)已有預約：(.+)$/,m=>`${m[1]==='此時段'?'Booked in this period':'Booked this day'}: ${enDates(m[2])}`],
 [/^(.+) 與日曆上已有的(.+)時段重疊（(.+)），請調整時間。$/,m=>`${m[1]==='所選車輛'?'The chosen bike':m[1]} overlaps an existing ${translate(m[2]).toLowerCase()} booking (${enDates(m[3])}). Please change the time.`],
 [/^共 (.+?)(（超過五天上限）)?$/,m=>`Total ${enDates(m[1])}${m[2]?' (over the five-day limit)':''}`],
 [/^已選 (.+) · (.+)$/,m=>`Chosen: ${m[1]} · ${enDates(m[2])}`],
 [/^(\d{1,2}\/\d{1,2}（週.）)，(已過|可借 (\d+) 台)$/,m=>`${enDates(m[1])}, ${m[3]===undefined?'past':`${m[3]} available`}`],
 [/^([^\s\u3400-\u9fff]+) (\d{1,2}\/\d{1,2}（週.）) (\S+)$/,m=>`${m[1]} ${enDates(m[2])} ${translate(m[3])}`],
 [/^(過去|更早)的紀錄（(\d+)）$/,m=>`${m[1]==='過去'?'Past':'Earlier'} bookings (${m[2]})`],
 [/^可於 (.+) 起開始取車檢查（還有 (.+)）。到社辦後依序拍照、檢查並簽署。$/,m=>`The pickup check opens at ${enDates(m[1])} (in ${enDates(m[2])}). At the club office, take photos, check and sign in order.`],
 [/^請於 (.+) 前歸還（還有 (.+)）。還車時同樣需要拍照與檢查。$/,m=>`Please return by ${enDates(m[1])} (${enDates(m[2])} left). Returning also needs photos and a check.`],
 [/^已逾期 (.+)。請盡快歸還並主動聯絡幹部。$/,m=>`Overdue by ${enDates(m[1])}. Return the bike soon and contact an officer.`],
 [/^取車時間尚未開始：可於 (.+) 起操作。$/,m=>`Pickup has not started yet; available from ${enDates(m[1])}.`],
 [/^這筆紀錄目前是「(.+)」，無法進行此步驟。$/,m=>`This booking is "${translate(m[1])}", so this step is not available.`],
 [/^(.+)｜(\d{1,2}\/\d{1,2}（週.）.+)$/,m=>`${m[1]} | ${enDates(m[2])}`],
 [/^已上傳 (\d+) 張 · 最近 (.+)$/,m=>`${m[1]} uploaded · latest ${m[2]}`],
 [/^(\d)\/(\d) · (\d+) 項異常$/,m=>`${m[1]}/${m[2]} · ${m[3]} with problems`],
 [/^須與預約時填寫的姓名相同：(.+)$/,m=>`Must match the name entered when booking: ${m[1]}`],
 [/^尚缺照片：(.+)$/,m=>`Photos missing: ${enList(m[1])}`],
 [/^尚未檢查：(.+)$/,m=>`Not checked yet: ${enList(m[1])}`],
 [/^(.+)異常：請停止取車並聯絡幹部。$/,m=>`Problem with ${enList(m[1]).toLowerCase()}: stop the pickup and contact an officer.`],
 [/^(.+)已上傳；原始照片會保留在借車紀錄中。$/,m=>`${translate(m[1])} uploaded; the original photo is kept in the booking record.`],
 [/^借車前後照片(?: · (.+))?$/,m=>`Before and after photos${m[1]?` · ${m[1]}`:''}`],
 [/^(.+)，(取車前|歸還時)$/,m=>`${translate(m[1])}, ${translate(m[2])}`],
 [/^(.+)預覽$/,m=>`${translate(m[1])} preview`],
 [/^上傳失敗：([\s\S]*)$/,m=>`Upload failed: ${translate(m[1])}`],
 [/^(預約失敗|無法完成|無法取消|照片讀取失敗|取還車碼無法使用|有借車紀錄暫時無法讀取|日曆更新失敗)：([\s\S]*)$/,m=>`${{'預約失敗':'Booking failed','無法完成':'Could not complete','無法取消':'Could not cancel','照片讀取失敗':'Could not load photos','取還車碼無法使用':'Booking code not accepted','有借車紀錄暫時無法讀取':'Some bookings could not be loaded','日曆更新失敗':'Calendar update failed'}[m[1]]}: ${translate(m[2])}`],
];
export function translate(text){if(language!=='en')return text;const key=text.trim();if(Object.hasOwn(english,key))return text.replace(key,english[key]);for(const [regex,render]of patterns){const m=key.match(regex);if(m)return render(m);}return text;}
export function confirmLocalized(text){return window.confirm(translate(text));}
// Preserve the original strings and DOM nodes: switching never resets form values.
const originals=new WeakMap(),attributes=new WeakMap();
function render(){observer.disconnect();document.documentElement.lang=language==='en'?'en':'zh-Hant';document.title=language==='en'?(document.body.classList.contains('admin-page')?'Officer desk | NTUT Cycling Club':'Bike registration | NTUT Cycling Club'):(document.body.classList.contains('admin-page')?'幹部管理｜北科大自由車社':'借車登記｜北科大自由車社');
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
 while(n=walker.nextNode()){if(n.parentElement?.closest('script,style,code,textarea,dd,.record-head h3,[data-no-translate],.user-content,.language-switch'))continue;
 const previous=originals.get(n);const source=previous&&n.data===previous.rendered?previous.source:n.data;const rendered=translate(source);originals.set(n,{source,rendered});if(n.data!==rendered)n.data=rendered;}
 document.querySelectorAll('[placeholder],[aria-label],[title]').forEach(el=>{const stored=attributes.get(el)||{};for(const attr of ['placeholder','aria-label','title']){if(!el.hasAttribute(attr))continue;const current=el.getAttribute(attr),old=stored[attr];const source=old&&current===old.rendered?old.source:current;const rendered=translate(source);stored[attr]={source,rendered};if(current!==rendered)el.setAttribute(attr,rendered);}attributes.set(el,stored);});
 document.querySelectorAll('[data-language]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.language===language)));
 observer.observe(document.body,{subtree:true,childList:true,characterData:true});
}
const observer=new MutationObserver(render);
if(typeof document!=='undefined'){document.querySelectorAll('[data-language]').forEach(button=>button.addEventListener('click',()=>{language=button.dataset.language;try{localStorage.setItem('bike-language',language);}catch{}render();}));render();}
