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
  node:(tag,text)=>({...element(),tag,textContent:text}),date:String,
  FormData:class {constructor(form){this.form=form;}get(key){return this.form.elements[key].value;}},
  api:(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject}))};
 runInNewContext(source,context);officer='test-officer';
 return{get,calls,refresh:context.refresh,openAction:context.openAction,
  submit:id=>get(id).listeners.get('submit')({preventDefault(){},currentTarget:get(id)})};
}
async function ready(p){const task=p.refresh();p.calls[0].resolve(snapshot(0));await task;}

test('A completed officer action reads again after a stale poll before unlocking controls',async()=>{
 const p=page();await ready(p);const poll=p.refresh();
 p.openAction({id:1,name:'Synthetic',studentId:'QA1',bikeNote:''},'lend');
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

test('Saved settings receive a fresh snapshot instead of the in-flight previous totals',async()=>{
 const p=page();await ready(p);const poll=p.refresh();p.get('settings-form').elements.total.value='7';
 const action=p.submit('settings-form');assert.equal(p.calls[2].path,'/api/admin/settings');
 p.calls[2].resolve({});await settle();p.calls[1].resolve(snapshot(0));await poll;await settle();
 assert.equal(p.calls[3]?.path,'/api/admin/records');
 const next=snapshot(0);next.summary.total=7;next.summary.available=7;p.calls[3].resolve(next);await action;
 assert.equal(p.get('total').textContent,7);assert.equal(p.get('settings-form').elements.total.value,7);
});
