'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { installNamedLogging } = require('../../lib/zclDebug');

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit() {
    installNamedLogging(this);
    this.log('Sonoff Zigbee Dongle E initialized — acts as a Zigbee router to extend network range');
    this.printNode();
  }

  onDeleted() {
    this.log('Sonoff Dongle removed');
  }

}

module.exports = SonoffDongleDevice;
