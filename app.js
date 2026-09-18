'use strict';

const Homey = require('homey');
const { Cluster, TimeCluster, debug } = require('zigbee-clusters');
const SonoffCluster = require('./lib/SonoffCluster');
const SonoffOnOffCluster = require('./lib/SonoffOnOffCluster');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // Flip to true for verbose ZCL frame logging during development.
    debug(true);

    // Must run before any device's onNodeInit — registers SonoffCluster
    // (0xFC11) globally so zclNode.endpoints[1].clusters['SonoffCluster']
    // resolves for every driver that uses it.
    Cluster.addCluster(SonoffCluster);

    // Time (0x000A) self-registers when zigbee-clusters is required, but
    // registering it explicitly here documents the dependency the same way
    // as SonoffCluster above, instead of relying on that implicit side effect.
    Cluster.addCluster(TimeCluster);

    // Overrides the built-in OnOff cluster (0x0006) with the Sonoff-specific
    // powerOnBehavior attribute — must run before any device's onNodeInit,
    // same as SonoffCluster above.
    Cluster.addCluster(SonoffOnOffCluster);

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

    // SNZB-09P siren flow cards.
    this.homey.flow.getActionCard('siren_play')
      .registerRunListener(async (args) => {
        await args.device._startSiren({
          soundType: parseInt(args.sound_type, 10),
          duration: args.duration,
        });
        return true;
      });

    this.homey.flow.getActionCard('siren_stop')
      .registerRunListener(async (args) => {
        await args.device._stopSiren();
        return true;
      });

    this.homey.flow.getConditionCard('is_playing')
      .registerRunListener(async (args) => Boolean(args.device.getCapabilityValue('onoff')));

    // Generic "is available" condition for any driver with is_availability
    // (see lib/AvailabilityManager.js) — one card, filtered by capability.
    this.homey.flow.getConditionCard('availability_is_on')
      .registerRunListener(async (args) => args.device.getAvailable());
  }

};
