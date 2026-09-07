'use strict';

const Homey = require('homey');
const { registerCustomClusters } = require('./lib/clusterRegistry');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // Must run before any device's onNodeInit — registers SonoffCluster
    // (0xFC11) globally so zclNode.endpoints[1].clusters['SonoffCluster']
    // resolves for every driver that uses it.
    registerCustomClusters();

    this.log('MyApp has been initialized');

    // Updates the onoff capability in the UI only, without sending a Zigbee
    // command — used to correct the displayed state on devices where
    // detach_mode decouples the physical switch from the relay.
    this.homey.flow.getActionCard('set_ui_onoff')
      .registerRunListener(async (args) => {
        let newValue;
        if (args.status === 'toggle') {
          newValue = !args.device.getCapabilityValue('onoff');
        } else {
          newValue = args.status === 'on';
        }
        await args.device.setCapabilityValue('onoff', newValue);
        return true;
      });
  }

};
