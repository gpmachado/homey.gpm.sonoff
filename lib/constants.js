'use strict';

const Homey = require('homey');

module.exports = {

  // ── Availability watchdog timeouts ────────────────────────────────────────
  // Time without any Zigbee frame before a device is marked unavailable.
  // Named by expected silence tolerance, not by device family — any device
  // whose reporting cadence fits a tier uses that tier.

  // Fast tier — mains-powered devices with active onOff/cluster-6 reporting
  // every ≤10 min (switches, relays). 2.5-3× the report interval.
  HEARTBEAT_FAST_MS: 25 * 60 * 1000, // 25 min

  // Medium tier — mains-powered devices with slower or heartbeat-only reporting,
  // and Zigbee repeaters/dongles that only respond to active pings.
  HEARTBEAT_MEDIUM_MS: 90 * 60 * 1000, // 90 min

  // Slow tier — battery/sleepy end devices (temp/humidity, contact) that are
  // legitimately silent for hours between reports.
  HEARTBEAT_SLOW_MS: 4 * 60 * 60 * 1000, // 4 h

  // ── Poll antes de marcar offline ──────────────────────────────────────────
  POLL_BEFORE_OFFLINE: true,
  POLL_TIMEOUT_MS: 10000,

  // Espalha o instante do poll de confirmação entre 0 e este valor.
  // Evita que vários dispositivos expirando no mesmo tick do watchdog
  // (ex.: queda de energia geral seguida de reconexão simultânea) disputem
  // o canal Zigbee ao mesmo tempo com readAttributes concorrentes.
  POLL_JITTER_MAX_MS: 5000, // 5 s

  // Verbose diagnostics. Set via env.json ({"DEBUG":"1"}, gitignored) or
  // process.env.DEBUG=1 — plain env vars never reach `homey app run -r`.
  ZCL_DEBUG: process.env.DEBUG === '1' || Homey.env?.DEBUG === '1',

};
