'use strict';

const RelaySwitchBase = require('../relaySwitchBase');

// All logic lives in RelaySwitchBase (shared with ZBMINIR2 - same firmware, z2m
// lists MINI-ZBD as a white-label of that device; see drivers/relaySwitchBase.js).
// This driver keeps its own folder for a distinct icon and name in the Homey app;
// `this.driver.id` ("MINI-ZBD") drives every driver-specific string at runtime.
class SonoffMINIZBD extends RelaySwitchBase {}

module.exports = SonoffMINIZBD;
