// -----------------------------------------------------------------------------
// Device orchestration: discovery and the polled nightly state.
//
// External ids are `ext:<selector>:resmed-myair:<serialNumber>` for the device
// and `...:<serialNumber>:<featureKey>` for a feature. ResMed serial numbers
// never contain ':'.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { convertToGladysDevice } from './convertToGladysDevice.js';
import { latestSleepRecord } from './MyAirApiClient.js';
import { computeMaintenanceStates, missingIntervalDefaults } from './maintenance.js';
import { DEVICE_TYPE, MINUTES_PER_HOUR } from './constants.js';

/**
 * Extract the ResMed serial number from a device external_id.
 * @param {string} deviceExternalId - The device external id.
 * @returns {string} The serial number (last segment).
 * @example
 * serialFromDevice('ext:sel:resmed-myair:SERIAL'); // 'SERIAL'
 */
export function serialFromDevice(deviceExternalId) {
  const parts = deviceExternalId.split(':');
  return parts[parts.length - 1];
}

/**
 * Discover the account's CPAP device and build the Gladys device to publish.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {import('./MyAirApiClient.js').MyAirApiClient} apiClient - The API client.
 * @returns {Promise<Array>} The Gladys devices to publish (one entry).
 * @example
 * const devices = await buildDiscoveredDevices(gladys, apiClient);
 */
export async function buildDiscoveredDevices(gladys, apiClient) {
  const device = await apiClient.getUserDeviceData();
  logger.info(
    `ResMed myAir: device "${device.localizedName || device.deviceSeries}", last sleep data report: ${device.lastSleepDataReportTime || 'never'}`,
  );
  const config = (await gladys.getConfig()) || {};
  // Apply default filter intervals on first run so maintenance works out of the
  // box (without re-saving the config form, which would clear the password).
  const defaults = missingIntervalDefaults(config);
  if (Object.keys(defaults).length > 0) {
    await gladys.setConfig(defaults);
    Object.assign(config, defaults);
  }
  return [convertToGladysDevice(gladys, device, config)];
}

/**
 * Map the latest sleep record to Gladys feature states.
 * @param {object} ids - The result of gladys.externalIds(DEVICE_TYPE, serial).
 * @param {object} record - The latest sleep record.
 * @returns {Array<object>} The states to publish.
 */
export function buildStatesFromRecord(ids, record) {
  const states = [];
  const push = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  };
  if (typeof record.totalUsage === 'number') {
    // totalUsage is in minutes; expose hours, rounded to two decimals.
    push('usage', Math.round((record.totalUsage / MINUTES_PER_HOUR) * 100) / 100);
  }
  push('ahi', record.ahi);
  push('mask-leak', record.leakPercentile);
  push('score', record.sleepScore);
  push('mask-events', record.maskPairCount);
  return states;
}

/**
 * Poll and publish the latest night's state of a device.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {import('./MyAirApiClient.js').MyAirApiClient} apiClient - The API client.
 * @param {object} device - The Gladys device being polled (onPoll payload).
 * @returns {Promise<void>} Resolves once published.
 * @example
 * await pollDevice(gladys, apiClient, device);
 */
export async function pollDevice(gladys, apiClient, device) {
  const serial = serialFromDevice(device.external_id);
  const ids = gladys.externalIds(DEVICE_TYPE, serial);
  const states = [];

  // Nightly sleep metrics (from the cloud).
  try {
    const records = await apiClient.getSleepRecords();
    logger.info(`ResMed myAir: fetched ${records.length} sleep record(s) for the last 30 days.`);
    const record = latestSleepRecord(records);
    if (record) {
      states.push(...buildStatesFromRecord(ids, record));
    } else {
      logger.info('ResMed myAir: no sleep record available yet.');
    }
  } catch (e) {
    logger.debug(`ResMed myAir: unable to fetch sleep records for ${device.name}: ${e.message}`);
  }

  // Consumable maintenance (local, time-based — published even with no night).
  const config = (await gladys.getConfig()) || {};
  const { states: maintenanceStates, datesToPersist } = computeMaintenanceStates(
    ids,
    config,
    Date.now(),
  );
  if (Object.keys(datesToPersist).length > 0) {
    await gladys.setConfig(datesToPersist);
  }
  states.push(...maintenanceStates);

  if (states.length > 0) {
    await gladys.publishStates(states);
  }
}
