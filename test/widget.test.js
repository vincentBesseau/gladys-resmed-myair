import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWidgetContent, buildDisconnectedWidgetContent, WIDGET_KEY } from '../src/widget.js';

const byType = (components, type) => components.filter((c) => c.type === type);
const tileByLabel = (components, en) => byType(components, 'value').find((c) => c.label.en === en);

test('WIDGET_KEY matches the manifest key regex', () => {
  assert.match(WIDGET_KEY, /^[a-z0-9_]{2,32}$/);
});

test('buildWidgetContent maps the latest night to tiles with thresholds', () => {
  const content = buildWidgetContent([
    { startDate: '2026-11-10', totalUsage: 120, ahi: 20, sleepScore: 40 },
    { startDate: '2026-11-12', totalUsage: 425, ahi: 3.2, leakPercentile: 12.5, sleepScore: 88 },
  ]);
  assert.equal(content.version, 1);
  assert.ok(content.ttl_seconds >= 10);

  const caption = byType(content.components, 'text')[0];
  assert.match(caption.text.fr, /2026-11-12/); // latest night chosen

  const usage = tileByLabel(content.components, 'Usage');
  assert.equal(usage.value, 7.1); // 425 / 60, 1 decimal
  assert.equal(usage.color, 'success'); // >= 4h

  const ahi = tileByLabel(content.components, 'AHI');
  assert.equal(ahi.value, 3.2);
  assert.equal(ahi.color, 'success'); // < 5

  const leak = tileByLabel(content.components, 'Mask leak');
  assert.equal(leak.value, 12.5);

  const score = tileByLabel(content.components, 'Score');
  assert.equal(score.value, 88);
  assert.equal(score.color, 'success'); // >= 70
});

test('buildWidgetContent colors poor metrics as warning/danger', () => {
  const content = buildWidgetContent([
    { startDate: '2026-11-12', totalUsage: 90, ahi: 18, sleepScore: 45 },
  ]);
  assert.equal(tileByLabel(content.components, 'Usage').color, 'warning'); // < 4h
  assert.equal(tileByLabel(content.components, 'AHI').color, 'danger'); // >= 15
  assert.equal(tileByLabel(content.components, 'Score').color, 'danger'); // < 50
});

test('buildWidgetContent respects the content budget (<=6 tiles, <=8 components)', () => {
  const content = buildWidgetContent([
    { startDate: '2026-11-12', totalUsage: 425, ahi: 3, leakPercentile: 10, sleepScore: 88 },
  ]);
  assert.ok(byType(content.components, 'value').length <= 6);
  assert.ok(content.components.length <= 8);
});

test('buildWidgetContent returns an empty-state text when there is no record', () => {
  const content = buildWidgetContent([]);
  const text = byType(content.components, 'text')[0];
  assert.equal(text.variant, 'body');
  assert.match(text.text.fr, /Aucune donnée/);
  assert.equal(byType(content.components, 'value').length, 0);
});

test('buildDisconnectedWidgetContent returns a short-lived connect prompt', () => {
  const content = buildDisconnectedWidgetContent();
  assert.ok(content.ttl_seconds <= 600);
  assert.match(content.components[0].text.en, /Not connected/);
});
