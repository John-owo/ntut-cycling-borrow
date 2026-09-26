import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportBackup} from '../scripts/export-backup.mjs';

const dump={records:[{name:'Synthetic member'}],audit:[{action:'export'}]};
const state={required:true,factors:[{id:'factor-1',name:'Test'}]};
function client(extra={}) {
 const env={BIKE_ADMIN_EMAIL:'officer@example.test',BIKE_ADMIN_PASSWORD:'synthetic-only',BIKE_SUPABASE_URL:'https://test.supabase.co',BIKE_SUPABASE_KEY:'sb_publishable_test',...extra};
 const steps=[],calls=[],warnings=[],outputDir=mkdtempSync(join(tmpdir(),'bike-backup-test-'));
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});const step=steps.shift();assert.ok(step,'Unexpected request '+url);
  assert.equal(url,'https://test.supabase.co'+step.path);assert.equal(options.method,'POST');
  assert.equal(options.headers.apikey,env.BIKE_SUPABASE_KEY);
  assert.equal(options.headers.Authorization,step.token?'Bearer '+step.token:undefined);
  if(step.body)assert.deepEqual(JSON.parse(options.body),step.body);
  return step.status===204?new Response(null,{status:204}):Response.json(step.data??{},{status:step.status??200});
 };
 return{env,steps,calls,warnings,outputDir,
  run:()=>exportBackup({env,fetchImpl,outputDir,now:()=>new Date('2026-09-26T00:00:00Z'),warn:message=>warnings.push(message)}),
  login:()=>steps.push({path:'/auth/v1/token?grant_type=password',body:{email:env.BIKE_ADMIN_EMAIL,password:env.BIKE_ADMIN_PASSWORD},data:{access_token:'aal1'}}),
  status:(data,token='aal1')=>steps.push({path:'/rest/v1/rpc/admin_session_status',token,data}),
  export:(token='aal1')=>steps.push({path:'/rest/v1/rpc/admin_export',token,data:dump}),
  logout:(token='aal1')=>steps.push({path:'/auth/v1/logout?scope=local',token,status:204}),
  done:()=>assert.equal(steps.length,0)};
}

test('Backup verifies officer access, writes complete JSON, and logs out only its own session',async()=>{
 const c=client();c.login();c.status({required:false});c.export();c.logout();
 const result=await c.run();assert.deepEqual(JSON.parse(readFileSync(result.file,'utf8')),dump);
 assert.equal(result.records,1);assert.equal(result.audit,1);assert.deepEqual(c.warnings,[]);c.done();
});

test('MFA backup challenges the selected factor and uses the verified token for export and cleanup',async()=>{
 const c=client({BIKE_ADMIN_MFA_CODE:'123456',BIKE_ADMIN_MFA_FACTOR_ID:'factor-2'});
 c.login();c.status({...state,factors:[...state.factors,{id:'factor-2'}]});
 c.steps.push({path:'/auth/v1/factors/factor-2/challenge',token:'aal1',data:{id:'challenge-1'}},
  {path:'/auth/v1/factors/factor-2/verify',token:'aal1',body:{challenge_id:'challenge-1',code:'123456'},data:{access_token:'aal2'}});
 c.status({required:false},'aal2');c.export('aal2');c.logout('aal2');
 const result=await c.run();assert.deepEqual(JSON.parse(readFileSync(result.file,'utf8')),dump);
 assert.ok(!c.calls.some(x=>x.options.method==='DELETE'));c.done();
});

test('Missing or malformed MFA code never exports data or writes a backup',async()=>{
 for(const code of [undefined,'bad-code']){
  const c=client({BIKE_ADMIN_MFA_CODE:code});c.login();c.status(state);c.logout();
  await assert.rejects(c.run(),/BIKE_ADMIN_MFA_CODE/);assert.deepEqual(readdirSync(c.outputDir),[]);c.done();
 }
});

test('Rejected MFA and unknown factors close the session without exporting',async()=>{
 const c=client({BIKE_ADMIN_MFA_CODE:'123456'});c.login();c.status(state);
 c.steps.push({path:'/auth/v1/factors/factor-1/challenge',token:'aal1',data:{id:'challenge-1'}},
  {path:'/auth/v1/factors/factor-1/verify',token:'aal1',status:422,data:{message:'Invalid code'}});c.logout();
 await assert.rejects(c.run(),/Invalid code/);assert.deepEqual(readdirSync(c.outputDir),[]);c.done();
 const missing=client({BIKE_ADMIN_MFA_CODE:'123456',BIKE_ADMIN_MFA_FACTOR_ID:'other'});missing.login();missing.status(state);missing.logout();
 await assert.rejects(missing.run(),/找不到可用驗證器/);missing.done();
});

test('Non-officers cannot export and private service keys are rejected before authentication',async()=>{
 const c=client();c.login();c.steps.push({path:'/rest/v1/rpc/admin_session_status',token:'aal1',status:403,data:{message:'Officer permission required'}});c.logout();
 await assert.rejects(c.run(),/Officer permission/);assert.deepEqual(readdirSync(c.outputDir),[]);c.done();
 for(const key of ['sb_secret_private','header.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.signature']){
  const invalid=client({BIKE_SUPABASE_KEY:key});await assert.rejects(invalid.run(),/金鑰|key/);assert.equal(invalid.calls.length,0);
 }
});

test('A filename collision preserves the previous backup and still closes the new session',async()=>{
 const c=client();c.login();c.status({required:false});c.export();c.logout();const first=await c.run();
 const original=readFileSync(first.file,'utf8');c.login();c.status({required:false});c.export();c.logout();
 await assert.rejects(c.run(),{code:'EEXIST'});assert.equal(readFileSync(first.file,'utf8'),original);c.done();
});

test('Failed remote cleanup reports its limit without discarding a completed backup',async()=>{
 const c=client();c.login();c.status({required:false});c.export();
 c.steps.push({path:'/auth/v1/logout?scope=local',token:'aal1',status:503,data:{message:'Unavailable'}});
 const result=await c.run();assert.equal(result.records,1);assert.equal(c.warnings.length,1);
 assert.match(c.warnings[0],/登出未確認/);assert.ok(!c.warnings[0].includes(c.env.BIKE_ADMIN_PASSWORD));c.done();
});
