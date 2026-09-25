# Development path and decisions

How this app got to where it is, and why the important choices were made. Dates are from the git history (2026-09-07 to 2026-09-24 so far). Each decision says what would make us revisit it.

## Starting point and goals

The app started from the community fork [macmonty/Homey.Sonoff.Zigbee](https://github.com/macmonty/Homey.Sonoff.Zigbee) (itself based on StyraHem/Tarra AB's original, MIT), with the ZBMINIR2 / MINI-ZB2GS work by Simone Di Maio in its history. The goals that shaped everything:

- Sonoff devices that the store app did not cover well (MINI-ZB1GP, SNZB-04P, SNZB-04PR2, a proper MINI-ZB2GS).
- Know when a device is really gone (power cut, lost link), and react when it comes back.
- Decide from measurements on real hardware, not from other projects' definitions.

The app is for internal use: the store already has a Sonoff app, so this one is installed from source.

## Timeline

| Dates | What happened |
|---|---|
| 09-07 to 09-09 | Initial import of the drivers; fixes to settings writes and the time cluster; MINI-ZB1GP gets exported energy (behind a setting) and a reset-consumption button. |
| 09-13 | Dongle E/P, SNZB-04P, SNZB-02LD/WD on a shared base with calibration, ZBMINI, SNZB-04PR2 (versions 1.0.1 and 1.0.2). |
| 09-14 | MINI-ZB1GSP and S60ZBTPF added; thermometer decimals and reporting interval settings; per-device name in logs attempted and abandoned (see below); version 1.0.4. |
| 09-18 to 09-19 | Availability tracking, shared door/window base; release 1.0.5 (availability for mains devices). |
| 09-20 | One `ZCL_DEBUG` constant instead of env.json debug levels; SNZB-05P added. |
| 09-24 | MINI-ZB2GS, Poll Control and availability for the sleepy sensors, zigbee-clusters 3.8.0, release 1.0.6 (icons). Then 1.0.7: removal of four untested drivers, BASICZBR3 availability, MINI-ZB1GP alarms, pending Poll Control read, corrected changelog. |

## Decisions

### Availability

- **Two mechanisms.** `AvailabilityManagerPassive` hooks every inbound frame of a mains device. `AvailabilityManagerCallback` is for battery devices that ignore pings: the driver reports each sign of life explicitly.
- **Timeout is about 2.5 times the device's own heartbeat**, so one missed report does not flip it. The tiers are in `lib/constants.js`: 10, 25, 90 and 150 minutes. The heartbeat of each model was measured from logs (see the table in the README), not assumed.
- **Poll before offline only for mains devices**, with a random delay so devices do not all poll on the same tick after a power cut. Sleepy sensors are never polled.
- **The unavailable state is persisted** and re-applied after a restart, because the base class marks a device available on every init.
- **A multi-gang node counts once.** The main device (EP1) owns availability, the active poll and rejoin detection; siblings follow it.
- **Revisit** when a model's measured heartbeat changes with firmware.

### SNZB-04P availability (open experiment)

The battery sensors got availability in 1.0.6 (commit `c695992`; not in 1.0.5). On another user's network six SNZB-04P, paired with an older version, showed no traffic for 24 h and were marked unavailable until the door was opened. The author's own SNZB-04P and SNZB-04PR2, removed and re-paired the night before, kept working: the SNZB-04P announced every 3600 s (9 announces in about 14 h) and the SNZB-04PR2 sent a battery report about every 1738 s.

Decision: keep the tracking, ask that user to re-pair the sensors and check the **Traffic** tab after more than 3 hours. If a re-paired SNZB-04P still shows no activity, remove tracking for that model. The alternative that was considered and not built: arm the timeout only after the first heartbeat has been seen, so silent devices are never flagged.

### Poll Control (0x0020)

- The stock cluster lacks the `checkIn` / `checkInResponse` commands, so `SonoffPollControlCluster` adds them. In the iHost pairing capture the SNZB-04PR2 sets a check-in interval of 14400 quarter-seconds (1 h).
- **Check-ins never reached the app in tests** (possibly consumed by the Homey stack), so they are not used as a heartbeat. The device announce and the battery reports are.
- The interval read at app start fails almost every time because the sensor is asleep. It is now kept pending and retried when the sensor is next heard from, up to 6 attempts.
- Not built: answering a check-in with fast polling only when work is pending, as zigbee-herdsman does.

### Rejoin (power-cut) detection

When ZBMINIR2, MINI-ZBD or MINI-ZB2GS regain power they send a burst of Report Attributes on `0xFC11` and on OnOff, about 8 ms apart. The periodic `0xFC11` heartbeat arrives alone. The drivers require both within 200 ms, ignore frames right after their own writes and merge bursts with a 30 s cool-down. The result is a per-device flow trigger, used to resynchronise lights with the switch after a power cut, plus a counter and timestamp in the settings Rejoins tab.

### Reporting re-sync on announce

Sleepy sensors announce every 29 to 60 minutes and are asleep again by the time requests go out, which produced error stacks on the thermometers and needless reporting resets on the door sensors. The re-sync now runs at most every 3 hours and is retried on the next announce if it failed.

### Debug switch

A single constant, `ZCL_DEBUG` in `lib/constants.js`, replaced the env.json debug levels. Reasons: the CLI sends env.json with every `homey app publish`, so a forgotten local file changes published behaviour, and there is no log access outside `homey app run` anyway. It must be `false` in commits.

### Device name in log lines (abandoned)

`this.log` and `this.error` are defined non-configurable on SDK device instances: assignment and `Object.defineProperty` both throw on real hardware (it crashed every driver's `onNodeInit`), and a `Proxy` cannot lie about a non-configurable property. The only workable design is a separate `nlog()` helper and replacing about 190 call sites; lines written by the SDK and homey-zigbeedriver would still show only the uuid. Not done. See TODO.md.

### Firmware updates (OTA)

The app does not implement OTA. Homey 13.2 and later has a native Zigbee firmware update mechanism that talks to the device's OTA client, and an app-level answer to `queryNextImageRequest` could race with it. Some Sonoff devices were already updated through the iHost, so there was also nothing safe to test on.

### MINI-ZB1GP

- Power, voltage, current and energy come from the manufacturer cluster `0xFC11`; the standard electrical measurement cluster returns `0xFFFF`.
- Exported energy is modelled as `meter_power.exported` and hidden by default (a 16 A meter is rarely used bidirectionally). Power may be negative (exporting).
- The fault code (`0xFC11`, attribute `0x0010`, TLV type 7 length 2, bits `0b010` metering error and `0b100` overload) becomes two alarms.
- **Electrical Monitoring** (power protector, attribute `0x7016`) is readable on the real unit but not implemented. Zigbee2MQTT treats it as set-only; a first probe read `undefined` and was wrongly taken for "unsupported". The raw frame showed status SUCCESS and an array of 63 bytes that our custom array type failed to decode. Details in TODO.md.

### Other device decisions

- **MINI-ZB2GS**: each channel is its own Homey device (tiles), the main one owns the node-level behaviour.
- **BASICZBR3**: the firmware rejects ZCL general commands (reporting cannot be configured, confirmation poll fails) but reports `onOff` every 300 s, so passive tracking with 25 min.
- **SNZB-06P**: no illuminance. The device only reports bright/dark, and only while presence is detected; Sonoff's iHost does not expose it either.
- **Four drivers removed in 1.0.7** (MINI-ZB1GSP, S60ZBTPF, SNZB-05P, SNZB-09P): no physical units to test. They are in the git history and can be restored.
- **`readAttributes(...attr)` in the shared base** threw synchronously with zigbee-clusters 3.x, which needs an array. It was fixed early (commit `b6962f5`); the upstream fork still works only because it pins 1.4.0 where the call is variadic.

## Mistakes worth remembering

- **Sync with `rsync --delete`** between the production folder and a test copy removed uncommitted work. It was recovered by replaying the tool calls from the session transcript. Commit before syncing, and never `--delete` a folder with unsaved work.
- **Gaps in a log are not missed heartbeats.** When the Mac sleeps, `homey app run` stops streaming while the device keeps talking. Compare the gaps against the whole log's silences before blaming a device.
- **`undefined` from `readAttributes` is not "unsupported".** The library drops any attribute without a SUCCESS status, and can also drop one it fails to decode. Look at the raw frame first (`debug(true)` around a single read).
- **A measurement from one unit is not a rule.** The SNZB-04P hourly announce held on the author's units and not on another network.
- **Do not describe a release from the last commit.** The 1.0.5 changelog promised battery-sensor availability that only shipped in 1.0.6.

## How things are verified

Physical units paired with Homey, logs kept for hours and analysed with timestamp arithmetic; Sonoff's own pairing traffic sniffed with an iHost and a CC2531 (pcapng); definitions from Zigbee2MQTT and ZHA used as references only. Packet captures and logs are analysed, and code is written and reviewed, with the help of Claude (Anthropic); the hardware testing and verification are the author's.

## Upstream

Field notes for the fork's maintainer are in [NOTES-FOR-UPSTREAM.md](NOTES-FOR-UPSTREAM.md). He replied that he is deciding whether to stay on Homey or move to Home Assistant, so no pull requests are planned for now; the notes stay as a reference.
