'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffSNZB04PDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('SNZB-04P driver initialized');
  }

}

module.exports = SonoffSNZB04PDriver;
