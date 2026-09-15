'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const IASZoneHelper = require('../../lib/IASZoneHelper');
const { CLUSTER } = require('zigbee-clusters');
const { installNamedLogging } = require('../../lib/zclDebug');

class SonoffSNZB04P extends SonoffBase {

    async onNodeInit({ zclNode }) {
        installNamedLogging(this);
        await super.onNodeInit({ zclNode });

        // SonoffBase only installs a passive battery listener — it never
        // actively reads the value, so measure_battery stays empty until
        // the device happens to send an unsolicited report on its own,
        // which can take hours. Read it once on pairing instead.
        this.readAttribute(CLUSTER.POWER_CONFIGURATION, ['batteryPercentageRemaining'], (data) => {
            if (data?.batteryPercentageRemaining !== undefined) {
                this.setCapabilityValue('measure_battery', data.batteryPercentageRemaining / 2).catch(this.error);
            }
        });

        this._iasZone = new IASZoneHelper(this, {
            endpointId: 1,
            zoneId: 1,
            sendEnrollOnInit: false,
            readInitialState: true,
            configureCieAddress: false,
            onStatus: zoneStatus => this._zoneStatusChangeNotification(zoneStatus),
        });
        await this._iasZone.init(zclNode);

        this.registerCapability('alarm_tamper', SonoffCluster, {
            report: 'tamper',
            reportParser: value => Boolean(value),
            get: 'tamper',
            getParser: value => Boolean(value),
            getOpts: { getOnStart: true, getOnOnline: true },
        });

        this.log('SNZB-04P initialized');
    }

    _zoneStatusChangeNotification(zoneStatus) {
        const contact = IASZoneHelper.hasAlarm(zoneStatus);
        this.log('[SNZB04P] IAS zoneStatus:', zoneStatus, '-> contact:', contact);
        this.setCapabilityValue('alarm_contact', contact).catch(this.error);
    }

    async _teardown() {
        this._iasZone?.dispose();
        await super._teardown?.();
    }

    async onDeleted() {
        await this._teardown();
        this.log('SNZB-04P removed');
    }

}

module.exports = SonoffSNZB04P;
