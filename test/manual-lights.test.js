'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ManualLights = require('../lib/manual-lights');
const LightWrites = require('../lib/light-writes');
const NightIdle = require('../lib/night-idle');
const MINUTE = 60000;
const flush = () => new Promise(resolve => setImmediate(resolve));

class Clock {
  constructor() { this.now = Date.now(); this.timers = new Map(); this.sequence = 0; }
  set(callback, delay) { const id = ++this.sequence; this.timers.set(id, { callback, at: this.now + delay }); return id; }
  async advance(ms) {
    const until = this.now + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); await next[1].callback(); await flush();
    }
    this.now = until; await flush();
  }
}

class Device extends EventEmitter {
  constructor(id, caps, writes) {
    super(); this.id = id; this.name = id; this.available = true; this.writes = writes;
    this.capabilities = Object.keys(caps);
    this.capabilitiesObj = Object.fromEntries(Object.entries(caps).map(([cap, value]) => [cap, { value }]));
  }
  async connect() {}
  async disconnect() {}
  async makeCapabilityInstance(capability, callback) {
    const handler = event => { if (event.capabilityId === capability) callback(event.value); };
    this.on('capability', handler);
    return { destroy: () => this.off('capability', handler) };
  }
  change(capabilityId, value, transactionId) {
    this.capabilitiesObj[capabilityId].value = value;
    this.emit('capability', { capabilityId, value, transactionId });
  }
  async setCapabilityValue(options) {
    const { capabilityId, value, transactionId } = options;
    if (this.failWrites) throw Error('Device offline');
    this.writes.push({ deviceId: this.id, capability: capabilityId, value });
    this.change(capabilityId, value, transactionId);
    // Some drivers report implicit power changes separately, without a command ID.
    if (capabilityId === 'dim' && this.capabilities.includes('onoff')) this.change('onoff', value > 0);
  }
}

async function setup({ night = false, hold = 5, turnOff = true, settings = new Map(), clock = new Clock(), devices } = {}) {
  const writes = [], logs = [], runs = {}, settingsEvents = new EventEmitter();
  devices ||= { sensor: new Device('sensor', { alarm_motion: true }, writes),
    light: new Device('light', { onoff: false, dim: .4 }, writes) };
  for (const device of Object.values(devices)) device.writes = writes;
  if (!settings.has('automations')) {
    const autos = [{ id: 'on', _groupId: 'room', _groupName: 'Room', _templateType: 'motion_lights', enabled: true,
      _manualHoldMinutes: hold, trigger: { type: 'motion_start', deviceId: 'sensor' }, conditions: [], actions: [{ type: 'turn_on', deviceId: 'light' }] }];
    if (turnOff) autos.push({ id: 'off', _groupId: 'room', _groupName: 'Room', _templateType: 'motion_lights', enabled: true,
      trigger: { type: 'motion_stop', deviceId: 'sensor' }, _holdMinutes: hold, conditions: [],
      ...(night ? { _nightIdle: { brightness: .01, offAfterMinutes: 180 } } : {}), actions: [{ type: 'turn_off', deviceId: 'light' }] });
    settings.set('automations', JSON.stringify(autos));
  }
  const homey = { manifest: { version: '1.0.0' }, settings: {
    get: key => settings.get(key), set: (key, value) => { settings.set(key, value); settingsEvents.emit('set', key); },
    on: (...args) => settingsEvents.on(...args),
  }, setTimeout: (callback, delay) => clock.set(callback, delay), clearTimeout: id => clock.timers.delete(id),
  flow: { getActionCard: id => ({ registerArgumentAutocompleteListener() {}, registerRunListener: handler => { runs[id] = handler; } }) } };
  const appFile = path.join(__dirname, '../app.js'), appModule = { exports: {} };
  const context = vm.createContext({ module: appModule, console, require: name => {
    if (name === 'homey') return { App: class {} };
    if (name === 'homey-api') return {};
    if (name === './lib/manual-lights') return class extends ManualLights { constructor(options) { super({ ...options, now: () => clock.now }); } };
    if (name === './lib/night-idle') return class extends NightIdle { constructor(options) { super({ ...options, now: () => clock.now }); } };
    if (name === './lib/light-writes') return class extends LightWrites { constructor() { super(() => clock.now); } };
    return require(path.resolve(path.dirname(appFile), name));
  } });
  vm.runInContext(fs.readFileSync(appFile, 'utf8'), context);
  const app = new appModule.exports();
  app.homey = homey; app.log = () => {}; app.error = () => {};
  app._addLog = (...args) => logs.push(args);
  app._refreshDeviceCache = async () => {};
  app._getSunWindow = async () => ({ isNight: night, nextSunrise: clock.now + 12 * 60 * MINUTE });
  app._getApi = async () => ({ devices: { getDevices: async () => devices } });
  app._scheduleTimeChecks = () => {}; app._scheduleReconnect = () => {};
  await app.onInit();
  return { app, devices, writes, settings, clock, logs, runs, homey,
    motion: async value => { devices.sensor.change('alarm_motion', value); await flush(); },
    dim: async value => { devices.light.change('dim', value); await flush(); },
    power: async value => { devices.light.change('onoff', value); await flush(); } };
}

test('manual dimming survives hours of occupancy, then switches off and restores normal brightness on next motion', async () => {
  const s = await setup(); await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.dim.value, 1);
  assert.equal(s.app._manualLights.isManual('room'), false, 'own commands must not start manual control');
  await s.dim(.3); await s.clock.advance(120 * MINUTE); await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.dim.value, .3);
  assert.equal(s.app._manualLights.isManual('room'), true);
  await s.motion(false); await s.clock.advance(5 * MINUTE - 1);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  await s.clock.advance(1);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
  assert.equal(s.app._manualLights.isManual('room'), false);
  await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.dim.value, 1);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  assert.equal(JSON.parse(s.settings.get('automations')).every(a => a.enabled), true);
});

test('manual OFF stays off through new motion; automatic control resumes only after the empty interval', async () => {
  const s = await setup(); await s.motion(true); await s.power(false);
  await s.motion(false); await s.clock.advance(2 * MINUTE); await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
  await s.clock.advance(60 * MINUTE);
  assert.equal(s.app._manualLights.isManual('room'), true);
  await s.motion(false); await s.clock.advance(5 * MINUTE);
  await s.motion(true); assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
});

test('manual adjustment during an existing countdown preserves elapsed inactivity; motion restarts the full interval', async () => {
  const s = await setup(); await s.motion(true); await s.motion(false);
  await s.clock.advance(2 * MINUTE); await s.dim(.25);
  const deadline = s.app._manualLights.states.room.endsAt;
  await s.clock.advance(MINUTE); await s.dim(.5); await s.motion(false);
  assert.equal(s.app._manualLights.states.room.endsAt, deadline);
  await s.motion(true); await s.clock.advance(10 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  await s.motion(false); await s.clock.advance(5 * MINUTE - 1);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  await s.clock.advance(1); assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
});

test('manual control finishes with full OFF even at night; ordinary night-light behaviour resumes next time', async () => {
  const s = await setup({ night: true }); await s.motion(true); await s.dim(.5);
  await s.motion(false); await s.clock.advance(5 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
  assert.equal(s.writes.some(write => write.capability === 'dim' && write.value === .01), false);
  await s.motion(true); await s.motion(false); await s.clock.advance(5 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.dim.value, .01);
  assert.equal(s.app._manualLights.isManual('room'), false);
});

test('restart preserves manual values and the original empty-room deadline', async () => {
  const s = await setup(); await s.motion(true); await s.dim(.4); await s.motion(false);
  await s.clock.advance(2 * MINUTE); const deadline = s.app._manualLights.states.room.endsAt;
  await s.app.onUninit();
  const restored = await setup({ settings: s.settings, clock: s.clock, devices: s.devices });
  assert.equal(restored.app._manualLights.states.room.endsAt, deadline);
  await restored.clock.advance(3 * MINUTE - 1); assert.equal(restored.devices.light.capabilitiesObj.onoff.value, true);
  await restored.clock.advance(1); assert.equal(restored.devices.light.capabilitiesObj.onoff.value, false);
  assert.equal(restored.app._manualLights.isManual('room'), false);
});

test('manual ON works while ordinary automatic OFF is disabled, using the saved inactivity setting', async () => {
  const s = await setup({ turnOff: false, hold: 7 }); await s.power(true); await s.motion(false);
  await s.clock.advance(7 * MINUTE - 1); assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  await s.clock.advance(1); assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
});

test('legacy button/Flow override now follows inactivity rather than a fixed expiry, including manual OFF', async () => {
  const s = await setup(); await s.runs.override_group({ group: { id: 'room', name: 'Room' } });
  await s.clock.advance(120 * MINUTE);
  assert.equal(s.app._manualLights.isManual('room'), true);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  await s.runs.cancel_override({ group: { id: 'room', name: 'Room' } }); await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
  await s.motion(false); await s.clock.advance(5 * MINUTE);
  assert.equal(s.app._manualLights.isManual('room'), false);
  assert.deepEqual(JSON.parse(s.settings.get('_overrides')), {});
});

test('failed switch-off and unavailable motion sensor retain manual control and retry', async () => {
  const s = await setup(); await s.motion(true); await s.dim(.3); await s.motion(false);
  s.devices.sensor.available = false; await s.clock.advance(5 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  assert.equal(s.app._manualLights.isManual('room'), true);
  s.devices.sensor.available = true; s.devices.light.failWrites = true; await s.clock.advance(6 * MINUTE);
  assert.equal(s.app._manualLights.isManual('room'), true);
  s.devices.light.failWrites = false; await s.clock.advance(MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
  assert.equal(s.app._manualLights.isManual('room'), false);
});

test('disabling or changing room targets cancels pending manual switch-off', async () => {
  for (const change of ['disable', 'targets']) {
    const s = await setup(); await s.motion(true); await s.dim(.3); await s.motion(false);
    const autos = JSON.parse(s.settings.get('automations'));
    for (const auto of autos) { if (change === 'disable') auto.enabled = false; else auto.actions = [{ type: 'turn_on', deviceId: 'other' }]; }
    s.homey.settings.set('automations', JSON.stringify(autos)); await s.app._listenerRefreshPromise;
    await s.clock.advance(5 * MINUTE);
    assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
    assert.equal(s.app._manualLights.isManual('room'), false);
  }
});

test('a room with two sensors cannot finish until both have been inactive for the full interval', async () => {
  const s = await setup();
  s.devices.otherSensor = new Device('otherSensor', { alarm_motion: true }, s.writes);
  const autos = JSON.parse(s.settings.get('automations'));
  autos.push({ ...autos[0], id: 'on2', trigger: { type: 'motion_start', deviceId: 'otherSensor' } });
  s.homey.settings.set('automations', JSON.stringify(autos)); await s.app._listenerRefreshPromise;
  await s.motion(true); await s.dim(.3); await s.motion(false); await s.clock.advance(10 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  s.devices.otherSensor.change('alarm_motion', false); await flush(); await s.clock.advance(5 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
});

test('own reports, implicit power and fade steps do not suppress a later genuine manual change', () => {
  const clock = new Clock(), writes = new LightWrites(() => clock.now);
  const device = new Device('light', { onoff: false, dim: 0 }, []); writes.seed(device);
  const transaction = writes.command(device, 'dim', .8, { duration: 5000 });
  assert.equal(writes.observe('light', 'onoff', true), false);
  assert.equal(writes.observe('light', 'dim', .8, transaction), false);
  assert.equal(writes.observe('light', 'dim', .3), false);
  assert.equal(writes.observe('light', 'dim', .6), false);
  assert.equal(writes.observe('light', 'dim', .2), true, 'a reversed fade is a manual change');
  clock.now += MINUTE;
  assert.equal(writes.observe('light', 'onoff', false), true);
  writes.command(device, 'dim', .01);
  assert.equal(writes.observe('light', 'dim', 0), true, 'manual OFF must be detected on a dim-only light at 1%');
});

test('an old override mapping to the room dimmer never replaces the manually selected brightness', async () => {
  const s = await setup();
  const autos = JSON.parse(s.settings.get('automations'));
  autos[0]._overrideSwitch = { deviceId: 'light', brightness: 1, durationMinutes: 30 };
  s.homey.settings.set('automations', JSON.stringify(autos)); await s.app._listenerRefreshPromise;
  await s.power(true); await s.dim(.25);
  await s.runs.override_group({ group: { id: 'room', name: 'Room' } });
  await s.motion(true);
  assert.equal(s.devices.light.capabilitiesObj.dim.value, .25);
  await s.motion(false); await s.clock.advance(5 * MINUTE);
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, false);
});

test('motion arriving during an awaited timeout lookup prevents stale light OFF and keeps manual control', async () => {
  const s = await setup(); await s.motion(true); await s.dim(.3); await s.motion(false);
  const original = s.app._manualLights.getDevices; let release;
  s.app._manualLights.getDevices = () => new Promise(resolve => { release = resolve; });
  const finishing = s.clock.advance(5 * MINUTE); await flush();
  await s.motion(true); release(s.devices); await finishing;
  s.app._manualLights.getDevices = original;
  assert.equal(s.devices.light.capabilitiesObj.onoff.value, true);
  assert.equal(s.app._manualLights.isManual('room'), true);
});
