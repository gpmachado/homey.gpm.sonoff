# Sonoff Zigbee

Homey app adding support for SONOFF Zigbee devices, with availability tracking, a Traffic and Rejoins overview in the app settings and a "reconnected after power cut" flow trigger.

Based on [Homey.Sonoff.Zigbee](https://github.com/StyraHem/Homey.Sonoff.Zigbee) by StyraHem (Tarra AB), through the community fork [macmonty/Homey.Sonoff.Zigbee](https://github.com/macmonty/Homey.Sonoff.Zigbee), which includes the ZBMINIR2 and MINI-ZB2GS work by Simone Di Maio.

**Internal use.** The Homey App Store already has a Sonoff app, so this one is not published there and is installed from source (see [Install](#install)). Requires Homey firmware `>=12.4.0`. Current version: **v1.0.7**.

## Changelog

**v1.0.7**
- SNZB-04P/04PR2 and SNZB-02LD/WD: if a sensor shows as unavailable while idle, remove and re-pair it. Sensors paired with an older version do not always send anything on their own (six SNZB-04P showed no traffic for 24 h on one network), while freshly paired ones announce every hour.
- MINI-ZB1GP: **Metering communication error** and **Electrical status** (overload protection) alarms, decoded from the fault code (`0xFC11`, attribute `0x0010`). Existing devices get them without re-pairing.
- BASICZBR3: availability tracking. The firmware rejects ZCL general commands but reports `onOff` every 300 s, so the passive frame hook is used with a 25 min timeout and no confirmation poll.
- Poll Control: the interval read that fails at every app start (the sleepy sensor is asleep) stays pending and is retried on the next announce, report or activity, up to 6 attempts.
- Removed the MINI-ZB1GSP, SNZB-05P, SNZB-09P and S60ZBTPF drivers: no physical unit to test them. They can be restored from the git history.
- The 1.0.5 changelog no longer claims the battery-sensor availability: it only exists from 1.0.6.

**v1.0.6**
- Icon fixes.
- Availability tracking for the battery sensors (SNZB-02LD/WD, SNZB-04P/PR2), using each sensor's own heartbeat. Poll Control check-in binding for sleepy sensors.

**v1.0.5**
- Availability tracking for mains-powered devices (ZBMINI, ZBMINIR2, MINI-ZB1GP/GSP, SNZB-06P, Zigbee Dongle E/P), with a Traffic and Rejoins overview in the app settings.
- New devices: MINI-ZB2GS 2-gang switch (each channel is its own Homey device), SNZB-05P water leak sensor and SNZB-09P siren.
- SNZB-04P battery reporting and SNZB-06P fixes. A single `ZCL_DEBUG` constant replaces the env.json debug levels.

**v1.0.4**
- SNZB-04PR2 fix. Added MINI-ZB1GSP and S60ZBTPF. Configurable temperature/humidity decimals and reporting interval on the thermometers.

**v1.0.3**
- Icon fix.

**v1.0.2**
- Added the SNZB-04PR2 door/window sensor (separate SKU from the SNZB-04P).

**v1.0.1**
- Added Zigbee Dongle E/P, SNZB-04P, ZBMINI and SNZB-02LD/WD, plus settings fixes for ZBMINIR2/MINI-ZBD.

**v1.0.0**
- First version.

## Supported devices (grouped by the version each was added in)

| Version | Devices |
|---|---|
| v1.0.0 | BASICZBR3 (Basic switch), MINI-ZB1GP (Energy meter, no relay), MINI-ZBD (Dry contact), SNZB-03 (Motion sensor), SNZB-06P (Presence sensor), ZBMINIR2 (Switch) |
| v1.0.1 | DONGLE-E_R / DONGLE-P (Zigbee dongles as routers), SNZB-04P (Door/window contact), SNZB-02LD (Thermometer), SNZB-02WD (Thermometer and humidity), ZBMINI (Switch) |
| v1.0.2 | SNZB-04PR2 (Door/window contact) |
| v1.0.5 | MINI-ZB2GS (2-gang switch) |
| Removed in v1.0.7 | MINI-ZB1GSP (added v1.0.4), S60ZBTPF (added v1.0.4), SNZB-05P (added v1.0.5), SNZB-09P (added v1.0.5) |

Tested on physical units paired with Homey, with logs kept for hours: BASICZBR3, MINI-ZB1GP, MINI-ZBD, MINI-ZB2GS, SNZB-02LD, SNZB-02WD, SNZB-03, SNZB-04P, SNZB-04PR2, SNZB-06P, ZBMINI and ZBMINIR2. The dongles are owned and run as routers with the router firmware from Sonoff's site. The removed drivers were not tested.

Notes per device:
- **ZBMINIR2**: TurboMode setting; power-cut trigger.
- **MINI-ZBD, MINI-ZB2GS**: power-cut trigger.
- **MINI-ZB1GP**: power, voltage, current, energy today/month, reset-consumption button, metering-error and overload alarms.
- **SNZB-06P**: the device does not measure lux. It only reports bright/dark, and only while presence is detected (Sonoff's own iHost does not expose it either), so the driver does not offer an illuminance value.

## Availability

Each device is marked unavailable after a silence that depends on how often it talks by itself. A sleepy sensor gets a timeout of about 2.5 times its heartbeat, so one missed report does not flip it. Before marking a mains device offline the app polls it once, with a random delay so devices do not all poll at the same moment after a power cut. Sleepy sensors are not polled: they ignore pings.

Heartbeats seen in logs (hours of capture per model):

| Device | Heartbeat | Timeout used |
|---|---|---|
| SNZB-02WD / SNZB-02LD | ZDO Device Announce about every 29 min | 90 min |
| SNZB-04P | Device Announce every 60 min, no periodic battery report | 150 min |
| SNZB-04PR2 | Battery percentage report about every 27 min | 90 min |
| ZBMINI | onOff report about every 4 min | 10 min |
| BASICZBR3 | onOff report every 5 min (300 s) | 25 min |
| MINI-ZB1GP | onOff / metering reports | 25 min |
| ZBMINIR2, MINI-ZB2GS, SNZB-06P, dongles | periodic reports / manufacturer frames | 90 min |

No availability tracking: MINI-ZBD and SNZB-03.

The SNZB-04P is the weak case: its only periodic sign of life is the hourly announce, and a closed door sends nothing. If a re-paired SNZB-04P still shows no activity in the **Traffic** tab after a few hours, tracking for it should be removed.

The tiers are in [lib/constants.js](lib/constants.js); the logic is in [lib/AvailabilityManager.js](lib/AvailabilityManager.js) and [lib/ActivePoll.js](lib/ActivePoll.js).

**Reporting re-sync.** Sleepy sensors announce every 29 to 60 minutes. Re-applying the whole reporting configuration at every announce is wasteful and fails while the sensor sleeps, so the thermometers and door sensors redo it at most once every 3 hours.

**Poll Control (0x0020).** Door and temperature sensors bind Poll Control and log its check-ins ([lib/SonoffPollControlCluster.js](lib/SonoffPollControlCluster.js), [lib/pollControlHeartbeat.js](lib/pollControlHeartbeat.js)). In tests the check-ins did not reach the app, so they are not relied on as a heartbeat. In the iHost pairing capture the SNZB-04PR2 sets a check-in interval of 1 hour. The binding to the coordinator is made at pairing.

## Power-cut detection (rejoin)

When ZBMINIR2, MINI-ZBD or MINI-ZB2GS regain power, they send a burst of Report Attributes on the manufacturer cluster `0xFC11` and on OnOff (`0x0006`), about 8 ms apart. The periodic `0xFC11` heartbeat arrives alone. The drivers require both within 200 ms, ignore frames right after their own writes, and merge a burst with a 30 s cool-down. The result is the flow trigger **Reconnected after power cut** for the device, plus a rejoin counter and timestamp. See [lib/RejoinManager.js](lib/RejoinManager.js).

## App settings

The settings page has two tabs:
- **Traffic**: Zigbee frames per device, by source (current hour and last 24 h). A device with no activity here is not talking to the app.
- **Rejoins**: how many times each device rejoined and when, with a reset.

## Install

```bash
npm install
homey app run        # temporary, with logs
homey app install    # permanent, no logs
```

Set `ZCL_DEBUG` in [lib/constants.js](lib/constants.js) to `true` for verbose frame logging while developing, and back to `false` before committing. There is no env.json and no settings toggle for it.

Open items are in [TODO.md](TODO.md). Field notes on heartbeats and rejoin detection, written for other Sonoff Homey developers, are in [docs/NOTES-FOR-UPSTREAM.md](docs/NOTES-FOR-UPSTREAM.md).

## Credits and license

MIT, see [LICENSE](LICENSE).

- Based on [Homey.Sonoff.Zigbee](https://github.com/StyraHem/Homey.Sonoff.Zigbee) by StyraHem (Tarra AB), through [macmonty/Homey.Sonoff.Zigbee](https://github.com/macmonty/Homey.Sonoff.Zigbee), which includes the ZBMINIR2 and MINI-ZB2GS work by Simone Di Maio.
- Packet captures (pcapng) and device logs were analysed, and code was written and reviewed, with the help of Claude (Anthropic). Hardware testing and verification are done by the author.
- Real-hardware tests use Sonoff units paired with Homey; the Sonoff pairing traffic was sniffed with an iHost and a CC2531.
