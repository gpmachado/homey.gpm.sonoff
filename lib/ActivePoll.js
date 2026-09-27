'use strict';

/**
 * Periodic Basic-cluster read (zclVersion - universal, cheap) whose result feeds
 * device._availability as an explicit activity signal. For devices with no
 * frequent traffic of their own (ZBMINIR2, SNZB-06P, dongles/repeaters).
 *
 * - Every 20 min while available, and skipped when the device was heard from in the last half
 *   interval. It does not speed up detection of a lost device (that is the watchdog's poll
 *   before offline, and the send-failure hook), it only keeps last seen fresh. At 5 min it was
 *   about 24% of all frames received on a network with 21 ZBMINIR2.
 * - Random start offset within one interval, so devices initialised together at
 *   boot don't all poll in the same instant.
 * - Exponential backoff while unavailable (same idea as the nova.digital smart
 *   plugs): the first probe comes after `offlineIntervalMs`, then the delay doubles
 *   after every failed probe up to `offlineMaxMs`. That recovers quickly after a
 *   short outage or replug and probes a permanently dead device only every
 *   `offlineMaxMs`. Back to `intervalMs` as soon as the device is available.
 */
class ActivePoll {

  constructor(device, {
    intervalMs = 20 * 60 * 1000,
    offlineIntervalMs = 60 * 1000,
    offlineMaxMs = 15 * 60 * 1000,
  } = {}) {
    this.device = device;
    this.intervalMs = intervalMs;
    this.offlineIntervalMs = offlineIntervalMs;
    this.offlineMaxMs = offlineMaxMs;
    this._started = false;
    this._generation = 0; // a chain only reschedules while it is the current one
    this._timer = null;
    this._offlineDelay = null;
  }

  start() {
    if (this._started) return; // already running (re-init guard, holds during a poll too)
    this._started = true;
    this._schedule(Math.floor(Math.random() * this.intervalMs), ++this._generation);
  }

  stop() {
    this._started = false;
    this._generation += 1;
    if (this._timer) {
      this.device.homey.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _poll() {
    const device = this.device;
    if (!device.zclNode) return;
    // Recently heard from (a report, a command answer, another poll): nothing to prove. Never
    // skipped while unavailable, where the poll is what notices the device coming back.
    if (device.getAvailable()) {
      const lastSeen = device._availability?.getLastSeen?.();
      if (lastSeen && Date.now() - lastSeen.getTime() < this.intervalMs / 2) return;
    }
    try {
      await device.zclNode.endpoints[1].clusters.basic.readAttributes(['zclVersion']);
      device._availability?.notifyActivity('active-poll');
    } catch (err) {
      device.log('[Active poll] failed:', err.message);
    }
  }

  _nextDelay() {
    if (this.device.getAvailable()) {
      this._offlineDelay = null;
      return this.intervalMs;
    }
    this._offlineDelay = this._offlineDelay === null
      ? this.offlineIntervalMs
      : Math.min(this._offlineDelay * 2, this.offlineMaxMs);
    return this._offlineDelay;
  }

  _schedule(delay, generation) {
    this._timer = this.device.homey.setTimeout(async () => {
      this._timer = null;
      await this._poll();
      if (this._started && generation === this._generation) {
        this._schedule(this._nextDelay(), generation);
      }
    }, delay);
  }
}

module.exports = ActivePoll;
