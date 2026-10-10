import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../public/admin.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const snapshot=borrowed=>({summary:{total:6,borrowed,available:6-borrowed,waiting:0,contactUrl:''},opening:{outstanding:0},records:[],audit:[]});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function element(){
 const listeners=new Map(),fields=new Map();
 return{listeners,hidden:false,disabled:false,value:'',textContent:'',children:[],classList:{toggle(){}},
  elements:new Proxy({},{get:(_,key)=>{if(!fields.has(key))fields.set(key,element());return fields.get(key);}}),
  addEventListener(type,fn){listeners.set(type,fn);},setAttribute(){},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
  querySelector(){return this.button??=element();},reset(){},close(){this.hidden=true;},showModal(){this.hidden=false;}};
}
function page(){
 const elements=new Map(),calls=[];let officer=null;
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 get('mfa-panel').hidden=true;
 const window={addEventListener(){}};window.self=window;window.top=window;
 const context={window,document:{documentElement:{},getElementById:get,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},
  localStorage:{getItem:()=>null},location:{pathname:'/admin.html'},cloud:false,currentAdmin:()=>officer,confirmLocalized:()=>true,
  node:(tag,text)=>({...element(),tag,textContent:text}),date:String,appointmentDetails:()=>element(),
  FormData:class {constructor(form){this.form=form;}get(key){return this.form.elements[key].value;}},
  api:(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}))};
 runInNewContext(source,context);officer='test-officer';
 return{get,calls,refresh:context.refresh,openAction:context.openAction,
  submit:id=>get(id).listeners.get('submit')({preventDefault(){},currentTarget:get(id)})};
}
async function ready(p){const task=p.refresh();p.calls[0].resolve(snapshot(0));await task;}

test('A completed officer action reads again after a stale poll before unlocking controls',async()=>{
 const p=page();await ready(p);const poll=p.refresh();
 p.openAction({id:1,name:'Synthetic',studentId:'QA1',bikeNote:''},'cancel');
 const action=p.submit('action-form');assert.equal(p.calls[2].path,'/api/admin/action');
 p.calls[2].resolve({});await settle();
 assert.equal(p.get('dialog-confirm').disabled,true,'keep the action pending while reconciling');
 p.calls[1].resolve(snapshot(0));await poll;await settle();
 assert.equal(p.calls[3]?.path,'/api/admin/records','issue a new read after the older response');
 p.calls[3].resolve(snapshot(1));await action;
 assert.equal(p.get('borrowed').textContent,1);assert.equal(p.get('dialog-confirm').disabled,false);
});

test('An uncertain officer action still reconciles from a fresh read after the old poll',async()=>{
 const p=page();await ready(p);const poll=p.refresh();p.openAction({id:1,name:'Synthetic',studentId:'QA1',bikeNote:''},'return');
 const action=p.submit('action-form');p.calls[2].reject(new Error('network failed'));await settle();
 p.calls[1].resolve(snapshot(0));await poll;await settle();
 assert.equal(p.calls[3]?.path,'/api/admin/records');p.calls[3].resolve(snapshot(1));await action;
 assert.equal(p.get('borrowed').textContent,1);assert.match(p.get('dialog-message').textContent,/network failed/);
});

test('The closed legacy desk only cancels waiting entries and returns legacy loans',async()=>{
 const p=page();const task=p.refresh();const next=snapshot(1);
 next.records=[{id:1,name:'Waiting',studentId:'QA1',status:'waiting',createdAt:0,updatedAt:0},{id:2,name:'Out',studentId:'QA2',status:'borrowed',createdAt:0,updatedAt:0}];
 p.calls[0].resolve(next);await task;
 const labels=root=>[root.textContent,...(root.children||[]).flatMap(labels)].filter(Boolean);
 const waiting=labels(p.get('records'));assert.ok(waiting.includes('取消登記'));
 for(const closed of ['確認借出','確認聯絡與時間'])assert.ok(!waiting.includes(closed),closed);
 assert.equal(p.calls.some(c=>['/api/admin/settings','/api/admin/borrowed'].includes(c.path)),false);
});
