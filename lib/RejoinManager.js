'use strict';

/**
 * @file RejoinManager.js
 * @description Fires the device_rejoined flow trigger after a power-cycle/rejoin.
 * ```js
 * const RejoinManager = require('../../lib/RejoinManager');
 * RejoinManager.triggerRejoin(this);
 * ```
 */

const { getNodeDevices } = require('./connectedDevices');

class RejoinManager {
  /**
   * Fire the device_rejoined flow trigger.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {number} gapMs - Gap since last seen in milliseconds
   */
  static triggerRejoin(device, gapMs = 0) {
    const cardId = `${device.driver.id}_device_rejoined`;
    device.log(`[RejoinManager] Firing flow: ${cardId} (gap ${Math.round(gapMs / 1000)}s)`);

    // Rejoin counter + timestamp for the settings-page Rejoins tab (reset
    // globally alongside rejoin_tracking_since in app.js/api.js - see
    // resetRejoinStats).
    const count = (device.getStoreValue('rejoin_count') || 0) + 1;
    device.setStoreValue('rejoin_count', count).catch(() => {});
    device.setStoreValue('rejoin_last_at', Date.now()).catch(() => {});

    // DeviceTriggerCard - appears directly in the device's flow card list.
    try {
      device.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(device)
        .catch(err => device.error(`[RejoinManager] ${cardId} trigger failed:`, err.message));
    } catch (err) {
      device.error(`[RejoinManager] ${cardId} error:`, err.message);
    }

    // Multi-gang nodes (MINI-ZB2GS): the rejoin is one physical event, counted
    // once on the main device above, but every gang's tile gets its own card.
    for (const sibling of getNodeDevices(device)) {
      if (sibling === device) continue;
      try {
        sibling.homey.flow.getDeviceTriggerCard(cardId)
          .trigger(sibling)
          .catch(err => sibling.error(`[RejoinManager] ${cardId} trigger failed:`, err.message));
      } catch (err) {
        sibling.error(`[RejoinManager] ${cardId} error:`, err.message);
      }
    }
  }
}

module.exports = RejoinManager;
