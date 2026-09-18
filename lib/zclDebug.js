'use strict';

// zigbee-clusters' writeAttributes() resolves successfully even when the
// device rejects individual attributes — the per-attribute status array it
// sends back (SUCCESS / MALFORMED_COMMAND / UNSUPPORTED_ATTRIBUTE /
// INVALID_VALUE / etc, see zigbee-clusters/lib/Cluster.js writeAttributes
// command's `response.attributes`) is returned from the call but easy to
// never inspect, so a rejected write looks identical to a successful one
// in the logs.
//
// Use this instead of calling cluster.writeAttributes(...) directly whenever
// a rejection should actually show up in `homey app run` logs.
async function writeAttributesVerbose(device, cluster, attributes) {
  const response = await cluster.writeAttributes(attributes);

  if (response && Array.isArray(response.attributes)) {
    for (const entry of response.attributes) {
      if (entry.status !== 'SUCCESS') {
        const attrName = Object.keys(cluster.constructor.attributes || {})
          .find((name) => cluster.constructor.attributes[name].id === entry.id) || `id_${entry.id}`;
        device.error(
          `Device REJECTED write to '${attrName}' on ${cluster.constructor.NAME}: ${entry.status}`,
        );
      }
    }
  }

  return response;
}

/**
 * Installs device.namedLog()/device.namedError() — NEW properties on the
 * instance, prefixed with the device's own name (e.g. "[Fonte do
 * Escritório]"), instead of relying on the SDK's [Device:<uuid>] prefix.
 *
 * Does NOT touch this.log/this.error: an earlier version tried to shadow
 * those directly and crashed every driver — confirmed on real hardware that
 * they're non-configurable on the instance (both a direct assignment and
 * Object.defineProperty throw). namedLog/namedError are plain new
 * properties, so there's no such restriction. Call once in onNodeInit, then
 * use this.namedLog(...)/this.namedError(...) instead of this.log(...)/
 * this.error(...) for lines you want prefixed.
 */
function installNamedLogging(device) {
  if (device._namedLoggingInstalled) return;
  device._namedLoggingInstalled = true;

  const originalLog = device.log.bind(device);
  const originalError = device.error.bind(device);

  device.namedLog = (...args) => originalLog(`[${device.getName()}]`, ...args);
  device.namedError = (...args) => originalError(`[${device.getName()}]`, ...args);
}

module.exports = { writeAttributesVerbose, installNamedLogging };
