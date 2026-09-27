'use strict';

/**
 * @file rejoinDetection.js
 * @description Power-cut ("rejoin") detection for Sonoff mains devices, from the boot dump the
 * device sends when it comes back: an OnOff (0x0006) Report Attributes and, within a few tens of
 * milliseconds, a manufacturer cluster (0xFC11) Report Attributes. The periodic 0xFC11 reports
 * arrive without an OnOff companion, so requiring both keeps them from counting.
 *
 * Measured on the MINI-ZB1GP (three power cuts, 14 to 28 ms apart) and, with the same rule
 * written into each driver, on the ZBMINIR2 (~8 ms). Every completed cut gave one pair; a cut
 * shorter than the device's boot and rejoin gave none.
 *
 * The hook wraps node.handleFrame once per node and only reads the frames: it always passes
 * them on. Install it before AvailabilityManagerPassive, which must stay the last layer (see
 * the note in drivers/sonoffbase.js).
 */

const ON_OFF_CLUSTER_ID = 0x0006;
const REPORT_ATTRIBUTES = 0x0a;

/**
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device driver instance; needs `node` and
 *   `_notifyRejoin()`.
 * @param {object} options
 * @param {number} options.sonoffClusterId the manufacturer cluster id (SonoffCluster.ID)
 * @param {number} [options.windowMs=200] the two reports must arrive within this time
 * @param {number} [options.cooldownMs=5000] minimum time between two detections
 */
function installRejoinDetection(device, { sonoffClusterId, windowMs = 200, cooldownMs = 5000 }) {
  const node = device.node;
  if (!node || typeof node.handleFrame !== 'function') return false;

  // The hook lives on the node, so it points at the device through the node: a re-init of
  // the device (a new instance on the same node) takes over without stacking a second hook.
  node._rejoinDetectionDevice = device;
  if (node._rejoinDetectionInstalled) return true;
  node._rejoinDetectionInstalled = true;

  let onOffReportAt = 0;
  let lastDetectionAt = 0;
  const original = node.handleFrame.bind(node);
  node.handleFrame = (...args) => {
    const [, clusterId, frame] = args;
    if (Buffer.isBuffer(frame) && frame.length >= 3) {
      const manufacturerSpecific = (frame[0] & 0x04) !== 0;
      const commandId = manufacturerSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
      if (commandId === REPORT_ATTRIBUTES && !manufacturerSpecific) {
        const now = Date.now();
        if (clusterId === ON_OFF_CLUSTER_ID) {
          onOffReportAt = now;
        } else if (clusterId === sonoffClusterId
          && now - onOffReportAt < windowMs
          && now - lastDetectionAt >= cooldownMs) {
          lastDetectionAt = now;
          try {
            node._rejoinDetectionDevice?._notifyRejoin();
          } catch (err) {
            node._rejoinDetectionDevice?.error?.('[Rejoin] detection failed:', err.message);
          }
        }
      }
    }
    return original(...args);
  };
  return true;
}

module.exports = { installRejoinDetection };
