'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

// Required: homey-zigbeedriver refuses Zigbee sub-devices (the second gang)
// unless the driver extends ZigBeeDriver.
class SonoffMINIZB2GSDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('MINI-ZB2GS driver initialized');
  }

}

module.exports = SonoffMINIZB2GSDriver;
