'use strict';

const SonoffCluster = require('../../lib/SonoffCluster');
const { CLUSTER, BoundCluster } = require('zigbee-clusters');
const SonoffBase = require('../sonoffbase');
const RejoinManager = require('../../lib/RejoinManager');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');
const { writeAttributesVerbose } = require('../../lib/zclDebug');
const { getNodeDevices, updateSiblingNames } = require('../../lib/connectedDevices');

/**
 * SonoffMINIZB2GS - MINI-ZB2GS (DUO) 2-gang switch, one Homey device per gang.
 *
 * Two sub-devices share a single Zigbee node (same pattern as the NovaDigital
 * multi-gang switches):
 *   - main device  -> endpoint 1 (subDeviceId: undefined), channel 1
 *   - secondSwitch -> endpoint 2, channel 2
 *
 * Both endpoints carry onOff (0x0006) and SonoffCluster (0xFC11), so per-gang
 * settings (switch mode, power-on behaviour/delay, inching) live on the gang's
 * own endpoint. Device-wide settings (turbo mode, network LED) and the detach
 * relay bitmap (detach_relay_mode2, bit0 = ch1, bit1 = ch2) live on endpoint 1
 * - see zigbee-herdsman-converters' MINI-ZB2GS definition.
 *
 * Availability, active poll and rejoin detection run on the main device only;
 * AvailabilityManager cascades availability to the second gang and
 * RejoinManager fires the rejoin card on both tiles.
 */

const GANG_ENDPOINT = {
    secondSwitch: 2,
};

// Handles external switch commands (detach relay mode) sent directly to the hub
class MyOnOffBoundCluster extends BoundCluster {
    constructor(device) {
        super();
        this._device = device;
        this._click = device.homey.flow.getDeviceTriggerCard('MINI-ZB2GS:click');
    }
    toggle() {
        this._device.log(`[detach_mode] toggle received (external switch, ep${this._device._endpointId})`);
        this._click.trigger(this._device, {}, {}).catch(this._device.error);
    }
    setOn() {
        this._device.log(`[detach_mode] setOn received (external switch, ep${this._device._endpointId})`);
        this._device.setCapabilityValue('onoff', true).catch(this._device.error);
    }
    setOff() {
        this._device.log(`[detach_mode] setOff received (external switch, ep${this._device._endpointId})`);
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
    onWithTimedOff({ onOffControl, onTime, offWaitTime }) {
        this._device.log('[detach_mode] onWithTimedOff received', { onOffControl, onTime, offWaitTime });
    }
    offWithEffect() {
        this._device.log(`[detach_mode] offWithEffect received (external switch, ep${this._device._endpointId})`);
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
}

// Per-gang SonoffCluster attributes, read from the gang's own endpoint.
const GANG_ATTRIBUTES = [
    'power_on_delay_state',
    'power_on_delay_time',
    'switch_mode',
];

// Device-wide SonoffCluster attributes, endpoint 1 only.
const MAIN_ATTRIBUTES = [
    'TurboMode',
    'network_led',
];

const INCHING_PROTOCOL = {
    CMD:             0x01,
    SUBCMD_INCHING:  0x17,
    PAYLOAD_LENGTH:  0x07,
    SEQ_NUM:         0x80,
    FLAG_ENABLE:     0x80,
    FLAG_MODE_ON:    0x01,
};

class SonoffMINIZB2GS extends SonoffBase {

    async onNodeInit({ zclNode }) {

        const { subDeviceId } = this.getData();
        this._endpointId = GANG_ENDPOINT[subDeviceId] ?? 1;
        this._isMainDevice = !subDeviceId;

        super.onNodeInit({ zclNode });
        this.log(`MINI-ZB2GS init - gang ${this._endpointId} (${this._isMainDevice ? 'main' : subDeviceId})`);

        if (this.hasCapability('onoff')) {
            // Same fire-and-forget wiring as ZBMINIR2: this family's firmware
            // doesn't reliably answer setOn/setOff with a ZCL Default Response,
            // so registerCapability's 10s wait would time out. The onOff report
            // that follows the switch updates the capability.
            const _onOffCluster = zclNode.endpoints[this._endpointId].clusters.onOff;

            this._onOnOff ??= value => {
                this.log(`handle report (cluster: onOff, capability: onoff, ep${this._endpointId}), parsed payload: ${value}`);
                this.setCapabilityValue('onoff', value).catch(this.error);
            };
            _onOffCluster.removeListener('attr.onOff', this._onOnOff);
            _onOffCluster.on('attr.onOff', this._onOnOff);

            this.registerCapabilityListener('onoff', async value => {
                this.log(`set onoff -> ${value} (cluster: onOff, endpoint: ${this._endpointId})`);
                if (value) {
                    return _onOffCluster.setOn({}, { waitForResponse: false });
                }
                return _onOffCluster.setOff({}, { waitForResponse: false });
            });
        }

        // Deferred 30 s: mesh routes are stale immediately after boot (see ZBMINIR2).
        this.homey.setTimeout(() => {
            if (!this.zclNode) return;
            this.zclNode.endpoints[this._endpointId].clusters.onOff.configureReporting({
                onOff: { minInterval: 0, maxInterval: 1800, minChange: 1 }, // 30 min
            }).catch(err => this.log('[Reporting] boot config failed:', err.message));
        }, 30_000);

        this.zclNode.endpoints[this._endpointId].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));

        if (this._isMainDevice) this._installFrameHook();

        // Read initial data so the settings UI reflects the device's actual
        // configuration rather than Homey's stored defaults.
        await this.checkAttributes();

        if (this._isMainDevice) {
            // Both gangs report onOff every <=30 min; 90 min gives 3x that as
            // buffer (medium tier, same as ZBMINIR2). The watchdog cascades to
            // the second gang (AvailabilityManager#_getSiblings).
            this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_MEDIUM_MS });
            await this._availability.install();
            this._startActivePoll();
        } else {
            // Show the main gang's device-wide settings as read-only labels.
            const main = getNodeDevices(this).find(d => d._isMainDevice);
            if (main) main._propagateGlobalLabels();

            // Homey marks every device available on init - if the main gang
            // already knows the node is offline, follow it.
            if (main && main._availability && !main.getAvailable()) {
                this.setUnavailable(main.getStoreValue('availability_unavailable_reason') || 'Device unreachable').catch(() => {});
            }
        }

        updateSiblingNames(this).catch(() => {});

        this.log(`MINI-ZB2GS gang ${this._endpointId} initialized`);
    }

    /**
     * Node-level handleFrame hook (main device only - the node is shared):
     *   1. Drop Sonoff manufacturer ACK frames (cmdId 0x0B) that zigbee-clusters
     *      can't route via BoundCluster (inching ACK, stray defaultResponse on onOff).
     *   2. Rejoin detection: 0xFC11 Report Attributes + 0x0006 Report Attributes
     *      within 200ms - the boot-dump pattern of the MINI family (ZBMINIR2,
     *      MINI-ZBD). Both endpoints dump on boot; the 30s cooldown in
     *      _notifyRejoin collapses them into one event.
     */
    _installFrameHook() {
        this._onOffReportTs = 0;
        if (this.node._zb2gsFrameHookInstalled) {
            this.log('[MINI-ZB2GS] handleFrame hook already installed (shared node)');
            return;
        }
        this.node._zb2gsFrameHookInstalled = true;
        const _hook = this.node.handleFrame.bind(this.node);
        this.node.handleFrame = (...args) => {
            const [, clusterId, frame] = args;
            const _now = Date.now();
            if (Buffer.isBuffer(frame) && frame.length >= 3) {
                const mfrSpecific = frame[0] & 0x04;
                const cmdId = mfrSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
                if (cmdId === 0x0B && (clusterId === SonoffCluster.ID || clusterId === 6)) return Promise.resolve();
                if (cmdId === 0x0A && !mfrSpecific) {
                    if (clusterId === 6) {
                        this._onOffReportTs = _now;
                    } else if (clusterId === SonoffCluster.ID) {
                        if ((_now - this._onOffReportTs) < 200 && _now - (this.node._zb2gsLastSonoffWriteAt ?? 0) >= 30_000) {
                            this._notifyRejoin();
                        }
                    }
                }
            }
            return _hook(...args);
        };
    }

    async onSettings({ newSettings, changedKeys }) {
        const ep = this.zclNode.endpoints[this._endpointId];

        if (changedKeys.includes('power_on_behavior')) {
            try {
                await writeAttributesVerbose(this, ep.clusters.onOff, { powerOnBehavior: newSettings.power_on_behavior });
            } catch (error) {
                this.log('Error updating the power on behavior:', error.message);
            }
        }

        // Per-gang SonoffCluster attributes, on this gang's endpoint.
        // power_on_delay_time: seconds in the UI, 0.5 s units on the wire.
        // switch_mode: stored as string (dropdown), firmware expects an integer.
        const gangWrite = {};
        if (changedKeys.includes('power_on_delay_state')) gangWrite.power_on_delay_state = Boolean(newSettings.power_on_delay_state);
        if (changedKeys.includes('power_on_delay_time')) gangWrite.power_on_delay_time = Math.round(newSettings.power_on_delay_time * 2);
        if (changedKeys.includes('switch_mode')) gangWrite.switch_mode = Number(newSettings.switch_mode);
        if (Object.keys(gangWrite).length) {
            this.node._zb2gsLastSonoffWriteAt = Date.now();
            this.writeAttributes(SonoffCluster, gangWrite).catch(this.error);
        }

        // Device-wide settings - only the main device has them.
        // TurboMode: boolean checkbox -> int16 expected by device (20=on, 9=off).
        const mainWrite = {};
        if (changedKeys.includes('TurboMode')) mainWrite.TurboMode = newSettings.TurboMode ? 20 : 9;
        if (changedKeys.includes('network_led')) mainWrite.network_led = Boolean(newSettings.network_led);
        if (Object.keys(mainWrite).length) {
            this.node._zb2gsLastSonoffWriteAt = Date.now();
            this.writeAttributes(SonoffCluster, mainWrite).catch(this.error);
            // onSettings runs before the new values are stored.
            setImmediate(() => this._propagateGlobalLabels(newSettings));
        }

        if (changedKeys.includes('detach_mode')) {
            await this._setDetachRelay(Boolean(newSettings.detach_mode));
        }

        const inchingKeys = ['inching_enabled', 'inching_mode', 'inching_time'];
        if (changedKeys.some(key => inchingKeys.includes(key))) {
            try {
                await this.setInching(
                    newSettings.inching_enabled,
                    newSettings.inching_time,
                    newSettings.inching_mode
                );
                this.log('Inching settings updated:', {
                    gang: this._endpointId,
                    enabled: newSettings.inching_enabled,
                    mode: newSettings.inching_mode,
                    time: newSettings.inching_time
                });
            } catch (error) {
                this.error('Error updating inching settings:', error);
                throw new Error('Failed to update inching settings');
            }
        }
    }

    /**
     * Detach relay is one bitmap for the whole device (detach_relay_mode2 on
     * endpoint 1, bit0 = channel 1, bit1 = channel 2) - read-modify-write so
     * changing one gang leaves the other untouched. Falls back to the other
     * gang's stored setting if the read fails.
     */
    async _setDetachRelay(enabled) {
        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        const myBit = 1 << (this._endpointId - 1);
        let current;
        try {
            ({ detach_relay_mode2: current } = await cluster.readAttributes(['detach_relay_mode2']));
        } catch (err) {
            this.log('[detach_mode] bitmap read failed, using stored settings:', err.message);
        }
        if (typeof current !== 'number') {
            current = 0;
            for (const d of getNodeDevices(this)) {
                if (d !== this && d.getSetting('detach_mode')) current |= 1 << ((d._endpointId ?? 1) - 1);
            }
        }
        const value = enabled ? (current | myBit) : (current & ~myBit);
        this.log(`[detach_mode] gang ${this._endpointId} -> ${enabled} (bitmap 0x${current.toString(16)} -> 0x${value.toString(16)})`);
        this.node._zb2gsLastSonoffWriteAt = Date.now();
        await writeAttributesVerbose(this, cluster, { detach_relay_mode2: value });
    }

    /**
     * Set inching (auto-off/on) configuration for this gang.
     * Same protocolData frame as ZBMINIR2, with the channel byte set and sent
     * to the gang's own endpoint (as zigbee-herdsman-converters does).
     * @param {boolean} enabled - Enable or disable inching
     * @param {number} time - Time in seconds (0.5-3599.5)
     * @param {string} mode - 'on' (turn ON then OFF) or 'off' (turn OFF then ON)
     */
    async setInching(enabled = false, time = 1, mode = 'on') {
        if (typeof enabled !== 'boolean') throw new TypeError(`enabled must be boolean, got ${typeof enabled}`);
        if (typeof time !== 'number' || time < 0 || time > 32767.5) throw new RangeError(`time must be 0-32767.5 s, got ${time}`);
        if (!['on', 'off'].includes(mode)) throw new TypeError(`mode must be "on" or "off", got "${mode}"`);

        try {
            const tmpTime = Math.min(Math.max(Math.round(time * 2), 1), 0xffff);

            const payloadValue = [
                INCHING_PROTOCOL.CMD,
                INCHING_PROTOCOL.SUBCMD_INCHING,
                INCHING_PROTOCOL.PAYLOAD_LENGTH,
                INCHING_PROTOCOL.SEQ_NUM,
                (enabled ? INCHING_PROTOCOL.FLAG_ENABLE : 0) | (mode === 'on' ? INCHING_PROTOCOL.FLAG_MODE_ON : 0),
                this._endpointId - 1, // channel: 0x00 = ch1, 0x01 = ch2
                tmpTime & 0xff,
                (tmpTime >> 8) & 0xff,
                0x00,
                0x00,
                0x00,
            ];
            payloadValue[10] = this._calculateChecksum(payloadValue, INCHING_PROTOCOL.PAYLOAD_LENGTH + 3);

            this.log('Sending inching command:', { gang: this._endpointId, enabled, mode, time_s: time, time_half_s: tmpTime });

            const cluster = this.zclNode.endpoints[this._endpointId].clusters[SonoffCluster.NAME];
            await cluster.protocolData(
                { data: Buffer.from(payloadValue) },
                { disableDefaultResponse: true, waitForResponse: false }
            );
            this.log('Inching command sent successfully');
        } catch (error) {
            this.error('Failed to set inching:', error);
            throw error;
        }
    }

    _calculateChecksum(payload, length) {
        let checksum = 0x00;
        for (let i = 0; i < length; i++) checksum ^= payload[i];
        return checksum;
    }

    /**
     * Fires the device_rejoined flow trigger (main device; RejoinManager
     * cascades the card to the second gang).
     * Guard: 30s cooldown deduplicates burst reports from the same rejoin event.
     */
    _notifyRejoin() {
        const now = Date.now();
        if ((now - (this._lastRejoinTs ?? 0)) < 30_000) return;  // burst cooldown
        this._lastRejoinTs = now;
        this.onDeviceRejoin();
    }

    onDeviceRejoin() {
        this.log('Device rejoined');
        RejoinManager.triggerRejoin(this);
    }

    async checkAttributes() {
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            this.setSettings({ power_on_behavior: data.powerOnBehavior }).catch(this.error);
        });

        const attributes = this._isMainDevice ? [...GANG_ATTRIBUTES, ...MAIN_ATTRIBUTES] : GANG_ATTRIBUTES;
        this.readAttribute(SonoffCluster, attributes, (data) => {
            if (!data) return;
            const settingsData = {};
            if (data.TurboMode !== undefined)            settingsData.TurboMode            = data.TurboMode === 20;
            if (data.network_led !== undefined)          settingsData.network_led          = Boolean(data.network_led);
            if (data.power_on_delay_state !== undefined) settingsData.power_on_delay_state = Boolean(data.power_on_delay_state);
            // Clamp to the settings schema's min (0.5) - the device reports 0
            // when the delay is disabled.
            if (data.power_on_delay_time !== undefined)  settingsData.power_on_delay_time  = Math.max(0.5, data.power_on_delay_time / 2);
            if (data.switch_mode !== undefined)          settingsData.switch_mode          = String(data.switch_mode);
            if (Object.keys(settingsData).length) {
                this.setSettings(settingsData)
                    .then(() => { if (this._isMainDevice) this._propagateGlobalLabels(); })
                    .catch(this.error);
            }
        });

        // Detach relay bitmap lives on endpoint 1 for both gangs.
        try {
            const { detach_relay_mode2: bitmap } = await this.zclNode.endpoints[1].clusters[SonoffCluster.NAME]
                .readAttributes(['detach_relay_mode2']);
            if (typeof bitmap === 'number') {
                this.setSettings({ detach_mode: Boolean(bitmap & (1 << (this._endpointId - 1))) }).catch(this.error);
            }
        } catch (err) {
            this.log('[detach_mode] initial read failed:', err.message);
        }
    }

    // -------------------------------------------------------------------------
    // Global settings propagation to secondary device tile
    // (same as _propagateSwitchModeLabel in the NovaDigital 2/3-gang drivers)
    // -------------------------------------------------------------------------

    /**
     * Mirror the main gang's device-wide settings (turbo mode, network LED) as
     * read-only labels on the second gang ("Global setting -- change from Gang 1").
     * @param {object} [settings] - main gang settings (default: stored ones)
     */
    _propagateGlobalLabels(settings = this.getSettings()) {
        const onOff = value => (value ? 'On' : 'Off');
        const labels = {
            TurboMode_readonly: onOff(settings.TurboMode),
            network_led_readonly: onOff(settings.network_led),
        };
        const siblings = getNodeDevices(this).filter(d => !d._isMainDevice);
        for (const sibling of siblings) {
            sibling.setSettings(labels).catch(() => {});
        }
    }

    onRenamed(name) {
        this.log(`Device renamed to: ${name}`);
        updateSiblingNames(this).catch(() => {});
    }

    async _teardown() {
        await super._teardown(); // stops the active poll before the manager goes away
        await this._availability?.uninstall().catch(() => {});
    }

    async onDeleted() {
        await this._teardown();
        this.log(`MINI-ZB2GS gang ${this._endpointId} removed`);
    }

}

module.exports = SonoffMINIZB2GS;
