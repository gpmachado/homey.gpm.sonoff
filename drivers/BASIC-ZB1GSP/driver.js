'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffBasicZB1GSPDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.homey.flow.getDeviceTriggerCard('BASIC-ZB1GSP:protection_tripped')
      .registerRunListener(async (args, state) => args.limit === 'any' || state.causes.includes(args.limit));
  }

}

module.exports = SonoffBasicZB1GSPDriver;
