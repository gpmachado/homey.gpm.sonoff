# Sonoff Zigbee for Homey (`com.gpm.sonoff`)

A Homey (SDK 3) app for Sonoff Zigbee devices, with availability tracking, a Traffic and Rejoins overview in the app settings, and a "reconnected after power cut" flow trigger.

**Internal use.** The Homey App Store already has a Sonoff app, so this one is not published there. It is installed from source (see [Install](#install)).

Requires Homey firmware `>=12.4.0`.

## Supported devices

| Driver | Device | Notes |
|---|---|---|
| ZBMINI | ZBMINI switch | tested |
| ZBMINIR2 | ZBMINI-R2 switch | tested; power-cut trigger; TurboMode setting |
| MINI-ZBD | MINI-ZBD dry contact | tested; power-cut trigger |
| MINI-ZB1GP | Energy meter (no relay) | tested; power, voltage, current, energy today/month, reset button |
| MINI-ZB2GS | 2-gang switch | tested; each channel is its own Homey device |
| BASICZBR3 | Basic ZBR3 switch | tested |
| SNZB-02WD | Temperature and humidity sensor | tested |
| SNZB-02LD | Temperature sensor | tested |
| SNZB-03 | Motion sensor (battery) | tested |
| SNZB-04P | Door/window sensor | tested |
| SNZB-04PR2 | Door/window sensor (separate SKU) | tested |
| SNZB-06P | Presence sensor | tested; no illuminance (see below) |
| DONGLE-E_R / DONGLE-P | Zigbee dongles as routers | physical units owned, flashed with the router firmware from Sonoff's site |

"Tested" means a physical unit paired with Homey and logs kept for hours. MINI-ZB1GSP, SNZB-05P, SNZB-09P and S60ZBTPF were removed for now because there is no physical unit to test them; they can be restored from the git history (commit `8ffb0d2` and earlier).

SNZB-06P: the device does not measure lux. It only reports bright/dark, and only while presence is detected (Sonoff's own iHost does not expose it either), so the driver does not offer an illuminance value.

## Availability

Each device is marked unavailable after a silence that depends on how often it talks by itself. A sleepy sensor gets a timeout of about 2.5 times its heartbeat, so one missed report does not flip it. Before marking a device offline the app polls it once, with a random delay so devices do not all poll at the same moment after a power cut.

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

No availability tracking yet: MINI-ZBD and SNZB-03.

The tiers are in [lib/constants.js](lib/constants.js); the logic is in [lib/AvailabilityManager.js](lib/AvailabilityManager.js) and [lib/ActivePoll.js](lib/ActivePoll.js).

**Reporting re-sync.** Sleepy sensors announce every 29 to 60 minutes. Re-applying the whole reporting configuration at every announce is wasteful and fails while the sensor sleeps, so the thermometers and door sensors redo it at most once every 3 hours.

**Poll Control (0x0020).** Door and temperature sensors bind Poll Control and log its check-ins ([lib/SonoffPollControlCluster.js](lib/SonoffPollControlCluster.js), [lib/pollControlHeartbeat.js](lib/pollControlHeartbeat.js)). In tests the check-ins did not reach the app, so they are not relied on as a heartbeat. In the iHost pairing capture the SNZB-04PR2 sets a check-in interval of 1 hour. Pair the SNZB-04P/04PR2 and SNZB-02LD/WD again to enable it.

## Power-cut detection (rejoin)

When ZBMINIR2, MINI-ZBD or MINI-ZB2GS regain power, they send a burst of Report Attributes on the manufacturer cluster `0xFC11` and on OnOff (`0x0006`), about 8 ms apart. The periodic `0xFC11` heartbeat arrives alone. The drivers require both within 200 ms, ignore frames right after their own writes, and merge a burst with a 30 s cool-down. The result is the flow trigger **Reconnected after power cut** for the device, plus a rejoin counter and timestamp. See [lib/RejoinManager.js](lib/RejoinManager.js).

## App settings

The settings page has two tabs:
- **Traffic**: Zigbee frames per device, by source.
- **Rejoins**: how many times each device rejoined and when, with a reset.

## Install

```bash
npm install
homey app run        # temporary, with logs
homey app install    # permanent, no logs
```

Set `ZCL_DEBUG` in [lib/constants.js](lib/constants.js) to `true` for verbose frame logging while developing, and back to `false` before committing. There is no env.json and no settings toggle for it.

## Credits and license

MIT, see [LICENSE](LICENSE).

- Based on [Homey.Sonoff.Zigbee](https://github.com/StyraHem/Homey.Sonoff.Zigbee) by StyraHem (Tarra AB), through the fork [macmonty/Homey.Sonoff.Zigbee](https://github.com/macmonty/Homey.Sonoff.Zigbee), which includes the ZBMINIR2 and MINI-ZB2GS work by Simone Di Maio.
- Packet captures (pcapng) and device logs were analysed, and code was written and reviewed, with the help of Claude (Anthropic). Hardware testing and verification are done by the author.
- Real-hardware tests use Sonoff units paired with Homey; the Sonoff pairing traffic was sniffed with an iHost and a CC2531.
