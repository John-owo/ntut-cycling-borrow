// Officer backup: sign in with an officer account, call admin_export(), write JSON under backups/.
// Usage (PowerShell):
//   $env:BIKE_ADMIN_EMAIL='officer@example.com'; $env:BIKE_ADMIN_PASSWORD='...'; node scripts/export-backup.mjs
// Optional: BIKE_SUPABASE_URL / BIKE_SUPABASE_KEY override the values read from the live config.js.
// The password is read from the environment only and never printed. The file contains personal data: keep it private.
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const liveConfig = 'https://john-owo.github.io/ntut-cycling-borrow/config.js';
const email = process.env.BIKE_ADMIN_EMAIL;
const password = process.env.BIKE_ADMIN_PASSWORD;
if (!email || !password) { console.error('請設定 BIKE_ADMIN_EMAIL 與 BIKE_ADMIN_PASSWORD 環境變數（幹部帳號）。'); process.exit(1); }

let url = process.env.BIKE_SUPABASE_URL, key = process.env.BIKE_SUPABASE_KEY;
if (!url || !key) {
  const source = await (await fetch(liveConfig, {cache: 'no-store'})).text();
  url ||= source.match(/"supabaseUrl":"([^"]+)"/)?.[1];
  key ||= source.match(/"supabaseKey":"([^"]+)"/)?.[1];
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url || '') || !key || key.startsWith('sb_secret_')) { console.error('無法取得公開連線設定，或金鑰不是 publishable key。'); process.exit(1); }

const headers = token => ({'Content-Type': 'application/json', apikey: key, ...(token ? {Authorization: `Bearer ${token}`} : {})});
async function call(path, options) {
  const response = await fetch(url + path, {cache: 'no-store', ...options});
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.message || data.msg || `HTTP ${response.status}`);
  return data;
}

const auth = await call('/auth/v1/token?grant_type=password', {method: 'POST', headers: headers(), body: JSON.stringify({email, password})});
try {
  const dump = await call('/rest/v1/rpc/admin_export', {method: 'POST', headers: headers(auth.access_token), body: '{}'});
  mkdirSync(resolve('backups'), {recursive: true});
  const file = resolve('backups', `borrow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 1));
  console.log(`已匯出 ${dump.records.length} 筆登記、${dump.audit.length} 筆操作紀錄 → ${file}`);
} finally {
  await call('/auth/v1/logout', {method: 'POST', headers: headers(auth.access_token)}).catch(() => {});
}
