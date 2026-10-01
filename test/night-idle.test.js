'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NightIdle = require('../lib/night-idle');
const sunWindow = require('../lib/sun-window');
const MINUTE = 60000;

class Clock {
  constructor() { this.now = Date.UTC(2026, 8, 30, 20); this.timers = new Map(); this.sequence = 0; }
  set(callback, delay) { const id = ++this.sequence; this.timers.set(id, { callback, at: this.now + delay }); return id; }
  async advance(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([,timer]) => timer.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); await next[1].callback();
    }
    this.now = target;
  }
}

function setup({ hold = 5, delay = 180, brightness = .01 } = {}) {
  const clock = new Clock(), settings = new Map(), calls = [], logs = [], overrides = {};
  const devices = {
    sensor: { capabilitiesObj: { alarm_motion: { value: false } } },
    light: { capabilities: ['onoff','dim'], capabilitiesObj: { onoff: { value: true }, dim: { value: 1 } } },
  };
  const automation = { id: 'off', _groupId:'room', _groupName:'Room', name:'Room OFF', enabled:true,
    trigger: { type:'motion_stop', deviceId:'sensor' }, _holdMinutes:hold,
    _nightIdle: { brightness, offAfterMinutes:delay }, actions:[{ type:'turn_off', deviceId:'light' }] };
  let automations = [automation];
  const sun = { isNight:true, nextSunrise:clock.now + 12 * 60 * MINUTE };
  const homey = { settings: { get:key=>settings.get(key), set:(key,value)=>settings.set(key,value) },
    setTimeout:(callback,delay)=>clock.set(callback,delay), clearTimeout:id=>clock.timers.delete(id) };
  const options = { homey, now:()=>clock.now, getAutomations:()=>automations, isManual:gid=>!!overrides[gid],
    getDevices:async()=>devices, getSunWindow:async()=>sun, setHold() {}, clearHold() {}, log:(...args)=>logs.push(args),
    runActions:async(actions,name,guard)=>{
      if (!guard()) return [];
      for (const action of actions) {
        calls.push(action);
        const state = devices[action.deviceId].capabilitiesObj;
        if (action.type === 'set_dim') state.dim.value = action.value;
        if (action.type === 'turn_off') state.onoff.value = false;
      }
      return actions.map(()=>({ok:true}));
    } };
  const controller = new NightIdle(options);
  return {clock,settings,calls,devices,automation,sun,homey,options,controller,logs,overrides,
    setAutomations:value=>{automations=value;} };
}

test('night: normal hold, adjustable dim level, then switch off after three hours', async () => {
  const s=setup({brightness:.04}); await s.controller.start(s.automation);
  await s.clock.advance(5*MINUTE-1); assert.equal(s.calls.length,0);
  await s.clock.advance(1); assert.deepEqual(s.calls,[{type:'set_dim',deviceId:'light',value:.04}]);
  await s.clock.advance(180*MINUTE-1); assert.equal(s.devices.light.capabilitiesObj.onoff.value,true);
  await s.clock.advance(1); assert.equal(s.devices.light.capabilitiesObj.onoff.value,false);
  assert.equal(s.controller.states.room.phase,'off'); assert.equal(s.clock.timers.size,0);
});

test('day: existing OFF actions run after the hold without dimming', async () => {
  const s=setup(); s.sun.isNight=false; await s.controller.start(s.automation); await s.clock.advance(5*MINUTE);
  assert.deepEqual(s.calls,[{type:'turn_off',deviceId:'light'}]); assert.equal(s.clock.timers.size,0);
});

test('optional delay disabled: dim until sunrise, including sunrise before a chosen delay', async () => {
  for (const delay of [0,180]) {
    const s=setup({hold:0,delay}); s.sun.nextSunrise=s.clock.now+30*MINUTE;
    await s.controller.start(s.automation); await s.clock.advance(29*MINUTE);
    assert.equal(s.calls.length,1); s.sun.isNight=false;
    await s.clock.advance(MINUTE); assert.equal(s.devices.light.capabilitiesObj.onoff.value,false);
  }
});

test('new motion cancels hold and late switch-off; next inactivity starts a fresh interval', async () => {
  const s=setup(); await s.controller.start(s.automation); s.controller.motionStarted('sensor');
  await s.clock.advance(10*MINUTE); assert.equal(s.calls.length,0);
  await s.controller.start(s.automation); await s.clock.advance(5*MINUTE);
  s.controller.motionStarted('sensor'); await s.clock.advance(180*MINUTE);
  assert.equal(s.calls.filter(a=>a.type==='turn_off').length,0);
  await s.controller.start(s.automation); await s.clock.advance(185*MINUTE);
  assert.equal(s.calls.filter(a=>a.type==='turn_off').length,1);
});

test('restart preserves both hold deadline and remaining long interval; completed lights stay off', async () => {
  const s=setup(); await s.controller.start(s.automation); await s.clock.advance(2*MINUTE); s.controller.stop();
  const restored=new NightIdle(s.options); await restored.restore(s.devices); await s.clock.advance(3*MINUTE);
  assert.equal(s.calls.length,1); await s.clock.advance(120*MINUTE); restored.stop();
  const restoredAgain=new NightIdle(s.options); await restoredAgain.restore(s.devices); await s.clock.advance(60*MINUTE);
  assert.equal(s.calls.filter(a=>a.type==='turn_off').length,1);
  const afterOff=new NightIdle(s.options); await afterOff.restore(s.devices); await s.clock.advance(60*MINUTE);
  assert.equal(s.calls.length,2); assert.equal(s.clock.timers.size,0);
});

test('duplicate inactive events and safety runs do not extend the night-light deadline', async () => {
  const s=setup({hold:0}); await s.controller.start(s.automation); await s.clock.advance(30*MINUTE);
  const deadline=s.controller.states.room.offAt;
  await s.controller.start(s.automation); await s.controller.start(s.automation,true);
  assert.equal(s.controller.states.room.offAt,deadline); await s.clock.advance(150*MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value,false);
});

test('override, disabling and changing the room targets cancel the old pending interval', async () => {
  for (const change of ['override','disable','targets']) {
    const s=setup({hold:0}); await s.controller.start(s.automation); await s.clock.advance(0);
    if (change==='override') { s.overrides.room=s.clock.now+60*MINUTE; s.controller.cancelGroup('room'); }
    if (change==='disable') s.automation.enabled=false;
    if (change==='targets') s.automation.actions=[{type:'turn_off',deviceId:'different'}];
    s.controller.prune(); await s.clock.advance(180*MINUTE);
    assert.equal(s.calls.filter(a=>a.type==='turn_off').length,0);
  }
});

test('new movement or listener refresh during an awaited sun lookup blocks stale dim/off actions', async () => {
  for (const change of ['motion','refresh']) {
    const s=setup({hold:0}); let resolveSun;
    s.controller.getSunWindow=()=>new Promise(resolve=>{resolveSun=resolve;});
    await s.controller.start(s.automation); const pending=s.clock.advance(0);
    await new Promise(resolve=>setImmediate(resolve));
    if (change==='motion') s.controller.motionStarted('sensor'); else s.controller.stop();
    resolveSun(s.sun); await pending;
    assert.equal(s.calls.length,0); assert.equal(s.clock.timers.size,0);
  }
});

test('restart with an inactive sensor does not turn on lights that were already off', async () => {
  const s=setup(); s.devices.light.capabilitiesObj.onoff.value=false;
  await s.controller.restore(s.devices); await s.clock.advance(180*MINUTE);
  assert.equal(s.calls.length,0); assert.equal(s.clock.timers.size,0);
});

test('temporary solar or device errors retry instead of completing the interval', async () => {
  const s=setup({hold:0}); let failed=true;
  s.controller.getSunWindow=async()=>{if(failed)throw Error('offline');return s.sun;};
  await s.controller.start(s.automation); await s.clock.advance(0);
  assert.equal(s.controller.states.room.phase,'holding'); failed=false; await s.clock.advance(MINUTE);
  assert.equal(s.controller.states.room.phase,'idle');
  const normal=s.controller.runActions; s.controller.runActions=async()=>[{ok:false}];
  await s.clock.advance(180*MINUTE); assert.equal(s.controller.states.room.phase,'idle');
  s.controller.runActions=normal; await s.clock.advance(MINUTE); assert.equal(s.controller.states.room.phase,'off');
});

test('sunset detection covers midnight, DST dates, western longitudes and polar day/night', () => {
  const oslo={latitude:59.9,longitude:10.75};
  for (const date of ['2026-09-30T22:00:00Z','2026-10-01T00:30:00Z','2026-03-29T00:30:00Z']) {
    const now=Date.parse(date), sun=sunWindow(now,oslo); assert.equal(sun.isNight,true); assert.ok(sun.nextSunrise>now);
  }
  assert.equal(sunWindow(Date.parse('2026-09-30T12:00:00Z'),oslo).isNight,false);
  assert.equal(sunWindow(Date.parse('2026-10-01T03:00:00Z'),{latitude:40.7,longitude:-74}).isNight,true);
  const tromso={latitude:69.65,longitude:18.95};
  assert.equal(sunWindow(Date.parse('2026-06-21T12:00:00Z'),tromso).isNight,false);
  assert.equal(sunWindow(Date.parse('2026-12-21T12:00:00Z'),tromso).isNight,true);
  assert.throws(()=>sunWindow(Date.now(),null),/location is unavailable/);
});

test('runtime action guard prevents a delayed fade-off from cutting power after new motion', async () => {
  const appFile=path.join(__dirname,'../app.js'), appModule={exports:{}};
  const context=vm.createContext({module:appModule,console,require:name=>name==='homey'?{App:class{}}:
    name==='homey-api'?{}:require(path.resolve(path.dirname(appFile),name))});
  vm.runInContext(fs.readFileSync(appFile,'utf8'),context);
  const app=new appModule.exports(), clock=new Clock(), writes=[];
  app.homey={setTimeout:(callback,delay)=>clock.set(callback,delay)};
  let current=true;
  const device={setCapabilityValue:async(...args)=>writes.push(args)};
  const pending=app._runAction({type:'fade_off',deviceId:'light',duration:5},{light:device},new Set(),()=>current);
  await new Promise(resolve=>setImmediate(resolve)); current=false; await clock.advance(5200); await pending;
  assert.equal(writes.some(([capability])=>capability==='onoff'),false);
});
