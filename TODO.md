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

- Rejoin detection: ZBMINIR2, MINI-ZBD and MINI-ZB2GS still carry their own copy (about 40 lines each, 30 s cooldown, a
  write guard). `lib/rejoinDetection.js` was written for the MINI-ZB1GP; moving the three onto it needs the
  power-cut test on each, and a decision on the cooldown (30 s merges cuts closer than that). **Confirmed
  2026-09-27**: the write guard (`_lastSonoffWriteAt` on ZBMINIR2/MINI-ZBD, `node._zb2gsLastSonoffWriteAt` on
  MINI-ZB2GS - node-scoped there because the two gangs share the node) suppresses the burst a settings write itself
  causes, and `lib/rejoinDetection.js` has no equivalent - it never needed one for the MINI-ZB1GP, which has no
  relay and so no user-triggered SonoffCluster writes frequent enough to collide. A unification has to add this as
  an optional parameter (node-scoped or device-scoped), not just swap the wrapper for the shared module; a first
  external-review sketch of a `FrameMiddleware`-based unification missed this.
  **2026-09-27: stage 1 and 2 done.** `lib/FrameMiddleware.js` exists (unit-tested standalone, not wired into
  `SonoffBase`/`availabilityHooks.js` yet) and `lib/rejoinDetection.js` (MINI-ZB1GP) now runs on it at
  `FRAME_PRIORITY.REJOIN`, verified on hardware: same "Power-up signature" detection, same flow trigger, zero
  `[FrameMiddleware]` errors, no effect on the other devices sharing the app. The write-guard gap above still
  applies before ZBMINIR2/MINI-ZBD/MINI-ZB2GS can move onto the same module. Next: `availabilityHooks.js`, then
  `SonoffBase`'s Basic filter and cluster-report interceptor.
  **2026-09-27 (later the same day): stage 3 done.** `availabilityHooks.js`'s inbound hook now registers on
  `FrameMiddleware` too, at `FRAME_PRIORITY.AVAILABILITY` (last); the outbound `sendFrame` hook is unchanged (a
  different function, outside FrameMiddleware's scope). `_originalHandleFrame`/`_substituteHandleFrame` are gone -
  the middleware owns that state. Verified against the pre-migration module on 16 simulated scenarios (identical
  behaviour and log lines) and, new for this stage, rejoin + availability coexisting on one node (priority order
  rejoin-then-availability, both see every frame, rejoin survives an availability uninstall). On hardware
  (teste9.log): 30 clean installs, a real power cut on the MINI-ZB1GP fired the rejoin trigger normally, removing
  that device produced the same restore sequence as before, zero residual activity or errors for 8.5 min after,
  and the other 29 devices kept working. Left: `SonoffBase`'s Basic filter and cluster-report interceptor - the
  only piece every driver goes through, so the largest blast radius; no urgency, no bug observed.
- Duplication between the switch drivers: `ZBMINIR2/device.js` and `MINI-ZBD/device.js` are 94% identical (318 and
  300 lines), their `driver.settings.compose.json` is byte-identical, and `MINI-ZB2GS` shares 80-90% of both with them.
  A shared base (onOff wiring, reporting, rejoin, availability) would remove most of that, but needs the same
  hardware pass (partida, power cut, removal, restart) on all three before landing. Not started.
- Frame hooks (needs hardware tests on ZBMINI, ZBMINIR2, MINI-ZBD, MINI-ZB2GS, MINI-ZB1GP and the sensors before
  and after): several layers wrap `node.handleFrame` today: the Basic filter in `SonoffBase`, the per-driver hooks of
  ZBMINIR2 / MINI-ZBD / MINI-ZB2GS, `_installClusterReportInterceptor` (MINI-ZB1GP) and the availability manager.
  It works because the availability manager is installed last and removed first (order documented in
  `drivers/sonoffbase.js`), and the flags on the node stop re-wrapping. Idea: one ordered hook list on the node with a
  single `handleFrame` that iterates it, so each layer removes only itself; that would also let the Basic filter
  (never removed today) be uninstalled. No bug was observed, so this is a cleanup, not a fix.
  Audit of the install order (2026-09-27): in every driver the frame hooks (own wrapper, `_installClusterReportInterceptor`,
  `installRejoinDetection`) run before `AvailabilityManagerPassive.install()`, which stays last; MINI-ZB2GS looks
  reversed by line number but calls `_installFrameHook()` (l.129) before the install (l.140). MINI-ZB2GS needs its 30 s
  rejoin cooldown because both gang endpoints dump on boot; a shorter one would still merge those (they arrive within ms).
  **Design sketched by an external review (not yet built or tested)**: `lib/FrameMiddleware.js`, one `node.handleFrame`
  per node with prioritized handlers (`register(id, priority, fn)`, `fn` returns `false` to swallow a frame),
  so each layer removes only its own entry instead of restoring a saved "original" function. Priorities suggested:
  Basic filter (10) -> cluster-report interceptor (20) -> rejoin (50) -> availability (100, last, never swallows).
  One correctness note for whoever builds it: the Basic filter in `SonoffBase` and `installRejoinDetection` on
  MINI-ZB2GS must stay keyed by the **node** (today: `node._basicReadResponseHookInstalled`,
  `node._rejoinDetectionInstalled`), not by `this.getData().id` — a multi-gang node has one device instance per
  gang calling `onNodeInit`, and a per-device id would register one duplicate handler per gang instead of one per
  node, which is exactly the stacking the guards exist to prevent. `installRejoinDetection` already gets this
  right (node-level flag, device pointer updated on re-init); a `FrameMiddleware` port needs the same. Suggested
  order, smallest first: (1) `FrameMiddleware.js` alone, unit-tested standalone, wired into nothing yet;
  (2) migrate `installRejoinDetection` onto it, since it already isolates cleanly and MINI-ZB1GP's real hardware
  gives a fast test; (3) migrate `availabilityHooks.js`, hardware-tested the same way as the current split
  (partida, power cut, removal, restart); (4) `SonoffBase`'s Basic filter and cluster-report interceptor last,
  since every driver goes through it.
- `AvailabilityManager.js` split: `HourlyMessageStats` is out (`lib/HourlyMessageStats.js`) and so are the inbound and
  outbound hooks (`lib/availabilityHooks.js`, applied to the Passive manager). The timeout policy, poll-before-offline
  and the sibling cascade stay in `AvailabilityManager.js` on purpose, so availability state is not spread over several
  files, and Passive and Callback stay together. Verified: old and new modules behave identically on a simulated
  node, and on hardware the hooks install once per node for 27 devices with no errors. **Still to test on hardware**:
  cut the power of one ZBMINIR2 (Send failed x/3, unavailable, back to available), remove one device (handleFrame
  hook restored, the others keep counting), restart the app.
- Availability on/off switch as a global app setting (design agreed, not implemented): stop marking devices
  unavailable when off, keep the Traffic and Rejoins statistics, restore devices to available when switched
  off, and do not fire the availability flow cards on the switch.
- Device name in the log lines: `this.log` cannot be replaced on an SDK device. Only option is a `nlog()`
  helper and a mechanical replacement of about 190 calls, and SDK/homey-zigbeedriver lines would still
  show only the uuid.
- Post the notes for the upstream fork owner (macmonty): issues are disabled there, so use the e-mail.
  Draft in the session scratchpad; put the full notes in a gist or `docs/` and link them.
- Sentinels (`gpm.statistic.tracker`): the `MEMORY_LOG` constant change is not committed yet.
