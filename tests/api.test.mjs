import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/api.js',import.meta.url),'utf8');
const origin='https://test-only.supabase.co';
const key='sb_publishable_test_only';
let instance=0;
async function client(t,initial=null) {
 const previous=Object.fromEntries(['window','sessionStorage','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const storage=new Map(initial?[['bike-admin-session',JSON.stringify(initial)]]:[]);
 const queue=[];
 globalThis.window={BIKE_CONFIG:{mode:'supabase',supabaseUrl:origin,supabaseKey:key}};
 globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.fetch=async(url,options)=>{
  const expected=queue.shift();assert.ok(expected,`Unexpected request: ${url}`);
  assert.equal(url,origin+expected.path);assert.equal(options.method,'POST');
  assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.apikey,key);
  assert.equal(options.headers.Authorization,expected.token?`Bearer ${expected.token}`:undefined);
  assert.deepEqual(options.body===undefined?undefined:JSON.parse(options.body),expected.body);
  if(expected.wait) await expected.wait;
  return expected.status===204?new Response(null,{status:204}):Response.json(expected.result??{}, {status:expected.status??200});
 };
 t.after(()=>{for(const [k,descriptor]of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}});
 const api=await import('data:text/javascript;base64,'+Buffer.from(source+`\n// test instance ${++instance}`).toString('base64'));
 return {api,storage,expect:request=>queue.push(request),done:()=>assert.equal(queue.length,0,'All expected requests must run')};
}
const authResult=(token='test-user-jwt',refresh='test-refresh')=>({user:{email:'president@example.test'},access_token:token,refresh_token:refresh,expires_in:3600});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('Concurrent officer requests share one rotating refresh token redemption',async t=>{
 const c=await client(t,{username:'president@example.test',token:'expired',refreshToken:'rotate-once',expires:0});
 const gate=deferred();
 c.expect({path:'/auth/v1/token?grant_type=refresh_token',body:{refresh_token:'rotate-once'},wait:gate.promise,result:authResult('rotated')});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'rotated',result:{records:[]}});
 c.expect({path:'/rest/v1/rpc/admin_export',body:{},token:'rotated',result:{records:[]}});
 const first=c.api.api('/api/admin/records',undefined,true),second=c.api.api('/api/admin/export',undefined,true);
 gate.resolve();await Promise.all([first,second]);c.done();
});

test('Logout clears immediately and a delayed refresh cannot restore credentials or send an RPC',async t=>{
 const c=await client(t,{username:'president@example.test',token:'expired',refreshToken:'old',expires:0});
 const refresh=deferred(),logout=deferred();
 c.expect({path:'/auth/v1/token?grant_type=refresh_token',body:{refresh_token:'old'},wait:refresh.promise,result:authResult('late')});
 const pending=assert.rejects(c.api.api('/api/admin/records',undefined,true),e=>e.status===401);
 c.expect({path:'/auth/v1/logout',token:'expired',wait:logout.promise,status:204});
 const signingOut=c.api.logout();assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.size,0);
 refresh.resolve();await pending;assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.size,0);
 logout.resolve();await signingOut;c.done();
});

test('An old rejected refresh cannot erase a newer officer login',async t=>{
 const c=await client(t,{username:'old@example.test',token:'expired',refreshToken:'old',expires:0});const gate=deferred();
 c.expect({path:'/auth/v1/token?grant_type=refresh_token',body:{refresh_token:'old'},wait:gate.promise,status:401});
 const old=assert.rejects(c.api.api('/api/admin/records',undefined,true));
 c.expect({path:'/auth/v1/token?grant_type=password',body:{email:'president@example.test',password:'test-only-password'},result:authResult('new-login')});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'new-login'});
 await c.api.login('president@example.test','test-only-password');gate.resolve();await old;
 assert.equal(c.api.currentAdmin(),'president@example.test');assert.equal(JSON.parse(c.storage.get('bike-admin-session')).token,'new-login');c.done();
});

test('A stale failed officer check cannot revoke or clear a newer login',async t=>{
 const c=await client(t),gate=deferred();
 c.expect({path:'/auth/v1/token?grant_type=password',body:{email:'president@example.test',password:'test-only-password'},result:authResult('old-login')});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'old-login',wait:gate.promise,status:403});
 const old=assert.rejects(c.api.login('president@example.test','test-only-password'));
 await new Promise(resolve=>setImmediate(resolve));
 c.expect({path:'/auth/v1/token?grant_type=password',body:{email:'president@example.test',password:'test-only-password'},result:authResult('new-login')});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'new-login'});
 await c.api.login('president@example.test','test-only-password');gate.resolve();await old;
 assert.equal(JSON.parse(c.storage.get('bike-admin-session')).token,'new-login');c.done();
});

test('Publishable anonymous requests use only apikey and preserve private lookup/register RPC arguments',async t=>{
 const c=await client(t);const token='a'.repeat(64);
 c.expect({path:'/rest/v1/rpc/summary',body:{},result:{total:2,waiting:0}});
 assert.deepEqual(await c.api.api('/api/summary'),{total:2,waiting:0});
 c.expect({path:'/rest/v1/rpc/register',body:{p_student_id:'S1',p_name:'Test member',p_contact_type:'line',p_contact:'test-only',p_token:token,p_purpose:'group_ride'},result:{record:{status:'waiting',position:1,purpose:'group_ride'}}});
 assert.equal((await c.api.api('/api/register',{studentId:'S1',name:'Test member',contactType:'line',contact:'test-only',purpose:'group_ride',token})).record.purpose,'group_ride');
 c.expect({path:'/rest/v1/rpc/lookup',body:{p_token:token},result:{record:{status:'waiting',position:2}}});
 assert.equal((await c.api.api('/api/me',{token})).record.position,2);
 assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.size,0);c.done();
});

test('Login verifies officer access, administrator RPCs use user JWT, and 204 logout clears credentials',async t=>{
 const c=await client(t);
 c.expect({path:'/auth/v1/token?grant_type=password',body:{email:'president@example.test',password:'test-only-password'},result:authResult()});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'test-user-jwt'});
 await c.api.login('president@example.test','test-only-password');assert.equal(c.api.currentAdmin(),'president@example.test');
 assert.equal(JSON.parse(c.storage.get('bike-admin-session')).token,'test-user-jwt');
 c.expect({path:'/rest/v1/rpc/admin_action',body:{p_id:7,p_action:'lend',p_bike_note:'Test bike'},token:'test-user-jwt',result:{record:{status:'borrowed'}}});
 assert.equal((await c.api.api('/api/admin/action',{id:7,action:'lend',bikeNote:'Test bike'},true)).record.status,'borrowed');
 c.expect({path:'/rest/v1/rpc/admin_action',body:{p_id:7,p_action:'return',p_bike_note:null},token:'test-user-jwt'});
 await c.api.api('/api/admin/action',{id:7,action:'return'},true);
 c.expect({path:'/rest/v1/rpc/admin_settings',body:{p_total:3,p_contact_url:'https://example.test/contact'},token:'test-user-jwt'});
 await c.api.api('/api/admin/settings',{total:3,contactUrl:'https://example.test/contact'},true);
 // An officer session must never turn public calls into private/authenticated calls.
 c.expect({path:'/rest/v1/rpc/summary',body:{}});await c.api.api('/api/summary');
 c.expect({path:'/auth/v1/logout',token:'test-user-jwt',status:204});await c.api.logout();
 assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.has('bike-admin-session'),false);
 await assert.rejects(c.api.api('/api/admin/records',undefined,true),e=>e.status===401);c.done();
});

test('Expired officer session refreshes with apikey and uses rotated user JWT on the following RPC',async t=>{
 const c=await client(t,{username:'president@example.test',token:'expired-jwt',refreshToken:'old-refresh',expires:0});
 c.expect({path:'/auth/v1/token?grant_type=refresh_token',body:{refresh_token:'old-refresh'},result:authResult('rotated-jwt','rotated-refresh')});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'rotated-jwt',result:{records:[]}});
 assert.deepEqual(await c.api.api('/api/admin/records',undefined,true),{records:[]});
 const saved=JSON.parse(c.storage.get('bike-admin-session'));assert.equal(saved.refreshToken,'rotated-refresh');assert.ok(saved.expires>Date.now());c.done();
});

test('Valid Auth login without officer permission removes the newly obtained session',async t=>{
 const c=await client(t);
 c.expect({path:'/auth/v1/token?grant_type=password',body:{email:'outsider@example.test',password:'test-only-password'},result:{...authResult(),user:{email:'outsider@example.test'}}});
 c.expect({path:'/rest/v1/rpc/admin_records',body:{},token:'test-user-jwt',status:403,result:{message:'Officer permission required'}});
 c.expect({path:'/auth/v1/logout',token:'test-user-jwt',status:204}); // the non-officer Auth session is revoked, not just forgotten
 await assert.rejects(c.api.login('outsider@example.test','test-only-password'),e=>e.status===403&&e.message==='此帳號不在幹部名單，請聯絡系統管理者。');
 assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.has('bike-admin-session'),false);
 await assert.rejects(c.api.api('/api/admin/settings',{total:2,contactUrl:''},true),e=>e.status===401);c.done();
});

test('Rejected refresh token clears the old session and sends no administrator RPC',async t=>{
 const c=await client(t,{username:'president@example.test',token:'expired-jwt',refreshToken:'revoked-refresh',expires:0});
 c.expect({path:'/auth/v1/token?grant_type=refresh_token',body:{refresh_token:'revoked-refresh'},status:401,result:{error_description:'Refresh token revoked'}});
 await assert.rejects(c.api.api('/api/admin/records',undefined,true),e=>e.status===401&&e.message==='Refresh token revoked');
 assert.equal(c.api.currentAdmin(),null);assert.equal(c.storage.size,0);c.done();
});

test('Officer bulk cancel and export map to the 003 RPCs with the user JWT',async t=>{
 const c=await client(t,{username:'president@example.test',token:'officer-jwt',refreshToken:'r',expires:Date.now()+3600000});
 c.expect({path:'/rest/v1/rpc/admin_cancel_many',body:{p_ids:[4,9]},token:'officer-jwt',result:{cancelled:[4,9],skipped:[]}});
 assert.deepEqual((await c.api.api('/api/admin/cancel-many',{ids:[4,9]},true)).cancelled,[4,9]);
 c.expect({path:'/rest/v1/rpc/admin_export',body:{},token:'officer-jwt',result:{records:[]}});
 assert.deepEqual(await c.api.api('/api/admin/export',undefined,true),{records:[]});c.done();
});


test('Borrowed adjustments preserve concurrency snapshot, reason and retry identity in officer RPC',async t=>{
 const c=await client(t,{username:'president@example.test',token:'officer-jwt',refreshToken:'r',expires:Date.now()+3600000});
 const operation={borrowed:4,expectedBorrowed:3,expectedOpening:2,requestId:'00000000-0000-4000-8000-000000000100',reason:'Paper count correction'};
 for(let i=0;i<2;i++){
  c.expect({path:'/rest/v1/rpc/admin_set_borrowed',body:{p_borrowed:4,p_expected_borrowed:3,p_expected_opening:2,p_request_id:operation.requestId,p_reason:operation.reason},token:'officer-jwt',result:{summary:{borrowed:4}}});
  assert.equal((await c.api.api('/api/admin/borrowed',operation,true)).summary.borrowed,4);
 }
 c.done();
});
