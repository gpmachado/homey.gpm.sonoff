'use strict';

/**
 * App Settings API.
 *
 * getMessageStats/resetMessageStats cover devices with an AvailabilityManager
 * installed (see lib/AvailabilityManager.js) - one row per physical Zigbee
 * node, since multi-gang drivers install it on the main/EP1 device only.
 * Battery sensors without a heartbeat (SNZB-04P, SNZB-03...) have none, so the
 * response also carries the total of installed physical devices to tell the
 * two counts apart: { devices: [...rows], totalDevices }.
 *
 * getRejoinStats/resetRejoinStats cover devices with rejoin detection
 * (see lib/RejoinManager.js) independently - a device can have one, both,
 * or neither, so these stay separate endpoints/tabs.
 *
 * getAvailabilitySetting/setAvailabilitySetting cover the app-wide on/off switch
 * (see lib/AvailabilityManager.js, "Global on/off switch") - turning it off also
 * force-restores every device that is currently unavailable, in the same pass.
 */
const { AVAILABILITY_ENABLED_SETTING_KEY } = require('./lib/constants');

/**
 * Every installed device across every driver, paired with the id of the driver that owns it.
 * The one iteration every endpoint below needs - each just filters/maps differently.
 * @param {object} homey
 * @yields {{ driverId: string, device: object }}
 */
function* allDevices(homey) {
  for (const [driverId, driver] of Object.entries(homey.drivers.getDrivers())) {
    for (const device of driver.getDevices()) {
      yield { driverId, device };
    }
  }
}

module.exports = {
  async getMessageStats({ homey }) {
    const rowsByPhysicalDevice = new Map();
    const allPhysicalIds = new Set();

    for (const { driverId, device } of allDevices(homey)) {
      const data = device.getData?.() || {};
      const settings = device.getSettings?.() || {};
      const physicalId = data.ieeeAddress
        || settings.zb_ieee_address
        || device.getId();
      allPhysicalIds.add(physicalId);

      const manager = device._availability;
      if (!manager || typeof manager.getMessageStats !== 'function') continue;

      const fullStats = manager.getMessageStats();
      const stats = {
        mode: fullStats.mode,
        currentHour: fullStats.currentHour,
        previousHour: fullStats.previousHour,
        last24h: fullStats.last24h,
        lastMessageAt: fullStats.lastMessageAt,
        bySource: fullStats.bySource,
      };

      const row = {
        id: device.getId(),
        physicalId,
        endpoint: 1,
        name: device.getName(),
        zone: device.getZone?.()?.getName?.() || '',
        driverId,
        modelId: data.modelId || settings.zb_product_id || '',
        manufacturerName:
          data.manufacturerName || settings.zb_manufacturer_name || '',
        available: device.getAvailable(),
        stats,
      };

      const existing = rowsByPhysicalDevice.get(physicalId);
      const isMain = !data.subDeviceId;
      if (!existing || (isMain && existing.isSubDevice)) {
        rowsByPhysicalDevice.set(physicalId, {
          ...row,
          isSubDevice: Boolean(data.subDeviceId),
        });
      }
    }

    return {
      devices: Array.from(rowsByPhysicalDevice.values())
        .map(({ isSubDevice, ...row }) => row),
      totalDevices: allPhysicalIds.size,
    };
  },

  async resetMessageStats({ homey }) {
    const managers = new Set();

    for (const { device } of allDevices(homey)) {
      const manager = device._availability;
      if (manager && typeof manager.resetMessageStats === 'function') {
        managers.add(manager);
      }
    }

    const results = await Promise.allSettled(
      Array.from(managers, manager => manager.resetMessageStats()),
    );
    const failures = results.filter(result => result.status === 'rejected');

    if (failures.length > 0) {
      throw new Error(
        `Failed to reset ${failures.length} of ${results.length} statistics counters`,
      );
    }

    return { reset: results.length };
  },

  async getRejoinStats({ homey }) {
    const rejoinSince = homey.settings.get('rejoin_tracking_since') || null;
    const rows = [];

    for (const { driverId, device } of allDevices(homey)) {
      const rejoinCount = device.getStoreValue?.('rejoin_count');
      if (rejoinCount === undefined) continue;

      rows.push({
        id: device.getId(),
        name: device.getName(),
        driverId,
        rejoinCount: rejoinCount ?? 0,
        rejoinLastAt: device.getStoreValue?.('rejoin_last_at') ?? null,
        rejoinSince,
      });
    }

    return rows;
  },

  async resetRejoinStats({ homey }) {
    const writes = [];

    for (const { device } of allDevices(homey)) {
      if (device.getStoreValue?.('rejoin_count') !== undefined) {
        writes.push(device.setStoreValue('rejoin_count', 0));
        writes.push(device.setStoreValue('rejoin_last_at', null));
      }
    }

    const results = await Promise.allSettled(writes);
    const failures = results.filter(result => result.status === 'rejected');

    if (failures.length > 0) {
      throw new Error(
        `Failed to reset ${failures.length} of ${results.length} rejoin counters`,
      );
    }

    homey.settings.set('rejoin_tracking_since', Date.now());

    return { since: homey.settings.get('rejoin_tracking_since') };
  },

  async getAvailabilitySetting({ homey }) {
    return { enabled: homey.settings.get(AVAILABILITY_ENABLED_SETTING_KEY) !== false };
  },

  /**
   * body.enabled must be an actual boolean - not truthy/falsy-coerced - so a client that
   * serializes booleans as strings ({"enabled":"false"}) gets a clear error instead of
   * silently having its intent inverted (Boolean("false") === true), and a missing/malformed
   * body errors instead of silently taking the "disable everything" branch.
   */
  async setAvailabilitySetting({ homey, body }) {
    if (typeof body?.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    const enabled = body.enabled;
    homey.settings.set(AVAILABILITY_ENABLED_SETTING_KEY, enabled);
    // Unconditional: this is the only confirmation in the log that the toggle was
    // received at all - _isGloballyEnabled()'s own gates are silent by design (they
    // only skip a "mark unavailable" that may never happen during a quick test).
    homey.log(`[Availability] Global switch turned ${enabled ? 'on' : 'off'}`);

    // Force-restore every device that is currently unavailable: turning the switch off
    // means "no device should be marked unavailable by timeout", which includes ones the
    // watchdog already caught before this call. The setting above is already persisted
    // regardless of how this part goes - a partial restore failure is reported back as
    // `restoreFailures` instead of throwing, so the caller never has to guess whether the
    // setting itself took effect from an error alone (see settings/index.html).
    let restoreFailures = 0;
    if (!enabled) {
      const restores = [];
      for (const { device } of allDevices(homey)) {
        const manager = device._availability;
        if (manager && typeof manager.markAvailable === 'function' && !device.getAvailable()) {
          restores.push(manager.markAvailable());
        }
      }

      if (restores.length > 0) {
        homey.log(`[Availability] Restoring ${restores.length} device(s) that were unavailable`);
      }

      const results = await Promise.allSettled(restores);
      restoreFailures = results.filter(result => result.status === 'rejected').length;
      if (restoreFailures > 0) {
        homey.error(
          `[Availability] Switch turned off, but failed to restore ${restoreFailures} of ${results.length} devices`,
        );
      }
    }

    return { enabled, restoreFailures };
  },
};
