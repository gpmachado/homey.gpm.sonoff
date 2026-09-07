'use strict';

/**
 * App Settings API — rejoin stats only (device_rejoined tracking).
 * Only MINI-ZBD / ZBMINIR2 (the drivers with rejoin detection) ever have
 * rejoin_count set, so those are the only devices returned.
 */
module.exports = {
  async getRejoinStats({ homey }) {
    const rejoinSince = homey.settings.get('rejoin_tracking_since') || null;
    const drivers = homey.drivers.getDrivers();
    const rows = [];

    for (const [driverId, driver] of Object.entries(drivers)) {
      for (const device of driver.getDevices()) {
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
    }

    return rows;
  },

  async resetRejoinStats({ homey }) {
    const drivers = homey.drivers.getDrivers();
    const writes = [];

    for (const driver of Object.values(drivers)) {
      for (const device of driver.getDevices()) {
        if (device.getStoreValue?.('rejoin_count') !== undefined) {
          writes.push(device.setStoreValue('rejoin_count', 0));
          writes.push(device.setStoreValue('rejoin_last_at', null));
        }
      }
    }

    await Promise.allSettled(writes);
    homey.settings.set('rejoin_tracking_since', Date.now());

    return { since: homey.settings.get('rejoin_tracking_since') };
  },
};
