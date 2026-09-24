'use strict';

const { BoundCluster, CLUSTER } = require('zigbee-clusters');

/**
 * Poll Control (0x0020) check-in for sleepy sensors (SNZB-04PR2 confirmed; testing on
 * SNZB-04P and SNZB-02WD/LD). The device checks in every checkInInterval (1 h per the
 * iHost sniffer on the SNZB-04PR2): a candidate heartbeat for availability tracking.
 * TEST: logs every check-in, counts it as activity (lastSeenAt + availability) and
 * answers checkInResponse without fast poll.
 *
 * Needs the pollControl cluster (32) in the driver's `clusters` and `bindings`: the
 * binding to the coordinator is only made at pairing. SonoffPollControlCluster (see
 * app.js) provides the check-in commands the built-in cluster lacks.
 *
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 */
function bindPollControl(device) {
    const endpoint = device.zclNode.endpoints[1];
    const pollControl = endpoint.clusters.pollControl;
    if (!pollControl) return;

    class PollControlBoundCluster extends BoundCluster {
        checkIn() {
            device._markSeen?.();
            device._markAliveFromAvailability?.('poll-control');
            device.log(`[${device.driver.id}] [PollControl] check-in received`);
            pollControl.checkInResponse({ startFastPolling: false, fastPollTimeout: 0 }, { waitForResponse: false })
                .catch(err => device.log(`[${device.driver.id}] [PollControl] checkInResponse failed:`, err.message));
        }
    }
    endpoint.bind(CLUSTER.POLL_CONTROL.NAME, new PollControlBoundCluster());

    // One-off read so the log shows the intervals this device actually uses.
    pollControl.readAttributes(['checkInInterval', 'longPollInterval', 'shortPollInterval'])
        .then(v => device.log(`[${device.driver.id}] [PollControl] intervals (1/4 s):`, v))
        .catch(err => device.log(`[${device.driver.id}] [PollControl] read failed (device asleep?):`, err.message));
}

module.exports = { bindPollControl };
