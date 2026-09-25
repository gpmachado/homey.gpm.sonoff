# TODO

## MINI-ZB1GP: Electrical Monitoring (power protector, attribute 0x7016)

Status: researched and confirmed readable on the real unit, **not implemented**. The two fault alarms
(metering error, overload) that come from the same feature area are already in the driver.

### What it is

The "Electrical Monitoring" entity in Home Assistant (via Zigbee2MQTT). It is the Sonoff "power
protector" configuration: thresholds the device watches on the measured load. Attribute `0x7016`
(`local_fast_scene_configuration`) of the manufacturer cluster `0xFC11` (manufacturer code `0x1286`),
a ZCL ARRAY (type `0x48`) of UINT8 holding TLV "scenes".

| Setting | Range | Value read from my unit (2026-09-25) |
|---|---|---|
| Overcurrent monitoring | 0.1 to 16 A | 16 A (the maximum) |
| Overpower monitoring | 2 to 3840 W | 3840 W (the maximum) |
| Overvoltage monitoring | on/off + 85 to 277 V | on, 277 V |
| Undervoltage monitoring | on/off + 85 to 277 V | on, 165 V |
| Auto recovery | on/off | off |
| Recovery only by external switch | on/off | off |

I do not know whether 165 V is the factory default or something set earlier from another app.
Overcurrent and overpower at their maximum effectively disable those two limits.

The MINI-ZB1GP has no relay, so nothing is tripped. On relay models (MINI-ZB1GSP, S60ZBTPF) the same
setting opens the relay. On this model it is monitoring only, and the result shows up in the fault code
(bit `0b100`, "Electrical Status").

### What was found

- Zigbee2MQTT documents it as a composite `power_protector` that is set-only (it never reads it).
- The open ZHA quirk PR (zigpy/zha-device-handlers#5155) reads `0x7016` at setup and parses the same TLV.
- On the real unit the read works. `teste-overmonitor3.log` (raw zigbee-clusters frame) shows
  `16 70 00 48 20 3f 00 ...`: attribute `0x7016`, status `00` (SUCCESS), type ARRAY, element type UINT8,
  63 elements.
- The first 50 bytes of that response, kept here because the log files are not in the repository (the
  log itself cut the last 20 bytes):
  `16 70 00 48 20 3f 00 | 01 01 01 | 01 05 01 00 00 03 28 | 02 14 01 80 3e 00 00 00 98 3a 00 00 08 3a 04 80 88 84 02 80 00 00 | 03 12 01 00 14 00 00 00 40 7e 05 ...`
  After the 7-byte header: 3 bytes `01 01 01`, then TLV scenes (type, length, value): type `01` (5 bytes),
  type `02` = power protector (20 bytes, the one decoded below), type `03` (18 bytes, not decoded).
- `SonoffCluster.parsePowerProtectorPayload()` decodes those bytes correctly (values in the table above).
  `createPowerProtectorPayload()` builds the write payload, byte for byte like the z2m encoder.

### Why the read returns `undefined` today

`cluster.readAttributes(['local_fast_scene_configuration'], { manufacturerCode: 0x1286 })` returns an
object without the key, even though the device answered SUCCESS. The response is decoded as
`readAttributesStructured.response` (command id `0x01` collides with the normal read response), and
the custom `ZCLUint8Array` type in `lib/SonoffCluster.js` does not consume the right number of bytes
when parsing, so the attribute is dropped. Do not read "undefined" as "unsupported": that was the wrong
conclusion of the first probe.

### To do

1. **Fix the read.** Either make the `ZCLUint8Array` parser return the elements and the correct length
   (element type byte + 2-byte count + data), or read the raw response frame and parse it directly.
   Check it against the captured bytes in `teste-overmonitor3.log` before trusting it.
2. **Show the current limits** in the device settings, read-only first (labels like the HA ones:
   Overcurrent / Overpower / Overvoltage / Undervoltage Monitoring).
3. **Allow editing** only after 1 and 2 work and with an explicit decision per setting. Writing changes
   the device configuration. Use `createPowerProtectorPayload()` with the values read back, change one
   field, and read again to confirm. Keep the ranges above. Note the write path was never exercised on
   real hardware.
4. Decide what the app does with the "Electrical Status" alarm once limits can be set (a flow trigger
   for the alarm already exists through the `alarm_generic.overload_protection` capability).

### References

- `lib/SonoffCluster.js`: `local_fast_scene_configuration` (0x7016), `createPowerProtectorPayload`,
  `parsePowerProtectorPayload`.
- `drivers/MINI-ZB1GP/device.js`: `_handleFaultCode` and `FAULT_BITS` for the fault alarms.
- Removed MINI-ZB1GSP driver (git history, commit `8ffb0d2`): its `setPowerProtector` and settings show
  how the write was wired for the relay model.
- zigbee-herdsman-converters `sonoff.ts`: `localFastSceneConfiguration({hasSwitch: false})` and
  `faultCodeMiniZb1gsp({hasSwitch: false})` for the MINI-ZB1GP.
- https://www.zigbee2mqtt.io/devices/MINI-ZB1GP.html
- https://github.com/zigpy/zha-device-handlers/pull/5155

## Other open items

- Availability on/off switch as a global app setting (design agreed, not implemented): stop marking devices
  unavailable when off, keep the Traffic and Rejoins statistics, restore devices to available when switched
  off, and do not fire the availability flow cards on the switch.
- Device name in the log lines: `this.log` cannot be replaced on an SDK device. Only option is a `nlog()`
  helper and a mechanical replacement of about 190 calls, and SDK/homey-zigbeedriver lines would still
  show only the uuid.
- Post the notes for the upstream fork owner (macmonty): issues are disabled there, so use the e-mail.
  Draft in the session scratchpad; put the full notes in a gist or `docs/` and link them.
- Sentinels (`gpm.statistic.tracker`): the `MEMORY_LOG` constant change is not committed yet.
