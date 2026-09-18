'use strict';

const { CLUSTER } = require('zigbee-clusters');
const SonoffBase = require('../sonoffbase');

class SonoffBASICZBR3 extends SonoffBase {

  async onNodeInit({ zclNode }) {
    super.onNodeInit({ zclNode });

    if (this.hasCapability('onoff')) {
      // BASICZBR3 firmware does not send ZCL Default Response to setOn/setOff.
      // Same fix as ZBMINIR2: wire manually with waitForResponse: false.
      const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

      this._onOnOff ??= value => {
        this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
        this.setCapabilityValue('onoff', value).catch(this.error);
      };
      _onOffCluster.removeListener('attr.onOff', this._onOnOff);
      _onOffCluster.on('attr.onOff', this._onOnOff);

      this.registerCapabilityListener('onoff', async value => {
        this.log(`set onoff → ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    // NOTE: BASICZBR3 firmware responds UNSUP_GENERAL_COMMAND to all ZCL general commands
    // (confirmed via Homey Interview). configureAttributeReporting is not supported.
    this.log('BASICZBR3 initialized');
  }

  async onDeleted() {
    this.log('BASICZBR3 removed');
  }

}

module.exports = SonoffBASICZBR3;
