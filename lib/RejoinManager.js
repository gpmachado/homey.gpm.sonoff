'use strict';

/**
 * @file RejoinManager.js
 * @description Fires the device_rejoined flow trigger after a power-cycle/rejoin.
 * ```js
 * const RejoinManager = require('../../lib/RejoinManager');
 * RejoinManager.triggerRejoin(this);
 * ```
 */

/**
 * Returns all Homey device instances sharing the same physical Zigbee node as
 * `device` (multi-gang siblings), matched by zclNode first, ieeeAddress fallback.
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 * @returns {Array} sibling device instances (includes `device` itself)
 */
function getNodeDevices(device) {
  const myZclNode = device.zclNode;
  const myIeee = device.getData()?.ieeeAddress;
  return device.driver.getDevices().filter(d => {
    try {
      if (myZclNode) return d.zclNode === myZclNode;
      if (myIeee) return d.getData().ieeeAddress === myIeee;
      return false;
    } catch { return false; }
  });
}

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
    // globally alongside rejoin_tracking_since in app.js/api.js — see
    // resetRejoinStats).
    const count = (device.getStoreValue('rejoin_count') || 0) + 1;
    device.setStoreValue('rejoin_count', count).catch(() => {});
    device.setStoreValue('rejoin_last_at', Date.now()).catch(() => {});

    // Resolve siblings so the DeviceTriggerCard fires for every gang,
    // not just the EP1 device that detected the rejoin.
    let siblings = [device];
    try {
      siblings = getNodeDevices(device);
    } catch (err) {
      device.error('[RejoinManager] getNodeDevices error:', err.message);
    }

    // DeviceTriggerCard — appears directly in each device's flow card list.
    // Fired for every sibling so a flow set up on any gang works correctly.
    try {
      const card = device.homey.flow.getDeviceTriggerCard(cardId);
      for (const dev of siblings) {
        card
          .trigger(dev)
          .catch(err => device.error(`[RejoinManager] ${cardId} trigger failed:`, err.message));
      }
    } catch (err) {
      device.error(`[RejoinManager] ${cardId} error:`, err.message);
    }
  }
}

module.exports = RejoinManager;
