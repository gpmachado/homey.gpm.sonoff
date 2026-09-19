'use strict';

const SonoffBase = require('./sonoffbase');
const { CLUSTER } = require('zigbee-clusters');
const SonoffCluster = require('../lib/SonoffCluster');
const { writeAttributesVerbose } = require('../lib/zclDebug');
const { AvailabilityManagerCallback } = require('../lib/AvailabilityManager');
const { HEARTBEAT_SLOW_MS } = require('../lib/constants');

/**
 * Shared base for the SNZB-02LD (temperature only) and SNZB-02WD
 * (temperature + humidity) drivers. Humidity support is auto-detected from
 * the cluster list, so the same code serves both models.
 */
class TempHumiditySensor extends SonoffBase {

    async onNodeInit({ zclNode }) {
        super.onNodeInit({ zclNode });

        this._hasHumidity = !!zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME];

        // SonoffBase only installs a passive battery listener - it never
        // actively reads the value, so measure_battery stays empty until
        // the device happens to send an unsolicited report on its own,
        // which can take hours. Read it once on pairing instead.
        this.readAttribute(CLUSTER.POWER_CONFIGURATION, ['batteryPercentageRemaining'], (data) => {
            if (data?.batteryPercentageRemaining !== undefined) {
                this.setCapabilityValue('measure_battery', data.batteryPercentageRemaining / 2).catch(this.error);
            }
        });

        if (this.isFirstInit()) {
            await this._configureReporting().catch(err => this.error('Failed to configure reporting', err));
        }

        // Read whatever calibration the device currently has applied, so the
        // settings UI reflects reality instead of Homey's last stored value.
        await this.syncOffsetSettings();

        this._onTempReport ??= this.onTemperatureMeasuredAttributeReport.bind(this);
        const tempCluster = zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME];
        tempCluster.removeListener('attr.measuredValue', this._onTempReport);
        tempCluster.on('attr.measuredValue', this._onTempReport);

        if (this._hasHumidity) {
            this._onHumidityReport ??= this.onRelativeHumidityMeasuredAttributeReport.bind(this);
            const humidityCluster = zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME];
            humidityCluster.removeListener('attr.measuredValue', this._onHumidityReport);
            humidityCluster.on('attr.measuredValue', this._onHumidityReport);
        }

        // Battery/sleepy end device - no handleFrame-based passive tracking
        // (see AvailabilityManagerPassive's doc). notifyActivity is called
        // explicitly from the temperature/humidity report handlers below and
        // from onEndDeviceAnnounce, since a temperature/humidity report is
        // the actual proof this device is alive and reporting normally.
        this._availability = new AvailabilityManagerCallback(this, { timeout: HEARTBEAT_SLOW_MS });
        await this._availability.install();

        this.log(`${this.driver.id} initialized`);
    }

    // A battery pull/rejoin resets the device's own calibration back to 0 -
    // reconfigure reporting and re-write the stored offset so it isn't lost.
    async onEndDeviceAnnounce() {
        this.log('endDeviceAnnounce - re-syncing reporting config and calibration');
        this._markAliveFromAvailability?.('rejoin');
        await this._configureReporting().catch(err => this.error('Failed to re-configure reporting on rejoin', err));
        await this._reassertCalibration().catch(err => this.error('Failed to reassert calibration on rejoin', err));
    }

    async _configureReporting() {
        const tempDecimals = parseInt(this.getSetting('temperature_decimals') ?? '1', 10);
        const humDecimals = parseInt(this.getSetting('humidity_decimals') ?? '0', 10);
        const maxInterval = parseInt(this.getSetting('reporting_interval') || '3600', 10);
        const tempMinChange = Math.pow(10, 2 - tempDecimals); // 0dec=100, 1dec=10, 2dec=1
        const humMinChange = Math.pow(10, 2 - humDecimals);

        const reportingConfigs = [
            {
                endpointId: 1,
                cluster: CLUSTER.TEMPERATURE_MEASUREMENT,
                attributeName: 'measuredValue',
                minInterval: 5,
                maxInterval,
                minChange: tempMinChange,
            },
        ];

        if (this._hasHumidity) {
            reportingConfigs.push({
                endpointId: 1,
                cluster: CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT,
                attributeName: 'measuredValue',
                minInterval: 5,
                maxInterval,
                minChange: humMinChange,
            });
        }

        await this.configureAttributeReporting(reportingConfigs);
        this.log(`Reporting configured: maxInterval=${maxInterval}s tempMinChange=${tempMinChange} humMinChange=${humMinChange}`);
    }

    async syncOffsetSettings() {
        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        if (!cluster) {
            this.log('SonoffCluster not available, skipping offset sync');
            return;
        }

        const attrs = this._hasHumidity
            ? ['temperatureCalibration', 'humidityCalibration']
            : ['temperatureCalibration'];

        this.readAttribute(SonoffCluster, attrs, (data) => {
            if (!data) return;
            const settingsData = {};
            if (data.temperatureCalibration !== undefined) {
                settingsData.temperature_offset = data.temperatureCalibration / 100;
            }
            if (this._hasHumidity && data.humidityCalibration !== undefined) {
                settingsData.humidity_offset = data.humidityCalibration / 100;
            }
            if (Object.keys(settingsData).length) this.setSettings(settingsData).catch(this.error);
        });
    }

    async _reassertCalibration() {
        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        if (!cluster) return;

        const attrs = {
            temperatureCalibration: Math.round((this.getSetting('temperature_offset') || 0) * 100),
        };
        if (this._hasHumidity) {
            attrs.humidityCalibration = Math.round((this.getSetting('humidity_offset') || 0) * 100);
        }
        await writeAttributesVerbose(this, cluster, attrs);
        this.log('Calibration reasserted after rejoin:', attrs);
    }

    _parseReportedValue(measuredValue, decimalsKey) {
        const d = parseInt(this.getSetting(decimalsKey) ?? '1', 10);
        const factor = Math.pow(10, d);
        return Math.round((measuredValue / 100) * factor) / factor;
    }

    onTemperatureMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('temperature');
        const parsedValue = this._parseReportedValue(measuredValue, 'temperature_decimals');
        this.setCapabilityValue('measure_temperature', parsedValue).catch(this.error);
    }

    onRelativeHumidityMeasuredAttributeReport(measuredValue) {
        this._markAliveFromAvailability?.('humidity');
        if (this.hasCapability('measure_humidity')) {
            const parsedValue = this._parseReportedValue(measuredValue, 'humidity_decimals');
            this.setCapabilityValue('measure_humidity', parsedValue).catch(this.error);
        }
    }

    async onSettings({ newSettings, changedKeys }) {
        if (changedKeys.includes('temperature_decimals') || changedKeys.includes('humidity_decimals') || changedKeys.includes('reporting_interval')) {
            await this._configureReporting().catch(err => this.error('Failed to reconfigure reporting', err));
        }

        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        if (!cluster) {
            this.log('SonoffCluster not available, offset settings cannot be applied to device');
            this.homey.notifications.createNotification({
                excerpt: `${this.getName()}: Re-add device to enable offset calibration features.`,
            }).catch(err => this.error('Failed to create notification:', err));
            return;
        }

        const attrs = {};
        if (changedKeys.includes('temperature_offset')) {
            attrs.temperatureCalibration = Math.round(newSettings.temperature_offset * 100);
        }
        if (this._hasHumidity && changedKeys.includes('humidity_offset')) {
            attrs.humidityCalibration = Math.round(newSettings.humidity_offset * 100);
        }
        if (Object.keys(attrs).length) {
            await writeAttributesVerbose(this, cluster, attrs);
            this.log('Calibration written to device:', attrs);
        }
    }

    // Remove sensor listeners on both re-init and removal so they never accumulate.
    async _teardown() {
        this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
            ?.removeListener('attr.measuredValue', this._onTempReport);
        if (this._hasHumidity) {
            this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME]
                ?.removeListener('attr.measuredValue', this._onHumidityReport);
        }
        await this._availability?.uninstall().catch(() => {});
        await super._teardown();
    }

    async onDeleted() {
        await this._teardown();
        this.log(`${this.driver.id} removed`);
    }

}

module.exports = TempHumiditySensor;
