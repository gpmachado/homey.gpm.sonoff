'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const IASZoneHelper = require('../../lib/IASZoneHelper');

class SonoffSNZB04P extends SonoffBase {

    async onNodeInit({ zclNode }) {
        await super.onNodeInit({ zclNode });

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
