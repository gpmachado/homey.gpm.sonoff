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
            // Answer first while the sleepy device is still awake. The SNZB-02 iHost
            // capture shows a Check-in followed by Check-in Response with fast polling
            // disabled; availability bookkeeping and reporting retries can use the
            // remainder of the wake window.
            pollControl.checkInResponse({ startFastPolling: false, fastPollTimeout: 0 }, { waitForResponse: false })
                .catch(err => device.log(`[${device.driver.id}] [PollControl] checkInResponse failed:`, err.message));
            device._markSeen?.();
            device._markAliveFromAvailability?.('poll-control');
            device.log(`[${device.driver.id}] [PollControl] check-in received`);
        }
    }
    endpoint.bind(CLUSTER.POLL_CONTROL.NAME, new PollControlBoundCluster());

    // This is diagnostic only. Do not query at app startup: sleepy sensors are usually
    // asleep then, and a timed-out request can overlap their next real activity. Read
    // once after the device next reports/announces activity instead.
    device._pollControlPending = true;
    device._pollControlAttempts = 0;
    device._pollControlLastAttemptAt = 0;
}

const POLL_CONTROL_MAX_ATTEMPTS = 6;
// Several IAS/attribute reports can arrive in one wake window. Treat them as one
// opportunity; otherwise each timeout can trigger another request while the sensor
// is already asleep again.
const POLL_CONTROL_RETRY_INTERVAL_MS = 30 * 1000;

function readPollControlIntervals(device) {
    const pollControl = device.zclNode?.endpoints?.[1]?.clusters?.pollControl;
    if (!pollControl || device._pollControlReading || !device._pollControlPending) return;
    if (device._pollControlAttempts >= POLL_CONTROL_MAX_ATTEMPTS) {
        device._pollControlPending = false;
        device.log(`[${device.driver.id}] [PollControl] interval read abandoned after ${POLL_CONTROL_MAX_ATTEMPTS} attempts`);
        return;
    }
    const now = Date.now();
    if (now - device._pollControlLastAttemptAt < POLL_CONTROL_RETRY_INTERVAL_MS) return;
    device._pollControlReading = true;
    device._pollControlAttempts += 1;
    device._pollControlLastAttemptAt = now;
    // Match the iHost pairing trace: it reads only checkInInterval. The other two
    // values are not used by this app, so querying them only spends airtime in the
    // sensor's short awake window.
    pollControl.readAttributes(['checkInInterval'])
        .then(v => {
            device._pollControlPending = false;
            const interval = v?.checkInInterval;
            if (Number.isFinite(interval)) {
                device.log(`[${device.driver.id}] [PollControl] checkInInterval: ${interval} quarter-seconds (${interval / 4}s)`);
            } else {
                device.log(`[${device.driver.id}] [PollControl] checkInInterval read:`, v);
            }
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
