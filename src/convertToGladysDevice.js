// -----------------------------------------------------------------------------
// Convert a raw ResMed myAir device (from MyAirApiClient.getUserDeviceData)
// into a Gladys device with its read-only sleep-metric features.
//
// ResMed is READ-ONLY (every feature is read_only, polled once a day when the
// machine syncs). Gladys has no "sleep"/medical feature category, so these
// metrics use the generic UNKNOWN category with decimal/integer sensor types
// and, where one exists, a matching unit (usage in hours). The feature keys
// map directly to the myAir API fields - see src/devices.js pollDevice.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, POLL_FREQUENCY_IN_MS } from './constants.js';
import { FILTERS, intervalDaysFor } from './maintenance.js';

/**
 * Build a Gladys device from a raw ResMed myAir device.
 * @param {object} gladys - The Gladys SDK instance (for externalIds).
 * @param {object} device - A device from getUserDeviceData().
 * @param {object} [config] - The integration config (enables maintenance features).
 * @returns {object} The Gladys device, with prefixed external ids.
 * @example
 * convertToGladysDevice(gladys, device, config);
 */
export function convertToGladysDevice(gladys, device, config = {}) {
  const ids = gladys.externalIds(DEVICE_TYPE, device.serialNumber);
  const name = device.localizedName || device.deviceSeries || 'ResMed CPAP';

  const features = [
    {
      // totalUsage (minutes) is converted to hours in pollDevice.
      name: `${name} - Usage`,
      external_id: ids.feature('usage'),
      category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.HOURS,
      min: 0,
      max: 24,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      // Apnea-Hypopnea Index (events per hour). No matching Gladys unit.
      name: `${name} - AHI (events/h)`,
      external_id: ids.feature('ahi'),
      category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      // leakPercentile, reported in L/min. No matching Gladys unit.
      name: `${name} - Mask leak (L/min)`,
      external_id: ids.feature('mask-leak'),
      category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      min: 0,
      max: 200,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      // myAir score out of 100.
      name: `${name} - myAir score`,
      external_id: ids.feature('score'),
      category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      // maskPairCount: how many times the mask was put on during the night.
      name: `${name} - Mask on/off count`,
      external_id: ids.feature('mask-events'),
      category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  // Consumable maintenance: one "life remaining" (%) feature per enabled filter.
  // The user triggers a scene on it ("life <= 10% -> replace the filter").
  for (const filter of FILTERS) {
    if (intervalDaysFor(config, filter) > 0) {
      features.push({
        name: `${name} - ${filter.labelEn}`,
        external_id: ids.feature(filter.featureKey),
        category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
        type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });
    }
  }

  return {
    name,
    external_id: ids.device,
    model: device.deviceSeries || device.deviceFamily || undefined,
    // Polled (see src/devices.js): myAir has no push mechanism and the machine
    // syncs roughly once a day (see POLL_FREQUENCY_IN_MS in constants.js).
    should_poll: true,
    poll_frequency: POLL_FREQUENCY_IN_MS,
    features,
  };
}
