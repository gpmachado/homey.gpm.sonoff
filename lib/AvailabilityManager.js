'use strict';

/**
 * @file AvailabilityManager.js
 * @description Zigbee device availability tracking + flow-card trigger helper.
 * Ported from nova.digital.homeyapp (v3.1.0). RejoinManager is intentionally
 * separate (see ./RejoinManager.js) — this file only tracks online/offline.
 *
 * ## AvailabilityManagerPassive — passive handleFrame hook
 * Hooks node.handleFrame to detect ANY inbound Zigbee frame (attribute
 * reports, poll responses, keepalives …) with ZERO extra network traffic.
 * ```js
 * const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
 * // main device only:
 * this._availability = new AvailabilityManagerPassive(this, { timeout: 25 * 60 * 1000 });
 * await this._availability.install();
 * // in onDeleted/onUninit:
 * this._availability?.uninstall().catch(() => {});
 * ```
 *
 * ## AvailabilityManagerCallback — callback-driven (battery sensors)
 * Injects device._markAliveFromAvailability(source) for explicit signalling.
 * ```js
 * const { AvailabilityManagerCallback } = require('../../lib/AvailabilityManager');
 * this._availability = new AvailabilityManagerCallback(this, { timeout: 4 * 60 * 60 * 1000 });
 * await this._availability.install();
 * // in every inbound data handler:
 * this._markAliveFromAvailability?.('reporting');
 * ```
 *
 * ## Persistence
 * last_seen_ts is stored via setStoreValue — survives app restarts.
 * After a restart, if the device was last seen longer ago than the timeout, the
 * first watchdog tick will immediately mark it unavailable.
 *
 * Message statistics are stored in hourly buckets under
 * availability_message_stats_v1. Passive counts raw inbound Zigbee frames;
 * Callback counts explicit activity callbacks from the driver. The statistics
 * never influence availability decisions — see getMessageStats()/resetMessageStats(),
 * surfaced on the app Settings page (settings/index.html, "Traffic" tab).
 */

const {
  POLL_BEFORE_OFFLINE,
  POLL_TIMEOUT_MS,
  POLL_JITTER_MAX_MS,
  ZCL_DEBUG,
} = require('./constants');

const LAST_SEEN_PERSIST_MS = 5 * 60 * 1000;
const MESSAGE_STATS_STORE_KEY = 'availability_message_stats_v1';
const MESSAGE_STATS_VERSION = 1;
const MESSAGE_STATS_HOUR_MS = 60 * 60 * 1000;
const MESSAGE_STATS_BUCKETS = 24;
const MESSAGE_STATS_PERSIST_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compact hourly message counter. It stores only the current clock hour and
 * the previous 23 buckets instead of retaining one timestamp per frame.
 */
class HourlyMessageStats {

  constructor(snapshot = null) {
    this.total = Number.isFinite(snapshot?.total) ? snapshot.total : 0;
    this.lastMessageAt = Number.isFinite(snapshot?.lastMessageAt)
      ? snapshot.lastMessageAt
      : null;
    this.buckets = this._normalizeBuckets(snapshot?.buckets);
    this.prune();
  }

  record(source = 'unknown', timestamp = Date.now()) {
    const key = String(this._hourStart(timestamp));
    const normalizedSource = this._normalizeSource(source);
    this.prune(timestamp);

    if (!this.buckets[key]) this.buckets[key] = { total: 0, bySource: {} };
    this.buckets[key].total += 1;
    this.buckets[key].bySource[normalizedSource] =
      (this.buckets[key].bySource[normalizedSource] || 0) + 1;
    this.total += 1;
    this.lastMessageAt = timestamp;
  }

  summary(timestamp = Date.now()) {
    this.prune(timestamp);
    const currentHourStart = this._hourStart(timestamp);
    const previousHourStart = currentHourStart - MESSAGE_STATS_HOUR_MS;
    const hourly = [];
    const bySource = {};
    let last24h = 0;

    for (let index = MESSAGE_STATS_BUCKETS - 1; index >= 0; index--) {
      const start = currentHourStart - (index * MESSAGE_STATS_HOUR_MS);
      const bucket = this.buckets[String(start)] || { total: 0, bySource: {} };
      hourly.push({ start, total: bucket.total });
      last24h += bucket.total;

      for (const [source, count] of Object.entries(bucket.bySource)) {
        bySource[source] = (bySource[source] || 0) + count;
      }
    }

    return {
      version: MESSAGE_STATS_VERSION,
      currentHour: this.buckets[String(currentHourStart)]?.total || 0,
      previousHour: this.buckets[String(previousHourStart)]?.total || 0,
      last24h,
      averagePerHour: Math.round((last24h / MESSAGE_STATS_BUCKETS) * 10) / 10,
      total: this.total,
      lastMessageAt: this.lastMessageAt,
      bySource,
      hourly,
    };
  }

  serialize(timestamp = Date.now()) {
    this.prune(timestamp);
    return {
      version: MESSAGE_STATS_VERSION,
      total: this.total,
      lastMessageAt: this.lastMessageAt,
      buckets: this.buckets,
    };
  }

  reset() {
    this.total = 0;
    this.lastMessageAt = null;
    this.buckets = {};
  }

  prune(timestamp = Date.now()) {
    const oldest = this._hourStart(timestamp)
      - ((MESSAGE_STATS_BUCKETS - 1) * MESSAGE_STATS_HOUR_MS);
    for (const key of Object.keys(this.buckets)) {
      if (!Number.isFinite(Number(key)) || Number(key) < oldest) delete this.buckets[key];
    }
  }

  _normalizeBuckets(buckets) {
    if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) return {};
    const normalized = {};

    for (const [key, bucket] of Object.entries(buckets)) {
      const timestamp = Number(key);
      if (!Number.isFinite(timestamp) || !bucket || typeof bucket !== 'object') continue;
      const total = Number.isFinite(bucket.total) && bucket.total >= 0
        ? Math.floor(bucket.total)
        : 0;
      const bySource = {};

      if (bucket.bySource && typeof bucket.bySource === 'object') {
        for (const [source, count] of Object.entries(bucket.bySource)) {
          if (Number.isFinite(count) && count > 0) {
            bySource[this._normalizeSource(source)] = Math.floor(count);
          }
        }
      }
      normalized[String(timestamp)] = { total, bySource };
    }
    return normalized;
  }

  _hourStart(timestamp) {
    return Math.floor(timestamp / MESSAGE_STATS_HOUR_MS) * MESSAGE_STATS_HOUR_MS;
  }

  _normalizeSource(source) {
    return String(source || 'unknown').slice(0, 64);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Static trigger helper
// ─────────────────────────────────────────────────────────────────────────────

class AvailabilityManager {
  /**
   * Fire the appropriate availability flow trigger card.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {boolean} available
   */
  static trigger(device, available) {
    const eventId = available ? 'availability_turned_on' : 'availability_turned_off';
    const cardId = `${device.driver.id}_${eventId}`;
    device.log(`[AvailabilityManager] Firing flow: ${cardId}`);

    // getTimezone() is synchronous in Homey SDK v3+ — returns a string directly.
    let tz = 'UTC';
    try {
      const result = device.homey.clock.getTimezone();
      if (typeof result === 'string' && result.length > 0) tz = result;
    } catch { /* use UTC fallback */ }

    const timestamp = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());

    const tokens = { device_name: device.getName(), timestamp };

    // getDeviceTriggerCard() throws synchronously for an unregistered card id
    // (e.g. driver/app.json mismatch) — the trailing .catch() only guards the
    // trigger() promise, not this call itself.
    try {
      device.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(device, tokens)
        .catch(err => device.error(`[AvailabilityManager] ${cardId} trigger failed:`, err.message));
    } catch (err) {
      device.error(`[AvailabilityManager] ${cardId} error:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────────────────

class AvailabilityManagerBase {

  /**
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {object} options
   * @param {number} options.timeout           - Inactivity timeout in ms
   * @param {number} [options.checkInterval]   - Watchdog tick in ms (default 60s)
   * @param {boolean} [options.pollBeforeOffline] - Poll device before marking unavailable
   * @param {number} [options.pollTimeoutMs]    - Timeout for the confirmation poll
   * @param {number} [options.pollJitterMaxMs]   - Max random delay (ms) before polling,
   *                                               spreads concurrent polls across devices
   *                                               that time out around the same tick.
   * @param {number} [options.bootGraceMs]       - Grace period after install before
   *                                               the watchdog evaluates last_seen_ts.
   * @param {boolean} [options.resetLastSeenOnInstall] - Start baseline from install
   *                                               time instead of stored last_seen_ts.
   */
  constructor(device, options = {}) {
    if (!device) throw new Error('[Availability] device is required');
    if (!options.timeout || options.timeout <= 0) throw new Error('[Availability] timeout must be positive');

    this.device = device;
    this.options = { checkInterval: 60 * 1000, logIdle: ZCL_DEBUG, ...options };
    this._bootGraceMs = options.bootGraceMs ?? 5 * 60 * 1000;
    this._installedAt = 0;
    this._watchdogInterval = null;
    this._installed = false;
    this._frameHookInstalled = false;
    this._lastSeen = 0;                // in-memory truth; Store is init/persist/recovery only
    this._persistingLastSeen = false;  // guard: avoid overlapping setStoreValue calls
    this._lastPersisted = 0;           // throttle: last time last_seen_ts was written
    this._zigbeeNode = null;           // reference kept for cleanup
    this._originalHandleFrame = null;  // original handler to restore on uninstall
    this._polling = false;
    this._pollTimeoutMs = options.pollTimeoutMs || POLL_TIMEOUT_MS;
    this._pollBeforeOffline = options.pollBeforeOffline ?? POLL_BEFORE_OFFLINE;
    this._pollJitterMaxMs = options.pollJitterMaxMs ?? POLL_JITTER_MAX_MS;

    // Statistics are passive and never affect availability decisions.
    this._messageStats = new HourlyMessageStats(
      this.device.getStoreValue(MESSAGE_STATS_STORE_KEY),
    );
    this._messageStatsRevision = 0;
    this._messageStatsDirty = false;
    this._messageStatsPersisting = false;
    this._lastMessageStatsPersisted = 0;
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  _recordMessage(source) {
    this._messageStats.record(source);
    this._messageStatsRevision += 1;
    this._messageStatsDirty = true;

    if (Date.now() - this._lastMessageStatsPersisted >= MESSAGE_STATS_PERSIST_INTERVAL_MS) {
      this._persistMessageStats().catch(() => {});
    }
  }

  async _persistMessageStats(force = false) {
    if (!this._messageStatsDirty && !force) return;
    if (this._messageStatsPersisting) return;
    if (
      !force
      && Date.now() - this._lastMessageStatsPersisted < MESSAGE_STATS_PERSIST_INTERVAL_MS
    ) return;

    this._messageStatsPersisting = true;
    const revision = this._messageStatsRevision;
    try {
      await this.device.setStoreValue(
        MESSAGE_STATS_STORE_KEY,
        this._messageStats.serialize(),
      );
      if (this._messageStatsRevision === revision) {
        this._messageStatsDirty = false;
      }
      this._lastMessageStatsPersisted = Date.now();
    } catch (err) {
      this.device.error('[Availability] Message stats persist failed:', err.message);
    } finally {
      this._messageStatsPersisting = false;
    }
  }

  /**
   * Record activity: persist timestamp, restore availability if lost.
   * @param {string} source - Log label (e.g. 'ep1 cl:0x0006', 'reporting')
   */
  async _markAlive(source) {
    try {
      const now = Date.now();
      this._lastSeen = now; // in-memory truth, updated unconditionally

      // Throttle persistence: the in-memory _lastSeen is the source of truth; the
      // store is only for recovery after an app restart, so write at most once
      // every 5 min.
      // Always write immediately on availability transitions (device was offline).
      const wasOffline = !this.device.getAvailable();
      if ((wasOffline || now - this._lastPersisted >= LAST_SEEN_PERSIST_MS) && !this._persistingLastSeen) {
        this._persistingLastSeen = true;
        try {
          await this.device.setStoreValue('last_seen_ts', now)
            .catch(err => this.device.error('[Availability] setStoreValue(last_seen_ts) failed:', err.message));
          // Native "last seen" UI field (Homey >= v12.6.1). No getter exists for
          // this property, so it's purely informational — _lastSeen above
          // remains the only source the watchdog reads from.
          if (typeof this.device.setLastSeenAt === 'function') {
            await this.device.setLastSeenAt().catch(() => {});
          }
          this._lastPersisted = now;
        } finally {
          this._persistingLastSeen = false;
        }
      }

      // _restoring guard prevents double-fire when multiple frames arrive simultaneously
      // (e.g. ep1 + ep2 both trigger _markAlive before setAvailable() resolves)
      if (wasOffline && !this._restoring) {
        this._restoring = true;
        this.device.log(`[Availability] Restoring (${source})`);
        await this._markAllAvailable().finally(() => { this._restoring = false; });
      }
    } catch (err) {
      this._restoring = false;
      this.device.error('[Availability] _markAlive error:', err.message);
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  /**
   * Tenta fazer poll no dispositivo antes de marcar offline.
   * Lê atributo do Basic Cluster (0x0000) — universal para todos dispositivos Zigbee.
   * @returns {Promise<boolean>} true se dispositivo respondeu, false se falhou
   */
  async _pollDevice() {
    if (this._polling) return false;

    this._polling = true;
    try {
      if (this._pollJitterMaxMs > 0) {
        const jitter = Math.floor(Math.random() * this._pollJitterMaxMs);
        await new Promise(resolve => setTimeout(resolve, jitter));
      }

      const endpoints = this.device.zclNode?.endpoints;
      const basic = endpoints?.[Object.keys(endpoints)[0]]?.clusters?.basic;
      if (!basic) {
        this.device.error('[Availability] Poll failed: no basic cluster');
        return false;
      }

      this.device.log('[Availability] Polling device before marking offline...');

      // Any response (even without the specific attribute — manufacturerName is
      // optional in the ZCL Basic cluster) already proves the device answered on
      // the network; requiring that specific attribute would false-offline
      // devices that don't implement it but respond normally.
      let timeoutId;
      let result;
      try {
        result = await Promise.race([
          basic.readAttributes(['zclVersion']),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Poll timeout')), this._pollTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }

      if (result != null) {
        this.device.log('[Availability] Poll succeeded — device still alive');
        await this._markAlive('poll');
        return true;
      }

      return false;
    } catch (err) {
      this.device.log(`[Availability] Poll failed: ${err.message}`);
      return false;
    } finally {
      this._polling = false;
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.device.log('[Availability] Watchdog starting...');

    this._watchdogInterval = this.device.homey.setInterval(async () => {
      try {
        await this._persistMessageStats().catch(() => {});

        if (!this._lastSeen) {
          // Defensive fallback — _seedLastSeen() during install() should have
          // already set this. Seed now so the next tick has a baseline.
          this._lastSeen = Date.now();
          await this.device.setStoreValue('last_seen_ts', this._lastSeen).catch(() => {});
          return;
        }

        // During the boot grace period, skip idle evaluation.
        const graceRemainingMs = this._bootGraceMs - (Date.now() - this._installedAt);
        if (graceRemainingMs > 0) {
          if (this.options.logIdle) {
            this.device.log(`[Availability] Boot grace: ${Math.round(graceRemainingMs / 1000)}s remaining`);
          }
          return;
        }

        // No work needed while already unavailable — avoids noisy idle logs.
        if (!this.device.getAvailable()) return;

        const idle = Date.now() - this._lastSeen;
        const idleMin = Math.round(idle / 60000);

        if (this.options.logIdle && idleMin > 0 && idleMin % 5 === 0) {
          this.device.log(`[Availability] Idle: ${idleMin}min / ${Math.round(this.options.timeout / 60000)}min`);
        }

        if (idle > this.options.timeout) {
          if (this._pollBeforeOffline) {
            this.device.log(`[Availability] Timeout — no activity for ${idleMin}min, polling before offline...`);
            const alive = await this._pollDevice();
            if (!alive) {
              await this._markAllUnavailable(`No activity for ${idleMin}min`);
            }
          } else {
            this.device.log(`[Availability] Timeout — no activity for ${idleMin}min`);
            await this._markAllUnavailable(`No activity for ${idleMin}min`);
          }
        }
      } catch (err) {
        this.device.error('[Availability] Watchdog error:', err.message);
      }
    }, this.options.checkInterval);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) {
      this.device.homey.clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
      this.device.log('[Availability] Watchdog stopped');
    }
  }

  // ── Sibling cascade ───────────────────────────────────────────────────────

  /**
   * Mark all sibling devices available.
   * Sets is_availability=true AFTER setAvailable() so Homey fires the
   * capability-based flow trigger ("is_availability turns on") on an
   * already-available device.
   */
  async _markAllAvailable() {
    const wasUnavailable = !this.device.getAvailable();
    const changed = this._getSiblings().filter(s => !s.getAvailable());

    await Promise.allSettled(
      changed.map(s => {
        s.log('[Availability] Available');
        return s.setAvailable().catch(() => {});
      })
    );

    if (this.device.hasCapability('is_availability')) {
      await this.device.setCapabilityValue('is_availability', true).catch(() => {});
    }

    AvailabilityManager.trigger(this.device, true);

    if (wasUnavailable && typeof this.device.onBecameAvailable === 'function') {
      try {
        await this.device.onBecameAvailable();
      } catch (err) {
        this.device.error('[Availability] onBecameAvailable error:', err.message);
      }
    }
  }

  /**
   * Mark all sibling devices unavailable.
   * Sets is_availability=false BEFORE setUnavailable() so Homey fires the
   * capability-based flow trigger ("is_availability turns off") while the
   * device is still available (ensuring the trigger fires).
   * @param {string} reason
   */
  async _markAllUnavailable(reason) {
    const wasAvailable = this.device.getAvailable();
    const changed = this._getSiblings().filter(s => s.getAvailable());

    if (this.device.hasCapability('is_availability')) {
      await this.device.setCapabilityValue('is_availability', false).catch(() => {});
    }

    await Promise.allSettled(
      changed.map(s => {
        s.log(`[Availability] Unavailable: ${reason}`);
        return s.setUnavailable(reason).catch(() => {});
      })
    );

    AvailabilityManager.trigger(this.device, false);

    if (wasAvailable && typeof this.device.onBecameUnavailable === 'function') {
      try {
        await this.device.onBecameUnavailable(reason);
      } catch (err) {
        this.device.error('[Availability] onBecameUnavailable error:', err.message);
      }
    }
  }

  /**
   * Resolve all Homey device instances sharing this physical Zigbee node.
   */
  _getSiblings() {
    return [this.device];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Seed the in-memory `_lastSeen` from Store (recovery after app restart),
   * or from `Date.now()` when absent or `resetLastSeenOnInstall` is set.
   */
  async _seedLastSeen() {
    const stored = this.device.getStoreValue('last_seen_ts');
    if (this.options.resetLastSeenOnInstall || !stored) {
      this._lastSeen = Date.now();
      await this.device.setStoreValue('last_seen_ts', this._lastSeen).catch(() => {});
    } else {
      this._lastSeen = stored;
    }
  }

  async uninstall() {
    if (!this._installed) return;
    // Set synchronously, before any await, so a concurrent uninstall() call
    // (onUninit and onDeleted both invoke _teardown() on user removal) sees
    // this guard immediately instead of racing through cleanup twice.
    this._installed = false;
    this._stopWatchdog();
    await this._persistMessageStats(true).catch(() => {});
    await this._cleanup();
    this.device.log('[Availability] Uninstalled');
  }

  /**
   * Seed is_availability to true only when it has never been set (fresh
   * pairing, or capability just added to an existing device). Forcing it
   * true on every boot would fire a misleading "turns on" trigger before the
   * watchdog/frame hook actually confirms the device is reachable again.
   */
  _initAlarmCapability() {
    if (!this.device.hasCapability('is_availability')) return;
    const current = this.device.getCapabilityValue('is_availability');
    if (current === null || current === undefined) {
      this.device.setCapabilityValue('is_availability', true).catch(() => {});
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Mark all siblings available — use instead of device.setAvailable() so that
   * the sibling cascade, is_availability capability, flow trigger and
   * onBecameAvailable() callback all fire correctly.
   */
  async markAvailable() {
    return this._markAllAvailable();
  }

  /**
   * Mark all siblings unavailable — use instead of device.setUnavailable() so
   * that the sibling cascade, is_availability capability, flow trigger and
   * onBecameUnavailable() callback all fire correctly.
   * @param {string} reason
   */
  async markUnavailable(reason) {
    return this._markAllUnavailable(reason);
  }

  /**
   * Signal device activity from an explicit caller (e.g. reportParser, poll result).
   * @param {string} [source]
   */
  async notifyActivity(source = 'activity') {
    this._recordMessage(source);
    return this._markAlive(source);
  }

  getMessageStats() {
    return {
      mode: this._messageStatsMode(),
      ...this._messageStats.summary(),
    };
  }

  async resetMessageStats() {
    while (this._messageStatsPersisting) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this._messageStats.reset();
    this._messageStatsRevision += 1;
    this._messageStatsDirty = true;
    await this._persistMessageStats(true);
    return this.getMessageStats();
  }

  _messageStatsMode() {
    return 'activity';
  }

  /** Last confirmed activity, as a Date (in-memory truth — see _seedLastSeen). */
  getLastSeen() {
    return this._lastSeen ? new Date(this._lastSeen) : null;
  }

  /** Diagnostic snapshot — for logs/debugging, not used by any availability decision. */
  getStatus() {
    return {
      installed: this._installed,
      available: this.device.getAvailable(),
      lastSeen: this._lastSeen || null,
      idleMs: this._lastSeen ? Date.now() - this._lastSeen : null,
      timeoutMs: this.options.timeout,
      polling: this._polling,
      bootGraceRemainingMs: Math.max(0, this._bootGraceMs - (Date.now() - this._installedAt)),
    };
  }

  /** @protected Override in subclass for additional cleanup */
  async _cleanup() {}

  /** @abstract */
  async install() {
    throw new Error('install() must be implemented by subclass');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Passive — passive handleFrame hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hooks node.handleFrame to intercept ALL inbound Zigbee frames.
 * Use for: mains-powered devices (switches, repeaters, energy meters) where
 * every poll response, attribute report and keepalive should count.
 *
 * The original handler is always called — cluster processing is unaffected.
 */
class AvailabilityManagerPassive extends AvailabilityManagerBase {

  _messageStatsMode() {
    return 'frames';
  }

  // Passive statistics count raw handleFrame invocations only. Drivers may
  // also call notifyActivity() from report parsers as an availability fallback;
  // that callback must not count the same Zigbee message a second time.
  async notifyActivity(source = 'activity') {
    return this._markAlive(source);
  }

  _logBasicFrameNeedingResponse(endpointId, clusterId, frame) {
    if (!ZCL_DEBUG) return;
    if (clusterId !== 0 || !Buffer.isBuffer(frame) || frame.length < 3) return;

    const frameControl = frame[0];
    const directionToClient = (frameControl & 0x08) !== 0;
    const disableDefaultResponse = (frameControl & 0x10) !== 0;
    const sequenceNumber = frame[1];
    const commandId = frame[2];

    if (directionToClient && !disableDefaultResponse && commandId === 0x0a) {
      this.device.log(
        `[Availability] Basic report expects default response: ep${endpointId} seq=${sequenceNumber} cmd=0x${commandId.toString(16)}`,
      );
    }
  }

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      await this._installHandleFrameHook();
      await this._seedLastSeen();
      this._installedAt = Date.now();
      this._initAlarmCapability();
      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Passive monitoring enabled');
    } catch (err) {
      // Undo any partial install (frame hook, watchdog, injected callback) so a
      // later onNodeInit is not blocked by a hook that uninstall() would skip
      // because _installed was never set.
      this._stopWatchdog();
      await this._cleanup().catch(() => {});
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  async _installHandleFrameHook() {
    const node = await this.device.homey.zigbee.getNode(this.device);
    if (!node) throw new Error('[Availability] Failed to get ZigBee node');

    if (node._availabilityHookInstalled) {
      // AvailabilityManagerPassive must be installed on exactly one device per
      // Zigbee node (the main/EP1 device). A second instance here would run
      // its own watchdog against a node it never receives frames from,
      // silently going stale while the physical device stays online.
      throw new Error(
        '[Availability] node.handleFrame already hooked — install AvailabilityManagerPassive '
        + 'on exactly one device per Zigbee node.',
      );
    }

    this._zigbeeNode = node;
    this._originalHandleFrame = node.handleFrame ?? null;

    const original = node.handleFrame;
    if (typeof original !== 'function') {
      node.handleFrame = (endpointId, clusterId, frame, meta) => {
        this._logBasicFrameNeedingResponse(endpointId, clusterId, frame);
        this._recordMessage(`ep${endpointId}:0x${clusterId.toString(16)}`);
        // Fire-and-forget: availability bookkeeping (Store I/O, sibling cascade)
        // must not serialize the frame path.
        this._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`)
          .catch(e => this.device.error('[Availability] handleFrame hook error:', e.message));
        return false;
      };
    } else {
      // Wrap the existing handler. Note: node is shared by all sub-devices.
      node.handleFrame = (endpointId, clusterId, frame, meta) => {
        this._logBasicFrameNeedingResponse(endpointId, clusterId, frame);
        this._recordMessage(`ep${endpointId}:0x${clusterId.toString(16)}`);
        this._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`)
          .catch(e => this.device.error('[Availability] handleFrame hook error:', e.message));
        return original.call(node, endpointId, clusterId, frame, meta);
      };
    }

    node._availabilityHookInstalled = true;
    this._frameHookInstalled = true;
    this.device.log('[Availability] handleFrame hook installed');
  }

  async _cleanup() {
    if (this._zigbeeNode) {
      if (this._originalHandleFrame !== null) {
        this._zigbeeNode.handleFrame = this._originalHandleFrame;
      }
      this._zigbeeNode._availabilityHookInstalled = false;
      this._zigbeeNode = null;
    }
    this._originalHandleFrame = null;
    this._frameHookInstalled = false;
    this._lastPersisted = 0;
    this._lastSeen = 0;
    this._installedAt = 0;
    this.device.log('[Availability] handleFrame hook restored');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback — callback-driven (battery-powered sensors)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injects device._markAliveFromAvailability(source) for explicit signalling.
 * Use for: battery devices (temp/humidity sensors) where handleFrame access
 * may not be available or is unreliable.
 *
 * The device must call this._markAliveFromAvailability?.('source') in every
 * inbound data handler (reportParser, wake/rejoin activity, etc).
 */
class AvailabilityManagerCallback extends AvailabilityManagerBase {

  /**
   * Sleepy/battery end devices ignore active pings — polling before offline
   * would spend a Zigbee transaction on a device designed to sleep through
   * it. Default pollBeforeOffline to false here (overrides the global
   * POLL_BEFORE_OFFLINE default), while still letting a caller opt back in
   * explicitly via options.
   */
  constructor(device, options = {}) {
    super(device, { pollBeforeOffline: false, ...options });
  }

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      this.device._markAliveFromAvailability = async (source = 'activity') => {
        await this.notifyActivity(source);
      };
      await this._seedLastSeen();
      this._installedAt = Date.now();
      this._initAlarmCapability();
      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Monitoring enabled (callback-driven)');
    } catch (err) {
      // Undo any partial install (frame hook, watchdog, injected callback) so a
      // later onNodeInit is not blocked by a hook that uninstall() would skip
      // because _installed was never set.
      this._stopWatchdog();
      await this._cleanup().catch(() => {});
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  async _cleanup() {
    delete this.device._markAliveFromAvailability;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = AvailabilityManager;
module.exports.AvailabilityManagerPassive = AvailabilityManagerPassive;
module.exports.AvailabilityManagerCallback = AvailabilityManagerCallback;
module.exports.HourlyMessageStats = HourlyMessageStats;
module.exports.MESSAGE_STATS_STORE_KEY = MESSAGE_STATS_STORE_KEY;
