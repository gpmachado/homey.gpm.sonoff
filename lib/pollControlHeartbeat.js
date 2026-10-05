'use strict';

const { BoundCluster, CLUSTER } = require('zigbee-clusters');

/**
 * Poll Control (0x0020) for sleepy sensors (SNZB-04P/04PR2, SNZB-02LD/WD).
 *
 * Expectation, from the logs and iHost captures: check-ins do NOT reach the app (none in
 * 3 h with frame logging on), so Poll Control is not relied on as a heartbeat. The sensors'
 * signs of life are the announce Homey emits every checkInInterval (1740 s thermometers,
 * 3600 s door sensors), battery/IAS reports and, on some models, periodic reports.
 * The binding to the coordinator is made at pairing, so sensors paired before it was
 * added to the driver never check in.
 *
 * What this does, best effort: if a check-in does arrive it is answered first (the sensor is
 * awake, no fast poll) and counted as activity. Nothing is ever sent to the sensor from here:
 * an earlier version also read checkInInterval (for the log only, with retries), which only
 * cost TX to devices that are asleep - the Developer Tools showed 58% TX errors on a SNZB-02LD.
 * The interval is documented instead: 1740 s on the thermometers, 3600 s on the door sensors
 * (iHost pairing captures).
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
}

module.exports = { bindPollControl };
