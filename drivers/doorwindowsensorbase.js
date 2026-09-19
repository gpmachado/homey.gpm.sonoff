'use strict';

const SonoffBase = require('./sonoffbase');
const SonoffCluster = require('../lib/SonoffCluster');
const IASZoneHelper = require('../lib/IASZoneHelper');
const { CLUSTER } = require('zigbee-clusters');

// Sniffer-confirmed (snzb04p-pareamento.pcapng, frames 313-315 & 372-374):
// Sonoff's own iHost hub configures exactly the battery entries on
// powerConfiguration and gets Status: Success from the device.
// minInterval/maxInterval ~1620-1740s form a periodic "heartbeat" battery
// report regardless of change; batteryVoltage's huge minChange (10V)
// effectively disables its change-trigger, leaving only the periodic report
// as its source.
//
// `tamper` (manufacturer-specific SonoffCluster) is deliberately NOT configured:
// iHost never attempts it, and on real hardware (SNZB-04P) the device answers
// UNSUPPORTED_ATTRIBUTE every time (homey-zigbeedriver even resends it twice, so
// 3 rejected requests plus an [err] per start). It reports on its own, which the
// passive `report` listener below picks up.
//
// Sent straight through the cluster (not this.configureAttributeReporting):
// that wrapper resends twice and prints an [err] stack trace on every failure,
// which for a sleeping device is just noise.
const REPORTING = {
    battery: {
        cluster: CLUSTER.POWER_CONFIGURATION.NAME,
        attributes: {
            batteryPercentageRemaining: { minInterval: 1620, maxInterval: 1740, minChange: 2 },
            batteryVoltage: { minInterval: 1620, maxInterval: 1740, minChange: 100 },
        },
    },
};

/**
 * Shared base for the SNZB-04P and SNZB-04PR2 door/window sensors (identical
 * behaviour, only the driver id differs). Sleepy IAS Zone end-device with no
 * confirmed heartbeat, so no availability tracking here.
 */
class DoorWindowSensor extends SonoffBase {

    async onNodeInit({ zclNode }) {
        await super.onNodeInit({ zclNode });

        // SonoffBase only installs a passive battery listener - it never
        // actively reads the value, so measure_battery stays empty until
        // the device happens to send an unsolicited report on its own,
        // which can take hours. Read it once on pairing instead.
        this.readAttribute(CLUSTER.POWER_CONFIGURATION, ['batteryPercentageRemaining'], (data) => {
            if (data?.batteryPercentageRemaining !== undefined) {
                this.setCapabilityValue('measure_battery', data.batteryPercentageRemaining / 2).catch(this.error);
            }
        });

        // This is a sleepy end-device: a configureReporting request sent right now
        // (onNodeInit, outside its wake window) commonly gets no ACK at all - not a
        // rejection, just silence - and the promise only rejects on Homey's own
        // send-timeout. Track success per group and keep retrying opportunistically
        // whenever the device proves it's awake (IAS activity, rejoin), instead of
        // trying exactly once and giving up. Set before the IAS init below, whose
        // first read already counts as activity.
        // The reporting config lives on the device, so once it was accepted there is
        // nothing to resend on later app starts (which would only hit a sleeping
        // device); it is redone after a rejoin (onEndDeviceAnnounce).
        this._reporting = {};
        for (const key of Object.keys(REPORTING)) {
            this._reporting[key] = { pending: !this.getStoreValue(`reporting_configured_${key}`), busy: false };
        }

        this._iasZone = new IASZoneHelper(this, {
            endpointId: 1,
            zoneId: 1,
            sendEnrollOnInit: false,
            readInitialState: true,
            configureCieAddress: false,
            onStatus: zoneStatus => this._zoneStatusChangeNotification(zoneStatus),
            onActivity: () => { this._markSeen(); this._retryPendingReporting(); },
        });
        await this._iasZone.init(zclNode);

        this._retryPendingReporting();

        // No `get`/getOpts either: the attribute always answers
        // UNSUPPORTED_ATTRIBUTE, so a getOnStart/getOnOnline read would just fail
        // every time. The passive `report` listener is the only mechanism that works.
        this.registerCapability('alarm_tamper', SonoffCluster, {
            report: 'tamper',
            reportParser: value => { this._markSeen(); return Boolean(value); },
        });

        this.log(`${this.driver.id} initialized`);
    }

    _zoneStatusChangeNotification(zoneStatus) {
        const contact = IASZoneHelper.hasAlarm(zoneStatus);
        this.log(`[${this.driver.id}] IAS zoneStatus:`, zoneStatus, '-> contact:', contact);
        this.setCapabilityValue('alarm_contact', contact).catch(this.error);
    }

    // One request per group at a time: every IAS event while a slow sleepy
    // device hasn't answered yet would otherwise start another overlapping one.
    async _tryConfigureReporting(key) {
        const state = this._reporting?.[key];
        if (!state || !state.pending || state.busy) return;
        state.busy = true;
        try {
            const { cluster, attributes } = REPORTING[key];
            await this.zclNode.endpoints[1].clusters[cluster].configureReporting(attributes);
            state.pending = false;
            this.setStoreValue(`reporting_configured_${key}`, true).catch(() => {});
            this.log(`[${this.driver.id}] ${key} configureReporting succeeded`);
        } catch (err) {
            if (SonoffBase.isDefinitiveZclRejection(err)) {
                state.pending = false;
                this.log(`[${this.driver.id}] ${key} configureReporting rejected, giving up:`, err.message);
            } else {
                this.log(`[${this.driver.id}] ${key} configureReporting still pending (device asleep?):`, err.message);
            }
        } finally {
            state.busy = false;
        }
    }

    _retryPendingReporting() {
        for (const key of Object.keys(REPORTING)) this._tryConfigureReporting(key);
    }

    onEndDeviceAnnounce() {
        this._markSeen();
        this.log(`[${this.driver.id}] Device rejoined network (End Device Announce)`);
        for (const key of Object.keys(REPORTING)) {
            if (this._reporting?.[key]) this._reporting[key].pending = true;
            this.setStoreValue(`reporting_configured_${key}`, false).catch(() => {});
        }
        this._retryPendingReporting();
    }

    async _teardown() {
        this._iasZone?.dispose();
        await super._teardown?.();
    }

    async onDeleted() {
        await this._teardown();
        this.log(`${this.driver.id} removed`);
    }

}

module.exports = DoorWindowSensor;
