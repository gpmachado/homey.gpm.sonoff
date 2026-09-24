'use strict';

/**
 * connectedDevices.js - ported from nova.digital.homeyapp.
 *
 * Shared utilities for multi-gang devices that register as separate Homey
 * sub-devices sharing one physical Zigbee node (MINI-ZB2GS).
 */

/**
 * Returns all Homey device instances that share the same physical Zigbee node
 * as `device` (including `device` itself).
 *
 * zclNode is shared by all sub-devices of the same node and is more reliable
 * than ieeeAddress (which may be absent on sub-devices).
 *
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 * @returns {Array}
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

/**
 * Writes the device_siblings_info label to every device of the node, main
 * device first and tagged "(Main)".
 *
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 */
async function updateSiblingNames(device) {
  try {
    const siblings = getNodeDevices(device)
      .sort((a, b) => Number(Boolean(a.getData().subDeviceId)) - Number(Boolean(b.getData().subDeviceId)));
    if (!siblings.length) return;
    const infoText = siblings
      .map(d => (d.getData().subDeviceId ? d.getName() : `${d.getName()} (Main)`))
      .join(' • ');
    await Promise.allSettled(
      siblings.map(d => d.setSettings({ device_siblings_info: infoText }).catch(() => {})),
    );
  } catch (err) {
    device.error('Error updating sibling names:', err.message);
  }
}

module.exports = { getNodeDevices, updateSiblingNames };
