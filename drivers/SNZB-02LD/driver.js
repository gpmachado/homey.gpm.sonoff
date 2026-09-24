'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffSNZB02LDDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('SNZB-02LD driver initialized');
  }

}

module.exports = SonoffSNZB02LDDriver;
