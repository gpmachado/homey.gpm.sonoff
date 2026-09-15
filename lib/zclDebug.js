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
 * DISABLED — this.log/this.error are defined non-configurable on real SDK
 * Device instances (confirmed on real hardware: both a direct assignment
 * and Object.defineProperty throw — "Cannot assign to read only property"
 * and "Cannot redefine property" respectively). There is no safe way to
 * shadow them on an existing instance; doing so crashed onNodeInit for
 * every driver in the app. Kept as a no-op (rather than removing the 15
 * call sites) so re-enabling this later, with a different approach (e.g. a
 * separate this.namedLog() method drivers call explicitly instead of
 * this.log), doesn't require touching every driver again.
 */
function installNamedLogging() {}

module.exports = { writeAttributesVerbose, installNamedLogging };
