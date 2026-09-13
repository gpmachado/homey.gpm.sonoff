'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit() {
    this.log('Sonoff Zigbee Dongle P initialized — acts as a Zigbee router to extend network range');
    this.printNode();
  }

  onDeleted() {
    this.log('Sonoff Dongle removed');
  }

}

module.exports = SonoffDongleDevice;
