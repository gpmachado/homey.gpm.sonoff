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
 * Prefixes every this.log()/this.error() call on a device with its
 * user-given name (e.g. "Fonte do Escritório"), instead of relying on the
 * Homey SDK's own [Device:<uuid>] log prefix — much easier to grep/follow
 * in `homey app run -r` output when several devices are active at once.
 *
 * Call once, as the first line of onNodeInit(). Safe to call again on
 * re-init (re-wraps the already-wrapped method idempotently, since it
 * always wraps the *original* log/error saved on first install).
 */
function installNamedLogging(device) {
  if (device._namedLoggingInstalled) return;
  device._namedLoggingInstalled = true;

  const originalLog = device.log.bind(device);
  const originalError = device.error.bind(device);

  // this.log/this.error are getter-only on the SDK's base Device class — a
  // direct assignment (device.log = ...) throws "Cannot assign to read only
  // property" under 'use strict'. Object.defineProperty shadows the getter
  // with an own, writable property instead.
  Object.defineProperty(device, 'log', {
    value: (...args) => originalLog(`[${device.getName()}]`, ...args),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(device, 'error', {
    value: (...args) => originalError(`[${device.getName()}]`, ...args),
    writable: true,
    configurable: true,
  });
}

module.exports = { writeAttributesVerbose, installNamedLogging };
