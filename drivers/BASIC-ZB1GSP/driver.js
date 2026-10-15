'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SonoffBasicZB1GSPDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.homey.flow.getDeviceTriggerCard('BASIC-ZB1GSP:protection_tripped')
      .registerRunListener(async (args, state) => {
        const run = args.limit === 'any' || state.causes.includes(args.limit);
        // Diagnostic: one line per flow Homey evaluates (field report 2026-10-15: flows did not run).
        this.log(`[Protection] flow card limit=${args.limit} causes=${state.causes.join(',') || '-'} -> ${run ? 'run' : 'skip'}`);
        return run;
      });
  }

}

module.exports = SonoffBasicZB1GSPDriver;
