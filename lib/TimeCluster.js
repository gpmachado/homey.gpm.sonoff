'use strict';

const { BoundCluster } = require('zigbee-clusters');

const ZIGBEE_EPOCH = 946684800;

function getZigbeeUtcSeconds() {
  return Math.floor(Date.now() / 1000) - ZIGBEE_EPOCH;
}

function getTimezoneOffsetSeconds() {
  return new Date().getTimezoneOffset() * -60;
}

/**
 * TimeServerBoundCluster — a real Time server (ZCL Time cluster, 0x000A).
 *
 * Registered via endpoint.bind('time', new TimeServerBoundCluster()) so the
 * app answers a device's Time queries with live UTC time, timezone offset
 * and a synchronized status — not just a placeholder. Most Tuya/Sonoff
 * devices have an *output* binding to the coordinator's Time cluster
 * (confirmed via device interview) expecting Homey to act as Time server;
 * without any BoundCluster registered here, zigbee-clusters throws
 * binding_unavailable for every such query instead of answering it.
 */
class TimeServerBoundCluster extends BoundCluster {
  constructor({ onReadAttributes } = {}) {
    super();
    this._onReadAttributes = onReadAttributes;
  }

  async readAttributes(args) {
    if (args?.attributes?.some(attrId => attrId === 0 || attrId === 7)) {
      this._onReadAttributes?.(args);
    }
    return super.readAttributes(args);
  }

  get time() {
    return getZigbeeUtcSeconds();
  }

  get timeStatus() {
    return { master: true, synchronized: true, masterZoneDst: true };
  }

  get timeZone() {
    return getTimezoneOffsetSeconds();
  }

  get standardTime() {
    return this.localTime;
  }

  get localTime() {
    return getZigbeeUtcSeconds() + getTimezoneOffsetSeconds();
  }

  get lastSetTime() {
    return this.time;
  }

  get validUntilTime() {
    return this.time + 86400;
  }
}

/**
 * BasicSilentBoundCluster — silently absorbs incoming Basic cluster (0x0000) frames.
 *
 * Registered via endpoint.bind('basic', new BasicSilentBoundCluster()) to
 * suppress "error while sending default error response" spam that occurs when
 * Tuya devices send unsolicited reportAttributes on cluster 0 during init and
 * the ZCL stack tries to ACK back to a device that is already unreachable.
 */
class BasicSilentBoundCluster extends BoundCluster {
  // No handlers — base class absorbs all incoming frames silently.
}

/**
 * SonoffTimeServerBoundCluster — extends TimeServerBoundCluster with DST attributes.
 *
 * Used by MINI-ZB1GP and similar Sonoff devices that request dstStart/dstEnd/dstShift
 * during Time cluster reads. Without these getters, zigbee-clusters logs
 * "not_implemented" for each missing attribute.
 */
class SonoffTimeServerBoundCluster extends TimeServerBoundCluster {
  get dstStart() {
    return 0;
  }

  get dstEnd() {
    return 0;
  }

  get dstShift() {
    return 0;
  }
}

module.exports = { TimeServerBoundCluster, SonoffTimeServerBoundCluster, BasicSilentBoundCluster };
