'use strict';

const MINUTE = 60000;
const LIGHT_ACTIONS = new Set(['turn_on', 'turn_off', 'set_dim', 'fade_to', 'fade_off']);

// Manual light values stay untouched while a room is occupied. The motion
// sensor remains live: an uninterrupted empty interval turns off and releases
// manual control. No fixed override expiry is used.
class ManualLights {
  constructor(options) {
    Object.assign(this, options);
    this.now = options.now || Date.now;
    this.timers = new Map();
    this.sensors = new Map();
    this.generation = 0;
    try { this.states = JSON.parse(this.homey.settings.get('_manualLightStatus') || '{}'); } catch { this.states = {}; }
    if (!this.states || typeof this.states !== 'object' || Array.isArray(this.states)) this.states = {};
  }

  groups() {
    const grouped = new Map();
    for (const automation of this.getAutomations()) {
      if (!automation.enabled) continue;
      const gid = automation._groupId || automation.id;
      if (!grouped.has(gid)) grouped.set(gid, []);
      grouped.get(gid).push(automation);
    }
    const result = [];
    for (const [id, items] of grouped) {
      const on = items.filter(a => a.trigger?.type === 'motion_start');
      if (!on.length) continue;
      const sensorIds = [...new Set(on.map(a => a.trigger.deviceId).filter(Boolean))].sort();
      const lightIds = [...new Set(items.flatMap(a => (a.actions || []).filter(action =>
        LIGHT_ACTIONS.has(action.type) || (action.type === 'set_capability' && ['onoff', 'dim'].includes(action.capability))
      ).map(action => action.deviceId)).filter(Boolean))].sort();
      if (!sensorIds.length || !lightIds.length) continue;
      const off = items.filter(a => a.trigger?.type === 'motion_stop');
      const minutes = off.length ? off.map(a => a._holdMinutes ?? 0) : on.map(a => a._manualHoldMinutes ?? 5);
      const holdMinutes = Math.max(0, ...minutes.map(value => Number.isFinite(Number(value)) ? Number(value) : 5));
      const signature = JSON.stringify([sensorIds, lightIds, holdMinutes]);
      result.push({ id, sensorIds, lightIds, holdMinutes, signature, name: on[0]._groupName || on[0].name });
    }
    return result;
  }

  _group(gid) { return this.groups().find(group => group.id === gid); }
  isManual(gid) { return !!this.states[gid] && this._group(gid)?.signature === this.states[gid].signature; }
  _save() { this.homey.settings.set('_manualLightStatus', JSON.stringify(this.states)); }

  _clearTimer(gid) {
    if (this.timers.has(gid)) this.homey.clearTimeout(this.timers.get(gid));
    this.timers.delete(gid);
  }

  stop() {
    this.generation++;
    for (const gid of this.timers.keys()) this._clearTimer(gid);
  }

  cancel(gid) {
    this._clearTimer(gid);
    if (!Object.hasOwn(this.states, gid)) return;
    delete this.states[gid];
    this.clearHold(gid);
    this._save();
  }

  async start(gid) {
    const group = this._group(gid);
    if (!group) return false;
    let state = this.states[gid];
    if (!state || state.signature !== group.signature) {
      this.cancel(gid);
      const existingHold = this.getHold?.(gid);
      state = { signature: group.signature, since: this.now(), inactiveSince: null, endsAt: null };
      if (Number.isFinite(existingHold)) state.inactiveSince = existingHold - group.holdMinutes * MINUTE;
      this.states[gid] = state;
      this.cancelPending(gid);
      this._save();
      this.log('info', `Manual light control: "${group.name}" until the room is empty`);
    }
    const devices = await this.getDevices();
    if (this.states[gid] === state) this._sync(group, state, devices);
    return true;
  }

  async lightChanged(deviceId) {
    await Promise.all(this.groups().filter(group => group.lightIds.includes(deviceId)).map(group => this.start(group.id)));
  }

  motionChanged(sensorId, value) {
    if (typeof value !== 'boolean') return;
    const previous = this.sensors.get(sensorId);
    this.sensors.set(sensorId, { value, inactiveSince: value ? null
      : previous?.value === false ? previous.inactiveSince : this.now() });
    for (const [gid, state] of Object.entries(this.states)) {
      const group = this._group(gid);
      if (!group || group.signature !== state.signature) { this.cancel(gid); continue; }
      if (!group.sensorIds.includes(sensorId)) continue;
      if (value) {
        this._clearTimer(gid);
        state.inactiveSince = null;
        state.endsAt = null;
        this.clearHold(gid);
        this._save();
      } else {
        this.getDevices().then(devices => {
          if (this.states[gid] === state) this._sync(group, state, devices);
        }).catch(error => this.log('warn', 'Manual control sensor update: ' + error.message));
      }
    }
  }

  _motion(group, devices) {
    const values = group.sensorIds.map(id => devices[id]?.available === false ? null
      : devices[id]?.capabilitiesObj?.alarm_motion?.value ?? this.sensors.get(id)?.value);
    if (values.includes(true)) return true;
    return values.every(value => value === false) ? false : null;
  }

  _sync(group, state, devices) {
    const motion = this._motion(group, devices);
    if (motion !== false) {
      this._clearTimer(group.id);
      state.inactiveSince = null;
      state.endsAt = null;
      this.clearHold(group.id);
      this._save();
      if (motion === null) this._schedule(group, state, MINUTE);
      return;
    }
    if (state.inactiveSince === null) {
      const known = group.sensorIds.map(id => this.sensors.get(id)?.inactiveSince);
      state.inactiveSince = known.every(Number.isFinite) ? Math.max(...known) : this.now();
    }
    state.endsAt = state.inactiveSince + group.holdMinutes * MINUTE;
    this.setHold(group.id, state.endsAt);
    this._save();
    this._schedule(group, state, state.endsAt - this.now());
  }

  _schedule(group, state, delay) {
    this._clearTimer(group.id);
    const generation = this.generation;
    const timer = this.homey.setTimeout(() => {
      if (this.timers.get(group.id) === timer) this.timers.delete(group.id);
      return this._finish(group, state, generation).catch(error => {
        this.log('warn', 'Manual light switch-off: ' + error.message);
        if (generation === this.generation && this.states[group.id] === state) this._schedule(group, state, MINUTE);
      });
    }, Math.max(0, delay));
    this.timers.set(group.id, timer);
  }

  async _finish(group, state, generation) {
    const current = () => generation === this.generation && this.states[group.id] === state && this.isManual(group.id);
    if (!current()) return;
    const devices = await this.getDevices();
    if (!current()) return;
    if (this._motion(group, devices) !== false || state.endsAt === null || state.endsAt > this.now()) {
      this._sync(group, state, devices);
      return;
    }
    const guard = () => current() && state.endsAt !== null && state.endsAt <= this.now() && this._motion(group, devices) === false;
    const results = await this.runActions(group.lightIds.map(deviceId => ({ type: 'turn_off', deviceId })), group.name + ' — empty room', guard);
    if (!guard()) return;
    if (Array.isArray(results) && results.some(result => result.ok === false)) throw new Error('Retrying failed light commands');
    this.cancel(group.id);
    this.log('info', `Room empty: "${group.name}" lights off, automatic control resumed`);
  }

  async restore(devices) {
    this.sensors.clear();
    for (const [gid, state] of Object.entries(this.states)) {
      const group = this._group(gid);
      if (!group || group.signature !== state.signature) { this.cancel(gid); continue; }
      this.cancelPending(gid);
      this._sync(group, state, devices);
    }
  }
}

module.exports = ManualLights;
