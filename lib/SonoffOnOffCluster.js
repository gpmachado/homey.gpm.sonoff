'use strict';

const { OnOffCluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * SonoffOnOffCluster — standard OnOff cluster (0x0006) extended with the
 * Sonoff-specific `powerOnBehavior` attribute (0x4003). The enum key for
 * value 255 is `last_state`, matching this app's settings dropdown id
 * directly — no bidirectional string remapping needed, unlike the standard
 * library's own `startUpOnOff` attribute, whose key for 255 is `previous`.
 */
class SonoffOnOffCluster extends OnOffCluster {

  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,
      powerOnBehavior: {
        id: 16387,
        type: ZCLDataTypes.enum8({
          off: 0,
          on: 1,
          toggle: 2,
          last_state: 255,
        }),
      },
    };
  }

}

module.exports = SonoffOnOffCluster;
