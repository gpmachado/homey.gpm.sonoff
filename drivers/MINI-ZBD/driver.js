'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffMINIZBDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('MINI-ZBD driver initialized');
  }

}

module.exports = SonoffMINIZBDriver;
