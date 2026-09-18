'use strict';

const SonoffBase = require('../sonoffbase');

class SonoffZBMINI extends SonoffBase {

  async onNodeInit({ zclNode }) {
    super.onNodeInit({ zclNode });

    if (this.hasCapability('onoff')) {
      // Same fix as BASICZBR3/ZBMINIR2: this generation's firmware doesn't
      // reliably send a ZCL Default Response to setOn/setOff, which makes
      // registerCapability's default 10s-wait handler time out. Wire it
      // manually instead.
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

    this.log('ZBMINI initialized');
  }

  async onDeleted() {
    this.log('ZBMINI removed');
  }

}

module.exports = SonoffZBMINI;
