'use strict';

const RelaySwitchBase = require('../relaySwitchBase');

// All logic lives in RelaySwitchBase (shared with MINI-ZBD - same firmware, see
// drivers/relaySwitchBase.js). This driver keeps its own folder for a distinct
// icon and name in the Homey app; `this.driver.id` ("ZBMINIR2") drives every
// driver-specific string (flow card id, log prefixes) at runtime.
class SonoffZBMINIR2 extends RelaySwitchBase {}

module.exports = SonoffZBMINIR2;
