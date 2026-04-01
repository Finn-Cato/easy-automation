'use strict';

const { Driver } = require('homey');

class RoomDriver extends Driver {

  async onInit() {
    this.log('Room driver initialized');
  }

  /**
   * Called when the user starts the pairing wizard.
   * We use a custom "start" view (pair/start.html) that collects the room name
   * and motion-timeout setting, then navigate to the built-in "add_devices"
   * template which calls list_devices.
   */
  async onPair(session) {
    let deviceName    = this.homey.__('pair.default_name');
    let motionTimeout = 5;

    // The custom start.html view asks for a name and timeout, then emits 'set_data'.
    session.setHandler('set_data', async (data) => {
      deviceName    = (data.name    || deviceName).trim();
      motionTimeout = parseInt(data.timeout, 10) || motionTimeout;
      return true;
    });

    // Built-in add_devices template calls list_devices to get the device list.
    session.setHandler('list_devices', async () => {
      return [
        {
          name: deviceName,
          data: {
            id: `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          },
          settings: {
            motion_timeout: motionTimeout
          }
        }
      ];
    });
  }

}

module.exports = RoomDriver;
