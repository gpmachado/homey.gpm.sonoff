'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { writeAttributesVerbose, installNamedLogging } = require('../../lib/zclDebug');

// zigbee-herdsman-converters: detachRelayActionEvent lookup
const ACTION_LOOKUP = {
  1: 'single_click',
  2: 'double_click',
  3: 'long_press',
  4: 'switch_on',
  5: 'switch_off',
};

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

class SonoffMiniZB1GSP extends SonoffBase {

  async onNodeInit({ zclNode }) {
    installNamedLogging(this);
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
      };
      _onOffCluster.removeListener('attr.onOff', this._onOnOff);
      _onOffCluster.on('attr.onOff', this._onOnOff);

      this.registerCapabilityListener('onoff', async value => {
        this.log(`set onoff → ${value} (cluster: onOff, endpoint: 1)`);
        if (value) return _onOffCluster.setOn({}, { waitForResponse: false });
        return _onOffCluster.setOff({}, { waitForResponse: false });
      });
    }

    const sonoffCluster = zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    if (sonoffCluster) {
      sonoffCluster.on('attr.detach_relay_action_event', (value) => this.handleActionEvent(value));
      sonoffCluster.on('attr.fault_code', (value) => this.handleFaultCode(value));
      sonoffCluster.on('attr.network_led', (value) => {
        if (this.getSetting('network_indicator') !== !!value) {
          this.setSettings({ network_indicator: !!value }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.TurboMode', (value) => {
        const valBool = Number(value) === 20;
        if (this.getSetting('turbo_mode') !== valBool) {
          this.setSettings({ turbo_mode: valBool }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.switch_mode', (value) => {
        const valStr = String(value);
        if (this.getSetting('switch_mode') !== valStr) {
          this.setSettings({ switch_mode: valStr }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.power_on_delay_state', (value) => {
        if (this.getSetting('delayed_power_on_state') !== !!value) {
          this.setSettings({ delayed_power_on_state: !!value }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.power_on_delay_time', (value) => {
        const valSec = value / 2;
        if (this.getSetting('delayed_power_on_time') !== valSec) {
          this.setSettings({ delayed_power_on_time: valSec }).catch(this.error);
        }
      });
      sonoffCluster.on('attr.detach_relay_mode2', (value) => {
        const enabled = !!(value && value.l1);
        if (this.getSetting('detach_relay') !== enabled) {
          this.setSettings({ detach_relay: enabled }).catch(this.error);
        }
      });

      // Live power measurements — manufacturer-specific cluster, NOT the
      // standard Electrical Measurement cluster (confirmed against
      // zigbee-herdsman-converters). Power can be negative here (export
      // direction) — acCurrentPowerValue is signed on the wire.
      sonoffCluster.on('attr.acCurrentVoltageValue', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('measure_voltage', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentPowerValue', (value) => {
        if (!this._isValidReading(value)) return;
        this.setCapabilityValue('measure_power', this._toSignedInt32(value) / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.acCurrentCurrentValue', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('measure_current', value / 1000).catch(this.error);
      });

      // Cumulative import/export counters — real running totals reported by
      // the device, no client-side reconstruction needed.
      sonoffCluster.on('attr.totalEnergyConsumption', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.totalOutputEnergyConsumption', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power.exported', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.energyToday', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power.today', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.energyMonth', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('meter_power.month', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.outputEnergyToday', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('output_energy_today', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.outputEnergyMonth', (value) => {
        if (this._isValidReading(value)) this.setCapabilityValue('output_energy_month', value / 1000).catch(this.error);
      });
      sonoffCluster.on('attr.local_fast_scene_configuration', (value) => {
        const scene = SonoffCluster.parsePowerProtectorPayload(value);
        if (!scene) return;
        this.setSettings({
          max_current_protect: scene.maxCurrentProtect,
          max_power_protect: scene.maxPowerProtect,
          max_voltage_protect_enabled: scene.maxVoltageProtectEnabled,
          max_voltage_protect: scene.maxVoltageProtect,
          min_voltage_protect_enabled: scene.minVoltageProtectEnabled,
          min_voltage_protect: scene.minVoltageProtect,
          external_switch_only_recovery: scene.externalSwitchOnlyRecovery,
          auto_recovery: scene.autoRecovery,
        }).catch(this.error);
      });
    }

    // Passive reports alone can lag behind a real change by hours (same
    // issue as MINI-ZB1GP's daily/monthly counters). Poll actively every
    // 120s instead — same base interval as the smartplug driver in
    // nova.digital.homeyapp.
    if (this._powerPollInterval) this.homey.clearInterval(this._powerPollInterval);
    this.pollPowerMeasurements();
    this._powerPollInterval = this.homey.setInterval(() => {
      this.pollPowerMeasurements();
    }, 120_000);

    await this.checkAttributes();

    this.log('MINI-ZB1GSP initialized');
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
        'totalEnergyConsumption', 'totalOutputEnergyConsumption',
        'energyToday', 'energyMonth', 'outputEnergyToday', 'outputEnergyMonth',
      ], { manufacturerCode: 0x1286 });

      if (data.acCurrentVoltageValue !== undefined && this._isValidReading(data.acCurrentVoltageValue)) {
        await this.setCapabilityValue('measure_voltage', data.acCurrentVoltageValue / 1000);
      }
      if (data.acCurrentPowerValue !== undefined && this._isValidReading(data.acCurrentPowerValue)) {
        await this.setCapabilityValue('measure_power', this._toSignedInt32(data.acCurrentPowerValue) / 1000);
      }
      if (data.acCurrentCurrentValue !== undefined && this._isValidReading(data.acCurrentCurrentValue)) {
        await this.setCapabilityValue('measure_current', data.acCurrentCurrentValue / 1000);
      }
      if (data.totalEnergyConsumption !== undefined && this._isValidReading(data.totalEnergyConsumption)) {
        await this.setCapabilityValue('meter_power', data.totalEnergyConsumption / 1000);
      }
      if (data.totalOutputEnergyConsumption !== undefined && this._isValidReading(data.totalOutputEnergyConsumption)) {
        await this.setCapabilityValue('meter_power.exported', data.totalOutputEnergyConsumption / 1000);
      }
      if (data.energyToday !== undefined && this._isValidReading(data.energyToday)) {
        await this.setCapabilityValue('meter_power.today', data.energyToday / 1000);
      }
      if (data.energyMonth !== undefined && this._isValidReading(data.energyMonth)) {
        await this.setCapabilityValue('meter_power.month', data.energyMonth / 1000);
      }
      if (data.outputEnergyToday !== undefined && this._isValidReading(data.outputEnergyToday)) {
        await this.setCapabilityValue('output_energy_today', data.outputEnergyToday / 1000);
      }
      if (data.outputEnergyMonth !== undefined && this._isValidReading(data.outputEnergyMonth)) {
        await this.setCapabilityValue('output_energy_month', data.outputEnergyMonth / 1000);
      }
    } catch (e) {
      this.log('Could not read power/energy measurements:', e.message);
    }
  }

  handleActionEvent(value) {
    const action = ACTION_LOOKUP[value];
    if (!action) return;
    this.log('Action event:', action);

    if (action === 'switch_on' || action === 'switch_off') {
      this.setCapabilityValue('onoff', action === 'switch_on').catch(this.error);
      return;
    }

    const triggerCard = this.homey.flow.getDeviceTriggerCard(`${this.driver.id}:${action}`);
    triggerCard.trigger(this).catch(this.error);
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
    if (changedKeys.includes('turbo_mode')) {
      sonoffSettings.TurboMode = newSettings.turbo_mode ? 20 : 9;
    }
    if (changedKeys.includes('switch_mode')) {
      sonoffSettings.switch_mode = Number(newSettings.switch_mode);
    }
    if (changedKeys.includes('delayed_power_on_state')) {
      sonoffSettings.power_on_delay_state = !!newSettings.delayed_power_on_state;
    }
    if (changedKeys.includes('delayed_power_on_time')) {
      sonoffSettings.power_on_delay_time = Math.round(newSettings.delayed_power_on_time * 2);
    }
    if (changedKeys.includes('detach_relay')) {
      sonoffSettings.detach_relay_mode2 = newSettings.detach_relay ? 0x01 : 0x00;
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

    const POWER_PROTECTOR_KEYS = [
      'max_current_protect', 'max_power_protect',
      'max_voltage_protect_enabled', 'max_voltage_protect',
      'min_voltage_protect_enabled', 'min_voltage_protect',
      'external_switch_only_recovery', 'auto_recovery',
    ];
    if (changedKeys.some((k) => POWER_PROTECTOR_KEYS.includes(k))) {
      await this.setPowerProtector(newSettings);
    }
  }

  async setPowerProtector(settings) {
    try {
      const payload = SonoffCluster.createPowerProtectorPayload({
        maxCurrentProtect: settings.max_current_protect,
        maxPowerProtect: settings.max_power_protect,
        maxVoltageProtectEnabled: settings.max_voltage_protect_enabled,
        maxVoltageProtect: settings.max_voltage_protect,
        minVoltageProtectEnabled: settings.min_voltage_protect_enabled,
        minVoltageProtect: settings.min_voltage_protect,
        externalSwitchOnlyRecovery: settings.external_switch_only_recovery,
        autoRecovery: settings.auto_recovery,
      });
      await writeAttributesVerbose(this, this.zclNode.endpoints[1].clusters[SonoffCluster.NAME], {
        local_fast_scene_configuration: payload,
      });
      this.log('Power protector written:', payload.toString('hex'));
    } catch (error) {
      this.error('Error writing power protector:', error.message || error);
    }
  }

  /**
   * Set inching (auto-off/on) configuration. Same protocol as ZBMINIR2's
   * setInching — see that driver for the payload format breakdown.
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

  async checkAttributes() {
    try {
      const data = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['powerOnBehavior']);
      if (data && data.powerOnBehavior !== undefined) {
        await this.setSettings({ power_on_behavior: data.powerOnBehavior });
      }
    } catch (e) {
      this.log('Device offline at startup, skipping attribute sync:', e.message);
      return;
    }

    try {
      const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
      const data = await cluster.readAttributes([
        'network_led',
        'TurboMode',
        'switch_mode',
        'power_on_delay_state',
        'power_on_delay_time',
        'detach_relay_mode2',
        'fault_code',
        'local_fast_scene_configuration',
      ], { manufacturerCode: 0x1286 });
      if (!data) return;

      const settingsData = {};
      if (data.network_led !== undefined) settingsData.network_indicator = !!data.network_led;
      if (data.TurboMode !== undefined) settingsData.turbo_mode = Number(data.TurboMode) === 20;
      if (data.switch_mode !== undefined) settingsData.switch_mode = String(data.switch_mode);
      if (data.power_on_delay_state !== undefined) settingsData.delayed_power_on_state = !!data.power_on_delay_state;
      if (data.power_on_delay_time !== undefined) settingsData.delayed_power_on_time = data.power_on_delay_time / 2;
      if (data.detach_relay_mode2 !== undefined) settingsData.detach_relay = !!(data.detach_relay_mode2 && data.detach_relay_mode2.l1);

      if (data.local_fast_scene_configuration !== undefined) {
        const scene = SonoffCluster.parsePowerProtectorPayload(data.local_fast_scene_configuration);
        if (scene) {
          settingsData.max_current_protect = scene.maxCurrentProtect;
          settingsData.max_power_protect = scene.maxPowerProtect;
          settingsData.max_voltage_protect_enabled = scene.maxVoltageProtectEnabled;
          settingsData.max_voltage_protect = scene.maxVoltageProtect;
          settingsData.min_voltage_protect_enabled = scene.minVoltageProtectEnabled;
          settingsData.min_voltage_protect = scene.minVoltageProtect;
          settingsData.external_switch_only_recovery = scene.externalSwitchOnlyRecovery;
          settingsData.auto_recovery = scene.autoRecovery;
        }
      }

      if (Object.keys(settingsData).length > 0) {
        await this.setSettings(settingsData);
      }

      if (data.fault_code !== undefined) {
        this.handleFaultCode(data.fault_code);
      }
    } catch (e) {
      this.log('Could not read SonoffCluster attributes:', e.message);
    }
  }

  async _teardown() {
    if (this._powerPollInterval) {
      this.homey.clearInterval(this._powerPollInterval);
      this._powerPollInterval = null;
    }
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('MINI-ZB1GSP removed');
  }

}

module.exports = SonoffMiniZB1GSP;
