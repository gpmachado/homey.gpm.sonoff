'use strict';

const DoorWindowSensor = require('../doorwindowsensorbase');
const IASZoneHelper = require('../../lib/IASZoneHelper');

// Water leak sensor: IAS Zone type waterSensor. As in zigbee-herdsman-converters
// (iasZoneAlarm water_leak + battery_low), the leak is alarm 1 (bit 0) and the low
// battery flag is bit 3 of the same zoneStatus. Battery reporting and the
// lastSeenAt feed come from the shared base.
class SonoffSNZB05P extends DoorWindowSensor {

    _zoneStatusChangeNotification(zoneStatus) {
        const leak = IASZoneHelper.hasAlarm1(zoneStatus);
        const batteryLow = IASZoneHelper.hasBatteryLow(zoneStatus);
        this.log(`[${this.driver.id}] IAS zoneStatus:`, zoneStatus, `-> water: ${leak}, battery low: ${batteryLow}`);
        this.setCapabilityValue('alarm_water', leak).catch(this.error);
        this.setCapabilityValue('alarm_battery', batteryLow).catch(this.error);
    }

}

module.exports = SonoffSNZB05P;
