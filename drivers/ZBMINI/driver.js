'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffZBMINIDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('ZBMINI driver initialized');
  }

}

module.exports = SonoffZBMINIDriver;
