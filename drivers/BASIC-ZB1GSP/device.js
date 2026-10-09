'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_FAST_MS } = require('../../lib/constants');
const { writeAttributesVerbose } = require('../../lib/zclDebug');

// zigbee-herdsman-converters: faultCodeMiniZb1gsp({hasSwitch:true}) bit map
const FAULT_BITS = {
  alarm_generic: 0b001,
  'alarm_generic.metering_error': 0b010,
  'alarm_generic.overload_protection': 0b100,
};

const INCHING_PROTOCOL = {
  CMD: 0x01,
  SUBCMD_INCHING: 0x17,
  PAYLOAD_LENGTH: 0x07,
  SEQ_NUM: 0x80,
  FLAG_ENABLE: 0x80,
  FLAG_MODE_ON: 0x01,
};

class SonoffBasicZB1GSP extends SonoffBase {

  async onNodeInit({ zclNode }) {
    super.onNodeInit({ zclNode });

    if (this.hasCapability('onoff')) {
      // Same fix as BASICZBR3/ZBMINIR2: this firmware doesn't reliably send
      // a ZCL Default Response to setOn/setOff, which makes
      // registerCapability's default 10s-wait handler time out. Wire it
      // manually instead.
      const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

      this._onOnOff ??= value => {
        this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
        this.setCapabilityValue('onoff', value).catch(this.error);
        if (!value) this._setCurrent(0);
        this._pollSoon();
      };
      _onOffCluster.removeListener('attr.onOff', this._onOnOff);
      _onOffCluster.on('attr.onOff', this._onOnOff);

      this.registerCapabilityListener('onoff', async value => {
        this.log(`set onoff -> ${value} (cluster: onOff, endpoint: 1)`);
        this._pollSoon();
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    const sonoffCluster = zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (sonoffCluster) {
      sonoffCluster.on('attr.fault_code', (value) => this.handleFaultCode(value));
      sonoffCluster.on('attr.network_led', (value) => {
        if (this.getSetting('network_indicator') !== !!value) {
          this.setSettings({ network_indicator: !!value }).catch(this.error);
        }
      });
      // Live power measurements - manufacturer-specific cluster, NOT the
      // standard Electrical Measurement cluster (confirmed against
      // zigbee-herdsman-converters). Power can be negative here (export
      // direction) - acCurrentPowerValue is signed on the wire.
      sonoffCluster.on('attr.acCurrentVoltageValue', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('measure_voltage', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentPowerValue', (value) => {
        if (!this._isValidReading(value)) return;
        this.setCapabilityValue('measure_power', this._toSignedInt32(value) / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentCurrentValue', (value) => {
        if (this._isValidReading(value)) this._setCurrent(value / 1000);
      });

      // Cumulative counters - real running totals reported by the device, no
      // client-side reconstruction needed. (Export counters exist only from firmware 1.3.0.)
      sonoffCluster.on('attr.totalEnergyConsumption', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.energyToday', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power.today', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.energyMonth', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power.month', value / 1000).catch(this.error);
      });
    }

    // Passive reports alone can lag behind a real change by hours (same
    // issue as MINI-ZB1GP's daily/monthly counters). Poll actively every
    // 120s instead - same base interval as the smartplug driver in
    // nova.digital.homeyapp.
    if (this._powerPollInterval) this.homey.clearInterval(this._powerPollInterval);
    this.pollPowerMeasurements();
    this._powerPollInterval = this.homey.setInterval(() => {
      this.pollPowerMeasurements();
    }, 120_000);

    this._configureReporting();
    await this.checkAttributes();

    // Power/energy poll runs every 120s (see above), so activity is frequent;
    // 25 min gives a wide margin over both that poll and onOff reporting.
    this._availability = new AvailabilityManagerPassive(this, { timeout: HEARTBEAT_FAST_MS });
    await this._availability.install();

    this.log('BASIC-ZB1GSP initialized');
  }

  // Power and current only arrive with the 120 s poll, so read them again right after a
  // relay change (the load takes a moment to settle: 2 s and 8 s later).
  _pollSoon() {
    for (const timer of this._pollSoonTimers || []) this.homey.clearTimeout(timer);
    this._pollSoonTimers = [2000, 8000].map(ms => this.homey.setTimeout(() => this.pollPowerMeasurements(), ms));
  }

  // The device keeps reporting a leftover current after the relay opens
  // (zigbee-herdsman-converters shows 0 A while off), so report 0 then.
  _setCurrent(amps) {
    return this.setCapabilityValue('measure_current', this.getCapabilityValue('onoff') === false ? 0 : amps).catch(this.error);
  }

  // Same reports zigbee-herdsman-converters asks of this model (BASIC-ZB1GSP). Reports need the
  // 0xFC11 binding from the manifest, which a device paired before this was added does not have;
  // the poll keeps working either way.
  async _configureReporting() {
    const report = (attributeName, minInterval, maxInterval, minChange) => ({
      endpointId: 1, cluster: SonoffCluster, attributeName, minInterval, maxInterval, minChange,
    });
    try {
      await this.configureAttributeReporting([
        report('acCurrentPowerValue', 10, 300, 5000), // 5 W
        report('acCurrentCurrentValue', 10, 300, 100), // 0.1 A
        report('energyToday', 60, 3600, 50),
        report('energyMonth', 60, 3600, 50),
        report('totalEnergyConsumption', 60, 3600, 50),
      ]);
    } catch (err) {
      this.log('Could not configure attribute reporting:', err.message);
    }
  }

  _isValidReading(value) {
    return Number.isFinite(value) && value !== 0xFFFFFFFF;
  }

  async pollPowerMeasurements() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (!cluster) return;

    try {
      const data = await cluster.readAttributes([
        'acCurrentVoltageValue', 'acCurrentPowerValue', 'acCurrentCurrentValue',
        'totalEnergyConsumption', 'energyToday', 'energyMonth',
      ], { manufacturerCode: 0x1286 });

      if (data.acCurrentVoltageValue !== undefined && this._isValidReading(data.acCurrentVoltageValue)) {
        await this.setCapabilityValue('measure_voltage', data.acCurrentVoltageValue / 1000);
      }
      if (data.acCurrentPowerValue !== undefined && this._isValidReading(data.acCurrentPowerValue)) {
        await this.setCapabilityValue('measure_power', this._toSignedInt32(data.acCurrentPowerValue) / 1000);
      }
      if (data.acCurrentCurrentValue !== undefined && this._isValidReading(data.acCurrentCurrentValue)) {
        await this._setCurrent(data.acCurrentCurrentValue / 1000);
      }
      if (data.totalEnergyConsumption !== undefined && this._isValidReading(data.totalEnergyConsumption)) {
        await this.setCapabilityValue('meter_power', data.totalEnergyConsumption / 1000);
      }
      if (data.energyToday !== undefined && this._isValidReading(data.energyToday)) {
        await this.setCapabilityValue('meter_power.today', data.energyToday / 1000);
      }
      if (data.energyMonth !== undefined && this._isValidReading(data.energyMonth)) {
        await this.setCapabilityValue('meter_power.month', data.energyMonth / 1000);
      }
    } catch (e) {
      this.log('Could not read power/energy measurements:', e.message);
    }
  }

  handleFaultCode(value) {
    if (typeof value !== 'number') return;
    const tlv = value >>> 0;
    const type = (tlv >>> 24) & 0xff;
    const length = (tlv >>> 16) & 0xff;
    if (type !== 0x07 || length !== 0x02) return;

    const faultValue = tlv & 0xffff;
    for (const [capabilityId, bit] of Object.entries(FAULT_BITS)) {
      if (this.hasCapability(capabilityId)) {
        this.setCapabilityValue(capabilityId, (faultValue & bit) !== 0).catch(this.error);
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('power_on_behavior')) {
      try {
        await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters.onOff, {
          powerOnBehavior: newSettings.power_on_behavior,
        });
      } catch (error) {
        this.error('Error updating power on behavior:', error.message);
      }
    }

    const sonoffSettings = {};

    if (changedKeys.includes('network_indicator')) {
      sonoffSettings.network_led = !!newSettings.network_indicator;
    }
    if (Object.keys(sonoffSettings).length > 0) {
      try {
        await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters[SonoffCluster.NAME], sonoffSettings);
        this.log('SonoffCluster attributes written:', sonoffSettings);
      } catch (err) {
        this.error('Error writing SonoffCluster settings:', err.message);
      }
    }

    if (changedKeys.includes('inching_control') || changedKeys.includes('inching_mode') || changedKeys.includes('inching_time')) {
      await this.setInching(
        newSettings.inching_control,
        newSettings.inching_time,
        newSettings.inching_mode,
      ).catch(err => this.error('Error updating inching settings:', err));
    }

    const PROTECTION = {
      current_protect_enabled: ['acCurrentMaxOverloadEnable', v => (v ? 1 : 0)],
      max_current_protect: ['acCurrentMaxOverload', v => Math.round(v * 1000)],
      voltage_protect_enabled: ['acVoltageMaxOverloadEnable', v => (v ? 1 : 0)],
      max_voltage_protect: ['acVoltageMaxOverload', v => Math.round(v * 1000)],
      power_protect_enabled: ['acPowerMaxOverloadEnable', v => (v ? 1 : 0)],
      max_power_protect: ['acPowerMaxOverload', v => Math.round(v * 1000)],
    };
    const protection = {};
    for (const key of changedKeys) {
      if (PROTECTION[key]) protection[PROTECTION[key][0]] = PROTECTION[key][1](newSettings[key]);
    }
    if (Object.keys(protection).length > 0) {
      try {
        await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters[SonoffCluster.NAME], protection);
        this.log('Overload protection written:', protection);
      } catch (error) {
        this.error('Error writing overload protection:', error.message || error);
      }
    }
  }

  /**
   * Set inching (auto-off/on) configuration. Same protocol as ZBMINIR2's
   * setInching - see that driver for the payload format breakdown.
   */
  async setInching(enabled = false, time = 1, mode = 'on') {
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

    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    await cluster.protocolData(
      { data: Buffer.from(payloadValue) },
      { disableDefaultResponse: true, waitForResponse: false },
    );
  }

  _calculateChecksum(payload, length) {
    let checksum = 0x00;
    for (let i = 0; i < length; i++) checksum ^= payload[i];
    return checksum;
  }

  async checkAttributes(attempt = 1) {
    try {
      const data = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['powerOnBehavior']);
      if (data && data.powerOnBehavior !== undefined) {
        await this.setSettings({ power_on_behavior: data.powerOnBehavior });
      }
    } catch (e) {
      this.log(`Device offline at startup, attribute sync failed (attempt ${attempt}/3):`, e.message);
      this._retryCheckAttributes(attempt);
      return;
    }

    try {
      const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
      const data = await cluster.readAttributes([
        'network_led',
        'fault_code',
        'acCurrentMaxOverloadEnable', 'acCurrentMaxOverload',
        'acVoltageMaxOverloadEnable', 'acVoltageMaxOverload',
        'acPowerMaxOverloadEnable', 'acPowerMaxOverload',
      ], { manufacturerCode: 0x1286 });
      if (!data) return;

      const settingsData = {};
      if (data.network_led !== undefined) settingsData.network_indicator = !!data.network_led;
      const limit = v => (this._isValidReading(v) ? v / 1000 : undefined);
      const protection = {
        current_protect_enabled: data.acCurrentMaxOverloadEnable === undefined ? undefined : !!data.acCurrentMaxOverloadEnable,
        max_current_protect: limit(data.acCurrentMaxOverload),
        voltage_protect_enabled: data.acVoltageMaxOverloadEnable === undefined ? undefined : !!data.acVoltageMaxOverloadEnable,
        max_voltage_protect: limit(data.acVoltageMaxOverload),
        power_protect_enabled: data.acPowerMaxOverloadEnable === undefined ? undefined : !!data.acPowerMaxOverloadEnable,
        max_power_protect: limit(data.acPowerMaxOverload),
      };
      for (const [key, value] of Object.entries(protection)) {
        if (value !== undefined) settingsData[key] = value;
      }

      if (Object.keys(settingsData).length > 0) {
        await this.setSettings(settingsData);
      }

      if (data.fault_code !== undefined) {
        this.handleFaultCode(data.fault_code);
      }
    } catch (e) {
      this.log(`Could not read SonoffCluster attributes (attempt ${attempt}/3):`, e.message);
      this._retryCheckAttributes(attempt);
    }
  }

  // The first read at start often fails while the app is sending a lot in parallel (seen on a
  // Homey with many devices); try again 60 s and 120 s later.
  _retryCheckAttributes(attempt) {
    if (attempt >= 3) return;
    this._syncTimer = this.homey.setTimeout(() => {
      this._syncTimer = null;
      this.checkAttributes(attempt + 1);
    }, attempt * 60 * 1000);
  }

  async _teardown() {
    if (this._powerPollInterval) {
      this.homey.clearInterval(this._powerPollInterval);
      this._powerPollInterval = null;
    }
    if (this._syncTimer) this.homey.clearTimeout(this._syncTimer);
    for (const timer of this._pollSoonTimers || []) this.homey.clearTimeout(timer);
    await this._availability?.uninstall().catch(() => {});
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('BASIC-ZB1GSP removed');
  }

}

module.exports = SonoffBasicZB1GSP;
