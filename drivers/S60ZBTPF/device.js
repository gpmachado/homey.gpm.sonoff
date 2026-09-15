'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { SonoffTimeServerBoundCluster } = require('../../lib/TimeCluster');
const { writeAttributesVerbose, installNamedLogging } = require('../../lib/zclDebug');
const { CLUSTER } = require('zigbee-clusters');

class SonoffS60ZBTPF extends SonoffBase {

  async onNodeInit({ zclNode }) {
    installNamedLogging(this);
    super.onNodeInit({ zclNode });

    // Serve time to the device so it can track its own daily/monthly energy
    // rollover (same reason MINI-ZB1GP binds this).
    zclNode.endpoints[1].bind(CLUSTER.TIME.NAME, new SonoffTimeServerBoundCluster());

    await this.readSettings();

    if (this.hasCapability('onoff')) {
      // Same fix as BASICZBR3/ZBMINIR2: this firmware doesn't reliably send
      // a ZCL Default Response to setOn/setOff, which makes
      // registerCapability's default 10s-wait handler time out. Wire it
      // manually instead.
      const _onOffCluster = zclNode.endpoints[1].clusters.onOff;

      this._onOnOff ??= value => {
        this.log(`handle report (cluster: onOff, capability: onoff), parsed payload: ${value}`);
        this.setCapabilityValue('onoff', value).catch(this.error);
        // The device keeps reporting a stale non-zero power/current reading
        // for a moment after being turned off — force both to 0 here too.
        if (!value) {
          if (this.hasCapability('measure_power')) this.setCapabilityValue('measure_power', 0).catch(this.error);
          if (this.hasCapability('measure_current')) this.setCapabilityValue('measure_current', 0).catch(this.error);
        }
      };
      _onOffCluster.removeListener('attr.onOff', this._onOnOff);
      _onOffCluster.on('attr.onOff', this._onOnOff);

      this.registerCapabilityListener('onoff', async value => {
        this.log(`set onoff → ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    // Live voltage/power/current are exposed via Sonoff's manufacturer-specific
    // cluster (acCurrentVoltageValue/acCurrentPowerValue/acCurrentCurrentValue),
    // NOT the standard Electrical Measurement cluster — confirmed against
    // zigbee-herdsman-converters. Raw values are milli-units (divide by 1000).
    const sonoffCluster = zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (sonoffCluster) {
      sonoffCluster.on('attr.acCurrentVoltageValue', (value) => {
        this.setCapabilityValue('measure_voltage', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentPowerValue', (value) => {
        // Device keeps reporting a non-zero value after turning off — force 0.
        const isOn = this.getCapabilityValue('onoff');
        this.setCapabilityValue('measure_power', isOn ? value / 1000 : 0).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentCurrentValue', (value) => {
        const isOn = this.getCapabilityValue('onoff');
        this.setCapabilityValue('measure_current', isOn ? value / 1000 : 0).catch(this.error);
      });
      sonoffCluster.on('attr.network_led', (value) => {
        if (this.getSetting('network_indicator') !== !!value) {
          this.setSettings({ network_indicator: !!value }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.outlet_control_protect', (value) => {
        if (this.getSetting('outlet_control_protect') !== !!value) {
          this.setSettings({ outlet_control_protect: !!value }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.energyToday', (value) => {
        const kwh = Number(value) / 1000;
        this.setCapabilityValue('meter_power.today', kwh).catch(this.error);
        this._updateCumulativeMeterPower(kwh).catch(this.error);
      });
      sonoffCluster.on('attr.energyYesterday', (value) => {
        this.setCapabilityValue('meter_power.yesterday', Number(value) / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.energyMonth', (value) => {
        this.setCapabilityValue('meter_power.month', Number(value) / 1000).catch(this.error);
      });
    }

    // Passive reports alone can be unreliable — poll actively as a fallback.
    // Same 120s base interval as the smartplug driver in nova.digital.homeyapp.
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    this.pollMeasurements();
    this._pollInterval = this.homey.setInterval(() => {
      this.pollMeasurements();
    }, 120_000);
  }

  async pollMeasurements() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (!cluster) return;

    try {
      const data = await cluster.readAttributes(
        ['acCurrentVoltageValue', 'acCurrentPowerValue', 'acCurrentCurrentValue', 'energyToday', 'energyYesterday', 'energyMonth'],
        { manufacturerCode: 0x1286 },
      );
      const isOn = this.getCapabilityValue('onoff');

      if (data.acCurrentVoltageValue !== undefined) {
        await this.setCapabilityValue('measure_voltage', data.acCurrentVoltageValue / 1000);
      }
      if (data.acCurrentPowerValue !== undefined) {
        await this.setCapabilityValue('measure_power', isOn ? data.acCurrentPowerValue / 1000 : 0);
      }
      if (data.acCurrentCurrentValue !== undefined) {
        await this.setCapabilityValue('measure_current', isOn ? data.acCurrentCurrentValue / 1000 : 0);
      }
      if (data.energyToday !== undefined) {
        const kwh = Number(data.energyToday) / 1000;
        await this.setCapabilityValue('meter_power.today', kwh);
        await this._updateCumulativeMeterPower(kwh);
      }
      if (data.energyYesterday !== undefined) {
        await this.setCapabilityValue('meter_power.yesterday', Number(data.energyYesterday) / 1000);
      }
      if (data.energyMonth !== undefined) {
        await this.setCapabilityValue('meter_power.month', Number(data.energyMonth) / 1000);
      }
    } catch (e) {
      this.log('Could not read power/energy measurements:', e.message);
    }
  }

  // Builds a strictly-increasing total kWh counter from the device's daily
  // counter (which resets at midnight) — this model has no native cumulative
  // total attribute (unlike MINI-ZB1GP/GSP's totalEnergyConsumption). Homey
  // Energy requires a cumulative meter_power that never decreases. State is
  // persisted via setStoreValue so app restarts don't lose the running total.
  async _updateCumulativeMeterPower(newTodayKwh) {
    if (!Number.isFinite(newTodayKwh)) return;
    const lastTodayKwh = this.getStoreValue('lastTodayKwh');
    const cumulative = this.getStoreValue('cumulativeKwh') ?? 0;

    let delta;
    if (lastTodayKwh === null || lastTodayKwh === undefined) {
      // First reading after install or app upgrade — anchor without backfilling.
      delta = 0;
    } else if (newTodayKwh >= lastTodayKwh) {
      delta = newTodayKwh - lastTodayKwh;
    } else {
      // Device reset its daily counter (midnight). Treat the new reading as
      // the delta since the rollover.
      delta = newTodayKwh;
    }

    const newCumulative = cumulative + delta;
    await this.setStoreValue('lastTodayKwh', newTodayKwh).catch(this.error);
    if (delta > 0 || cumulative === 0) {
      await this.setStoreValue('cumulativeKwh', newCumulative).catch(this.error);
    }
    await this.setCapabilityValue('meter_power', newCumulative).catch(this.error);
  }

  async readSettings() {
    try {
      const data = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['powerOnBehavior']);
      if (data?.powerOnBehavior !== undefined) {
        await this.setSettings({ power_on_behavior: data.powerOnBehavior });
      }
    } catch (error) {
      this.log('Could not read power on behavior:', error.message);
    }

    try {
      const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
      const data = await cluster.readAttributes(['network_led', 'outlet_control_protect'], { manufacturerCode: 0x1286 });
      const settingsData = {};
      if (data.network_led !== undefined) settingsData.network_indicator = !!data.network_led;
      if (data.outlet_control_protect !== undefined) settingsData.outlet_control_protect = !!data.outlet_control_protect;
      if (Object.keys(settingsData).length > 0) await this.setSettings(settingsData);
    } catch (error) {
      this.log('Could not read network_led / outlet_control_protect:', error.message);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('power_on_behavior')) {
      try {
        await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters.onOff, {
          powerOnBehavior: newSettings.power_on_behavior,
        });
      } catch (error) {
        this.error('Error setting power on behavior:', error.message);
      }
    }

    const sonoffSettings = {};
    if (changedKeys.includes('network_indicator')) {
      sonoffSettings.network_led = !!newSettings.network_indicator;
    }
    if (changedKeys.includes('outlet_control_protect')) {
      sonoffSettings.outlet_control_protect = newSettings.outlet_control_protect ? 1 : 0;
    }
    if (Object.keys(sonoffSettings).length > 0) {
      try {
        await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters[SonoffCluster.NAME], sonoffSettings);
      } catch (error) {
        this.error('Error writing SonoffCluster settings:', error.message);
      }
    }

    if (changedKeys.includes('inching_control') || changedKeys.includes('inching_mode') || changedKeys.includes('inching_time')) {
      await this.setInchingControl(newSettings);
    }
  }

  async setInchingControl(settings) {
    try {
      const enabled = settings.inching_control || false;
      const mode = settings.inching_mode || 'off';
      const time = settings.inching_time || 0.5;

      const payload = this._createInchingPayload(enabled, mode, time);
      this.log('Setting inching control:', { enabled, mode, time, payload: payload.toString('hex') });

      await this.zclNode.endpoints[1].clusters[SonoffCluster.NAME].setInching({ data: payload });
    } catch (error) {
      this.error('Error setting inching control:', error);
    }
  }

  // Same protocol as ZBMINIR2/MINI-ZB1GSP's inching command.
  _createInchingPayload(enabled, mode, timeSeconds) {
    const timeUnits = Math.round(timeSeconds * 2);
    const modeFlags = (enabled ? 0x80 : 0x00) | (mode === 'on' ? 0x01 : 0x00);

    const payload = [0x01, 0x17, 0x07, 0x80, modeFlags, 0x00, timeUnits & 0xff, (timeUnits >> 8) & 0xff, 0x00, 0x00];
    let checksum = 0x00;
    for (let i = 0; i < payload.length; i++) checksum ^= payload[i];
    payload.push(checksum);

    return Buffer.from(payload);
  }

  async _teardown() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('S60ZBTPF removed');
  }

}

module.exports = SonoffS60ZBTPF;
