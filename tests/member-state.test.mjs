import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const oldToken='a'.repeat(64),newToken='b'.repeat(64),thirdToken='c'.repeat(64);
const summary=waiting=>({total:6,borrowed:0,available:6,waiting,contactUrl:''});
const record=name=>({name,studentId:name,status:'waiting',position:1,standby:0,createdAt:0,updatedAt:0});
function element(){
 const listeners=new Map();
 return {listeners,hidden:false,disabled:false,checked:false,value:'',textContent:'',children:[],
  scrollTop:0,clientHeight:100,scrollHeight:200,classList:{toggle(){}},
  addEventListener(type,fn){listeners.set(type,fn);},append(...items){this.children.push(...items);},
  replaceChildren(...items){this.children=items;},querySelector(){return this.button??=element();},reset(){}};
}
function page(saved=oldToken){
 const elements=new Map(),stored=new Map(saved?[['bike-query-token',saved]]:[]),calls=[],intervals=[];
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 get('personal-result').hidden=true;
 const context={document:{getElementById:get,addEventListener(){},hidden:false,activeElement:null},
  window:{addEventListener(){}},localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
  requestAnimationFrame(){},setInterval:(fn,ms)=>intervals.push({fn,ms}),confirmLocalized:()=>true,
  node:(tag,text)=>({...element(),tag,textContent:text}),date:String,
  api:(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject})),safeContact:()=>null,
  FormData:class {constructor(){return new Map([['studentId','NEW'],['name','new'],['purpose','group_ride'],['contactType','line'],['contact','synthetic']]);}},
  crypto:{getRandomValues:array=>array.fill(1)}};
 runInNewContext(source,context);
 return{get,stored,calls,poll:()=>intervals.find(x=>x.ms===15000).fn(),
  dispatch:(id,type='click')=>get(id).listeners.get(type)({preventDefault(){},currentTarget:get(id)})};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function ready(p){p.calls[0].resolve({record:record('old'),summary:summary(1)});await settle();}
function manual(p,token){p.get('lookup-token').value=token;return p.dispatch('lookup-form','submit');}

test('Manual lookup owns the selected code while polling is due',async()=>{
 const p=page();await ready(p);const task=manual(p,newToken);
 assert.equal(p.calls.at(-1).body.token,newToken);
 p.poll();assert.equal(p.calls.length,2,'background polling must wait for the manual lookup');
 p.calls[1].resolve({record:record('new'),summary:summary(2)});await task;
 assert.equal(p.stored.get('bike-query-token'),newToken);
 assert.equal(p.get('lookup-token').value,newToken);
 assert.equal(p.get('recovery-code').textContent,newToken);
 p.poll();assert.equal(p.calls.at(-1).body.token,newToken);
 p.calls.at(-1).resolve({record:record('new'),summary:summary(2)});await settle();
});

test('A late background lookup cannot replace a manual lookup result',async()=>{
 const p=page(),task=manual(p,newToken);
 p.calls[1].resolve({record:record('new'),summary:summary(2)});await task;
 p.calls[0].resolve({record:record('old'),summary:summary(1)});await settle();
 assert.equal(p.stored.get('bike-query-token'),newToken);
 assert.equal(p.get('waiting').textContent,2);
});

test('Only the newest manual lookup can save a code, and forgetting invalidates it',async()=>{
 const p=page();await ready(p);
 const first=manual(p,newToken),second=manual(p,thirdToken);
 p.calls[2].resolve({record:record('third'),summary:summary(3)});await second;
 p.calls[1].resolve({record:record('new'),summary:summary(2)});await first;
 assert.equal(p.stored.get('bike-query-token'),thirdToken);
 const pending=manual(p,newToken);p.dispatch('forget');
 p.calls[3].resolve({record:record('new'),summary:summary(2)});await pending;
 assert.equal(p.stored.has('bike-query-token'),false);
 assert.equal(p.get('personal-result').hidden,true);
 assert.equal(p.get('lookup-token').value,'');
});

test('An earlier public summary response cannot replace a completed manual lookup',async()=>{
 const p=page(''),task=manual(p,newToken);
 p.calls[1].resolve({record:record('new'),summary:summary(2)});await task;
 p.calls[0].resolve(summary(0));await settle();
 assert.equal(p.get('waiting').textContent,2);
});

test('An earlier failed summary does not mark a successful manual lookup stale',async()=>{
 const p=page(''),task=manual(p,newToken);
 p.calls[1].resolve({record:record('new'),summary:summary(2)});await task;
 p.calls[0].reject(new Error('old network failure'));await settle();
 assert.match(p.get('sync-status').textContent,/更新於/);
});

test('Failed manual lookup releases polling and preserves the previous saved code',async()=>{
 const p=page();await ready(p);const task=manual(p,newToken);
 p.calls[1].reject(Object.assign(new Error('not found'),{status:404}));await task;
 assert.equal(p.stored.get('bike-query-token'),oldToken);
 p.poll();assert.equal(p.calls.at(-1).body.token,oldToken);
 p.calls.at(-1).resolve({record:record('old'),summary:summary(1)});await settle();
});

test('Registration invalidates a public summary that was already in flight',async()=>{
 const p=page('');p.calls[0].resolve(summary(0));await settle();
 p.get('borrow-terms-text').scrollTop=100;p.dispatch('borrow-terms-text','scroll');
 p.get('terms-agree').checked=true;p.dispatch('terms-agree','change');p.poll();
 const task=p.dispatch('register-form','submit');
 assert.equal(p.calls[2].path,'/api/register');
 p.calls[2].resolve({record:record('new'),summary:summary(1)});await task;
 p.calls[1].resolve(summary(0));await settle();
 assert.equal(p.get('waiting').textContent,1);
 assert.equal(p.stored.get('bike-query-token'),'01'.repeat(32));
});
