import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTERS,
  intervalDaysFor,
  lifeRemainingPercent,
  computeMaintenanceStates,
  missingIntervalDefaults,
  DEFAULT_FILTER_INTERVAL_DAYS,
} from '../src/maintenance.js';

const DAY = 24 * 60 * 60 * 1000;
const ids = { feature: (key) => `ext:sel:resmed-myair:SERIAL:${key}` };

test('intervalDaysFor reads the interval and treats <=0 / invalid as disabled', () => {
  const device = FILTERS[0];
  assert.equal(intervalDaysFor({ [device.intervalConfigKey]: 30 }, device), 30);
  assert.equal(intervalDaysFor({ [device.intervalConfigKey]: 0 }, device), 0);
  assert.equal(intervalDaysFor({ [device.intervalConfigKey]: -5 }, device), 0);
  assert.equal(intervalDaysFor({}, device), 0);
});

test('lifeRemainingPercent counts down linearly and clamps 0-100', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(lifeRemainingPercent(now, 30, now), 100); // just replaced
  assert.equal(lifeRemainingPercent(now - 15 * DAY, 30, now), 50); // halfway
  assert.equal(lifeRemainingPercent(now - 30 * DAY, 30, now), 0); // due
  assert.equal(lifeRemainingPercent(now - 45 * DAY, 30, now), 0); // overdue -> clamped
  assert.equal(lifeRemainingPercent(now, 0, now), null); // disabled
});

test('computeMaintenanceStates emits a state per enabled filter', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const config = {
    [FILTERS[0].intervalConfigKey]: 30,
    [FILTERS[0].replacedConfigKey]: new Date(now - 15 * DAY).toISOString(),
    [FILTERS[1].intervalConfigKey]: 30,
    [FILTERS[1].replacedConfigKey]: new Date(now - 30 * DAY).toISOString(),
  };
  const { states, datesToPersist } = computeMaintenanceStates(ids, config, now);
  const byId = Object.fromEntries(states.map((s) => [s.device_feature_external_id, s.state]));
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:device-filter-life'], 50);
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:mask-filter-life'], 0);
  assert.deepEqual(datesToPersist, {}); // both already had a date
});

test('computeMaintenanceStates initializes a missing replacement date to now', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const config = { [FILTERS[0].intervalConfigKey]: 30 }; // enabled, never replaced
  const { states, datesToPersist } = computeMaintenanceStates(ids, config, now);
  assert.equal(states[0].state, 100); // baselined at now
  assert.equal(datesToPersist[FILTERS[0].replacedConfigKey], new Date(now).toISOString());
});

test('computeMaintenanceStates skips disabled filters', () => {
  const now = Date.now();
  const config = { [FILTERS[0].intervalConfigKey]: 0, [FILTERS[1].intervalConfigKey]: 0 };
  const { states } = computeMaintenanceStates(ids, config, now);
  assert.deepEqual(states, []);
});

test('missingIntervalDefaults fills only never-configured filters', () => {
  assert.deepEqual(missingIntervalDefaults({}), {
    [FILTERS[0].intervalConfigKey]: DEFAULT_FILTER_INTERVAL_DAYS,
    [FILTERS[1].intervalConfigKey]: DEFAULT_FILTER_INTERVAL_DAYS,
  });
  // A filter the user explicitly disabled (0) is left untouched.
  assert.deepEqual(missingIntervalDefaults({ [FILTERS[0].intervalConfigKey]: 0 }), {
    [FILTERS[1].intervalConfigKey]: DEFAULT_FILTER_INTERVAL_DAYS,
  });
  assert.deepEqual(
    missingIntervalDefaults({
      [FILTERS[0].intervalConfigKey]: 15,
      [FILTERS[1].intervalConfigKey]: 45,
    }),
    {},
  );
});
