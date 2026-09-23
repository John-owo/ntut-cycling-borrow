const cfg = window.BIKE_CONFIG || {};
export const cloud = cfg.mode === 'supabase';
let session, refreshTask = null, authGeneration = 0;
try { session = JSON.parse(sessionStorage.getItem('bike-admin-session') || 'null'); } catch {}
const remember = value => { session = value; try { value ? sessionStorage.setItem('bike-admin-session',JSON.stringify(value)) : sessionStorage.removeItem('bike-admin-session'); } catch {} };
export const currentAdmin = () => session?.username || null;
export const clearAdmin = () => { authGeneration++; refreshTask = null; remember(null); };
const signedOutError = () => Object.assign(new Error('請先登入。'), {status:401});
async function request(url, options = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { cache:'no-store', ...options, signal:controller.signal });
    if(response.status===204) return null;
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error_description || data.message || data.error || '操作失敗，請稍後再試。'); error.status=response.status; throw error; }
    return data;
  } catch(error) { if(error.name==='AbortError') throw new Error('連線逾時，尚未確認是否完成。請保留查詢碼後重試或查詢。'); if(error instanceof TypeError || error instanceof SyntaxError) throw new Error('無法連線到資料服務，請確認網路後重新更新。'); throw error; }
  finally { clearTimeout(timer); }
}
function cloudHeaders(token) { if(!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('資料服務尚未設定，請聯絡幹部。'); return {'Content-Type':'application/json',apikey:cfg.supabaseKey,...(token?{Authorization:`Bearer ${token}`}:{})}; }
async function adminToken() {
  if(!session) throw signedOutError();
  const generation = authGeneration;
  if(cloud && session.expires < Date.now()+30000) {
    // A rotating refresh token must be redeemed once even when polling and an action overlap.
    if(!refreshTask) {
      const refreshToken = session.refreshToken;
      const task = (async()=>{
        try {
          const data=await request(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:cloudHeaders(),body:JSON.stringify({refresh_token:refreshToken})});
          if(generation!==authGeneration) throw signedOutError();
          remember({username:data.user.email,token:data.access_token,refreshToken:data.refresh_token,expires:Date.now()+data.expires_in*1000});
        } catch(e) { if(generation===authGeneration) clearAdmin(); throw e; }
      })();
      refreshTask=task;
      task.finally(()=>{if(refreshTask===task)refreshTask=null;}).catch(()=>{});
    }
    await refreshTask;
  }
  if(generation!==authGeneration||!session) throw signedOutError();
  return session.token;
}
export async function api(path, body, admin=false) {
  if(cloud) {
    const routes={ '/api/admin/borrowed':['admin_set_borrowed',{p_borrowed:body?.borrowed,p_expected_borrowed:body?.expectedBorrowed,p_expected_opening:body?.expectedOpening,p_request_id:body?.requestId,p_reason:body?.reason}], '/api/admin/opening-return':['admin_return_opening',{p_count:body?.count,p_request_id:body?.requestId}], '/api/admin/cancel-many':['admin_cancel_many',{p_ids:body?.ids}], '/api/admin/export':['admin_export',{}], '/api/summary':['summary',{}], '/api/register':['register',{p_student_id:body?.studentId,p_name:body?.name,p_contact_type:body?.contactType,p_contact:body?.contact,p_token:body?.token,p_purpose:body?.purpose}], '/api/me':['lookup',{p_token:body?.token}], '/api/admin/records':['admin_records',{}], '/api/admin/action':['admin_action',{p_id:body?.id,p_action:body?.action,p_bike_note:body?.bikeNote??null}], '/api/admin/settings':['admin_settings',{p_total:body?.total,p_contact_url:body?.contactUrl}] };
    const route=routes[path]; if(!route)throw new Error('不支援的操作。');
    return request(`${cfg.supabaseUrl}/rest/v1/rpc/${route[0]}`,{method:'POST',headers:cloudHeaders(admin?await adminToken():undefined),body:JSON.stringify(route[1])});
  }
  if(location.hostname.endsWith('github.io')&&!cfg.apiBase) throw new Error('共用資料服務尚未連接，目前不能登記。');
  return request((cfg.apiBase||'')+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(admin?{Authorization:`Bearer ${await adminToken()}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
export async function login(username,password) {
  clearAdmin(); const generation=authGeneration;
  const d=cloud ? await request(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`,{method:'POST',headers:cloudHeaders(),body:JSON.stringify({email:username,password})}) : await api('/api/admin/login',{username,password});
  if(generation!==authGeneration) throw signedOutError();
  remember(cloud?{username:d.user.email,token:d.access_token,refreshToken:d.refresh_token,expires:Date.now()+d.expires_in*1000}:d);
  try { await api('/api/admin/records',undefined,true); if(generation!==authGeneration)throw signedOutError(); } catch(e) {
    const ownsSession=generation===authGeneration;
    if(ownsSession)clearAdmin();
    // Supabase logout may revoke other sessions: never run it for a stale login.
    if(ownsSession&&cloud&&d.access_token){try{await request(`${cfg.supabaseUrl}/auth/v1/logout`,{method:'POST',headers:cloudHeaders(d.access_token)});}catch{}}
    if(e.status===403||e.status===401){const denied=new Error('此帳號不在幹部名單，請聯絡系統管理者。');denied.status=403;throw denied;}throw e;}
}
export async function logout() {
  const token=session?.token;
  // Remove local authority immediately; delayed Auth responses cannot resurrect it.
  clearAdmin();
  if(!token)return;
  if(cloud)await request(`${cfg.supabaseUrl}/auth/v1/logout`,{method:'POST',headers:cloudHeaders(token)});
  else await request((cfg.apiBase||'')+'/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:'{}'});
}
export function safeContact(url) { try {const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;} }
export function node(tag,text,cls) { const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el; }
export function date(value) { return value ? new Date(value).toLocaleString('zh-TW',{hour12:false}) : '—'; }
