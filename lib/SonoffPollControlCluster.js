'use strict';

const { Cluster, PollControlCluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * SonoffPollControlCluster - Poll Control (0x0020) with the check-in commands
 * zigbee-clusters' built-in PollControlCluster leaves out.
 *
 * Sniffer (iHost pairing an SNZB-04PR2, fw 1.0.1): checkInInterval 14400
 * quarter-seconds (1 h), longPollInterval 6480 (27 min), shortPollInterval 1.
 * The device sends checkIn (0x00, server->client) every checkInInterval;
 * the client answers checkInResponse (0x00, client->server). Same command id
 * in both directions, so each declares its direction (as iasZone does).
 */
class SonoffPollControlCluster extends PollControlCluster {

  static get COMMANDS() {
    return {
      ...super.COMMANDS,
      checkIn: {
        id: 0x00,
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
      },
      checkInResponse: {
        id: 0x00,
        direction: Cluster.DIRECTION_CLIENT_TO_SERVER,
        args: {
          startFastPolling: ZCLDataTypes.bool,
          fastPollTimeout: ZCLDataTypes.uint16,
        },
      },
    };
  }

}

module.exports = SonoffPollControlCluster;
