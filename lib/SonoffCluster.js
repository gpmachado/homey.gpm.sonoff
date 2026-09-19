'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');
const { DataType } = require('@athombv/data-types');

/**
 * Raw ZCL ARRAY of UINT8 (type tag 0x48, elementType 0x20, 2-byte LE count,
 * then the raw elements) - matches zigbee-herdsman-converters writing
 * SonoffCluster.local_fast_scene_configuration as
 * `{elementType: UINT8, elements: bytes}` with `type: ARRAY`.
 */
const ZCLUint8Array = new DataType(
  0x48,
  'rawUint8Array',
  -0,
  (buf, v, i) => {
    const elements = Buffer.isBuffer(v) ? v : Buffer.from(v);
    let offset = buf.writeUInt8(0x20, i);
    offset = buf.writeUInt16LE(elements.length, offset);
    elements.copy(buf, offset);
    return (offset + elements.length) - i;
  },
  (buf, i) => buf.slice(i),
);

/** BITMAP8 type (ZCL type ID 0x18) that serializes/deserializes as a plain number. */
const bitmap8 = new DataType(
  0x18,
  'bitmap8',
  1,
  (buf, v, i) => buf.writeUInt8(typeof v === 'number' ? v & 0xFF : 0, i),
  (buf, i) => buf.readUInt8(i),
);

/** BITMAP32 type (ZCL type ID 0x1B) that serializes/deserializes as a plain number. */
const bitmap32 = new DataType(
  0x1B,
  'bitmap32',
  4,
  (buf, v, i) => buf.writeUInt32LE(typeof v === 'number' ? v : 0, i),
  (buf, i) => buf.readUInt32LE(i),
);

/**
 * SonoffCluster - manufacturer-specific ZCL cluster (0xFC11 / 64529) used by
 * Sonoff Zigbee devices (switches, energy meters, TRVs, sensors) for settings
 * and readings that don't map to a standard ZCL cluster.
 *
 * NOTE: attribute IDs must be unique. Two ZCL attribute *names* can never share
 * one wire ID - device.js's incoming-report interceptor builds an id->name map
 * that keeps only the first name found in insertion order, so a duplicate ID
 * silently loses its second name. Keep this list free of collisions.
 */
class SonoffCluster extends Cluster {

  static get ID() {
    return 64529;
  }

  static get NAME() {
    return 'SonoffCluster';
  }

  static get ATTRIBUTES() {
    return {
      child_lock: { id: 0x0000, type: ZCLDataTypes.bool },
      network_led: { id: 0x0001, type: ZCLDataTypes.bool },
      backlight: { id: 0x0002, type: ZCLDataTypes.bool },
      temperatureUnits: { id: 0x0007, type: ZCLDataTypes.uint16 },
      fault_code: { id: 0x0010, type: ZCLDataTypes.uint32 },
      TurboMode: { id: 0x0012, type: ZCLDataTypes.int16 },
      power_on_delay_state: { id: 0x0014, type: ZCLDataTypes.bool },
      power_on_delay_time: { id: 0x0015, type: ZCLDataTypes.uint16 },
      switch_mode: { id: 0x0016, type: ZCLDataTypes.uint8 },
      detach_mode: { id: 0x0017, type: ZCLDataTypes.bool },
      deviceWorkMode: { id: 0x0018, type: ZCLDataTypes.uint8 },
      detach_relay_mode2: { id: 0x0019, type: bitmap8 },
      // MINI-ZB1GSP physical button/switch action feed (read-only report).
      // 1=single_click, 2=double_click, 3=long_press, 4=switch_on, 5=switch_off.
      detach_relay_action_event: { id: 0x0028, type: ZCLDataTypes.uint8 },
      setCalibrationAction: { id: 0x001D, type: ZCLDataTypes.charStr },
      calibrationStatus: { id: 0x001E, type: ZCLDataTypes.uint8 },
      transitionTime: { id: 0x001F, type: ZCLDataTypes.uint32 },
      calibrationProgress: { id: 0x0020, type: ZCLDataTypes.uint8 },
      // 0x0022 = programmableStepperSequence (confirmed against
      // zigbee-herdsman-converters' shared `customClusterEwelink` cluster -
      // there is no such thing as a "protocolDataReport" attribute; that name
      // was a leftover duplicate of this same ID and has been removed).
      programmableStepperSequence: { id: 0x0022, type: ZCLDataTypes.buffer },
      inching_control_bits: { id: 0x001C, type: bitmap32 },

      temperatureCalibration: { id: 0x2003, type: ZCLDataTypes.int16 },
      humidityCalibration: { id: 0x2004, type: ZCLDataTypes.int16 },
      tamper: { id: 0x2000, type: ZCLDataTypes.uint8 },
      illuminance: { id: 0x2001, type: ZCLDataTypes.uint8 },
      // SNZB-09P siren (read-only): 0=battery, 1=external power.
      powerSupplyMode: { id: 0x0024, type: ZCLDataTypes.uint8 },
      // SNZB-09P siren alarm configuration, written before each alertCommand trigger.
      alarmLightEnable: { id: 0x2022, type: ZCLDataTypes.bool },
      alarmSoundType: { id: 0x2023, type: ZCLDataTypes.uint8 },
      alarmVolumeLevel: { id: 0x2024, type: ZCLDataTypes.uint8 },
      alarmDuration: { id: 0x2025, type: ZCLDataTypes.uint16 },
      alarmSoundEnable: { id: 0x2026, type: ZCLDataTypes.bool },

      minBrightnessThreshold: { id: 0x4001, type: ZCLDataTypes.uint8 },
      maxBrightnessThreshold: { id: 0x4002, type: ZCLDataTypes.uint8 },
      dimmingLightRate: { id: 0x4003, type: ZCLDataTypes.uint8 },
      levelForCalibration: { id: 0x4006, type: ZCLDataTypes.uint8 },

      motorTravelCalibrationAction: { id: 0x5001, type: ZCLDataTypes.uint8 },
      lackWaterCloseValveTimeout: { id: 0x5011, type: ZCLDataTypes.uint16 },
      motorTravelCalibrationStatus: { id: 0x5012, type: ZCLDataTypes.uint8 },
      motorRunStatus: { id: 0x5013, type: ZCLDataTypes.uint8 },

      open_window: { id: 0x6000, type: ZCLDataTypes.bool },
      frost_protection_temperature: { id: 0x6002, type: ZCLDataTypes.int16 },
      idle_steps: { id: 0x6003, type: ZCLDataTypes.uint16 },
      closing_steps: { id: 0x6004, type: ZCLDataTypes.uint16 },
      valve_opening_limit_voltage: { id: 0x6005, type: ZCLDataTypes.uint16 },
      valve_closing_limit_voltage: { id: 0x6006, type: ZCLDataTypes.uint16 },
      valve_motor_running_voltage: { id: 0x6007, type: ZCLDataTypes.uint16 },
      valve_opening_degree: { id: 0x600b, type: ZCLDataTypes.uint8 },
      valve_closing_degree: { id: 0x600c, type: ZCLDataTypes.uint8 },

      // MINI-ZB1GP / MINI-ZB1GSP energy meter attributes (from z2m)
      acCurrentCurrentValue: { id: 0x7004, type: ZCLDataTypes.uint32 },
      acCurrentVoltageValue: { id: 0x7005, type: ZCLDataTypes.uint32 },
      acCurrentPowerValue: { id: 0x7006, type: ZCLDataTypes.uint32 },
      outlet_control_protect: { id: 0x7007, type: ZCLDataTypes.uint8 },
      energyToday: { id: 0x7009, type: ZCLDataTypes.uint32 },
      energyMonth: { id: 0x700A, type: ZCLDataTypes.uint32 },
      energyYesterday: { id: 0x700B, type: ZCLDataTypes.uint32 },
      daily_run_time: { id: 0x701C, type: ZCLDataTypes.uint32 },
      total_run_time: { id: 0x701D, type: ZCLDataTypes.uint32 },
      // 0x7018/0x7019 also carry a "daily/monthly reverse energy" meaning on some
      // Sonoff models. Both names map to the same wire IDs; keep a single entry
      // each (outputEnergy*) to avoid a duplicate-ID collision. See class doc.
      outputEnergyToday: { id: 0x7018, type: ZCLDataTypes.uint32 },
      outputEnergyMonth: { id: 0x7019, type: ZCLDataTypes.uint32 },
      outputEnergyYesterday: { id: 0x701A, type: ZCLDataTypes.uint32 },
      // 0x701E/0x701F also carry a "total forward/reverse energy" meaning on some
      // Sonoff models. Both names map to the same wire IDs; keep a single entry
      // each (total*EnergyConsumption) to avoid a duplicate-ID collision.
      totalEnergyConsumption: { id: 0x701E, type: ZCLDataTypes.uint32 },
      totalOutputEnergyConsumption: { id: 0x701F, type: ZCLDataTypes.uint32 },
      voltage_frequency: { id: 0x7029, type: ZCLDataTypes.uint32 },
      // MINI-ZB1GSP "Power Protector" overload-protection settings. Encoded
      // as a raw ZCL ARRAY of UINT8 (see ZCLUint8Array above). Full write
      // payload built by SonoffCluster.createPowerProtectorPayload().
      local_fast_scene_configuration: { id: 0x7016, type: ZCLUint8Array },
    };
  }

  // MINI-ZB1GSP "Power Protector" (localFastSceneConfiguration) payload.
  // Byte-for-byte match of zigbee-herdsman-converters' encoder - see its
  // localFastSceneConfiguration({hasSwitch:true}) toZigbee.convertSet.
  // Settings units: current in A, power in W, voltage in V, all stored
  // on the wire as value*1000 (uint32).
  static createPowerProtectorPayload(settings) {
    const toUInt32LEBytes = (value) => {
      const v = value >>> 0;
      return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    };

    const sceneValue = [1]; // enabled
    sceneValue.push(...toUInt32LEBytes(Math.round(settings.maxCurrentProtect * 1000)));
    sceneValue.push(...toUInt32LEBytes(Math.round(settings.maxPowerProtect * 1000)));
    sceneValue.push(settings.externalSwitchOnlyRecovery ? 1 : 0);

    const maxVoltage = Math.round(settings.maxVoltageProtect * 1000) & 0x7fffffff;
    const minVoltage = Math.round(settings.minVoltageProtect * 1000) & 0x7fffffff;
    sceneValue.push(...toUInt32LEBytes((settings.maxVoltageProtectEnabled ? 0x80000000 : 0) | maxVoltage));
    sceneValue.push(...toUInt32LEBytes((settings.minVoltageProtectEnabled ? 0x80000000 : 0) | minVoltage));
    sceneValue.push(settings.autoRecovery ? 1 : 0, 1);

    const powerProtectorType = 0x02;
    return Buffer.from([0x00, 0x01, 0x01, powerProtectorType, sceneValue.length & 0xff, ...sceneValue]);
  }

  // Decodes a reported localFastSceneConfiguration buffer back into the
  // same field names createPowerProtectorPayload() accepts. Returns null
  // if the buffer doesn't contain a "power protector" (type 0x02) scene.
  static parsePowerProtectorPayload(bytes) {
    if (!bytes || bytes.length < 5) return null;
    const powerProtectorType = 0x02;

    let index = 3;
    while (index + 1 < bytes.length) {
      const reportedSceneType = bytes[index];
      const length = bytes[index + 1];
      index += 2;
      const value = bytes.slice(index, index + length);
      index += length;

      if (reportedSceneType !== powerProtectorType) continue;
      if (value.length < 19) return null;

      const readUInt32LE = (buf, i) => buf[i] + buf[i + 1] * 0x100 + buf[i + 2] * 0x10000 + buf[i + 3] * 0x1000000;
      const maxVoltageRaw = readUInt32LE(value, 10);
      const minVoltageRaw = readUInt32LE(value, 14);

      return {
        maxCurrentProtect: readUInt32LE(value, 1) / 1000,
        maxPowerProtect: readUInt32LE(value, 5) / 1000,
        externalSwitchOnlyRecovery: value[9] === 1,
        maxVoltageProtectEnabled: !!(maxVoltageRaw & 0x80000000),
        maxVoltageProtect: (maxVoltageRaw & 0x7fffffff) / 1000,
        minVoltageProtectEnabled: !!(minVoltageRaw & 0x80000000),
        minVoltageProtect: (minVoltageRaw & 0x7fffffff) / 1000,
        autoRecovery: value[18] === 1,
      };
    }
    return null;
  }

  // SNZB-09P: activate the siren, carrying the sound/light/volume/duration
  // config directly in the command payload (device firmware does not apply
  // separately-written attribute values to a bare trigger). Ported from
  // macmonty's SNZB-09P driver (_reference/macmonty.Homey.Sonoff.Zigbee-master) -
  // NOT independently verified against real hardware yet.
  static createAlertPayload({ soundEnable, lightEnable, soundType, volumeLevel, durationSeconds }) {
    const duration = Math.max(1, Math.min(900, Math.round(durationSeconds)));
    return Buffer.from([
      0x02,                 // command: start alert
      0x00,
      soundEnable ? 1 : 0,  // voice
      lightEnable ? 1 : 0,  // light
      soundType & 0xFF,     // alertSound (0-9 preset)
      volumeLevel & 0xFF,   // volume (0-3)
      duration & 0xFF,          // duration low byte
      (duration >> 8) & 0xFF,   // duration high byte
      0x00,
    ]);
  }

  // SNZB-09P: cancel an active siren alert.
  static createCancelAlertPayload() {
    return Buffer.from([0x01]);
  }

  static get COMMANDS() {
    return {
      protocolData: {
        id: 0x01,
        manufacturerId: 0x1286,
        args: { data: ZCLDataTypes.buffer },
      },
      // cmdId 0x03 - device status/heartbeat sent periodically by the energy meter.
      // Declaring it here prevents unknown_command_received:3 errors.
      statusReport: {
        id: 0x03,
        manufacturerId: 0x1286,
        args: { data: ZCLDataTypes.buffer },
      },
      protocolDataResponse: {
        id: 0x0B,
        manufacturerId: 0x1286,
        args: {
          status: ZCLDataTypes.uint8,
          reserved: ZCLDataTypes.uint8,
        },
      },
      // cmdId 0x10 - resets accumulated energy (totalEnergyConsumption). NOT
      // manufacturer-specific (sniffer-confirmed: mfr-specific bit unset in
      // frame control). Distinct from statusReport (0x03) - an earlier TODO
      // comment here mistakenly assumed the last byte of the 0x10 payload
      // (01 01 03) was the cmdId; the real cmdId is a separate frame field.
      resetConsumption: {
        id: 0x10,
        args: {
          data: ZCLDataTypes.buffer,
        },
      },
      // SNZB-09P siren: triggers/cancels the alarm. Unlike other Sonoff
      // attributes, sound/light/volume/duration are NOT pre-written then
      // referenced - they're embedded directly in this command's payload
      // each time (see createAlertPayload()/createCancelAlertPayload()
      // below). Also reused bidirectionally: the device sends the same
      // command back to report state changes (own button, scene, timeout)
      // - see SirenAlertBoundCluster in SNZB-09P/device.js.
      alertCommand: {
        id: 0x0f,
        manufacturerId: 0x1286,
        args: {
          data: ZCLDataTypes.buffer,
        },
      },
    };
  }

  /** Suppress device->hub protocolData response ACK - prevents unknown_command errors. */
  protocolDataResponse() {}

  /** Suppress the framework's default-response handling for this cluster. */
  onDefaultResponse() {}

  // statusReport (cmdId 0x03) heartbeats from the device are handled by
  // device.js's handleFrame interceptor - no handler needed here.
}

module.exports = SonoffCluster;
