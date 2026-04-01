'use strict';

const { Device } = require('homey');

class RoomDevice extends Device {

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onInit() {
    this.log(`Room "${this.getName()}" initialized`);

    this._motionTimer = null;

    // Set safe defaults if capabilities have never been set.
    if (this.getCapabilityValue('alarm_motion') === null) {
      await this.setCapabilityValue('alarm_motion', false).catch(this.error);
    }
    if (this.getCapabilityValue('onoff') === null) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
    }

    // Allow the user to toggle automation on/off from the device tile.
    this.registerCapabilityListener('onoff', async (enabled) => {
      this.log(`Room "${this.getName()}" automation ${enabled ? 'enabled' : 'disabled'}`);
      if (!enabled) {
        // Cancel any running countdown when automation is turned off.
        this._clearTimer();
      }
    });
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('motion_timeout')) {
      this.log(`Room "${this.getName()}" motion timeout changed to ${newSettings.motion_timeout} min`);
      // Restart the countdown with the new duration if it was already running.
      if (this._motionTimer !== null) {
        this._clearTimer();
        this._startTimer();
      }
    }
  }

  async onDeleted() {
    this._clearTimer();
    this.log(`Room "${this.getName()}" deleted`);
  }

  // ── Public API called by app.js flow handlers ──────────────────────────────

  /**
   * setMotion(true)  → mark room occupied, cancel any pending timeout
   * setMotion(false) → start the no-motion countdown
   */
  async setMotion(isMotion) {
    const wasOccupied      = this.getCapabilityValue('alarm_motion');
    const automationActive = this.getCapabilityValue('onoff');

    if (isMotion) {
      this._clearTimer();

      await this.setCapabilityValue('alarm_motion', true).catch(this.error);

      if (!wasOccupied) {
        if (this.homey.app.triggerRoomOccupied) await this.homey.app.triggerRoomOccupied(this).catch(() => {});
        this.log(`Room "${this.getName()}" became OCCUPIED`);
      }
    } else {
      if (automationActive) {
        this._startTimer();
      } else {
        // Automation is off: immediately mark as empty without a countdown.
        await this._onTimeout();
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _startTimer() {
    const minutes = this.getSetting('motion_timeout') || 5;
    const ms      = minutes * 60 * 1000;

    this.log(`Room "${this.getName()}" starting ${minutes}-min no-motion timer`);

    this._motionTimer = this.homey.setTimeout(async () => {
      await this._onTimeout();
    }, ms);
  }

  _clearTimer() {
    if (this._motionTimer !== null) {
      this.homey.clearTimeout(this._motionTimer);
      this._motionTimer = null;
    }
  }

  async _onTimeout() {
    this._motionTimer = null;

    const wasOccupied = this.getCapabilityValue('alarm_motion');

    await this.setCapabilityValue('alarm_motion', false).catch(this.error);

    // Always fire the no-motion timeout trigger.
    if (this.homey.app.triggerMotionTimeout) await this.homey.app.triggerMotionTimeout(this).catch(() => {});
    this.log(`Room "${this.getName()}" motion timeout fired`);

    // Fire "became empty" only if room was previously occupied.
    if (wasOccupied) {
      await this.homey.app.triggerRoomEmpty(this);
      this.log(`Room "${this.getName()}" became EMPTY`);
    }
  }

}

module.exports = RoomDevice;
