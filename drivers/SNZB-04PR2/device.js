'use strict';

const DoorWindowSensor = require('../doorwindowsensorbase');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');

class SonoffSNZB04PR2 extends DoorWindowSensor {

    // 90 min = ~3x the 27 min battery-report heartbeat.
    static AVAILABILITY_TIMEOUT_MS = HEARTBEAT_MEDIUM_MS;

}

module.exports = SonoffSNZB04PR2;
