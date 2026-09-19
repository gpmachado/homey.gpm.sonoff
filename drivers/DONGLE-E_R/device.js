'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { installNamedLogging } = require('../../lib/zclDebug');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');
const ActivePoll = require('../../lib/ActivePoll');

class SonoffDongleDevice extends ZigBeeDevice {

  async onNodeInit() {
    installNamedLogging(this);
    this.log('Sonoff Zigbee Dongle E initialized - acts as a Zigbee router to extend network range');
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
  }

  async _teardown() {
    this._activePoll?.stop();
    await this._availability?.uninstall().catch(() => {});
  }

  onEndDeviceAnnounce() {
    super.onEndDeviceAnnounce();
    this._availability?.notifyActivity('announce');
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
