'use strict';

const { CLUSTER } = require('zigbee-clusters');
const SonoffBase = require('../sonoffbase');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_FAST_MS } = require('../../lib/constants');

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
        this.log(`set onoff -> ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    // NOTE: BASICZBR3 firmware responds UNSUP_GENERAL_COMMAND to all ZCL general commands
    // (confirmed via Homey Interview). configureAttributeReporting is not supported.
    // Field-confirmed (14 h log): the firmware sends an onOff report every 300 s in
    // either state, even though it rejects ZCL general commands. The passive frame hook
    // counts any inbound frame, so it works without the confirmation poll (which reads
    // Basic and is refused by this firmware). 25 min is 5x the report interval.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_FAST_MS });
    await this._availability.install();

    this.log('BASICZBR3 initialized');
  }

  async _teardown() {
    await this._availability?.uninstall().catch(() => {});
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('BASICZBR3 removed');
  }

}

module.exports = SonoffBASICZBR3;
