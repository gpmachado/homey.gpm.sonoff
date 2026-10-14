# TODO

Only what is still open. Finished work (the lean availability model, the SNZB-02LD/WD reporting fix, the
Poll Control and init-read changes, the shared relay base, the FrameMiddleware migration of the relays,
the SNZB-05P restore, the settings page split) is in the git history and in `docs/DEVELOPMENT.md`.

## BASIC-ZB1GSP (under analysis, tested at a distance by a friend)

Driver restored from the removed MINI-ZB1GSP and aligned with the zigbee-herdsman-converters definition
of this model. Confirmed on his unit: relay, power and current reads, and the relay opening by itself
when a configured current, voltage or power limit is crossed. After the re-pair (log 2026-10-13) it reports
power/current/voltage on its own (42 reports in 12 min; poll lowered to 10 min) and every trip reports
`fault_code` `0x06020004` (TLV type `0x06`, bit 2 = overload protection, the same for current, voltage and
power), cleared to `0x06020000` by the next "on"; `handleFaultCode` now accepts type `0x06`. It also reads
the Time cluster (`localTime`, `time`, `timeStatus`...), so the Time bind stays. Test steps:
`docs/TESTE-REMOTO.md`, checked with `node scripts/check-log.js <log>`.

1. **Fault bits 0 and 1 not seen.** Overheat (bit 0) and metering error (bit 1) follow the MINI-ZB1GSP map
   without confirmation on this unit.
2. **Hub features not mapped:** minimum power, voltage and current limits, and "Remote Unlock". Candidates:
   the `0x7003` limits block (z2m `buildOverloadProtectionPayload`: max current and max power always present,
   the rest optional behind flags) and `outlet_control_protect` (`0x7007`). Not guessed: the read-back log lines
   (`[Protection] ...`) give the bytes; confirm what changes with a capture (needs a unit paired to the hub
   with a sniffer) before writing anything.
3. **Maximum current and power are always on in the hub** ("default protection is enabled", no switch; only
   the voltage has one). Remove the two "Enable" checkboxes and write enable `1` with the value.
4. **A failed write of a protection limit must show as an error.** `onSettings` catches and only logs; the
   page then says "saved" while the device keeps the old limit. Let the error go (the MINI-ZB1GP already does).
5. **Energy counters** still need a load running a few minutes to confirm.
6. Not done on purpose: export energy and the consumption history (firmware 1.3.0 or later; this unit is
   1.0.5), `energyYesterday` (no standard capability).

## MINI-ZB1GP

- **Electrical Monitoring (`0x7016`, the power protector).** Read and shown read-only in the settings,
  confirmed on the unit. **No editing is planned:** the Sonoff hub offers no limit setting for this model (its
  device screen has Turbo Mode, Billing Date, Network Indicator, Reset Consumption, Show Export Energy; firmware
  1.2.7 on that unit), which fits a device with no relay: nothing trips. Open decision: keep the four read-only
  labels (they show a configuration the hub never shows and that has no effect here; the read is 70 bytes and
  failed at boot on the first run, hence its two retries) or remove them: about 50 lines in
  `drivers/MINI-ZB1GP/device.js` plus the settings group. The parser and builder in `lib/SonoffCluster.js` stay
  as protocol knowledge either way (the BASIC-ZB1GSP does not use `0x7016`).
  Protocol notes, kept because the logs are not in the repository: ARRAY of UINT8 (`0x48`), 3 bytes
  `01 01 01`, then TLV scenes; type `02` (20 bytes) is the protector. Read from the unit: overcurrent 16 A,
  overpower 3840 W, overvoltage on at 277 V, undervoltage on at 165 V, auto recovery off, recovery only by
  external switch off. First 50 bytes of the answer:
  `16 70 00 48 20 3f 00 | 01 01 01 | 01 05 01 00 00 03 28 | 02 14 01 80 3e 00 00 00 98 3a 00 00 08 3a 04 80 88 84 02 80 00 00 | 03 12 01 00 14 00 00 00 40 7e 05 ...`
  (z2m `localFastSceneConfiguration({hasSwitch: false})`; ZHA quirk PR zigpy/zha-device-handlers#5155.)
- **Billing Date is not a device setting.** The hub has "Billing Date Settings" (day of the month) for this model,
  but the three captures of changing it (`_reference/sniffers/energymeter/billing-*.pcapng`, 732 to 976 bytes)
  hold only route requests and link status: nothing is sent to the device. The only writes in the longer
  capture (`dia 5-10-1-15 billing - networkled.pcapng`) are the network LED (`0xFC11` attribute `0x0001`). The
  device's own month counter rolls over on the 1st; a different billing day would be a software sum in the app.
- **Standard-cluster capabilities.** Power, current and voltage are registered on the Electrical Measurement
  cluster, which this unit always answers with "no value" (`65535`, `-1`; two units, with a 1.5 kW load).
  The real values come on `0xFC11`, which the device reports on its own. Test one freshly paired unit with
  only the `0xFC11` listeners; if the reports still flow, drop the three registrations and their repeated
  comments (about 60 lines, three reads and three report configs per start).
- **Poll.** Every 10 min, kept for `fault_code` (never seen reported on its own in any log) and as a
  safety net. Voltage and current are now reported by the device after our `configureReporting`.

## MINI-ZB2GS and MINI-ZBD (the friend owns both)

- **MINI-ZB2GS has never run on hardware since the 2026-10-05 edit** (the secondary gang no longer mirrors
  the main gang's stored reason at boot; checked by syntax and build only). First do the test of
  `docs/TESTE-REMOTO.md` as a baseline: both gangs, wall buttons, a power cut, a settings write, inching.
- **Then:** move its hand-made frame hook onto `installRejoinDetection` plus the ACK-suppress handler of
  `relaySwitchBase.js`. It needs the write guard as a node-scoped option (the two gangs share the node) and
  keeps the 30 s cooldown (both gangs dump on boot within milliseconds). The hook keeps `this` of the first
  main device forever; `rejoinDetection.js` points at the device through the node instead. Repeat the same
  test afterwards and compare.
- **Then:** fold it into a shared multi-gang base. Reference: `~/HomeyApp/com.gpm.novadigital/lib/TuyaZclBase.js`
  (generic endpoint list, siblings through `getNodeDevices()`, availability on the main sibling, a
  reporting loop over the endpoints). A different protocol, so only the shape carries over.
- **MINI-ZBD** runs the same code as the ZBMINIR2 (`relaySwitchBase.js`) with availability and an active poll
  it never had; not yet confirmed on a real unit. His Homey has one: a hardware pass (start, power cut,
  removal, restart).

## Frame hooks

`SonoffBase`'s Basic filter and cluster-report interceptor still wrap `node.handleFrame` by hand (the
interceptor is used by the MINI-ZB1GP). Decision 2026-09-27: no action; largest blast radius, no bug seen.
Revisit only for a concrete bug or need. The priority rule and the handler id convention are documented in
`lib/FrameMiddleware.js`; any new swallower must keep a number of 10 or more. If the Basic filter is
touched, guard the private `basicCluster._trxHandlers` (see the audit list below).

## Poll Control

`lib/pollControlHeartbeat.js` sends nothing to the sleeping sensors any more. To measure the effect: note
TX and TX Error of the SNZB sensors in the Developer Tools, leave the app running 24 h without a restart,
compare the increase (before: 58% TX errors on a SNZB-02LD, 49% on a SNZB-04PR2). Not run yet.
Known limit of the lean availability model: nothing is persisted, so a dead device shows as available
after every app restart until 90 min of silence or 5 failed sends.

## To verify on a real Homey

- The settings page now loads `settings.css` and `settings.js` next to `index.html`; the old and new page
  were compared in a browser with a stand-in `/homey.js`, but a real Homey has not served the two new files.
  Run `homey app run` and open the settings.

## Audit follow-ups (2026-10-11, `/ponytail:ponytail-audit`)

Should fix:
- Guard and pin the private zigbee-clusters use: `basicCluster?._trxHandlers?.[trxSeq]` in
  `drivers/sonoffbase.js`, exact versions in `package.json`.
- Await the settings writes of the relays and the MINI-ZB2GS (`relaySwitchBase.js`, `MINI-ZB2GS/device.js`):
  the page says "saved" even when the device did not get it.
- Tests in the repo: move `01-three-signals.test.js` and `run.js` from `~/HomeyApp/_testes/disponibilidade-leve`
  into `test/` and add an npm `test` script (its default path still names the old folder).
- Docs and comments that describe removed code: `SUPPORTED_DEVICES.md` mentions an npm script that does not
  exist; "poll-before-offline" in
  `lib/constants.js` and `drivers/ZBMINI/device.js`; "Store I/O" in `lib/availabilityHooks.js`; "every 5 min"
  in the two dongle drivers (the poll is 20 min).

Lean (about -450 lines):
- `lib/IASZoneHelper.js`: the CIE address path (`configureCieAddress`, `writeCieAddress`,
  `_getCoordinatorIeee`, `cleanIeee`, `_isEnrolled`) has no caller that enables it.
- `drivers/sonoffbase.js`: `initAttribute`, `writeAttribute`; `lib/zclDebug.js`: `installNamedLogging` and its
  three callers (`namedLog` and `namedError` are never called).
- The on/off wiring is copied in five drivers; the inching code (`INCHING_PROTOCOL`, `setInching`,
  `_calculateChecksum`) in three, the external-switch BoundCluster in two. One helper each in `SonoffBase`.
- `DONGLE-P` extends `DONGLE-E_R`; one shared `_isValidReading` and the same power listeners for the
  MINI-ZB1GP and the BASIC-ZB1GSP (the MINI rejects a real 65535 mW reading).
- `lib/rejoinDetection.js`: the manufacturer-specific branch of `commandId` is computed and then ignored.

Nice to have:
- `markUnavailable` swallows a failing `setUnavailable` of a sibling; a frame arriving during that await skips
  the restore until the next frame.
- `FrameMiddleware.listHandlers()` is unused; `RejoinManager.triggerRejoin(gapMs)` always logs `gap 0s`;
  `SNZB-03` has an empty `catch {}`.

## Small

- Device name in the log lines: `this.log` cannot be replaced on an SDK device (non-configurable). Only a
  `nlog()` helper and a mechanical replacement of about 190 calls works, and SDK and homey-zigbeedriver lines
  would still show only the uuid. Partly covered: each Sonoff device now logs its node address at start and,
  with `ZCL_DEBUG`, one line per inbound frame with its device id.
- Post the notes for the upstream fork owner (macmonty): issues are disabled there, so use the e-mail. Put the
  notes in a gist or `docs/` and link them.
- Before the next build goes to the store (non-public, not certified): it is at 1.0.8; the next one is 1.0.10 (1.0.9 was never published, its text is
  merged into the 1.0.10 entry of `.homeychangelog.json`, which is also the text the store will show: check it).
  `ZCL_DEBUG` back to `false` in `lib/constants.js` (it is `true` on `main` on purpose while the remote tests run).
  Decide whether the BASIC-ZB1GSP goes in this release: it is still under analysis.
