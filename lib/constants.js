'use strict';

module.exports = {

  // -- Availability watchdog timeouts ----------------------------------------
  // Time without any Zigbee frame before a device is marked unavailable.
  // Named by expected silence tolerance, not by device family - any device
  // whose reporting cadence fits a tier uses that tier.

  // Fastest tier - mains-powered devices that heartbeat every ~4 min (2.5x that),
  // relying on poll-before-offline to absorb an occasional missed report.
  HEARTBEAT_FASTEST_MS: 10 * 60 * 1000, // 10 min

  // Fast tier - mains-powered devices with active onOff/cluster-6 reporting
  // every <=10 min (switches, relays). 2.5-3x the report interval.
  HEARTBEAT_FAST_MS: 25 * 60 * 1000, // 25 min

  // Medium tier - mains-powered devices with slower or heartbeat-only reporting,
  // and Zigbee repeaters/dongles that only respond to active pings.
  HEARTBEAT_MEDIUM_MS: 90 * 60 * 1000, // 90 min

  // Slow tier - sleepy end devices whose only heartbeat is hourly (SNZB-04P: a Device
  // Announce every 60 min, no periodic battery report). 2.5x the interval, so one missed
  // announce does not flip the device to unavailable.
  HEARTBEAT_SLOW_MS: 150 * 60 * 1000, // 2.5 h

  // -- Poll before marking offline -------------------------------------------
  POLL_BEFORE_OFFLINE: true,
  POLL_TIMEOUT_MS: 10000,

  // Spreads the confirmation poll over a random 0..this-value delay, so several
  // devices timing out on the same watchdog tick (e.g. a general power cut followed
  // by a simultaneous reconnection) do not fight for the Zigbee channel with
  // concurrent readAttributes.
  POLL_JITTER_MAX_MS: 5000, // 5 s

  // -- Debug ---------------------------------------------------------------
  // true  -> verbose zigbee-clusters frame logging and extra app-side diagnostics
  //          (availability: boot grace, idle, activity gaps, send-failure hook).
  // false -> production logging. The single debug switch: set it to true only
  //          while developing, and back to false before committing/publishing.
  ZCL_DEBUG: false,

};
