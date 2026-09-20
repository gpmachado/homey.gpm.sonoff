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

  // Slow tier - battery/sleepy end devices (temp/humidity, contact) that are
  // legitimately silent for hours between reports.
  HEARTBEAT_SLOW_MS: 4 * 60 * 60 * 1000, // 4 h

  // -- Poll antes de marcar offline ------------------------------------------
  POLL_BEFORE_OFFLINE: true,
  POLL_TIMEOUT_MS: 10000,

  // Espalha o instante do poll de confirmação entre 0 e este valor.
  // Evita que vários dispositivos expirando no mesmo tick do watchdog
  // (ex.: queda de energia geral seguida de reconexão simultânea) disputem
  // o canal Zigbee ao mesmo tempo com readAttributes concorrentes.
  POLL_JITTER_MAX_MS: 5000, // 5 s

  // -- Debug ---------------------------------------------------------------
  // true  -> verbose zigbee-clusters frame logging and extra app-side diagnostics
  //          (availability: boot grace, idle, activity gaps, send-failure hook).
  // false -> production logging. The single debug switch: set it to true only
  //          while developing, and back to false before committing/publishing.
  ZCL_DEBUG: false,

};
