'use strict';

const { Cluster } = require('zigbee-clusters');

/**
 * @file clusterRegistry.js
 * @description Registers custom Zigbee clusters once at app startup.
 *
 * Calling Cluster.addCluster() in individual device files causes redundant
 * global re-registration on every driver load. Centralizing here ensures
 * each cluster is registered exactly once regardless of how many drivers use it.
 *
 * Usage: call registerCustomClusters() in app.js onInit().
 */

let _registered = false;

/**
 * Register all custom clusters. Safe to call multiple times (idempotent).
 * Must be called before any ZigBeeDevice initializes.
 */
function registerCustomClusters() {
  if (_registered) return;
  _registered = true;

  const SonoffCluster = require('./SonoffCluster');

  Cluster.addCluster(SonoffCluster);
}

module.exports = { registerCustomClusters };
