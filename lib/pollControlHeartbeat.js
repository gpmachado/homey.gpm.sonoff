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

    // Read the intervals for the log. A sleepy sensor is almost always asleep at app start,
    // so a failed read stays pending and is retried on the device's next sign of life
    // (see retryPollControlIfPending).
    device._pollControlPending = true;
    device._pollControlAttempts = 0;
    readPollControlIntervals(device);
}

const POLL_CONTROL_MAX_ATTEMPTS = 6;

function readPollControlIntervals(device) {
    const pollControl = device.zclNode?.endpoints?.[1]?.clusters?.pollControl;
    if (!pollControl || device._pollControlReading || !device._pollControlPending) return;
    if (device._pollControlAttempts >= POLL_CONTROL_MAX_ATTEMPTS) {
        device._pollControlPending = false;
        return;
    }
    device._pollControlReading = true;
    device._pollControlAttempts += 1;
    pollControl.readAttributes(['checkInInterval', 'longPollInterval', 'shortPollInterval'])
        .then(v => {
            device._pollControlPending = false;
            device.log(`[${device.driver.id}] [PollControl] intervals (1/4 s):`, v);
        })
        .catch(err => device.log(`[${device.driver.id}] [PollControl] read failed (device asleep?), will retry when it is next heard from:`, err.message))
        .finally(() => { device._pollControlReading = false; });
}

/**
 * Call when the device has just shown it is awake (report, announce): completes a
 * Poll Control read that failed earlier because the sensor was asleep.
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 */
function retryPollControlIfPending(device) {
    if (device._pollControlPending) readPollControlIntervals(device);
}

module.exports = { bindPollControl, retryPollControlIfPending };
