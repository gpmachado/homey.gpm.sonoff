'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const { writeAttributesVerbose, installNamedLogging } = require('../lib/zclDebug');
const { DEBUG_LEVEL } = require('../lib/constants');
const ActivePoll = require('../lib/ActivePoll');

/**
 * SonoffBase - shared base class for Sonoff Zigbee device drivers.
 * Provides battery-report wiring, retrying attribute reads, filtered
 * attribute writes, and idempotent teardown on uninit/delete.
 *
 * Deliberately does NOT bind anything on the OTA cluster (0x0019): Homey
 * >=13.2 has its own native Zigbee firmware-update mechanism (Device Updates,
 * see https://apps.developer.homey.app/wireless/zigbee/zigbee-firmware-updates)
 * that talks to the device's OTA client directly. An app-level BoundCluster
 * answering queryNextImageRequest itself would race with - and could block -
 * that native flow.
 */
class SonoffBase extends ZigBeeDevice {

  async onNodeInit({ zclNode }, options) {
    installNamedLogging(this);
    this.log(`NodeInit SonoffBase: ${this.getName()}`);
    options = options || {};

    if (DEBUG_LEVEL >= 2) {
      this.enableDebug();
    }
    this.printNode();

    if (options.noAttribCheck !== true) {
      if ('powerConfiguration' in zclNode.endpoints[1].clusters) {
        // Battery-powered devices report proactively - listen and update capability.
        // Remove-then-add guards against duplicate listeners if onNodeInit runs
        // again on a reused cluster object (node reuse happens on re-init).
        this._onBatteryReport ??= (value) => {
          this._markSeen();
          this.log(`[Battery] ${value / 2}%`);
          this.setCapabilityValue('measure_battery', value / 2).catch(this.error);
        };
        const pc = this.zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME];
        pc.removeListener('attr.batteryPercentageRemaining', this._onBatteryReport);
        pc.on('attr.batteryPercentageRemaining', this._onBatteryReport);
      }
    }

    // Homey's own native Device Updates feature (>=13.2) polls basic.swBuildId
    // directly over the shared Zigbee radio, bypassing our zclNode entirely.
    // Our own 'basic' cluster instance still sees the response frame (shared
    // radio traffic) but has no pending request matching it - no driver here
    // ever reads from 'basic' itself - so it logs 'unknown_command_received'.
    // Accurate (we really didn't ask), but noisy. Drop only frames with no
    // matching _trxHandlers entry, so a genuine future read (ours or the
    // framework's own) is never swallowed.
    if (!this.node._basicReadResponseHookInstalled) {
      this.node._basicReadResponseHookInstalled = true;
      const _basicHook = this.node.handleFrame.bind(this.node);
      this.node.handleFrame = (...args) => {
        const [, clusterId, frame] = args;
        if (clusterId === CLUSTER.BASIC.ID && Buffer.isBuffer(frame) && frame.length >= 3) {
          const mfrSpecific = frame[0] & 0x04;
          const cmdId = mfrSpecific ? (frame.length >= 5 ? frame[4] : -1) : frame[2];
          if (cmdId === 0x01) { // readAttributes response (global)
            const trxSeq = frame[mfrSpecific ? 3 : 1];
            const basicCluster = this.zclNode.endpoints[1].clusters[CLUSTER.BASIC.NAME];
            if (basicCluster && !basicCluster._trxHandlers[trxSeq]) {
              return Promise.resolve();
            }
          }
        }
        return _basicHook(...args);
      };
    }
  }

  // Feeds Homey's native "last seen" on real device activity, at most once per
  // 5 min. For sleepy sensors with no heartbeat there is no availability watchdog
  // here on purpose (a closed door can stay silent for days): whoever reads
  // lastSeenAt decides with its own per-device threshold.
  _markSeen() {
    const now = Date.now();
    if (now - (this._lastSeenPushed ?? 0) < 5 * 60 * 1000) return;
    this._lastSeenPushed = now;
    if (typeof this.setLastSeenAt === 'function') this.setLastSeenAt().catch(() => {});
  }

  // Read an attribute once, only on the device's first-ever init (not on every restart).
  async initAttribute(cluster, attr, handler) {
    if (!this.isFirstInit()) return;
    this.readAttribute(cluster, attr, handler);
  }

  /**
   * Periodically read the Basic cluster (zclVersion - universal, cheap) and
   * feed the result to this._availability as an explicit activity signal.
   * Use for devices with no other frequent traffic of their own (ZBMINIR2,
   * dongles/repeaters) - see AvailabilityManagerPassive/Callback in
   * lib/AvailabilityManager.js, which already covers devices that already
   * poll something else on a short interval (energy meters).
   */
  _startActivePoll(intervalMs = 5 * 60 * 1000) {
    this._activePoll ??= new ActivePoll(this, { intervalMs });
    this._activePoll.start();
  }

  // A power-cycled device announces itself on the network: proof of life, so it
  // restores availability at once instead of waiting for the next frame or poll.
  // Subclasses with their own handler (sleepy sensors) override this.
  onEndDeviceAnnounce() {
    super.onEndDeviceAnnounce();
    this._availability?.notifyActivity('announce');
  }

  // Read one or more attributes with exponential backoff + jitter retry.
  async readAttribute(cluster, attr, handler, maxRetries = 3, baseDelay = 3000) {
    if ('NAME' in cluster) cluster = cluster.NAME;
    if (!Array.isArray(attr)) attr = [attr];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.log('Ask attribute', attr);
        const value = await this.zclNode.endpoints[1].clusters[cluster].readAttributes(attr);
        this.log('Got attr', attr, value);
        handler(value);
        return;
      } catch (e) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random()); // jitter +/-50%
          this.log(`Retry read attr ${attr} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => this.homey.setTimeout(r, delay));
        } else {
          this.log('Device unreachable - attr read skipped:', attr);
        }
      }
    }
  }

  // Write a single attribute.
  async writeAttribute(cluster, attr, value) {
    const data = {};
    data[attr] = value;
    this.writeAttributes(cluster, data);
  }

  // Write multiple attributes, silently dropping any key the cluster doesn't
  // declare (and any key not in `filter`, when given).
  async writeAttributes(cluster, attribs, filter = null) {
    let items = {};
    try {
      if ('NAME' in cluster) cluster = cluster.NAME;
      const clust = this.zclNode.endpoints[1].clusters[cluster];
      items = {};
      for (const key in attribs) {
        if (filter && !filter.includes(key)) continue;
        if (!(key in clust.constructor.attributes)) continue;
        items[key] = attribs[key];
      }

      if (!Object.keys(items).length) {
        this.log('Write attribute', {});
        return undefined;
      }

      this.log('Write attribute', items);
      return await writeAttributesVerbose(this, clust, items);
    } catch (error) {
      this.error('Error write attr', items, error);
      throw error;
    }
  }

  // zigbee-clusters' Cluster#configureReporting throws `new Error(status)` where
  // status is the raw ZCL status string returned by the device. Some of those
  // are definitive ("this attribute/cluster will never support that config")
  // and retrying them changes nothing - only silence/timeout is worth retrying
  // opportunistically on the next sign of device activity.
  static isDefinitiveZclRejection(err) {
    return [
      'UNSUPPORTED_ATTRIBUTE',
      'UNSUPPORTED_CLUSTER',
      'MALFORMED_COMMAND',
      'INVALID_FIELD',
      'INVALID_VALUE',
      'NOT_FOUND',
    ].includes(err?.message);
  }

  // Several Sonoff manufacturer-specific attributes (e.g. acCurrentPowerValue)
  // are transmitted two's-complement but declared/read as uint32 - convert.
  _toSignedInt32(raw) {
    return raw > 0x7fffffff ? raw - 0x100000000 : raw;
  }

  /**
   * Install a node-level `handleFrame` interceptor for a manufacturer-specific
   * cluster whose reportAttributes frames the zigbee-clusters auto-parser
   * can't decode, and/or whose clusterSpecific commands have no BoundCluster
   * handler (causing "binding_unavailable" log spam).
   *
   * reportAttributes (cmdId 0x0A) is parsed manually against `cluster.ATTRIBUTES`
   * and emits `attr.<name>` events on the cluster instance. Any cmdId listed in
   * `opts.suppressCmdIds` is swallowed silently but still counts as activity for
   * the availability watchdog.
   *
   * Guarded against re-installing on re-init: `this.node` can be reused by the
   * framework across an `onNodeInit` re-run, and wrapping `handleFrame` again
   * on the same node would stack interceptors indefinitely.
   */
  _installClusterReportInterceptor(cluster, { suppressCmdIds = [] } = {}) {
    const endpoint = this.zclNode.endpoints[1];
    const clusterInstance = endpoint.clusters[cluster.NAME];
    if (!clusterInstance) return;

    const installedFlag = `_${cluster.NAME}ReportInterceptorInstalled`;
    if (this.node[installedFlag]) {
      this.log(`[${cluster.NAME}] report interceptor already installed (shared node)`);
      return;
    }

    const ATTR_MAP = {};
    for (const [name, def] of Object.entries(cluster.ATTRIBUTES)) {
      if (!ATTR_MAP[def.id]) ATTR_MAP[def.id] = { name, type: def.type };
    }

    // Fallback sizes, used only for an attrId the device sends that isn't in
    // cluster.ATTRIBUTES. Known attributes are sized from their own
    // `type.length` instead of guessed from the wire type byte.
    const TYPE_SIZES = {
      0x10: 1, 0x18: 1, 0x20: 1, 0x21: 2, 0x23: 4,
      0x28: 1, 0x29: 2, 0x2B: 4, 0x1B: 4,
    };

    const readValue = (buf, offset, typeId) => {
      switch (typeId) {
        case 0x10: return buf.readUInt8(offset) === 1;
        case 0x20: return buf.readUInt8(offset);
        case 0x21: return buf.readUInt16LE(offset);
        case 0x23: return buf.readUInt32LE(offset);
        case 0x28: return buf.readInt8(offset);
        case 0x29: return buf.readInt16LE(offset);
        case 0x2B: return buf.readInt32LE(offset);
        case 0x18: return buf.readUInt8(offset);
        case 0x1B: return buf.readUInt32LE(offset);
        default:   return buf.readUInt16LE(offset);
      }
    };

    const hook = this.node.handleFrame.bind(this.node);
    this.node.handleFrame = (...args) => {
      const [, clusterId, frame] = args;
      if (clusterId === cluster.ID && Buffer.isBuffer(frame) && frame.length >= 2) {
        const cmdId = frame[0];

        if (cmdId === 0x0A) { // reportAttributes
          const data = frame.slice(1);
          let offset = 0;
          while (offset + 3 <= data.length) {
            const attrId = data.readUInt16LE(offset);
            offset += 2;
            const typeId = data[offset++];
            const attr = ATTR_MAP[attrId];
            const size = (attr?.type?.length > 0) ? attr.type.length : (TYPE_SIZES[typeId] || 2);
            if (offset + size > data.length) break;
            if (attr) {
              const value = readValue(data, offset, typeId);
              clusterInstance.emit(`attr.${attr.name}`, value);
            }
            offset += size;
          }
          return Promise.resolve(); // skip framework auto-parser
        }

        if (suppressCmdIds.includes(cmdId)) {
          return Promise.resolve();
        }
      }
      return hook(...args);
    };

    this.node[installedFlag] = true;
  }

  // onUninit fires on re-init/restart (onDeleted only on user removal).
  async onUninit() {
    await this._teardown();
  }

  onDeleted() {
    this._teardown();
    this.log('sonoff device removed');
  }

  // Idempotent cleanup - safe to call from both onUninit and onDeleted.
  async _teardown() {
    this.zclNode?.endpoints?.[1]?.clusters?.[CLUSTER.POWER_CONFIGURATION.NAME]
      ?.removeListener('attr.batteryPercentageRemaining', this._onBatteryReport);
    this._activePoll?.stop();
  }

}

module.exports = SonoffBase;
