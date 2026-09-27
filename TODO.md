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

### FrameMiddleware migration (frame hooks)

Goal: one `node.handleFrame` per node (`lib/FrameMiddleware.js`), with named, prioritized handlers, instead of each
concern wrapping the previous one by hand. No bug was ever observed in the old per-layer wrapping - this is about
removing a hand-maintained ordering invariant before a future mistake breaks it, not fixing something broken today.

**Rule that governs every priority number**: a handler that never returns `false` (an "observer") must have a
lower number than any handler that can swallow a frame it needs to see - the dispatch loop stops at the first
`false`. Current values, in `lib/FrameMiddleware.js`: `AVAILABILITY: 0`, `REJOIN: 5`, `BASIC_FILTER: 10`,
`CLUSTER_REPORT: 20`. Getting this backwards is not cosmetic: verified by simulation that it would silently break
the "Reconnected after power cut" trigger (a swallower ahead of `REJOIN` eats the exact frame rejoin needs) and
undercount the Traffic tab (a swallower ahead of `AVAILABILITY` hides frames from `_recordMessage`; a naive
"notify activity on swallow" compensation only patches the availability timeout, not that count - see
`AvailabilityManagerPassive.notifyActivity()`'s own comment for why it deliberately skips `_recordMessage`).

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
- Availability on/off switch as a global app setting: **done**, not yet hardware-tested. `homey.settings` key
  `availability_enabled` (`lib/constants.js`), read by `AvailabilityManagerBase._isGloballyEnabled()` and gating
  the three paths that can mark a device unavailable - the watchdog timeout, `_onSendFailure`'s confirmation poll
  (Passive), and `_reapplyUnavailable()` at install (so a stale offline reason from before an app restart isn't
  reapplied while the switch is off). `_markAlive`/`_recordMessage` are never gated - activity tracking, Traffic
  and Rejoins statistics, and restoring a device to available on real activity all keep working exactly as
  before. `api.js`'s `getAvailabilitySetting`/`setAvailabilitySetting` (new `app.json` routes, added through
  `.homeycompose/app.json` + `homey app build`) read/write the setting; turning it off also force-restores, in
  the same call, every device that is currently unavailable (`manager.markAvailable()` per device, mirroring how
  `resetMessageStats`/`resetRejoinStats` already iterate `homey.drivers.getDrivers()`). UI: a switch in the
  settings page header (`settings/index.html`, above the Traffic/Rejoins tabs, since this applies to both) -
  `locales/en.json` has the three new strings. Verified with a standalone simulation against the real
  `AvailabilityManagerPassive` class (fake device/homey, watchdog tick driven manually): enabled-path behaviour
  unchanged, disabled-path never marks unavailable/never polls, stale offline state not reapplied at install,
  `markAvailable()` still restores while the switch is off. This app is meant to be the reference implementation
  for the same switch in Moes/Tuya/NovaDigital - see `~/HomeyApp/ARQUITETURA_DISPONIBILIDADE_REJOIN.md`.
  Confirmed on real hardware (`teste16.log`): toggling off/on while the app was running logged the change
  correctly, no errors, no false unavailable marks.
  A `/code-review max` pass (3 subagents, 15 findings, 10 CONFIRMED/5 PLAUSIBLE) then found the first version's
  gating was per-call-site rather than at the one real chokepoint - a TOCTOU: the switch was checked once before
  `_pollDevice()` (up to ~15s) but never rechecked before `_markAllUnavailable()` actually ran, so toggling off
  mid-poll could still mark a device unavailable. Fixed by moving the authoritative check inside
  `_markAllUnavailable()` itself (the call every path - watchdog, `_onSendFailure`, and the public
  `markUnavailable()` - funnels through), keeping the early per-call-site checks only as a cheap "skip a
  pointless poll" optimization. Also fixed in the same pass: `markUnavailable()` was entirely ungated (closed by
  the same chokepoint fix); MINI-ZB2GS's secondary gang mirrors the main gang's unavailable state via a raw
  `setUnavailable()` call that bypassed the switch (now also checks `main._availability._isGloballyEnabled()`);
  `_reapplyUnavailable()` left a stale `availability_unavailable_reason` in the store when declining to reapply
  it; `api.js`'s `Boolean(body?.enabled)` inverted intent for a JSON string `"false"` and silently disabled
  tracking for a bodyless request (now `typeof body?.enabled !== 'boolean'` throws instead); `setAvailabilitySetting`
  persisted the setting before a restore step that could throw, leaving the settings page unable to tell "nothing
  changed" from "changed, but a restore partially failed" - now returns `{ enabled, restoreFailures }` and never
  throws for a partial restore, and the client no longer reverts the toggle on that path; two concurrent toggle
  calls could double-fire `onBecameAvailable()`/`onBecameUnavailable()` for one device (closed with a re-entrancy
  guard on `_markAllAvailable`/`_markAllUnavailable`); the settings page had no request-ordering guard on the
  availability GET/POST (added, matching `loadStats()`'s existing `latestRequest` pattern) and defaulted the
  toggle to OFF on a malformed-but-successful API response (now requires `typeof result.enabled === 'boolean'`).
  Also deduplicated `api.js`'s five near-identical `homey.drivers.getDrivers()` loops into one `allDevices()`
  generator. Not fixed, left for later (lower severity / architectural): restore latency scales with how many
  devices are down (`Promise.allSettled` already runs them concurrently, so this is a response-time nicety, not
  a correctness gap); the force-restore loop scopes on `!device.getAvailable()` rather than on whether the
  watchdog specifically caused it - latent today since nothing else in the app calls `setUnavailable()` for an
  unrelated reason. All fixes re-verified with an extended standalone simulation plus a dedicated `api.js` test
  (validation, restore-failure reporting, the `allDevices()` refactor) - both passing - before committing.
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
  `reporting_interval` reconfigures. Not yet re-tested on real hardware (needs a fresh Traffic tab reset and a
  few hours, same as the original observation).
- Device name in the log lines: `this.log` cannot be replaced on an SDK device. Only option is a `nlog()`
  helper and a mechanical replacement of about 190 calls, and SDK/homey-zigbeedriver lines would still
  show only the uuid.
- Post the notes for the upstream fork owner (macmonty): issues are disabled there, so use the e-mail.
  Draft in the session scratchpad; put the full notes in a gist or `docs/` and link them.

