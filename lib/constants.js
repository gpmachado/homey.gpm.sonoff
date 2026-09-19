'use strict';

const Homey = require('homey');

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

  // Debug level, from env.json ({"DEBUG":"1"}, gitignored) or process.env.DEBUG -
  // plain env vars never reach `homey app run -r`:
  //   0 / unset  off
  //   1          diagnostics (availability logs: boot grace, idle, activity gaps)
  //   2          + raw ZCL frame dumps of zigbee-clusters (very noisy)
  DEBUG_LEVEL: Math.max(Number(process.env.DEBUG) || 0, Number(Homey.env?.DEBUG) || 0),

};
