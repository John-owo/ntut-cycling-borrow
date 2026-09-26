// Officer backup: sign in with an officer account, call admin_export(), write JSON under backups/.
// Usage (PowerShell):
//   $env:BIKE_ADMIN_EMAIL='officer@example.com'; $env:BIKE_ADMIN_PASSWORD='...'; node scripts/export-backup.mjs
// MFA: BIKE_ADMIN_MFA_CODE (six digits), optionally BIKE_ADMIN_MFA_FACTOR_ID for a chosen factor.
// Optional: BIKE_SUPABASE_URL / BIKE_SUPABASE_KEY override the values read from the live config.js.
// The password is read from the environment only and never printed. The file contains personal data: keep it private.
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const liveConfig = 'https://john-owo.github.io/ntut-cycling-borrow/config.js';
export async function exportBackup({env=process.env,fetchImpl=fetch,outputDir=resolve('backups'),now=()=>new Date(),warn=console.warn}={}) {
  const email = env.BIKE_ADMIN_EMAIL;
  const password = env.BIKE_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('請設定 BIKE_ADMIN_EMAIL 與 BIKE_ADMIN_PASSWORD 環境變數（幹部帳號）。');

  let url = env.BIKE_SUPABASE_URL, key = env.BIKE_SUPABASE_KEY;
  if (!url || !key) {
    const response = await fetchImpl(liveConfig, {cache: 'no-store',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('無法取得公開連線設定。');
    const source = await response.text();
    url ||= source.match(/"supabaseUrl":"([^"]+)"/)?.[1];
    key ||= source.match(/"supabaseKey":"([^"]+)"/)?.[1];
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url || '') || !key || key.startsWith('sb_secret_')) throw new Error('無法取得公開連線設定，或金鑰不是 publishable key。');
  if (!key.startsWith('sb_publishable_')) {
    let payload;try {payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url'));}catch{}
    if (payload?.role!=='anon') throw new Error('請使用 publishable／anon key，不可使用私密金鑰。');
  }

  const headers = token => ({'Content-Type': 'application/json', apikey: key, ...(token ? {Authorization: `Bearer ${token}`} : {})});
  async function call(path, options) {
    const response = await fetchImpl(url + path, {cache: 'no-store',signal:AbortSignal.timeout(15000), ...options});
    if (response.status === 204) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.message || data.msg || `HTTP ${response.status}`);
    return data;
  }

  let auth = await call('/auth/v1/token?grant_type=password', {method: 'POST', headers: headers(), body: JSON.stringify({email, password})});
  try {
    const state = await call('/rest/v1/rpc/admin_session_status', {method:'POST',headers:headers(auth.access_token),body:'{}'});
    if (state.required) {
      const code=env.BIKE_ADMIN_MFA_CODE;
      if (!/^[0-9]{6}$/.test(code||'')) throw new Error('此幹部帳號需要雙重驗證。請在自己的終端設定 BIKE_ADMIN_MFA_CODE 為目前六位數驗證碼，再重新執行；請勿將驗證碼交給代理或貼到聊天。');
      const factors=state.factors||[];
      const factor=env.BIKE_ADMIN_MFA_FACTOR_ID?factors.find(f=>f.id===env.BIKE_ADMIN_MFA_FACTOR_ID):factors[0];
      if (!factor) throw new Error('找不到可用驗證器，請確認 BIKE_ADMIN_MFA_FACTOR_ID 或由本人至幹部頁確認設定。');
      const path=`/auth/v1/factors/${encodeURIComponent(factor.id)}`;
      const challenge=await call(path+'/challenge',{method:'POST',headers:headers(auth.access_token),body:'{}'});
      auth=await call(path+'/verify',{method:'POST',headers:headers(auth.access_token),body:JSON.stringify({challenge_id:challenge.id,code})});
      const verified=await call('/rest/v1/rpc/admin_session_status',{method:'POST',headers:headers(auth.access_token),body:'{}'});
      if (verified.required) throw new Error('雙重驗證尚未完成，未匯出備份。');
    }
    const dump = await call('/rest/v1/rpc/admin_export', {method: 'POST', headers: headers(auth.access_token), body: '{}'});
    mkdirSync(outputDir, {recursive: true});
    const file = resolve(outputDir, `borrow-${now().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(dump, null, 1), {flag:'wx',mode:0o600});
    return {file,records:dump.records.length,audit:dump.audit.length};
  } finally {
    // The backup owns only its own session; preserve officers' other signed-in devices.
    await call('/auth/v1/logout?scope=local', {method: 'POST', headers: headers(auth.access_token)}).catch(() => warn('備份流程已結束，但遠端登出未確認；請由本人確認此登入狀態。'));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {const result=await exportBackup();console.log(`已匯出 ${result.records} 筆登記、${result.audit} 筆操作紀錄 → ${result.file}`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
