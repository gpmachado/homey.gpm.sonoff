'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffZBMINIR2Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('ZBMINI-R2 driver initialized');
  }

}

module.exports = SonoffZBMINIR2Driver;
