'use strict';

const SonoffBase = require('../sonoffbase');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_FASTEST_MS } = require('../../lib/constants');

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
        this.log(`set onoff -> ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    // Field-confirmed: the firmware sends an onOff report every ~239 s in either
    // state (13 in a row while on, and again while off after a power-up), so the
    // passive frame hook alone is a reliable heartbeat - 10 min is ~2.5x that (a
    // missed report is absorbed by poll-before-offline) and no active poll is needed.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_FASTEST_MS });
    await this._availability.install();

    this.log('ZBMINI initialized');
  }

  async _teardown() {
    await this._availability?.uninstall().catch(() => {});
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('ZBMINI removed');
  }

}

module.exports = SonoffZBMINI;
