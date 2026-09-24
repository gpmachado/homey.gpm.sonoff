'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffBASICZBR3Driver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();


    this.log('BASICZBR3 driver initialized');
  }

}

module.exports = SonoffBASICZBR3Driver;
