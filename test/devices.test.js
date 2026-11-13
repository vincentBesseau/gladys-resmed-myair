import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialFromDevice, buildStatesFromRecord } from '../src/devices.js';

// Minimal stand-in for gladys.externalIds(DEVICE_TYPE, serial).
const ids = { feature: (key) => `ext:sel:resmed-myair:SERIAL:${key}` };

test('serialFromDevice extracts the last segment', () => {
  assert.equal(serialFromDevice('ext:sel:resmed-myair:AB12345'), 'AB12345');
});

test('buildStatesFromRecord converts usage minutes to hours and maps fields', () => {
  const states = buildStatesFromRecord(ids, {
    totalUsage: 425,
    ahi: 3.2,
    leakPercentile: 12.5,
    sleepScore: 88,
    maskPairCount: 2,
  });
  const byId = Object.fromEntries(states.map((s) => [s.device_feature_external_id, s.state]));
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:usage'], 7.08); // 425 / 60
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:ahi'], 3.2);
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:mask-leak'], 12.5);
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:score'], 88);
  assert.equal(byId['ext:sel:resmed-myair:SERIAL:mask-events'], 2);
});

test('buildStatesFromRecord skips missing or non-numeric fields', () => {
  const states = buildStatesFromRecord(ids, { totalUsage: 60, sleepScore: null, ahi: undefined });
  const keys = states.map((s) => s.device_feature_external_id);
  assert.deepEqual(keys, ['ext:sel:resmed-myair:SERIAL:usage']);
  assert.equal(states[0].state, 1); // 60 min -> 1 h
});

test('buildStatesFromRecord returns no states for an empty record', () => {
  assert.deepEqual(buildStatesFromRecord(ids, {}), []);
});
