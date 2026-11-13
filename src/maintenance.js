// -----------------------------------------------------------------------------
// Consumable maintenance tracking: remaining life of the replaceable filters,
// computed from a user-configured interval (calendar days) and the date each
// was last replaced. Exposed as Gladys MAINTENANCE / LIFE_REMAINING features
// (a percentage) the user can trigger a scene on ("life <= 10% -> notify me").
//
// Pure, network-free logic so it can be unit tested; the config read/write and
// state publishing happen in devices.js / index.js.
// -----------------------------------------------------------------------------

import { CONFIG_SCHEMA_KEYS, CONFIG_KEYS } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Default replacement interval (days) applied the first time an integration
// runs, so filter tracking works out of the box. The user can change it, or
// set 0 to disable, in the configuration.
export const DEFAULT_FILTER_INTERVAL_DAYS = 30;

// The consumables tracked. Each maps to a config interval key, a persisted
// "last replaced" date key, and the Gladys feature key.
export const FILTERS = [
  {
    id: 'device',
    featureKey: 'device-filter-life',
    labelEn: 'Device filter',
    labelFr: 'Filtre appareil',
    intervalConfigKey: CONFIG_SCHEMA_KEYS.DEVICE_FILTER_INTERVAL,
    replacedConfigKey: CONFIG_KEYS.DEVICE_FILTER_REPLACED_AT,
  },
  {
    id: 'mask',
    featureKey: 'mask-filter-life',
    labelEn: 'Mask filter',
    labelFr: 'Filtre masque',
    intervalConfigKey: CONFIG_SCHEMA_KEYS.MASK_FILTER_INTERVAL,
    replacedConfigKey: CONFIG_KEYS.MASK_FILTER_REPLACED_AT,
  },
];

/**
 * Resolve the configured replacement interval (days) of a filter.
 * @param {object} config - The integration config.
 * @param {object} filter - A FILTERS entry.
 * @returns {number} The interval in days, or 0 when tracking is disabled.
 * @example
 * intervalDaysFor({ device_filter_interval_days: 30 }, FILTERS[0]); // 30
 */
export function intervalDaysFor(config, filter) {
  const raw = Number(config[filter.intervalConfigKey]);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Interval defaults to persist for any filter never configured yet (its
 * interval key absent), so tracking is enabled out of the box. A filter the
 * user explicitly set (including to 0 = off) is left untouched.
 * @param {object} config - The integration config.
 * @returns {object} A partial config of interval keys to set, possibly empty.
 * @example
 * missingIntervalDefaults({}); // { device_filter_interval_days: 30, mask_filter_interval_days: 30 }
 */
export function missingIntervalDefaults(config) {
  const defaults = {};
  for (const filter of FILTERS) {
    const value = config[filter.intervalConfigKey];
    if (value === undefined || value === null || value === '') {
      defaults[filter.intervalConfigKey] = DEFAULT_FILTER_INTERVAL_DAYS;
    }
  }
  return defaults;
}

/**
 * Remaining life of a consumable as a percentage (0-100).
 * @param {number} replacedAtMs - Last replacement, ms since epoch.
 * @param {number} intervalDays - Replacement interval in days.
 * @param {number} nowMs - Current time, ms since epoch.
 * @returns {number|null} The percentage remaining, or null when disabled.
 * @example
 * lifeRemainingPercent(Date.parse('2026-11-01'), 30, Date.parse('2026-11-16')); // 50
 */
export function lifeRemainingPercent(replacedAtMs, intervalDays, nowMs) {
  if (!intervalDays || intervalDays <= 0) {
    return null;
  }
  const elapsedDays = (nowMs - replacedAtMs) / DAY_MS;
  return Math.max(0, Math.min(100, Math.round((1 - elapsedDays / intervalDays) * 100)));
}

/**
 * Compute the maintenance feature states to publish, initializing a filter's
 * "last replaced" date the first time it is enabled.
 * @param {object} ids - gladys.externalIds(DEVICE_TYPE, serial).
 * @param {object} config - The integration config.
 * @param {number} nowMs - Current time, ms since epoch.
 * @returns {{states: Array, datesToPersist: object}} The states to publish and
 *   any newly-initialized replacement dates to persist via setConfig.
 * @example
 * const { states, datesToPersist } = computeMaintenanceStates(ids, config, Date.now());
 */
export function computeMaintenanceStates(ids, config, nowMs) {
  const states = [];
  const datesToPersist = {};
  for (const filter of FILTERS) {
    const intervalDays = intervalDaysFor(config, filter);
    if (intervalDays <= 0) {
      continue;
    }
    let replacedAtMs = Date.parse(config[filter.replacedConfigKey]);
    if (!Number.isFinite(replacedAtMs)) {
      // First time this filter is tracked: baseline its life at "now".
      replacedAtMs = nowMs;
      datesToPersist[filter.replacedConfigKey] = new Date(nowMs).toISOString();
    }
    const life = lifeRemainingPercent(replacedAtMs, intervalDays, nowMs);
    if (life !== null) {
      states.push({ device_feature_external_id: ids.feature(filter.featureKey), state: life });
    }
  }
  return { states, datesToPersist };
}
