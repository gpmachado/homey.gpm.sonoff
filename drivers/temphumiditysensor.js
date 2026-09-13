'use strict';

const SonoffBase = require('./sonoffbase');
const { CLUSTER } = require('zigbee-clusters');
const SonoffCluster = require('../lib/SonoffCluster');
const { writeAttributesVerbose } = require('../lib/zclDebug');

/**
 * Shared base for the SNZB-02LD (temperature only) and SNZB-02WD
 * (temperature + humidity) drivers. Humidity support is auto-detected from
 * the cluster list, so the same code serves both models.
 */
class TempHumiditySensor extends SonoffBase {

    async onNodeInit({ zclNode }) {
        super.onNodeInit({ zclNode });

        this._hasHumidity = !!zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME];

        if (this.isFirstInit()) {
            await this._configureReporting().catch(err => this.error('Failed to configure reporting', err));
        }

        // Read whatever calibration the device currently has applied, so the
        // settings UI reflects reality instead of Homey's last stored value.
        await this._syncCalibrationFromDevice();

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

        this.log(`${this.driver.id} initialized`);
    }

    // A battery pull/rejoin resets the device's own calibration back to 0 —
    // reconfigure reporting and re-write the stored offset so it isn't lost.
    async onEndDeviceAnnounce() {
        this.log('endDeviceAnnounce — re-syncing reporting config and calibration');
        await this._configureReporting().catch(err => this.error('Failed to re-configure reporting on rejoin', err));
        await this._reassertCalibration().catch(err => this.error('Failed to reassert calibration on rejoin', err));
    }

    async _configureReporting() {
        const reportingConfigs = [
            {
                endpointId: 1,
                cluster: CLUSTER.TEMPERATURE_MEASUREMENT,
                attributeName: 'measuredValue',
                minInterval: 5,
                maxInterval: 3600,
                minChange: 50, // 0.5 °C in ZCL units (×100)
            },
        ];

        if (this._hasHumidity) {
            reportingConfigs.push({
                endpointId: 1,
                cluster: CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT,
                attributeName: 'measuredValue',
                minInterval: 5,
                maxInterval: 3600,
                minChange: 300, // 3 %RH in ZCL units (×100)
            });
        }

        await this.configureAttributeReporting(reportingConfigs);
        this.log('Reporting configured');
    }

    async _syncCalibrationFromDevice() {
        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        if (!cluster) return;

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

    async onSettings({ newSettings, changedKeys }) {
        const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
        if (!cluster) return;

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

    onTemperatureMeasuredAttributeReport(measuredValue) {
        this.setCapabilityValue('measure_temperature', Math.round(measuredValue / 10) / 10).catch(this.error);
    }

    onRelativeHumidityMeasuredAttributeReport(measuredValue) {
        if (this.hasCapability('measure_humidity')) {
            this.setCapabilityValue('measure_humidity', Math.round(measuredValue / 10) / 10).catch(this.error);
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
        await super._teardown();
    }

    async onDeleted() {
        await this._teardown();
        this.log(`${this.driver.id} removed`);
    }

}

module.exports = TempHumiditySensor;
