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
 * Runs on lib/FrameMiddleware.js at FRAME_PRIORITY.REJOIN: it only observes frames, never
 * swallows one, and does not itself need to be uninstalled - it lives for the life of the node.
 *
 * Optional write guard (`writeGuardMs` + `getLastWriteAt`): a settings write on the relay models
 * (TurboMode, switch_mode, inching, ...) triggers its own burst of reports, which can accidentally
 * match the OnOff+manufacturer-report pattern. When both options are given, a match is ignored
 * while a write happened less than `writeGuardMs` ago - checked *before* the cooldown window is
 * touched, so a write-induced false match never consumes it and a genuine rejoin right after the
 * guard clears is still detected. `getLastWriteAt` lets each driver keep its own timestamp with
 * its own scope (per-device on ZBMINIR2/MINI-ZBD, per-node on MINI-ZB2GS, whose two gangs share
 * the write guard because either one's write can produce the burst on the shared node).
 */

const { FrameMiddleware, FRAME_PRIORITY } = require('./FrameMiddleware');

const ON_OFF_CLUSTER_ID = 0x0006;
const REPORT_ATTRIBUTES = 0x0a;
const HANDLER_ID = 'rejoin';

/**
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device driver instance; needs `node` and
 *   `_notifyRejoin()`.
 * @param {object} options
 * @param {number} options.sonoffClusterId the manufacturer cluster id (SonoffCluster.ID)
 * @param {number} [options.windowMs=200] the two reports must arrive within this time
 * @param {number} [options.cooldownMs=5000] minimum time between two detections
 * @param {number} [options.writeGuardMs=0] suppress a match for this long after the device's own
 *   most recent settings write (0 disables the guard)
 * @param {() => number} [options.getLastWriteAt] returns the timestamp of that last write
 */
function installRejoinDetection(device, {
  sonoffClusterId, windowMs = 200, cooldownMs = 5000, writeGuardMs = 0, getLastWriteAt,
}) {
  const node = device.node;
  if (!node) return false;

  // The hook lives on the node, so it points at the device through the node: a re-init of
  // the device (a new instance on the same node) takes over without stacking a second hook.
  node._rejoinDetectionDevice = device;
  if (node._rejoinDetectionInstalled) return true;
  node._rejoinDetectionInstalled = true;

  let onOffReportAt = 0;
  let lastDetectionAt = 0;
  FrameMiddleware.for(node).register(HANDLER_ID, FRAME_PRIORITY.REJOIN, (endpointId, clusterId, frame) => {
    if (!Buffer.isBuffer(frame) || frame.length < 3) return;
    const manufacturerSpecific = (frame[0] & 0x04) !== 0;
    const commandId = manufacturerSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
    if (commandId !== REPORT_ATTRIBUTES || manufacturerSpecific) return;

    const now = Date.now();
    if (clusterId === ON_OFF_CLUSTER_ID) {
      onOffReportAt = now;
      return;
    }
    if (clusterId !== sonoffClusterId || now - onOffReportAt >= windowMs) return;
    // Checked before the cooldown line below: a write-induced false match must not consume it.
    if (writeGuardMs > 0 && getLastWriteAt && now - getLastWriteAt() < writeGuardMs) return;
    if (now - lastDetectionAt < cooldownMs) return;
    lastDetectionAt = now;
    try {
      node._rejoinDetectionDevice?._notifyRejoin();
    } catch (err) {
      node._rejoinDetectionDevice?.error?.('[Rejoin] detection failed:', err.message);
    }
    // Never returns false: this handler only observes.
  });
  return true;
}

module.exports = { installRejoinDetection };
