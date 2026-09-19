'use strict';

const SonoffBase = require('../sonoffbase');
const SonoffCluster = require('../../lib/SonoffCluster');
const { CLUSTER, BoundCluster } = require('zigbee-clusters');

// The SNZB-09P reports its own alert state back (triggered manually on the
// device, via a scene, or cancelled) using the same 'alertCommand' - data[1]
// is the alarm type (0=none, 1=manual, 2=scene). Keeps onoff/flows in sync
// even when Homey didn't start the alarm itself.
// NOT verified against real hardware - ported from macmonty's own SNZB-09P
// driver (_reference/macmonty.Homey.Sonoff.Zigbee-master), cross-checked
// against zigbee-herdsman-converters' snzb_09p_alert fromZigbee converter.
class SirenAlertBoundCluster extends BoundCluster {
  constructor(device) {
    super();
    this._device = device;
  }

  alertCommand({ data } = {}) {
    if (!data || data.length < 2) return;
    const alarmType = { 0: 'none', 1: 'manual', 2: 'scene' }[data[1]];
    if (alarmType === undefined) return;

    const active = alarmType !== 'none';
    this._device.log('[SNZB09P] alert report:', alarmType, '-> siren', active ? 'ON' : 'OFF');
    if (this._device.getCapabilityValue('onoff') !== active) {
      this._device.setCapabilityValue('onoff', active).catch(this._device.error);
    }
    if (!active) {
      clearTimeout(this._device._alarmAutoResetTimer);
      this._device._alarmAutoResetTimer = null;
    }
    this._device._triggerFlow(active ? 'siren_activated' : 'siren_deactivated', active ? {} : { reason: 'auto' });
  }
}

class SonoffSNZB09P extends SonoffBase {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this._alarmAutoResetTimer = null;

    zclNode.endpoints[1].bind(SonoffCluster.NAME, new SirenAlertBoundCluster(this));

    this.registerCapability('alarm_tamper', SonoffCluster, {
      report: 'tamper',
      reportParser: value => Boolean(value),
      get: 'tamper',
      getParser: value => Boolean(value),
      getOpts: { getOnStart: true, getOnOnline: true },
    });

    // SonoffBase only installs a passive battery listener - it never
    // actively reads the value, so measure_battery stays empty until the
    // device happens to send an unsolicited report on its own (same fix as
    // the other SNZB-0x battery sensors).
    this.readAttribute(CLUSTER.POWER_CONFIGURATION, ['batteryPercentageRemaining'], (data) => {
      if (data?.batteryPercentageRemaining !== undefined && data.batteryPercentageRemaining < 255) {
        this.setCapabilityValue('measure_battery', data.batteryPercentageRemaining / 2).catch(this.error);
      }
    });

    // Read whatever alarm config the device currently has, so the settings
    // UI reflects reality instead of Homey's last-saved value.
    this.readAttribute(SonoffCluster, [
      'alarm_sound_enable', 'alarm_light_enable', 'alarm_sound_type', 'alarm_volume_level', 'alarm_duration',
    ], (data) => {
      if (!data) return;
      const settingsData = {};
      if (data.alarm_sound_enable !== undefined) settingsData.alarm_sound_enable = Boolean(data.alarm_sound_enable);
      if (data.alarm_light_enable !== undefined) settingsData.alarm_light_enable = Boolean(data.alarm_light_enable);
      if (data.alarm_sound_type !== undefined) settingsData.alarm_sound_type = String(data.alarm_sound_type);
      if (data.alarm_volume_level !== undefined) settingsData.alarm_volume_level = String(data.alarm_volume_level);
      if (data.alarm_duration !== undefined) settingsData.alarm_duration = data.alarm_duration;
      if (Object.keys(settingsData).length) this.setSettings(settingsData).catch(this.error);
    });

    this.registerCapabilityListener('onoff', value => {
      if (value) return this._startSiren();
      return this._stopSiren();
    });

    this.log('SNZB-09P initialized');
  }

  // overrides: optional { soundType, duration } - used by the "Play siren
  // with sound preset" flow action; falls back to Settings otherwise.
  async _startSiren(overrides = {}) {
    const settings = this.getSettings();
    const duration = overrides.duration ?? (Number(settings.alarm_duration) || 60);
    const soundType = overrides.soundType ?? (parseInt(settings.alarm_sound_type, 10) || 0);

    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    const payload = SonoffCluster.createAlertPayload({
      soundEnable: settings.alarm_sound_enable !== false,
      lightEnable: settings.alarm_light_enable !== false,
      soundType,
      volumeLevel: parseInt(settings.alarm_volume_level, 10) || 1,
      durationSeconds: duration,
    });
    await cluster.alertCommand({ data: payload });

    await this.setCapabilityValue('onoff', true).catch(this.error);
    this._scheduleAutoReset(duration);
    this._triggerFlow('siren_activated', { duration });
    this.log(`Siren started: sound=${soundType} duration=${duration}s`);
  }

  async _stopSiren() {
    const cluster = this.zclNode.endpoints[1].clusters[SonoffCluster.NAME];
    await cluster.alertCommand({ data: SonoffCluster.createCancelAlertPayload() });

    await this.setCapabilityValue('onoff', false).catch(this.error);
    clearTimeout(this._alarmAutoResetTimer);
    this._alarmAutoResetTimer = null;
    this._triggerFlow('siren_deactivated', { reason: 'manual' });
    this.log('Siren stopped');
  }

  // Device does not reliably send an alertCommand(alarmType: none) report
  // when the duration elapses - mirror ekaza_siren's UI auto-reset so the
  // onoff tile doesn't stay stuck "on" after the siren itself has stopped.
  _scheduleAutoReset(duration) {
    clearTimeout(this._alarmAutoResetTimer);
    if (!(duration > 0)) return;
    this._alarmAutoResetTimer = this.homey.setTimeout(() => {
      this.setCapabilityValue('onoff', false).catch(this.error);
      this._triggerFlow('siren_deactivated', { reason: 'auto' });
      this._alarmAutoResetTimer = null;
    }, (duration + 2) * 1000);
  }

  _triggerFlow(flowId, tokens = {}) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(flowId);
      if (trigger) trigger.trigger(this, tokens, {});
    } catch (err) {
      this.error(`Flow trigger ${flowId} failed:`, err);
    }
  }

  async onSettings({ changedKeys }) {
    const keys = ['alarm_sound_enable', 'alarm_light_enable', 'alarm_sound_type', 'alarm_volume_level', 'alarm_duration'];
    if (keys.some(key => changedKeys.includes(key))) {
      this.log('Alarm settings changed - applied on next trigger (device has no standalone "save config" command)');
    }
  }

  async _teardown() {
    clearTimeout(this._alarmAutoResetTimer);
    await super._teardown();
  }

  async onDeleted() {
    await this._teardown();
    this.log('SNZB-09P removed');
  }

}

module.exports = SonoffSNZB09P;
