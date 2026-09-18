'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { installNamedLogging } = require('../../lib/zclDebug');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit() {
    installNamedLogging(this);
    this.log('Sonoff Zigbee Dongle P initialized — acts as a Zigbee router to extend network range');
    this.printNode();

    // Migrate already-paired devices: driver.compose.json only applies
    // capabilities to newly-paired devices.
    if (!this.hasCapability('is_availability')) {
      await this.addCapability('is_availability').catch(() => {});
    }

    // Routers relay other devices' mesh traffic at the MAC layer — that
    // never surfaces to this node's own handleFrame, so passive listening
    // alone would rarely see activity. pollBeforeOffline (default on)
    // becomes the real heartbeat here: a Basic-cluster read every time the
    // device has been idle for the full timeout, acting as a periodic
    // active ping instead of a one-off check.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_MEDIUM_MS });
    await this._availability.install();

    // No traffic of its own at all — an active poll every 5 min (reading the
    // universal Basic cluster) is the only way to actually confirm it's alive.
    this._activePollInterval = this.homey.setInterval(async () => {
      if (!this.zclNode) return;
      try {
        await this.zclNode.endpoints[8].clusters.basic.readAttributes(['zclVersion']);
        this._availability?.notifyActivity('active-poll');
      } catch (err) {
        this.log('[Active poll] failed:', err.message);
      }
    }, 5 * 60 * 1000);
  }

  async _teardown() {
    if (this._activePollInterval) {
      this.homey.clearInterval(this._activePollInterval);
      this._activePollInterval = null;
    }
    await this._availability?.uninstall().catch(() => {});
  }

  async onUninit() {
    await this._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('Sonoff Dongle removed');
  }

}

module.exports = SonoffDongleDevice;
