'use strict';

const DoorWindowSensor = require('../doorwindowsensorbase');
const { HEARTBEAT_SLOW_MS } = require('../../lib/constants');

class SonoffSNZB04P extends DoorWindowSensor {

    // The SNZB-04P only heartbeats through an hourly Device Announce (field log, 8 h:
    // 3600 s apart, no periodic battery report), so 2.5 h.
    static AVAILABILITY_TIMEOUT_MS = HEARTBEAT_SLOW_MS;

}

module.exports = SonoffSNZB04P;
