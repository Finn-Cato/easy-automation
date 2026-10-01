'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
function load(automations, devices = [], manualLights = {}) {
  const context = vm.createContext({ navigator: { language: 'en' }, window: {}, document: { addEventListener() {} }, console });
  context.window = context;
  vm.runInContext(mainScript, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../settings/overview.js'), 'utf8'), context);
  context.State.automations = automations;
  context.State.devices = devices;
  context.State.manualLights = manualLights;
  return context;
}
const light = { id: 'light', zone: 'Stue' };
const part = (id, enabled = true) => ({ id, _groupId: 'motion', _groupName: 'Motion', enabled, actions: [{ deviceId: 'light' }] });
test('legacy on/off pairs count as one automation and open the original group', () => {
  const c = load([part('on'), part('off')], [light]);
  const model = c.Overview.model(1000);
  assert.equal(model.total, 1);
  assert.equal(model.rooms[0].name, 'Stue');
  assert.equal(model.counts.active, 1);
  c.AutoList.editGroup = index => assert.equal(index, 0);
  c.Overview.open('g-0');
});
test('manual light control keeps automations active; disabled and partial remain distinct', () => {
  const c = load([part('on'), part('off')], [light], { motion: { since: 1000, endsAt: 2000 } });
  assert.equal(c.Overview.model(1000).counts.active, 1);
  assert.equal(Object.hasOwn(c.Overview.model(1000).counts, 'paused'), false);
  assert.equal(c.Overview.model(2000).counts.active, 1);
  c.State.automations[0].enabled = false;
  assert.equal(c.Overview.model(1000).counts.partial, 1);
  c.State.automations[1].enabled = false;
  assert.equal(c.Overview.model(1000).counts.disabled, 1);
});
test('ungrouped automations remain editable at their original index', () => {
  const c = load([part('on'), { id: 'custom', name: 'Custom', enabled: true, actions: [] }], [light]);
  assert.equal(c.Overview.model(1000).total, 2);
  const orphan = c.Overview.model(1000).entries.find(entry => entry.id === 'custom');
  assert.equal(orphan.singleIndex, 1);
  c.CustomEditor.open = index => assert.equal(index, 1);
  c.Overview.open('s-1');
});
test('room assignment supports schedules, sensors, zones and multi-room scenes', () => {
  const c = load([
    { id:'scene', enabled:true, actions:[{deviceId:'light'},{deviceId:'other'}] },
    { id:'sensor', enabled:true, trigger:{deviceId:'motion-sensor'}, actions:[] },
    { id:'zone', enabled:true, _zone:'Kjøkken', actions:[] }
  ], [light, {id:'other', zone:'Gang'}, {id:'motion-sensor', zone:'Bod'}]);
  const entries = c.Overview.model(1000).entries;
  assert.equal(entries[0].room, 'Multiple rooms');
  assert.equal(entries[1].room, 'Bod');
  assert.equal(entries[2].room, 'Kjøkken');
});
test('empty and unusual room names do not lose automations or mutate settings', () => {
  const empty = load([]);
  assert.equal(empty.Overview.model(1000).total, 0);
  const c = load([part('on')], [{ id:'light', zone:'__proto__' }]);
  const before = JSON.stringify(c.State);
  assert.equal(c.Overview.model(1000).rooms[0].name, '__proto__');
  assert.equal(JSON.stringify(c.State), before);
  assert.equal(c.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});
