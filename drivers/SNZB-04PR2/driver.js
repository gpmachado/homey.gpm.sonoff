'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffSNZB04PR2Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('SNZB-04PR2 driver initialized');
  }

}

module.exports = SonoffSNZB04PR2Driver;
