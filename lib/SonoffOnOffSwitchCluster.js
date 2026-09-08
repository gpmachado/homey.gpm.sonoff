'use strict';

const { OnOffSwitchCluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * SonoffOnOffSwitchCluster — standard OnOffSwitch cluster (0x0007) extended
 * with the Sonoff-specific `switchType` attribute (external switch wired as
 * toggle vs. momentary). Not currently registered or used by any driver —
 * no driver here declares cluster 0x0007, and the upstream Sonoff Zigbee app
 * itself leaves its equivalent write commented out as "apparently readonly".
 * Kept for structural parity with that upstream file.
 */
class SonoffOnOffSwitchCluster extends OnOffSwitchCluster {

  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,
      switchType: {
        id: 0,
        type: ZCLDataTypes.enum8({
          toggle: 0,
          momentary: 1,
        }),
      },
    };
  }

}

module.exports = SonoffOnOffSwitchCluster;
