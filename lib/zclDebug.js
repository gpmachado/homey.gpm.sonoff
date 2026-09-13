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

module.exports = { writeAttributesVerbose };
