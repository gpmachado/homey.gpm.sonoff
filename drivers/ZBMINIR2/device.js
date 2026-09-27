'use strict';

const SonoffCluster = require('../../lib/SonoffCluster');
const { CLUSTER, BoundCluster } = require('zigbee-clusters');
const SonoffBase = require('../sonoffbase');
const RejoinManager = require('../../lib/RejoinManager');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_MEDIUM_MS } = require('../../lib/constants');
const { writeAttributesVerbose } = require('../../lib/zclDebug');
const { installRejoinDetection } = require('../../lib/rejoinDetection');
const { FrameMiddleware, FRAME_PRIORITY } = require('../../lib/FrameMiddleware');

// Handles external switch commands (detach_mode) sent directly to the hub
class MyOnOffBoundCluster extends BoundCluster {
    constructor(device) {
        super();
        this._device = device;
        this._click = device.homey.flow.getDeviceTriggerCard("ZBMINIR2:click");
    }
    toggle() {
        this._device.log('[detach_mode] toggle received (external switch)');
        this._click.trigger(this._device, {}, {}).catch(this._device.error);
    }
    setOn() {
        this._device.log('[detach_mode] setOn received (external switch)');
        this._device.setCapabilityValue('onoff', true).catch(this._device.error);
    }
    setOff() {
        this._device.log('[detach_mode] setOff received (external switch)');
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
    onWithTimedOff({ onOffControl, onTime, offWaitTime }) {
        this._device.log('[detach_mode] onWithTimedOff received', { onOffControl, onTime, offWaitTime });
    }
    offWithEffect() {
        this._device.log('[detach_mode] offWithEffect received (external switch)');
        this._device.setCapabilityValue('onoff', false).catch(this._device.error);
    }
}

const SonoffClusterAttributes = [
    'TurboMode',
    'network_led',
    'power_on_delay_state',
    'power_on_delay_time',
    'switch_mode',
    'detach_mode'
];

const INCHING_PROTOCOL = {
    CMD:             0x01,
    SUBCMD_INCHING:  0x17,
    PAYLOAD_LENGTH:  0x07,
    SEQ_NUM:         0x80,
    FLAG_ENABLE:     0x80,
    FLAG_MODE_ON:    0x01,
};

class SonoffZBMINIR2 extends SonoffBase {

    async onNodeInit({ zclNode }) {

        super.onNodeInit({ zclNode });

        if (this.hasCapability('onoff')) {
            // registerCapability's default send waits up to 10s for a ZCL response and
            // times out here ("Timeout: Expected Response"). A sniffer capture shows
            // this device DOES answer a similarly-shaped On command from a different
            // controller, so it isn't a firmware limitation - waitForResponse: false
            // just stops the JS side from waiting (see zigbee-clusters Cluster.js:
            // `if (opts.waitForResponse === false) return this.sendFrame(payload);`),
            // it doesn't change what's sent on the wire or what the device does.
            // Instead, wire the capability manually:
            //   - SET:    registerCapabilityListener with waitForResponse: false (fire-and-forget)
            //   - REPORT: cluster attr.onOff event -> setCapabilityValue
            const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

            this._onOnOff ??= value => {
                this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
                this.setCapabilityValue('onoff', value).catch(this.error);
            };
            _onOffCluster.removeListener('attr.onOff', this._onOnOff);
            _onOffCluster.on('attr.onOff', this._onOnOff);

            this.registerCapabilityListener('onoff', async value => {
                this.log(`set onoff -> ${value} (cluster: onOff, endpoint: 1)`);
                if (value) {
                    return _onOffCluster.setOn({}, { waitForResponse: false });
                }
                return _onOffCluster.setOff({}, { waitForResponse: false });
            });
        }

        // Deferred 30 s: mesh routes are stale immediately after boot.
        // Plus 0-60 s of random spread: with 21 relays the fixed 30 s fired 21 writes in 240 ms, and
        // once all of them failed with 'Could not reach device' at the same time.
        // Firing configureAttributeReporting before the route is established generates
        // [err] stack traces from homey-zigbeedriver's executeMethod - harmless but noisy.
        this.homey.setTimeout(() => {
            if (!this.zclNode) return;
            this.zclNode.endpoints[1].clusters.onOff.configureReporting({
                onOff: { minInterval: 0, maxInterval: 1800, minChange: 1 }, // 30 min
            }).catch(err => this.log('[Reporting] boot config failed:', err.message));
        }, 30_000 + Math.floor(Math.random() * 60_000));

        this.zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));

        // Power-cut detection: OnOff report + SonoffCluster report within 200 ms (sniffer confirmed:
        // ~8ms apart on real boot dumps; periodic 0xFC11 heartbeats arrive alone, gap >> 200ms).
        // Shared helper (lib/FrameMiddleware.js, FRAME_PRIORITY.REJOIN). The write guard reproduces
        // the old inline hook's behaviour exactly: a settings write's own report burst can otherwise
        // match the same pattern, so a match within 30 s of our last write is ignored - checked
        // before the module's own cooldown is touched, so that false match never consumes it.
        installRejoinDetection(this, {
            sonoffClusterId: SonoffCluster.ID,
            windowMs: 200,
            cooldownMs: 30_000,
            writeGuardMs: 30_000,
            getLastWriteAt: () => this._lastSonoffWriteAt ?? 0,
        });

        // Drop Sonoff manufacturer ACK (cmdId 0x0B) that zigbee-clusters cannot route via
        // BoundCluster (inching ACK on 0xFC11, stray defaultResponse on OnOff) - prevents
        // unknown_command_received log spam. Installed once per node (shared by re-init).
        this._installAckSuppressHandler();

        // Read initial data so the settings UI reflects the device's actual
        // configuration rather than Homey's stored defaults.
        await this.checkAttributes();

        // onOff is configured for a 30 min max report interval (see above);
        // 90 min gives 3x that as buffer, matching the "medium tier" used for
        // other Sonoff onOff-reporting mains devices.
        this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_MEDIUM_MS });
        await this._availability.install();
        // No frequent traffic of its own beyond onOff reports - an active poll
        // every 20 min (see SonoffBase) keeps last_seen_ts fresh independent
        // of whether the device happens to report anything.
        this._startActivePoll();

        this.log('ZBMINIR2 initialized');
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        if (changedKeys.includes("power_on_behavior")) {
            try {
                await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters.onOff, { powerOnBehavior: newSettings.power_on_behavior });
            } catch (error) {
                this.log("Error updating the power on behavior:", error.message);
            }
        }

        // Convert TurboMode boolean checkbox -> int16 expected by device (20=on, 9=off)
        // Convert power_on_delay_time from seconds (UI) to 0.5s units for wire (scale: 2)
        const settingsToWrite = { ...newSettings };
        if (settingsToWrite.TurboMode !== undefined) {
            settingsToWrite.TurboMode = settingsToWrite.TurboMode ? 20 : 9;
        }
        if (settingsToWrite.power_on_delay_time !== undefined) {
            settingsToWrite.power_on_delay_time = Math.round(settingsToWrite.power_on_delay_time * 2);
        }
        // switch_mode is stored as string (dropdown) but firmware expects integer
        if (settingsToWrite.switch_mode !== undefined) {
            settingsToWrite.switch_mode = Number(settingsToWrite.switch_mode);
        }
        this._lastSonoffWriteAt = Date.now();
        this.writeAttributes(SonoffCluster, settingsToWrite, changedKeys).catch(this.error);

        // Handle inching settings changes
        const inchingKeys = ['inching_enabled', 'inching_mode', 'inching_time'];
        const inchingChanged = changedKeys.some(key => inchingKeys.includes(key));

        if (inchingChanged) {
            try {
                await this.setInching(
                    newSettings.inching_enabled,
                    newSettings.inching_time,
                    newSettings.inching_mode
                );
                this.log('Inching settings updated:', {
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
     * Set inching (auto-off/on) configuration
     * @param {boolean} enabled - Enable or disable inching
     * @param {number} time - Time in seconds (0.1-3600)
     * @param {string} mode - 'on' (turn ON then OFF) or 'off' (turn OFF then ON)
     */
    async setInching(enabled = false, time = 1, mode = 'on') {
        if (typeof enabled !== 'boolean') throw new TypeError(`enabled must be boolean, got ${typeof enabled}`);
        if (typeof time !== 'number' || time < 0 || time > 32767.5) throw new RangeError(`time must be 0-32767.5 s, got ${time}`);
        if (!['on', 'off'].includes(mode)) throw new TypeError(`mode must be "on" or "off", got "${mode}"`);

        try {
            const tmpTime = Math.min(Math.max(Math.round(time * 2000 / 1000), 1), 0xffff);

            const payloadValue = [
                INCHING_PROTOCOL.CMD,
                INCHING_PROTOCOL.SUBCMD_INCHING,
                INCHING_PROTOCOL.PAYLOAD_LENGTH,
                INCHING_PROTOCOL.SEQ_NUM,
                (enabled ? INCHING_PROTOCOL.FLAG_ENABLE : 0) | (mode === 'on' ? INCHING_PROTOCOL.FLAG_MODE_ON : 0),
                0x00,
                tmpTime & 0xff,
                (tmpTime >> 8) & 0xff,
                0x00,
                0x00,
                0x00,
            ];
            payloadValue[10] = this._calculateChecksum(payloadValue, INCHING_PROTOCOL.PAYLOAD_LENGTH + 3);

            this.log('Sending inching command:', { enabled, mode, time_s: time, time_half_s: tmpTime });

            const cluster = this.zclNode.endpoints[1].clusters['SonoffCluster'];
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
     * Swallow manufacturer / OnOff ACK frames (cmdId 0x0B) that would log unknown_command_received.
     * Registered once per Zigbee node (see the node-level flag - a multi-device node would
     * otherwise get one duplicate handler per device instance calling onNodeInit).
     */
    _installAckSuppressHandler() {
        const node = this.node;
        if (!node) return;
        if (node._zbminir2AckSuppressInstalled) {
            this.log('[ZBMINIR2] ACK suppress handler already installed (shared node)');
            return;
        }
        node._zbminir2AckSuppressInstalled = true;
        FrameMiddleware.for(node).register(
            'zbminir2-suppress-ack',
            FRAME_PRIORITY.CLUSTER_REPORT,
            (endpointId, clusterId, frame) => {
                if (!Buffer.isBuffer(frame) || frame.length < 3) return;
                const mfrSpecific = (frame[0] & 0x04) !== 0;
                const cmdId = mfrSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
                if (cmdId === 0x0B && (clusterId === SonoffCluster.ID || clusterId === 6)) return false;
            },
        );
    }

    /**
     * Fires the device_rejoined flow trigger.
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

    // Rejoin is detected from the SonoffCluster boot dump (installRejoinDetection above),
    // not from ZDO Device Announce - the base class's default onEndDeviceAnnounce()
    // (just a log line) is fine as-is.

    async checkAttributes() {
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            this.setSettings({ power_on_behavior: data.powerOnBehavior }).catch(this.error);
        });

        this.readAttribute(SonoffCluster, SonoffClusterAttributes, (data) => {
            if (!data) return;
            const settingsData = {};
            if (data.TurboMode !== undefined)          settingsData.TurboMode            = data.TurboMode === 20;
            if (data.network_led !== undefined)        settingsData.network_led          = Boolean(data.network_led);
            if (data.power_on_delay_state !== undefined) settingsData.power_on_delay_state = Boolean(data.power_on_delay_state);
            // Clamp to the settings schema's min (0.5) - the device reports 0
            // when the delay is disabled, which is below the field's allowed
            // range and would otherwise leave the number field empty/invalid.
            if (data.power_on_delay_time !== undefined) settingsData.power_on_delay_time  = Math.max(0.5, data.power_on_delay_time / 2);
            if (data.switch_mode !== undefined)        settingsData.switch_mode          = String(data.switch_mode);
            if (data.detach_mode !== undefined)        settingsData.detach_mode          = Boolean(data.detach_mode);
            if (Object.keys(settingsData).length) this.setSettings(settingsData).catch(this.error);
        });
    }

    async _teardown() {
        await super._teardown(); // stops the active poll before the manager goes away
        await this._availability?.uninstall().catch(() => {});
    }

    async onDeleted() {
        await this._teardown();
        this.log('ZBMINIR2 removed');
    }

}

module.exports = SonoffZBMINIR2;
