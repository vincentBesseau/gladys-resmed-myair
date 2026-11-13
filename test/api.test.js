import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSleepRecord } from '../src/MyAirApiClient.js';

test('latestSleepRecord returns the record with the most recent startDate', () => {
  const records = [
    { startDate: '2026-11-10', sleepScore: 70 },
    { startDate: '2026-11-12', sleepScore: 90 },
    { startDate: '2026-11-11', sleepScore: 80 },
  ];
  assert.equal(latestSleepRecord(records).sleepScore, 90);
});

test('latestSleepRecord returns null for an empty or invalid list', () => {
  assert.equal(latestSleepRecord([]), null);
  assert.equal(latestSleepRecord(undefined), null);
});

test('latestSleepRecord handles a single record', () => {
  assert.equal(latestSleepRecord([{ startDate: '2026-11-12', sleepScore: 55 }]).sleepScore, 55);
});
