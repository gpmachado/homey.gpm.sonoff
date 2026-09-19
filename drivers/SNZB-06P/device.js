'use strict';

const SonoffBase = require('../sonoffbase');
const { CLUSTER } = require('zigbee-clusters');
const IASZoneHelper = require('../../lib/IASZoneHelper');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');

const OccupancySensing = CLUSTER.OCCUPANCY_SENSING;

class SonoffSNZB06P extends SonoffBase {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    if (this.hasCapability('alarm_contact')) {
      await this.removeCapability('alarm_contact');
      await this.addCapability('alarm_motion');
    }

    // IAS Zone - enrolled by Homey 13.4 stack during pairing; we only install
    // listeners and read initial state. The SNZB-06P firmware 1.0.6 does not
    // reliably emit zoneStatusChangeNotification for this device, so the
    // occupancySensing cluster is the primary motion channel (below).
    this._iasZone = new IASZoneHelper(this, {
      endpointId: 1,
      zoneId: 1,
      sendEnrollOnInit: false,
      readInitialState: true,
      configureCieAddress: false,
      onStatus: zoneStatus => this._zoneStatusChangeNotification(zoneStatus),
    });
    await this._iasZone.init(zclNode);

    // Occupancy cluster - primary presence channel for SNZB-06P firmware 1.0.6.
    // No configureReporting on purpose: on real hardware the device answers the
    // request with UNSUP_CLUSTER_COMMAND every time. It pushes occupancy on its own,
    // which the passive listener below picks up.
    const occCluster = zclNode.endpoints[1].clusters[OccupancySensing.NAME];

    this._onOccupancyReport = value => {
      this.log('[SNZB06P] occupancy:', value);
      const motion = Boolean(value?.occupied);
      this.setCapabilityValue('alarm_motion', motion)
        .catch(error => this.error('[SNZB06P] occupancy update failed:', error.message));
    };
    occCluster.removeListener('attr.occupancy', this._onOccupancyReport);
    occCluster.on('attr.occupancy', this._onOccupancyReport);

    // Defer initial read until device wakes up (it reports on first occupancy)
    this._settingsReadTimer = this.homey.setTimeout(() => {
      this._readSettings().catch(error => {
        this.log('[SNZB06P] Initial settings read deferred:', error.message);
      });
    }, 5000);

    // USB-powered and always listening, but it only sends occupancy changes (a
    // 52 min gap without any frame was seen), so the watchdog leans on an active
    // Basic-cluster poll. 90 min stays generous until it is confirmed that the
    // device answers that read and honours the occupancy reporting above.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_MEDIUM_MS });
    await this._availability.install();
    this._startActivePoll();

    this.log(`[SNZB06P] initialized (firmware ${this.getSetting('zb_sw_build_id') || 'unknown'})`);
  }

  async _readSettings() {
    try {
      const occCluster = this.zclNode.endpoints[1].clusters[OccupancySensing.NAME];
      const data = await occCluster.readAttributes([
        'ultrasonicOccupiedToUnoccupiedDelay',
        'ultrasonicUnoccupiedToOccupiedThreshold',
      ]);
      const updates = {};
      if (data.ultrasonicOccupiedToUnoccupiedDelay != null && this.getSetting('occupied_to_unoccupied_delay') !== data.ultrasonicOccupiedToUnoccupiedDelay) {
        updates.occupied_to_unoccupied_delay = data.ultrasonicOccupiedToUnoccupiedDelay;
      }
      if (data.ultrasonicUnoccupiedToOccupiedThreshold != null && this.getSetting('occupied_threshold') !== String(data.ultrasonicUnoccupiedToOccupiedThreshold)) {
        updates.occupied_threshold = String(data.ultrasonicUnoccupiedToOccupiedThreshold);
      }
      if (Object.keys(updates).length > 0) {
        await this.setSettings(updates);
      }
    } catch (err) {
      this.log('[SNZB06P] Settings read deferred:', err.message);
    }
  }

  _zoneStatusChangeNotification(zoneStatus) {
    const motion = IASZoneHelper.hasAlarm(zoneStatus);
    this.log('[SNZB06P] IAS zoneStatus:', zoneStatus, '-> motion:', motion);
    this.setCapabilityValue('alarm_motion', motion)
      .catch(error => this.error('[SNZB06P] motion update failed:', error.message));
  }

  async onSettings({ newSettings, changedKeys }) {
    const writes = {};
    if (changedKeys.includes('occupied_to_unoccupied_delay')) {
      writes.ultrasonicOccupiedToUnoccupiedDelay = newSettings.occupied_to_unoccupied_delay;
    }
    if (changedKeys.includes('occupied_threshold')) {
      writes.ultrasonicUnoccupiedToOccupiedThreshold = Number(newSettings.occupied_threshold);
    }
    if (Object.keys(writes).length > 0) {
      await this.writeAttributes(OccupancySensing, writes);
      await this._readSettings();
    }
  }

  async _teardown() {
    if (this._settingsReadTimer) {
      this.homey.clearTimeout(this._settingsReadTimer);
      this._settingsReadTimer = null;
    }

    await super._teardown?.(); // stops the active poll before the manager goes away

    this._iasZone?.dispose();
    await this._availability?.uninstall().catch(() => {});

    // Undefined when the device is removed before onNodeInit got that far, and
    // removeListener(undefined) throws.
    if (this._onOccupancyReport) {
      this.zclNode?.endpoints?.[1]?.clusters?.[OccupancySensing.NAME]
        ?.removeListener('attr.occupancy', this._onOccupancyReport);
    }
  }

}

module.exports = SonoffSNZB06P;
