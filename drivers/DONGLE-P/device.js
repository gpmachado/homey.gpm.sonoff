'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { installNamedLogging } = require('../../lib/zclDebug');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');
const ActivePoll = require('../../lib/ActivePoll');

// Sniffer-confirmed (Dongle_P_E/sonoff-repeater -E e P no ihost.pcapng): the iHost
// configures Basic.zclVersion to report at max 3600 s on the Dongle P, which answers
// Success and then reports at exactly that interval. That gives the dongle a native
// hourly heartbeat for the passive frame hook (90 min timeout = 1.5x). The Dongle E
// gets no such configuration from the iHost and is only polled.
const HEARTBEAT_REPORTING = { zclVersion: { minInterval: 0, maxInterval: 3600 } };
const REPORTING_STORE_KEY = 'reporting_configured_basic';

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit() {
    installNamedLogging(this);
    this.log('Sonoff Zigbee Dongle P initialized - acts as a Zigbee router to extend network range');
    this.printNode();

    // Routers relay other devices' mesh traffic at the MAC layer - that
    // never surfaces to this node's own handleFrame, so passive listening
    // alone would rarely see activity. pollBeforeOffline (default on)
    // becomes the real heartbeat here: a Basic-cluster read every time the
    // device has been idle for the full timeout, acting as a periodic
    // active ping instead of a one-off check.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_MEDIUM_MS });
    await this._availability.install();

    // No traffic of its own at all - an active poll every 5 min (reading the
    // universal Basic cluster) is the only way to actually confirm it's alive.
    this._activePoll = new ActivePoll(this);
    this._activePoll.start();

    this._configureHeartbeat();
  }

  // Sent straight through the cluster (not configureAttributeReporting, which resends
  // and prints an [err] per failure). The config lives on the device, so once accepted
  // it is not resent on later starts; it is retried after a rejoin/announce and when the
  // device comes back from unavailable.
  async _configureHeartbeat() {
    if (this.getStoreValue(REPORTING_STORE_KEY) || this._configuringReporting) return;
    this._configuringReporting = true;
    try {
      await this.zclNode.endpoints[1].clusters.basic.configureReporting(HEARTBEAT_REPORTING);
      await this.setStoreValue(REPORTING_STORE_KEY, true).catch(() => {});
      this.log('[Reporting] Basic zclVersion heartbeat configured (max 3600 s)');
    } catch (err) {
      this.log('[Reporting] Basic heartbeat configureReporting failed, will retry later:', err.message);
    } finally {
      this._configuringReporting = false;
    }
  }

  onBecameAvailable() {
    this._configureHeartbeat();
  }

  async _teardown() {
    this._activePoll?.stop();
    await this._availability?.uninstall().catch(() => {});
  }

  onEndDeviceAnnounce() {
    super.onEndDeviceAnnounce();
    this._availability?.notifyActivity('announce');
    this.setStoreValue(REPORTING_STORE_KEY, false).catch(() => {});
    this._configureHeartbeat();
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
