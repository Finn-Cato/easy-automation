'use strict';

// Homey also reports our own commands as device changes. Match command IDs and
// the subsequent driver reports, including implicit on/off and fade steps.
class LightWrites {
  constructor(now = Date.now) {
    this.now = now;
    this.pending = new Map();
    this.values = new Map();
    this.levels = new Map();
    this.sequence = 0;
  }

  seed(device) {
    for (const capability of ['onoff', 'dim']) {
      const value = device.capabilitiesObj?.[capability]?.value;
      this.values.set(device.id + ':' + capability, value);
      if (capability === 'dim' && value > 0) this.levels.set(device.id, value);
    }
  }

  _expect(id, capability, value, duration = 0) {
    const key = id + ':' + capability;
    const previous = this.values.get(key);
    const items = (this.pending.get(key) || []).filter(item => item.until > this.now());
    items.push({ value, last: previous, fade: duration > 0, until: this.now() + duration + 10000 });
    this.pending.set(key, items.slice(-8));
  }

  command(device, capability, value, options = {}) {
    this._expect(device.id, capability, value, options.duration || 0);
    if (capability === 'dim') {
      this._expect(device.id, 'onoff', value > 0, options.duration || 0);
    } else if (capability === 'onoff') {
      this._expect(device.id, 'dim', value ? (this.levels.get(device.id) || 1) : 0);
    }
    return 'light-guard-' + this.now() + '-' + (++this.sequence);
  }

  observe(id, capability, value, transactionId) {
    const key = id + ':' + capability;
    const previous = this.values.get(key);
    this.values.set(key, value);
    if (capability === 'dim' && value > 0) this.levels.set(id, value);
    const items = (this.pending.get(key) || []).filter(item => item.until > this.now());
    if (items.length) this.pending.set(key, items); else this.pending.delete(key);
    if (previous === value || (typeof transactionId === 'string' && transactionId.startsWith('light-guard-'))) return false;
    const own = items.some(item => {
      if (typeof value !== 'number') return item.value === value;
      if (Math.abs(item.value - value) < .005) return true;
      if (!item.fade || !Number.isFinite(item.last)) return false;
      const followsFade = item.value >= item.last
        ? value >= item.last - .015 && value <= item.value + .015
        : value <= item.last + .015 && value >= item.value - .015;
      if (followsFade) item.last = value;
      return followsFade;
    });
    if (!own) this.pending.delete(key);
    return !own;
  }
}

module.exports = LightWrites;
