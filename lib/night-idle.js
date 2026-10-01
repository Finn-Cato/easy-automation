'use strict';

const MINUTE = 60000;

// Owns both the normal hold and the subsequent night-light interval. Persisted
// deadlines survive listener refreshes and Homey restarts without starting over.
class NightIdle {
  constructor(options) {
    Object.assign(this, options);
    this.now = options.now || Date.now;
    this.timers = new Map();
    this.generation = 0;
    try { this.states = JSON.parse(this.homey.settings.get('_nightIdleStatus') || '{}'); } catch { this.states = {}; }
    if (!this.states || typeof this.states !== 'object' || Array.isArray(this.states)) this.states = {};
  }

  static supports(automation) {
    const config = automation._nightIdle;
    return automation.trigger?.type === 'motion_stop' && config &&
      Number.isFinite(config.brightness) && config.brightness >= .01 && config.brightness <= 1 &&
      Number.isFinite(config.offAfterMinutes) && config.offAfterMinutes >= 0 && config.offAfterMinutes <= 1440;
  }

  _signature(automation) {
    return JSON.stringify([automation.trigger.deviceId, automation._holdMinutes || 0, automation._nightIdle, automation.actions]);
  }

  _automation(gid, state) {
    return this.getAutomations().find(a => a.enabled && (a._groupId || a.id) === gid &&
      NightIdle.supports(a) && this._signature(a) === state.signature);
  }

  _current(gid, state) {
    return this.states[gid] === state && !!this._automation(gid, state) &&
      !this.isManual?.(gid);
  }

  _save() {
    this.homey.settings.set('_nightIdleStatus', JSON.stringify(this.states));
  }

  _clearTimer(gid) {
    if (this.timers.has(gid)) this.homey.clearTimeout(this.timers.get(gid));
    this.timers.delete(gid);
  }

  stop() {
    this.generation++;
    for (const gid of this.timers.keys()) this._clearTimer(gid);
  }

  prune() {
    for (const [gid, state] of Object.entries(this.states)) {
      if (!this._current(gid, state)) this.cancelGroup(gid);
    }
  }

  cancelGroup(gid) {
    this._clearTimer(gid);
    if (!Object.hasOwn(this.states, gid)) return;
    this.clearSafety?.(gid, this.states[gid].sensorId);
    delete this.states[gid];
    this.clearHold(gid);
    this._save();
  }

  motionStarted(sensorId) {
    for (const [gid, state] of Object.entries(this.states)) {
      if (state.sensorId === sensorId) this.cancelGroup(gid);
    }
  }

  _schedule(gid, state, delay) {
    this._clearTimer(gid);
    const generation = this.generation;
    const timer = this.homey.setTimeout(() => {
      if (this.timers.get(gid) === timer) this.timers.delete(gid);
      return this._transition(gid, state).catch(error => {
        this.log('warn', `Night light: ${error.message}`);
        if (generation === this.generation && this._current(gid, state)) this._schedule(gid, state, MINUTE);
      });
    }, Math.max(0, delay));
    this.timers.set(gid, timer);
  }

  async start(automation, immediate = false) {
    const gid = automation._groupId || automation.id;
    if (this.isManual?.(gid)) { this.cancelGroup(gid); return; }
    let state = this.states[gid];
    const signature = this._signature(automation);
    if (state && state.signature === signature) {
      // Repeated inactive events and the safety timer must not restart a
      // three-hour countdown after the lights have already been dimmed/off.
      if (!immediate || state.phase !== 'holding') return;
    } else {
      this.cancelGroup(gid);
      state = { signature, sensorId: automation.trigger.deviceId, phase: 'holding',
        holdUntil: this.now() + Math.max(0, automation._holdMinutes || 0) * MINUTE };
      this.states[gid] = state;
      this._save();
    }
    this.setHold(gid, state.holdUntil);
    if (immediate) {
      this._clearTimer(gid);
      await this._transition(gid, state);
    } else this._schedule(gid, state, state.holdUntil - this.now());
  }

  async restore(devices) {
    for (const [gid, state] of Object.entries(this.states)) {
      if (!this._current(gid, state) || devices[state.sensorId]?.capabilitiesObj?.alarm_motion?.value === true) {
        this.cancelGroup(gid);
      } else if (state.phase === 'holding') {
        this.setHold(gid, state.holdUntil);
        this._schedule(gid, state, state.holdUntil - this.now());
      } else if (state.phase === 'idle') this._schedule(gid, state, 0);
      // A completed interval stays completed until the next movement.
    }
    for (const automation of this.getAutomations()) {
      const gid = automation._groupId || automation.id;
      if (!automation.enabled || !NightIdle.supports(automation) || Object.hasOwn(this.states, gid)) continue;
      if (this.isManual?.(gid)) continue;
      const sensor = devices[automation.trigger.deviceId];
      const isLit = (automation.actions || []).some(a => devices[a.deviceId]?.capabilitiesObj?.onoff?.value === true);
      if (sensor?.capabilitiesObj?.alarm_motion?.value === false && isLit) await this.start(automation);
    }
  }

  async _transition(gid, state) {
    const generation = this.generation;
    const current = () => generation === this.generation && this._current(gid, state);
    if (!current() || state.phase === 'off') return;
    const automation = this._automation(gid, state);
    const devices = await this.getDevices();
    if (!current()) return;
    const motion = devices[state.sensorId]?.capabilitiesObj?.alarm_motion?.value;
    if (typeof motion !== 'boolean') throw new Error('Motion sensor is unavailable; retrying the night-light timer');
    if (motion) { this.cancelGroup(gid); return; }
    const guard = () => current() &&
      devices[state.sensorId]?.capabilitiesObj?.alarm_motion?.value === false;
    const sun = await this.getSunWindow();
    if (!guard()) return;

    if (state.phase === 'holding') {
      this.clearHold(gid);
      this.clearSafety?.(gid, state.sensorId);
      const ids = [...new Set((automation.actions || []).map(a => a.deviceId).filter(Boolean))];
      const litIds = ids.filter(id => devices[id]?.capabilities?.includes('dim') &&
        (devices[id].capabilitiesObj?.onoff?.value === true ||
          (!devices[id].capabilitiesObj?.onoff && devices[id].capabilitiesObj?.dim?.value > 0)));
      if (!sun.isNight || !litIds.length) {
        await this._finish(gid, state, automation.actions || [], automation.name, guard);
        return;
      }
      const actions = litIds.map(deviceId => {
        const fade = (automation.actions || []).find(a => a.deviceId === deviceId && a.type === 'fade_off');
        return fade?.duration > 0 ? { type: 'fade_to', deviceId, value: automation._nightIdle.brightness, duration: fade.duration }
          : { type: 'set_dim', deviceId, value: automation._nightIdle.brightness };
      });
      const results = await this.runActions(actions, automation.name + ' — night light', guard);
      if (!guard()) return;
      if (Array.isArray(results) && results.some(result => result.ok === false)) throw new Error('Night-light dimming failed; retrying');
      state.phase = 'idle';
      state.brightness = automation._nightIdle.brightness;
      state.deviceIds = litIds;
      state.offAt = automation._nightIdle.offAfterMinutes > 0 ? this.now() + automation._nightIdle.offAfterMinutes * MINUTE : null;
      this.log('info', `Night light: "${automation._groupName || automation.name}" → ${Math.round(state.brightness * 100)}%`);
    }

    if (!sun.isNight || (state.offAt && this.now() >= state.offAt)) {
      const actions = (automation.actions || []).filter(a => state.deviceIds.includes(a.deviceId));
      await this._finish(gid, state, actions, automation.name, guard);
      return;
    }
    const deadlines = [state.offAt, sun.nextSunrise].filter(time => Number.isFinite(time) && time > 0);
    state.endsAt = deadlines.length ? Math.min(...deadlines) : null;
    this._save();
    this._schedule(gid, state, state.endsAt ? Math.min(MINUTE, state.endsAt - this.now()) : MINUTE);
  }

  async _finish(gid, state, actions, name, guard) {
    const results = await this.runActions(actions, name, guard);
    if (!guard()) return;
    if (Array.isArray(results) && results.some(result => result.ok === false)) throw new Error('Night-light switch-off failed; retrying');
    state.phase = 'off';
    state.endsAt = null;
    this.clearHold(gid);
    this._save();
  }
}

module.exports = NightIdle;
