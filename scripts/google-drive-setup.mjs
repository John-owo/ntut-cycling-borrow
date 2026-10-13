// One-time Google Drive connection for borrowing photos. Run it yourself in your own terminal:
//   node scripts/google-drive-setup.mjs
// It signs in to the Google account whose Drive will hold the photos (drive.file scope: only files this app
// creates), creates the photo folder and writes the Edge Function secrets to a new git-ignored env file.
// Secret values are never printed. Upload them with `supabase secrets set --env-file <file>`, then delete the file.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

const scope = 'https://www.googleapis.com/auth/drive.file';
const folderName = process.env.GOOGLE_DRIVE_FOLDER_NAME || '北科大自由車社 借還車照片';
const requested = process.argv[2] || 'supabase/.env.drive';
let output = requested;
for (let i = 2; existsSync(output); i++) output = `${requested}.${i}`;
if (!/(^|[\\/])\.env\.[^\\/]+$/.test(output)) throw new Error('Output must be a .env.* file so Git ignores it.');

const ask = async question => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question(question)).trim(); } finally { rl.close(); } };
const clientId = process.env.GOOGLE_CLIENT_ID || await ask('Google OAuth client ID (Desktop app): ');
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || await ask('Google OAuth client secret: ');
if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) throw new Error('A Desktop-app OAuth client ID and secret are required.');

let redirect = '';
const verifier = randomBytes(48).toString('base64url'), state = randomBytes(16).toString('hex');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(ok ? '已完成 Google 授權，可以關閉此分頁回到終端機。' : '授權失敗，請回到終端機重新執行。');
    server.close();
    ok ? resolve(url.searchParams.get('code')) : reject(new Error(url.searchParams.get('error') || 'Authorization was not completed.'));
  });
  server.listen(0, '127.0.0.1', () => {
    redirect = `http://127.0.0.1:${server.address().port}`;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) auth.searchParams.set(k, v);
    console.log(`\n請用要存放照片的 Google 帳號在瀏覽器完成授權：\n${auth}\n`);
    try { spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [auth.toString()], { stdio: 'ignore', detached: true }).unref(); } catch {}
  });
  setTimeout(() => { server.close(); reject(new Error('Timed out waiting for Google authorization.')); }, 10 * 60000).unref();
});

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) });
const tokens = await tokenResponse.json();
if (!tokenResponse.ok || !tokens.refresh_token) throw new Error(`Google did not return a refresh token (${tokens.error || tokenResponse.status}).`);
if (!String(tokens.scope || '').split(' ').includes(scope)) throw new Error('The Drive permission was not granted.');

const folderResponse = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }) });
const folder = await folderResponse.json();
if (!folderResponse.ok || !folder.id) throw new Error(`Could not create the Drive folder (${folderResponse.status}).`);

writeFileSync(output, `GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\nGOOGLE_DRIVE_FOLDER_ID=${folder.id}\n`, { flag: 'wx', mode: 0o600 });
console.log(`已建立雲端資料夾「${folderName}」：${folder.webViewLink || folder.id}`);
console.log(`已寫入 ${output}（Git 忽略；內容是密鑰，不要分享）。下一步：`);
console.log(`  npx supabase secrets set --env-file ${output} --project-ref <project-ref>`);
console.log('  npx supabase functions deploy lifecycle-photo --no-verify-jwt --project-ref <project-ref>');
console.log(`完成後刪除 ${output}。`);
