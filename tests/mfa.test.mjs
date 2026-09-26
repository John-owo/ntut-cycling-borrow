import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/api.js',import.meta.url),'utf8');
let instance=0;
async function client(t){
 const old=Object.fromEntries(['window','sessionStorage','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const stored=new Map([['bike-admin-session','{"token":"legacy-secret"}']]),queue=[],calls=[];
 globalThis.window={BIKE_CONFIG:{mode:'supabase',supabaseUrl:'https://test.supabase.co',supabaseKey:'public-test'}};
 globalThis.sessionStorage={removeItem:k=>stored.delete(k),getItem:k=>stored.get(k),setItem:()=>assert.fail('Credentials must not be persisted')};
 globalThis.fetch=async(url,options)=>{calls.push({url,options});const step=queue.shift();assert.ok(step,'Unexpected request '+url);assert.ok(url.endsWith(step.path),url);if(step.token)assert.equal(options.headers.Authorization,'Bearer '+step.token);if(step.wait)await step.wait;return Response.json(step.data??{}, {status:step.status??200});};
 t.after(()=>{for(const[k,v]of Object.entries(old)){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}});
 const api=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+(++instance)).toString('base64'));
 return{api,stored,calls,expect:s=>queue.push(s),done:()=>assert.equal(queue.length,0)};
}
const auth=(token='aal1')=>({user:{email:'officer@example.test'},access_token:token,refresh_token:'refresh-'+token,expires_in:3600});
const state={enrolled:true,required:true,factors:[{id:'factor-1',name:'Authenticator'}]};
async function login(c){c.expect({path:'grant_type=password',data:auth()});c.expect({path:'/rpc/admin_session_status',data:state});await c.api.login('officer@example.test','password');}
test('Legacy storage is discarded; enrolled login pauses before data RPC and successful MFA rotates tokens',async t=>{
 const c=await client(t);assert.equal(c.stored.size,0);assert.equal(c.api.currentAdmin(),null);await login(c);
 assert.equal(c.api.adminMfaState().required,true);await assert.rejects(c.api.api('/api/admin/records',undefined,true),/MFA_REQUIRED/);
 c.expect({path:'/factor-1/challenge',token:'aal1',data:{id:'challenge-1'}});
 c.expect({path:'/factor-1/verify',token:'aal1',data:auth('aal2')});
 c.expect({path:'/rpc/admin_session_status',token:'aal2',data:{...state,required:false}});
 await c.api.verifyMfa('factor-1','123456');assert.equal(c.api.adminMfaState().required,false);
 assert.deepEqual(JSON.parse(c.calls.find(x=>x.url.endsWith('/verify')).options.body),{challenge_id:'challenge-1',code:'123456'});
 c.expect({path:'/rpc/admin_records',token:'aal2'});await c.api.api('/api/admin/records',undefined,true);c.done();
});
test('Logout during verification cannot restore the session or issue a post-verification RPC',async t=>{
 const c=await client(t);await login(c);let resolve;const wait=new Promise(r=>resolve=r);
 c.expect({path:'/factor-1/challenge',data:{id:'c'}});c.expect({path:'/factor-1/verify',wait,data:auth('late')});
 const pending=assert.rejects(c.api.verifyMfa('factor-1','123456'),e=>e.status===401);
 await new Promise(r=>setImmediate(r));c.expect({path:'/logout'});await c.api.logout();resolve();await pending;assert.equal(c.api.currentAdmin(),null);c.done();
});
test('A non-officer is rejected before MFA and invalid codes never reach Auth',async t=>{
 const c=await client(t);c.expect({path:'grant_type=password',data:auth()});c.expect({path:'/rpc/admin_session_status',status:403,data:{message:'Officer permission required'}});c.expect({path:'/logout'});
 await assert.rejects(c.api.login('outsider@example.test','password'),e=>e.status===403);await assert.rejects(c.api.verifyMfa('f','invalid'),/六位/);assert.equal(c.api.currentAdmin(),null);c.done();
});
test('Setup is explicit, does not enroll on login, and never deletes existing factors',async t=>{
 const c=await client(t);
 c.expect({path:'grant_type=password',data:auth()});c.expect({path:'/rpc/admin_session_status',data:{enrolled:false,required:false,factors:[]}});c.expect({path:'/rpc/admin_records'});
 await c.api.login('officer@example.test','password');assert.ok(!c.calls.some(x=>x.url.includes('/factors')));
 c.expect({path:'/rpc/admin_session_status',data:{enrolled:false,required:false,factors:[]}});
 c.expect({path:'/factors',data:{id:'new-factor',totp:{secret:'TEST-ONLY'}}});
 const factor=await c.api.enrollMfa();assert.equal(factor.id,'new-factor');
 assert.equal(c.stored.size,0);assert.ok(!c.calls.some(x=>x.options.method==='DELETE'));
 c.expect({path:'/rpc/admin_session_status',data:state});await assert.rejects(c.api.enrollMfa(),/已設定/);c.done();
});
test('Fresh backend state can require MFA after a session changes',async t=>{
 const c=await client(t);
 c.expect({path:'grant_type=password',data:auth()});c.expect({path:'/rpc/admin_session_status',data:{enrolled:false,required:false,factors:[]}});c.expect({path:'/rpc/admin_records'});
 await c.api.login('officer@example.test','password');
 c.expect({path:'/rpc/admin_records',status:403,data:{message:'MFA_REQUIRED'}});
 await assert.rejects(c.api.api('/api/admin/records',undefined,true),/MFA_REQUIRED/);
 c.expect({path:'/rpc/admin_session_status',data:state});await c.api.loadMfaState();
 await assert.rejects(c.api.api('/api/admin/export',undefined,true),/MFA_REQUIRED/);c.done();
});

test('Authenticator cap errors explain recovery without deleting uncertain factors',async t=>{
 const c=await client(t),unenrolled={enrolled:false,required:false,factors:[]};
 c.expect({path:'grant_type=password',data:auth()});c.expect({path:'/rpc/admin_session_status',data:unenrolled});c.expect({path:'/rpc/admin_records'});
 await c.api.login('officer@example.test','password');
 c.expect({path:'/rpc/admin_session_status',data:unenrolled});
 c.expect({path:'/factors',status:422,data:{error_code:'too_many_enrolled_mfa_factors',msg:'Factor limit'}});
 await assert.rejects(c.api.enrollMfa(),/清理未完成/);
 assert.ok(!c.calls.some(x=>x.options.method==='DELETE'));c.done();
});
