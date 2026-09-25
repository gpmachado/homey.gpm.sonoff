# Field notes for the Homey.Sonoff.Zigbee fork

Thanks for keeping the fork going. I built my own Homey app for Sonoff Zigbee devices (internal use only, not published, since the store already has a Sonoff app) using your fork as a starting point, together with the ZBMINIR2 / MINI-ZB2GS work from Simone Di Maio's commits (they are in your history). I kept the original Tarra AB copyright in my LICENSE.

My code is public and MIT-licensed: https://github.com/gpmachado/homey.gpm.sonoff. Files that match the items below (repository: https://github.com/gpmachado/homey.gpm.sonoff):
- `lib/RejoinManager.js` and `drivers/ZBMINIR2/device.js` (power-cut detection, item 3)
- `lib/AvailabilityManager.js`, `lib/constants.js` (availability tiers, item 1)
- `lib/SonoffPollControlCluster.js`, `lib/pollControlHeartbeat.js` (Poll Control, item 5)
- `drivers/SNZB-04PR2/`, `drivers/MINI-ZB1GP/` (devices missing here, item 2)

**Transparency:** I use Claude (Anthropic's AI) to analyse the pcapng captures and the device logs, and to write and review the code. I do the hardware testing, pairing and verification myself. I would rather say this upfront so you can decide how much weight to give the notes below.

I would be glad to send small, isolated PRs if you are interested. I read your master branch (zigbee-clusters 1.4.0 pinned) before writing this, so the notes are only about things that do not seem to be covered there.

**Tested hardware (physical units I own):** ZBMINI, ZBMINIR2, MINI-ZBD, MINI-ZB1GP (energy monitor, no relay), MINI-ZB2GS, BASICZBR3, SNZB-02WD, SNZB-02LD, SNZB-03 (battery motion sensor), SNZB-04P, SNZB-04PR2 and SNZB-06P. The app ran on a Homey with debug logs kept for hours per device, and Sonoff's own pairing traffic was sniffed with an iHost and a CC2531 (pcapng).

**1. Heartbeat of each device (observed in logs, hours of capture)**

| Device | What it sends on its own |
|---|---|
| SNZB-02WD / SNZB-02LD | ZDO Device Announce about every 29 min (1739-1743 s apart) |
| SNZB-04P | Device Announce every 60 min; no periodic battery report |
| SNZB-04PR2 | Battery percentage report about every 27 min (~1616 s); answers UNSUPPORTED_ATTRIBUTE for batteryVoltage |
| Mains devices (ZBMINIR2, SNZB-06P, ...) | Periodic reports / 0xFC11 frames |

Useful for any "unavailable after X minutes of silence" logic: X should be at least ~2.5x the heartbeat, otherwise sleepy sensors flap. I did not see any availability tracking beyond `setAvailable()` on announce in your drivers, so this could be a small documentation or feature PR.

**2. Devices I did not find in your tree**
- **SNZB-04PR2** (only SNZB-04 / SNZB-04P are there). It is a separate SKU with its own manufacturerName; my driver for it works with a shared door/window base.
- **MINI-ZB1GP**, the energy monitor version without a relay (it only appears in `docs/DEVELOPMENT_NOTES.md`). I have this one physically and tested it: power, voltage, current, energy today/month and a reset-consumption button. I do not have the relay version (MINI-ZB1GSP), so I am not proposing anything about it.

**3. Detecting a power cut / rejoin of a mains device (ZBMINIR2, MINI-ZBD, MINI-ZB2GS):** I detect it from the boot dump rather than from the ZDO Device Announce. When one of these relays regains power, the pairing sniff and my logs show a fixed pattern: a burst of Report Attributes (cmd 0x0A) on the manufacturer cluster 0xFC11 and on OnOff (0x0006), about 8 ms apart. The periodic 0xFC11 heartbeat arrives alone, so requiring both within ~200 ms avoids false positives; a 30 s cool-down collapses the burst, and frames right after one of my own writes are ignored. I turned it into a per-device flow trigger, "Reconnected after power cut", plus a rejoin counter and timestamp shown in the app settings. It is small and self-contained (a frame hook plus a helper that fires the flow card), so it could be a PR if you like the idea.

**4. Reporting on Device Announce:** your SNZB-02 code re-configures reporting on every endDeviceAnnounce (and the comment explains why: sensors otherwise stop reporting). In my tests the announce comes every ~29 min and the sensor may be asleep, so the write fails and logs errors; re-syncing at most every few hours (retrying on the next announce if it failed) kept the behaviour and removed the noise.

**5. Poll Control (0x0020):** in the iHost pairing sniff on the SNZB-04PR2 (fw 1.0.1) the device sets checkInInterval = 14400 (quarter-seconds, 1 h). The stock cluster in zigbee-clusters lacks the checkIn / checkInResponse commands, so I added a small custom cluster. In my tests the check-ins did not reach the app, so I do not rely on them as a heartbeat.

**6. Sniffer-confirmed reporting on the SNZB-04P:** Sonoff's iHost configures batteryPercentageRemaining with minInterval ~1620 / maxInterval ~1740 and never touches the manufacturer `tamper` attribute (the device answers UNSUPPORTED_ATTRIBUTE for it).

**7. Small heads-up, only relevant when upgrading zigbee-clusters:** `readAttribute()` in `drivers/sonoffbase.js` calls `readAttributes(...attr)`. With zigbee-clusters 1.4.0 (variadic) that works. Newer versions require an array, and the same call then throws before sending anything, which shows up as a misleading "device unreachable". Also, `if (!attr instanceof Array)` is parsed as `(!attr) instanceof Array`, so the intended wrapping of a single attribute never happens. In my app (zigbee-clusters 3.x) this made every settings read-back fail until I removed the spread.

**8. OTA:** I have not tested the firmware update code (`lib/SonoffOTABoundCluster.js`, which reads Koenkk's zigbee-OTA index and serves the image through a custom bound cluster). My ZBMINI units had already been updated through the iHost, so there was nothing left for me to test with, and I preferred not to risk flashing a device. I only noticed that I could not find any driver that starts it, and that it is not the approach Homey has published for OTA (Homey >=13.2 has a native mechanism that talks to the device's OTA client directly, see https://apps.developer.homey.app/wireless/zigbee/zigbee-firmware-updates ; an app-level answer to queryNextImageRequest could race with it). Take that as an observation, not a verdict.

**9. SNZB-06P illuminance:** My SNZB-06P driver deliberately does not expose illuminance. In my units it does not measure lux: it only reports bright/dark, and only while presence is detected, and Sonoff's own iHost does not expose it either. A lux sensor for it would be misleading.

**10. Small confirmation:** ZBMINIR2 accepts the TurboMode write (20 = on, 9 = off) without errors on my unit.

If any of this is of interest, tell me which item you would like as a PR (for example the heartbeat table as documentation, the SNZB-04PR2 driver, the MINI-ZB1GP energy monitor, the power-cut trigger, or the announce throttling) and I will send a small, tested one. Please do not hesitate to say no.
