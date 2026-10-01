'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function form() {
  const html=fs.readFileSync(path.join(__dirname,'../settings/index.html'),'utf8');
  const fields={};
  const add=(id,value='',checked=false)=>fields[id]={value,checked,style:{},textContent:''};
  add('t-sensor','sensor'); add('t-bright','100'); add('t-turnoff','',true); add('t-hold','5'); add('t-name','Motion room');
  add('t-night-idle','',true); add('t-night-bright','1'); add('t-night-off','',true); add('t-night-hours','3');
  for(const id of ['t-hold-wrap','t-fadeout-wrap','t-night-section','t-night-controls','t-night-off-wrap','t-night-bval'])add(id);
  const context=vm.createContext({navigator:{language:'nb-NO'},console,document:{getElementById:id=>fields[id]||null,addEventListener(){}}});
  context.window=context; vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1],context);
  context.Picker.getSelected=()=>['light']; context.TModal._lightDims={}; context.TModal._prevGlobal={};
  return {fields,context};
}

test('motion saves adjustable night brightness and three-hour delay while retaining daytime OFF',()=>{
  const {context:c}=form(), autos=c.TModal._saveMotion();
  const on=autos.find(a=>a.trigger.type==='motion_start'), off=autos.find(a=>a.trigger.type==='motion_stop');
  assert.deepEqual(JSON.parse(JSON.stringify(off._nightIdle)),{brightness:.01,offAfterMinutes:180});
  assert.equal(off._holdMinutes,5); assert.equal(off.actions[0].type,'turn_off');
  assert.ok(on.actions.some(a=>a.type==='set_dim'&&a.value===1),'motion restores 100% after a 1% idle level');
});

test('saved night settings reopen accurately, and opting out retains the old motion rules',()=>{
  const {context:c,fields}=form(); c.TModal._fillNightIdle({brightness:.07,offAfterMinutes:120});
  assert.equal(Number(fields['t-night-bright'].value),7); assert.equal(Number(fields['t-night-hours'].value),2);
  assert.equal(fields['t-night-off'].checked,true);
  fields['t-night-off'].checked=false; assert.equal(c.TModal._readNightIdle().offAfterMinutes,0);
  fields['t-night-idle'].checked=false;
  assert.equal(c.TModal._saveMotion().some(a=>Object.hasOwn(a,'_nightIdle')),false);
  fields['t-turnoff'].checked=false; assert.equal(c.TModal._saveMotion().length,1);
  assert.equal(c.TModal._saveMotion()[0]._manualHoldMinutes,5,'manual inactivity stays configured without normal automatic OFF');
});

test('invalid percentage and long-delay inputs give Norwegian errors',()=>{
  const {context:c,fields}=form(); fields['t-night-bright'].value='0';
  assert.throws(()=>c.TModal._readNightIdle(),/mellom 1 og 100/);
  fields['t-night-bright'].value='5'; fields['t-night-hours'].value='0';
  assert.throws(()=>c.TModal._readNightIdle(),/mellom 0,25 og 24/);
  fields['t-night-hours'].value='3'; assert.equal(c.TModal._readNightIdle().brightness,.05);
});
