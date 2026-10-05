# TODO

## MINI-ZB1GP: Electrical Monitoring (power protector, attribute 0x7016)

Status: **read fixed and shown read-only** (2026-10-05, simulated against the real bytes, not yet run on the unit); editing not implemented. The two fault alarms
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

1. **Fix the read.** DONE. `ZCLUint8Array.fromBuffer` returned a bare Buffer; zigbee-clusters' record parser
   calls it with `returnLength` and expects `{ result, length }` for a variable-length type, so the value
   came back `undefined`. It now reads the array header (element type + 2-byte count) and returns the
   elements. Checked against the real bytes in `teste-overmonitor3.log` (first 50 of 70 captured, the rest
   padded): the record parser gives id `0x7016`, SUCCESS, 63 elements, and `parsePowerProtectorPayload()`
   gives 16 A, 3840 W, overvoltage on 277 V, undervoltage on 165 V - the values in the table above. The
   original code, same input, gives `undefined`.
2. **Show the current limits** in the device settings, read-only first. DONE: `_readElectricalMonitoring()`
   in `drivers/MINI-ZB1GP/device.js` reads `0x7016` once at start (with `manufacturerCode: 0x1286`) and writes
   four read-only labels (Overcurrent / Overpower / Overvoltage / Undervoltage monitoring) in a settings group.
   A failed read only logs a line. Simulated with the real class (fake cluster that runs the captured bytes
   through zigbee-clusters' own record parser); needs one run on the unit to see the labels.
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

### FrameMiddleware migration (frame hooks)

Goal: one `node.handleFrame` per node (`lib/FrameMiddleware.js`), with named, prioritized handlers, instead of each
concern wrapping the previous one by hand. No bug was ever observed in the old per-layer wrapping - this is about
removing a hand-maintained ordering invariant before a future mistake breaks it, not fixing something broken today.

**Rule that governs every priority number**: a handler that never returns `false` (an "observer") must have a
lower number than any handler that can swallow a frame it needs to see - the dispatch loop stops at the first
`false`. Current values, in `lib/FrameMiddleware.js`: `AVAILABILITY: 0`, `REJOIN: 5`, `BASIC_FILTER: 10`,
`CLUSTER_REPORT: 20`. Getting this backwards is not cosmetic: verified by simulation that it would silently break
the "Reconnected after power cut" trigger (a swallower ahead of `REJOIN` eats the exact frame rejoin needs) and
undercount the Traffic tab (a swallower ahead of `AVAILABILITY` hides frames from the statistics; a naive
"notify activity on swallow" compensation only patches the availability timeout, not that count - see
`AvailabilityManagerPassive.notifyActivity()`'s own comment for why it deliberately skips recording the message).

**Done, hardware-tested:**
- `lib/FrameMiddleware.js` itself (21 simulated scenarios, including the MINI-ZB2GS multi-device-per-node case).
- `lib/rejoinDetection.js` gained an optional write guard (`writeGuardMs` + `getLastWriteAt`, checked before the
  module's own cooldown is touched, so a write-induced false match never consumes it). MINI-ZB1GP runs on it
  unchanged (no write guard needed - no relay, no frequent writes); ZBMINIR2 now runs on it too, with the guard
  (teste8.log: real power cut on the MINI-ZB1GP; teste12.log: two settings writes on two different ZBMINIR2 - LED
  indicator off, TurboMode on - caused zero false rejoins, and a later real power cut on two ZBMINIR2 sharing a
  circuit fired the trigger once per device, no duplicates, no interference with the other 28 devices running).
  ZBMINIR2's own ACK-drop (cmdId 0x0B) moved to a small handler at `FRAME_PRIORITY.CLUSTER_REPORT`.
  MINI-ZBD got the exact same migration, plus availability tracking and an active poll it never had (same firmware
  as the ZBMINIR2 - z2m lists MINI-ZBD as a white-label of the same device definition - so the same tier applies);
  **not yet confirmed on a real MINI-ZBD unit** (the user testing has none; a friend who owns one will test later).
  MINI-ZB2GS still carries its own separate inline copy - not migrated yet, see below.
- `lib/availabilityHooks.js`'s inbound hook (every driver using `AvailabilityManagerPassive`) runs on it at
  `FRAME_PRIORITY.AVAILABILITY`; the outbound `sendFrame` hook is untouched, a different function outside
  FrameMiddleware's scope. `_originalHandleFrame`/`_substituteHandleFrame` are gone, the middleware owns that
  state. teste9.log: 30 clean installs, a real power cut + rejoin trigger, a device removal with zero residual
  activity or errors for 8.5 min after, the other 29 devices unaffected throughout.
- `HourlyMessageStats` extracted to its own file (`lib/HourlyMessageStats.js`) - unrelated to FrameMiddleware, same
  cleanup effort, done and verified identical to the pre-extraction module.

**Not done, no hardware pass yet:**
- `SonoffBase`'s Basic filter and cluster-report interceptor - the piece every driver goes through, so the
  largest blast radius. Two independent external patch proposals for this were reviewed and rejected: both had the
  priority order backwards (see the rule above); the first also had `_installClusterReportInterceptor`'s
  behaviour changed in ways not verified against the current implementation. If this is attempted again, don't
  reuse `_notifyAliveOnSwallow`-style compensation - with the corrected priorities, `AVAILABILITY` already sees
  every frame before anything can swallow it, so no compensation is needed.
  Decision (2026-09-27): no action for now - largest blast radius in the app, no bug observed, no pressing
  need. Revisit only if a concrete bug or feature need shows up; don't refactor this speculatively.
- MINI-ZBD and MINI-ZB2GS's own inline rejoin + ACK-drop code - still raw-wrapped, not on `lib/rejoinDetection.js`
  (ZBMINIR2 is done, see above; the write guard it needed is now a module option). MINI-ZB2GS additionally needs
  `node._zb2gsLastSonoffWriteAt` (node-scoped since the two gangs share the node) to suppress the burst a
  settings write itself causes; `lib/rejoinDetection.js` has no equivalent (never needed one for the MINI-ZB1GP,
  which has no relay and so no frequent user-triggered writes). A unification needs this as an optional parameter
  (node-scoped or device-scoped depending on the driver), not just a wrapper swap - confirmed by reading the
  actual write-guard code in all three drivers. MINI-ZB2GS's 30 s rejoin cooldown is required (both gang
  endpoints dump on boot within milliseconds of each other); a shorter one would still merge those two frames into
  one event.
- Two external review sketches of `FrameMiddleware.js` itself were compared against ours and not adopted beyond
  the harmless `listHandlers()` diagnostic: both had the same reproducible bug (`register()` calling
  `unregister()` on a same-id replace trips the "handlers went empty" auto-restore mid-replace, silently killing
  the wrapper - our own first draft had this too, caught by its own test suite before shipping), and one added a
  `dispose()` that clears every handler on the node instead of just the caller's, a footgun once two concerns
  share a node (confirmed: calling it where `unregister(id)` was meant silently breaks the other handler too).

**Convention for handler ids**: node-level (same string regardless of which device instance installs it, e.g.
`'availability'`, `'rejoin'`) for anything that must exist once per node no matter how many devices share it -
`installRejoinDetection` already does this right (node-level flag, device pointer updated on re-init). A
multi-gang node (MINI-ZB2GS) runs `onNodeInit` once per gang, so a per-device id for a node-level concern installs
one duplicate handler per gang - confirmed by simulation, not just a hypothetical.

### Other items

- Duplication between the switch drivers: **done for ZBMINIR2 and MINI-ZBD** (were 94% identical, 318/300 lines).
  `drivers/relaySwitchBase.js` now holds all the shared logic (onOff wiring, reporting, rejoin, ACK-drop,
  availability, inching, settings); both `ZBMINIR2/device.js` and `MINI-ZBD/device.js` are 11-line empty
  subclasses. Driver-specific strings (flow card id, log prefixes) come from `this.driver.id` at runtime, which
  matches each driver's own manifest `id` exactly. The driver folders (`driver.compose.json`, icons, settings)
  stay separate on purpose - confirmed why: same firmware (MINI-ZBD is a white-label of the ZBMINIR2 in z2m's own
  device database), kept as two Homey drivers only for a distinct icon and name per model.
  Verified with a simulated node running the actual classes (not a reimplementation): ACK swallowed, a
  settings-write-induced burst suppressed, a real cut fires, a lone periodic report does not - identical for both.
  **Still needs a hardware pass** on both models (partida, power cut, removal, restart) before this is trusted the
  same way the pre-extraction code was.
  `MINI-ZB2GS` (80-90% shared with the other two) is not folded in - it is a multi-gang node (main + sub device),
  which `RelaySwitchBase` does not handle. A reference worth reusing when that is attempted: this app's own
  `~/HomeyApp/nova.digital.homeyapp/lib/TuyaZclBase.js` already generalizes N-gang ZCL switches (a generic
  `_endpoint`/`epId` instead of hardcoded gang numbers, siblings via `getNodeDevices()` - which this app already
  has too, in `lib/connectedDevices.js` and `RejoinManager.js` - availability delegated to the main sibling, and
  a `_configureOnOffReporting(zclNode, endpointIds)` that loops over however many endpoints exist). It is a
  different protocol (Tuya, not Sonoff's manufacturer cluster) so nothing copies verbatim, but the shape - generic
  endpoint list plus sibling iteration, instead of a `_isMainDevice`/hardcoded-two-gangs split - is the right
  target for a `RelayMultiGangBase` later.
- Availability, lean model (3 signals): **done, confirmed on real hardware** (`logs/test-disponilidade2.log` and `4.log`: 5 failed
  sends 19-29 s apart -> "No response to commands", then the first frame after replugging -> Restoring, Available,
  one rejoin flow; the sendFrame hook was seen working on 12 devices. `5.log`, silence path with a temporary
  5 min timeout on one relay: last frame 01:23:47, "Unavailable: No activity for 6min" at 01:30:35, replugged ->
  Restoring, Available, Device rejoined, one flow at 01:31:17). See
  `~/HomeyApp/MODELO_DISPONIBILIDADE_LEVE.md`. `lib/AvailabilityManager.js` went from ~760 to ~420 lines:
  any frame marks the device available (and resets the failure count); silence past the family timeout marks
  it unavailable; 5 failed sends in a row with no frame in between (Passive only, no minimum gap) mark it
  unavailable with "No response to commands". Removed: the confirmation poll before offline, the send-failure
  gap/cooldown/"Homey radio down" guard, `last_seen_ts`, the persisted unavailable reason and
  `_reapplyUnavailable`, the Store-persisted Traffic statistics (now in memory, footnote updated), the global
  `setTimeout`/`clearTimeout` (the poll that used them is gone), `setLastSeenAt`. The MINI-ZB2GS secondary gang
  no longer mirrors the main gang's stored reason at boot; the sibling cascade covers live transitions.
  The global on/off switch stays (`availability_enabled`, gate inside `markUnavailable`, which is the only
  way to go unavailable; confirmed on hardware earlier), with the reentrancy guards on both `_markAll*`.
  Evidence behind the choices (ZBMINIR2 paired as "TEMP", availability forced off, logs in
  `logs/test-disponilidade.log`): Homey does not turn an unavailable device available again when it talks
  (Basic, onOff and 0xFC11 frames, even after a power cut and rejoin, left `getAvailable()` false), so the
  restore on frame is required; the node Last Seen in Developer Tools follows the frames by itself (2 min ->
  17 s after a button press), so `setLastSeenAt` was dropped. A Zemismart plug unplugged for 5 minutes only
  gave `timeout after 10000ms` on every click, so Homey does not mark unavailable on silence either.
  Test: `~/HomeyApp/_testes/disponibilidade-leve/` (26 cases against the real classes).
  The older shared suite `_testes/disponibilidade` (01 to 04) targets the previous baseline (confirmation poll,
  1-minute `setLastSeenAt`) and fails on those by design.
  Earlier history of this switch: a `/code-review max` pass found the per-call-site gating had a TOCTOU race
  (switch turned off while a confirmation poll was in flight); the single gate in `markUnavailable` closed it.
- SNZB-02LD/WD reporting too often (Traffic tab: two SNZB-02LD units at ~280-293 msg/24h, more than a
  SNZB-02WD at 136/24h despite reporting one attribute instead of two): **done**. Root cause confirmed by
  sniffer, not environment/placement - `drivers/temphumiditysensor.js`'s `_configureReporting()` tied `minChange`
  to the temperature/humidity decimals setting (1 decimal → 10 = 0.1°C, 0 decimals → 100 = 1%), 5x/3x more
  sensitive than Sonoff's own iHost hub. Extracted the iHost reference values with `tshark` from
  `_reference/sniffers/sonoff-snzb02/*.pcapng` (Configure Reporting frames on clusters 0x0402/0x0405,
  confirmed identical across 4 separate pairings/re-syncs): `minInterval=5, maxInterval=3600` (already matched),
  `minChange=50` (0.5°C) and `minChange=300` (3%) - fixed regardless of any display setting, since iHost has no
  decimals option of its own. Fixed by decoupling: `TEMP_MIN_CHANGE`/`HUM_MIN_CHANGE` are now fixed constants
  matching iHost exactly; `temperature_decimals`/`humidity_decimals` are display formatting only
  (`_parseReportedValue`) and no longer reconfigure the device in `onSettings()` (only `reporting_interval`
  still does). Settings hints updated to say so. Verified with a standalone simulation against the real
  `TempHumiditySensor` class (a minimal `homey` module stub under `NODE_PATH`, since `homey-zigbeedriver`
  requires the real Homey runtime at import time) - decimals no longer affect `minChange`, only
  `reporting_interval` reconfigures. **Confirmed on real hardware** (`teste18.log`): all three units logged
  `Reporting configured: maxInterval=3600s tempMinChange=50 humMinChange=300`, and 24h message counts dropped
  from ~293/280/136 to 66/64/103 - the SNZB-02WD is now correctly the highest of the three (it reports one more
  attribute than the SNZB-02LD units), matching what the equal-threshold design predicts instead of the earlier,
  decimals-driven imbalance.
- SNZB-05P (water leak sensor): restored from git history (`git checkout 1dd7397~1 -- drivers/SNZB-05P`) - a
  physical unit is available to test again after being removed in 1dd7397 for lack of one. Unchanged from the
  pre-removal version: `doorwindowsensorbase.js`/`lib/IASZoneHelper.js` (`hasAlarm1`/`hasBatteryLow`) it depends
  on are still current, and SNZB-04P/04PR2 already exercise the same base class. `homey app build` validates
  clean, `node --check` passes. Not yet tested on real hardware - needs a pairing.
- Poll Control (0x0020) no longer sends anything: removed the `checkInInterval` read and its retry from
  `lib/pollControlHeartbeat.js` (101 -> 49 lines; it was for the log only and cost TX to sleeping sensors; the
  Developer Tools showed 58% TX errors on a SNZB-02LD, 49% on a SNZB-04PR2). The binding and the answer to a
  check-in stay, and so does `SonoffPollControlCluster` as cluster knowledge. Verify later with the
  Developer Tools: note TX / TX Error of the SNZB sensors, leave the app running 24 h without restarting,
  compare the increase. Not yet run on the sensors.
- Multi-gang unification (MINI-ZB2GS into a shared relay base, see the nova.digital `TuyaZclBase.js`
  reference above) is blocked by hardware: no MINI-ZB2GS and no 3-gang unit to test with. The 2026-10-05 edits
  to `drivers/MINI-ZB2GS/device.js` (secondary gang no longer mirrors the main gang's stored reason at boot)
  were validated by syntax and `homey app build` only, never on the device.
- Device name in the log lines: `this.log` cannot be replaced on an SDK device. Only option is a `nlog()`
  helper and a mechanical replacement of about 190 calls, and SDK/homey-zigbeedriver lines would still
  show only the uuid.
- Post the notes for the upstream fork owner (macmonty): issues are disabled there, so use the e-mail.
  Draft in the session scratchpad; put the full notes in a gist or `docs/` and link them.

