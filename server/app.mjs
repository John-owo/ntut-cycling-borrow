import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const text = (v, max, label) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\x00-\x1f]/.test(v)) fail(400, `${label}格式不正確`); return v.trim(); };
const tokenCheck = token => { if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(400, '查詢碼格式不正確'); return token; };
const exact = (body, keys) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) fail(400, '請求欄位不正確'); };
// The member API is a separate view: officer notes and contact details stay private.
const memberRecord = record => Object.fromEntries(['id','studentId','name','purpose','status','createdAt','updatedAt','position','standby'].map(key=>[key,record[key]]));

export function createApp({ dbPath = resolve('data/bikes.sqlite'), origins = [], hosts = [], publicDir = resolve('public'), rateLimit = 120, loginLimit = 10, registerLimits = { minute: 15, hour: 90, day: 300, client: 10 } } = {}) {
  // Host allowlist defeats DNS rebinding against the loopback server: a page on attacker.example resolving to 127.0.0.1 would otherwise pass the same-origin CORS shortcut.
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...hosts, ...origins.map(o => { try { return new URL(o).host; } catch { return null; } }).filter(Boolean)]);
  const hostAllowed = host => typeof host === 'string' && host.length > 0 && host.length <= 255 && (allowedHosts.has(host) || allowedHosts.has(host.replace(/:\d{1,5}$/, '')));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER, contactUrl TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT, studentId TEXT NOT NULL, name TEXT NOT NULL, contactType TEXT NOT NULL, contact TEXT NOT NULL, purpose TEXT CHECK(purpose IN ('group_ride','personal_ride')), tokenHash TEXT UNIQUE NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','borrowed','returned','cancelled')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, bikeNote TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS active_student ON records(studentId) WHERE status IN ('waiting','borrowed');
    CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY, salt TEXT NOT NULL, passwordHash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES admins(username), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, recordId INTEGER, at TEXT NOT NULL, details TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS opening_loans(id INTEGER PRIMARY KEY CHECK(id=1), outstanding INTEGER NOT NULL DEFAULT 0 CHECK(outstanding>=0), expectedReturn TEXT, note TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO opening_loans(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS opening_returns(requestId TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count>0), receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS borrowed_adjustments(requestId TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(records)').all().some(column=>column.name==='purpose')) db.exec("ALTER TABLE records ADD COLUMN purpose TEXT CHECK(purpose IN ('group_ride','personal_ride'))");
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  const settings = () => db.prepare('SELECT total,contactUrl FROM settings WHERE id=1').get();
  const opening = () => db.prepare('SELECT outstanding,expectedReturn,note FROM opening_loans WHERE id=1').get();
  const summary = () => { const s = settings(); const borrowed = db.prepare("SELECT COUNT(*) n FROM records WHERE status='borrowed'").get().n + opening().outstanding; const waiting = db.prepare("SELECT COUNT(*) n FROM records WHERE status='waiting'").get().n; return {...s, borrowed, available: s.total === null ? null : s.total - borrowed, waiting, updatedAt: new Date().toISOString()}; };
  const decorate = (r,s) => { if(!r) return null; const {tokenHash,...safe} = r; const position = r.status === 'waiting' ? db.prepare("SELECT COUNT(*) n FROM records WHERE status='waiting' AND id<=?").get(r.id).n : null; return {...safe,position,standby: position === null || s.available === null ? null : Math.max(0,position-s.available)}; };
  const audit = (actor,action,id,details={}) => db.prepare('INSERT INTO audit(actor,action,recordId,at,details) VALUES(?,?,?,?,?)').run(actor,action,id,new Date().toISOString(),JSON.stringify(details));
  function addAdmin(username,password) { username=text(username,60,'帳號'); if(typeof password!=='string'||password.length<12||password.length>256) fail(400,'管理密碼需為 12 到 256 字元'); const salt=randomBytes(16).toString('hex'); db.prepare('INSERT INTO admins VALUES(?,?,?)').run(username,salt,passwordHash(password,salt)); }
  const buckets = new Map();
  // Fixed one-minute window per key. Login gets its own, much smaller budget so scrypt guessing stays slow even from one loopback client.
  const limit = (key, max, now) => { let bucket = buckets.get(key); if (!bucket || now - bucket.start > 60000) { bucket = { start: now, n: 0 }; buckets.set(key, bucket); } if (++bucket.n > max) { const e = new Error('操作過於頻繁，請稍後再試'); e.status = 429; e.retryAfter = Math.max(1, Math.ceil((bucket.start + 60000 - now) / 1000)); throw e; } if (buckets.size > 10000) for (const [k, v] of buckets) if (now - v.start > 60000) buckets.delete(k); };
  // Registration throttle mirrors private.check_register_throttle(): site-wide per minute/hour/day plus per client per 10 minutes. Memory only; stores a hash of the address.
  const attempts = [];
  const throttleRegister = client => {
    const now = Date.now(); while (attempts.length && now - attempts[0].at > 86400000) attempts.shift();
    const since = ms => attempts.filter(a => now - a.at < ms);
    if (since(60000).length >= registerLimits.minute) fail(429, '目前登記人數較多，請一分鐘後再試');
    if (since(3600000).length >= registerLimits.hour) fail(429, '目前登記人數較多，請稍後再試');
    if (attempts.length >= registerLimits.day) fail(429, '今日登記次數已達上限，請明天再試或聯絡幹部');
    if (since(600000).filter(a => a.client === client).length >= registerLimits.client) fail(429, '此網路短時間內登記次數過多，請稍後再試');
    attempts.push({ at: now, client });
  };
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self' https://*.supabase.co http://127.0.0.1:* http://localhost:*; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin'); res.setHeader('Cross-Origin-Resource-Policy','same-origin'); res.setHeader('X-Permitted-Cross-Domain-Policies','none');
    const send = (status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      if(!hostAllowed(req.headers.host)) fail(421,'主機名稱不在允許清單');
      const origin=req.headers.origin;
      if(origin) {const own=`http://${req.headers.host}`; if(!origins.includes(origin)&&origin!==own) fail(403,'來源未獲允許');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.writeHead(204);res.end();return;}
      const path = new URL(req.url,'http://localhost').pathname;
      if(!path.startsWith('/api/')) { const files={'/':'index.html','/index.html':'index.html','/admin.html':'admin.html','/club.html':'club.html','/app.js':'app.js','/admin.js':'admin.js','/api.js':'api.js','/i18n.js':'i18n.js','/translations.js':'translations.js','/style.css':'style.css','/brand-tokens.css':'brand-tokens.css','/styles.css':'styles.css','/config.js':'config.js','/favicon.svg':'favicon.svg','/ntut-club-logo.png':'ntut-club-logo.png'}; const file=files[path]; if(req.method!=='GET'||!file) fail(404,'找不到頁面'); let contents; try{contents=readFileSync(resolve(publicDir,file));}catch{fail(404,'找不到頁面');}res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.png')?'image/png':file.endsWith('.jpeg')?'image/jpeg':file.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8'});res.end(contents);return; }
      // Share an address budget across routes: arbitrary unknown paths must not bypass
      // throttling or create an unbounded bucket per attacker-controlled URL.
      const now=Date.now(); limit(`api:${req.socket.remoteAddress}`,rateLimit,now); if(path==='/api/admin/login') limit(`login:${req.socket.remoteAddress}`,loginLimit,now);
      let body={}; if(req.method==='POST'){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'請使用 JSON');const chunks=[];let size=0; for await (const chunk of req){size+=chunk.length;if(size>8192)fail(413,'資料過大');chunks.push(chunk);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'JSON 格式不正確');}}
      let actor;
      if(path.startsWith('/api/admin/')&&path!=='/api/admin/login'){const auth=req.headers.authorization||'';if(!/^Bearer [a-f0-9]{64}$/.test(auth))fail(401,'請先登入');const session=db.prepare('SELECT username FROM sessions WHERE tokenHash=? AND expires>?').get(hash(auth.slice(7)),now);if(!session)fail(401,'登入已失效，請重新登入');actor=session.username;}
      let result;
      if(req.method==='POST'&&path==='/api/admin/borrowed') {
        exact(body,['borrowed','expectedBorrowed','expectedOpening','requestId','reason']);
        if([body.borrowed,body.expectedBorrowed,body.expectedOpening].some(v=>!Number.isSafeInteger(v)||v<0||v>10000)||typeof body.requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId))fail(400,'已借出數量或操作識別碼格式不正確');
        const reason=text(body.reason,500,'調整原因'),requestId=body.requestId.toLowerCase();
        const payload=JSON.stringify({borrowed:body.borrowed,expectedBorrowed:body.expectedBorrowed,expectedOpening:body.expectedOpening,reason});
        result=transaction(()=>{const previous=db.prepare('SELECT payload,receipt FROM borrowed_adjustments WHERE requestId=?').get(requestId);if(previous){if(previous.payload!==payload)fail(409,'操作識別碼已用於不同調整內容');return {receipt:JSON.parse(previous.receipt),opening:opening(),summary:summary()};}const before=summary(),oldOpening=opening().outstanding;const realBorrowed=before.borrowed-oldOpening;if(before.total===null)fail(409,'幹部尚未設定社車總數');if(body.borrowed>before.total)fail(409,'已借出數量不可超過總車數');if(body.borrowed<realBorrowed)fail(409,'已借出數量不可低於社員借用紀錄數量');if(body.expectedBorrowed!==before.borrowed||body.expectedOpening!==oldOpening)fail(409,'數量已變更，請重新載入後再調整');const newOpening=body.borrowed-realBorrowed;db.prepare('UPDATE opening_loans SET outstanding=? WHERE id=1').run(newOpening);const receipt={requestId,actor,at:new Date().toISOString(),reason,oldBorrowed:before.borrowed,newBorrowed:body.borrowed,oldOpening,newOpening,realBorrowed};db.prepare('INSERT INTO borrowed_adjustments VALUES(?,?,?)').run(requestId,payload,JSON.stringify(receipt));audit(actor,'borrowed-adjustment',null,receipt);return {receipt,opening:opening(),summary:summary()};});
        send(200,result);return;
      }
      if(req.method==='POST'&&path==='/api/admin/opening-return') {
        exact(body,['count','requestId']);
        if(!Number.isSafeInteger(body.count)||body.count<1||typeof body.requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId))fail(400,'歸還數量或操作識別碼格式不正確');
        const requestId=body.requestId.toLowerCase();
        result=transaction(()=>{const previous=db.prepare('SELECT count,receipt FROM opening_returns WHERE requestId=?').get(requestId);if(previous){if(previous.count!==body.count)fail(409,'操作識別碼已用於不同歸還數量');return {receipt:JSON.parse(previous.receipt),opening:opening(),summary:summary()};}const before=opening();if(body.count>before.outstanding)fail(409,'歸還數量不可超過期初尚未歸還數量');db.prepare('UPDATE opening_loans SET outstanding=outstanding-? WHERE id=1').run(body.count);const receipt={requestId,count:body.count,actor,at:new Date().toISOString(),remaining:before.outstanding-body.count};db.prepare('INSERT INTO opening_returns VALUES(?,?,?)').run(requestId,body.count,JSON.stringify(receipt));audit(actor,'opening-return',null,receipt);return {receipt,opening:opening(),summary:summary()};});
        send(200,result);return;
      }
      if(req.method==='GET'&&path==='/api/summary') result=transaction(summary);
      else if(req.method==='POST'&&path==='/api/register') {exact(body,['studentId','name','contactType','contact','purpose','token']);const studentId=text(body.studentId,30,'學號').toUpperCase();if(!/^[a-zA-Z0-9-]+$/.test(studentId))fail(400,'學號格式不正確');const name=text(body.name,80,'姓名'),contactType=text(body.contactType,30,'聯絡方式'),contact=text(body.contact,200,'聯絡資訊'),purpose=text(body.purpose,30,'借車目的');if(!['line','instagram'].includes(contactType))fail(400,'聯絡方式格式不正確');if(!['group_ride','personal_ride'].includes(purpose))fail(400,'借車目的格式不正確');const tokenHash=hash(tokenCheck(body.token));result=transaction(()=>{const s=summary();const old=db.prepare('SELECT * FROM records WHERE tokenHash=?').get(tokenHash);if(old){if(old.studentId!==studentId||old.name!==name||old.contactType!==contactType||old.contact!==contact||old.purpose!==purpose)fail(409,'查詢碼已使用');return {record:decorate(old,s),summary:s};}throttleRegister(hash(req.socket.remoteAddress||'unknown'));if(s.total===null)fail(409,'幹部尚未設定社車總數');if(db.prepare("SELECT id FROM records WHERE studentId=? AND status IN ('waiting','borrowed')").get(studentId))fail(409,'此學號已有有效登記或借用；請使用原查詢碼或聯絡幹部');const at=new Date().toISOString();const id=db.prepare("INSERT INTO records(studentId,name,contactType,contact,purpose,tokenHash,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'waiting',?,?)").run(studentId,name,contactType,contact,purpose,tokenHash,at,at).lastInsertRowid;const next=summary();return {record:decorate(db.prepare('SELECT * FROM records WHERE id=?').get(id),next),summary:next};});}
      else if(req.method==='POST'&&path==='/api/me'){exact(body,['token']);result=transaction(()=>{const s=summary();const r=db.prepare('SELECT * FROM records WHERE tokenHash=?').get(hash(tokenCheck(body.token)));if(!r)fail(404,'查無登記，請確認查詢碼');return {record:decorate(r,s),summary:s};});}
      else if(req.method==='POST'&&path==='/api/admin/login'){exact(body,['username','password']);const username=text(body.username,60,'帳號');if(typeof body.password!=='string'||body.password.length>256)fail(400,'密碼格式不正確');const admin=db.prepare('SELECT * FROM admins WHERE username=?').get(username);const calculated=scryptSync(body.password,admin?.salt||'dummy-salt',64);if(!admin||!timingSafeEqual(calculated,Buffer.from(admin.passwordHash,'hex')))fail(401,'帳號或密碼不正確');const token=randomBytes(32).toString('hex');const expires=now+8*60*60*1000;db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),username,expires);result={token,username,expires};}
      else if(req.method==='POST'&&path==='/api/admin/logout'){exact(body,[]);db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(hash(req.headers.authorization.slice(7)));result={ok:true};}
      else if(req.method==='GET'&&path==='/api/admin/records') result=transaction(()=>{const s=summary();return {opening:opening(),summary:s,records:db.prepare('SELECT * FROM records ORDER BY id').all().map(r=>decorate(r,s)),audit:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all()};});
      else if(req.method==='GET'&&path==='/api/admin/export') result=transaction(()=>{audit(actor,'export',null,{});return {exportedAt:new Date().toISOString(),exportedBy:actor,settings:settings(),opening:opening(),records:db.prepare('SELECT * FROM records ORDER BY id').all(),audit:db.prepare('SELECT * FROM audit ORDER BY id').all(),openingReturns:db.prepare('SELECT * FROM opening_returns').all(),borrowedAdjustments:db.prepare('SELECT * FROM borrowed_adjustments').all(),admins:db.prepare('SELECT username FROM admins ORDER BY username').all().map(a=>a.username)};});
      else if(req.method==='POST'&&path==='/api/admin/cancel-many'){exact(body,['ids']);if(!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>500||body.ids.some(id=>!Number.isSafeInteger(id)||id<1))fail(400,'取消清單格式不正確');result=transaction(()=>{const cancelled=[],skipped=[];for(const id of [...new Set(body.ids)].sort((a,b)=>a-b)){const changed=db.prepare("UPDATE records SET status='cancelled',updatedAt=? WHERE id=? AND status='waiting'").run(new Date().toISOString(),id).changes;if(changed){cancelled.push(id);audit(actor,'cancel',id,{bulk:true});}else skipped.push(id);}return {cancelled,skipped,summary:summary()};});}
      else if(req.method==='POST'&&path==='/api/admin/settings'){exact(body,['total','contactUrl']);if(!Number.isSafeInteger(body.total)||body.total<0||body.total>10000)fail(400,'總車數格式不正確');if(typeof body.contactUrl!=='string'||body.contactUrl.length>500)fail(400,'聯絡連結格式不正確');if(body.contactUrl){let u;try{u=new URL(body.contactUrl);}catch{fail(400,'聯絡連結格式不正確');}if(u.protocol!=='https:'||u.username||u.password)fail(400,'聯絡連結需為 HTTPS');}result=transaction(()=>{if(body.total<summary().borrowed)fail(409,'總車數不可低於已借出數量');db.prepare('UPDATE settings SET total=?,contactUrl=? WHERE id=1').run(body.total,body.contactUrl);audit(actor,'settings',null,body);return {summary:summary()};});}
      else if(req.method==='POST'&&path==='/api/admin/action'){exact(body,['id','action','bikeNote']);if(!Number.isSafeInteger(body.id)||body.id<1||!['lend','return','cancel'].includes(body.action))fail(400,'操作格式不正確');if(body.bikeNote!==undefined&&(typeof body.bikeNote!=='string'||body.bikeNote.length>500))fail(400,'車號／備註過長');result=transaction(()=>{const r=db.prepare('SELECT * FROM records WHERE id=?').get(body.id);if(!r)fail(404,'查無紀錄');const target={lend:'borrowed',return:'returned',cancel:'cancelled'}[body.action];if(r.status===target)return {record:decorate(r,summary()),summary:summary()};if((body.action==='lend'&&r.status!=='waiting')||(body.action==='return'&&r.status!=='borrowed')||(body.action==='cancel'&&r.status!=='waiting'))fail(409,'目前狀態不允許此操作');if(body.action==='lend'&&(summary().available??0)<1)fail(409,'目前沒有尚未借出的車輛');db.prepare('UPDATE records SET status=?,updatedAt=?,bikeNote=? WHERE id=?').run(target,new Date().toISOString(),body.bikeNote??r.bikeNote,r.id);audit(actor,body.action,r.id,{bikeNote:body.bikeNote??r.bikeNote});const s=summary();return {record:decorate(db.prepare('SELECT * FROM records WHERE id=?').get(r.id),s),summary:s};});}
      else fail(404,'找不到 API');
      if((path==='/api/register'||path==='/api/me')&&result?.record) result={...result,record:memberRecord(result.record)};
      send(200,result);
    }catch(e){if(e.status===429)res.setHeader('Retry-After',String(e.retryAfter||60));send(e.status||500,{error:e.status?e.message:'伺服器操作失敗，請稍後再試'});}
  });
  return {server,db,addAdmin,close:async()=>{if(server.listening)await new Promise(r=>server.close(r));db.close();}};
}
