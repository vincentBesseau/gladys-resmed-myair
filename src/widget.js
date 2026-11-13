// -----------------------------------------------------------------------------
// Dashboard widget "Last night": the most recent night's CPAP metrics as a
// row of tiles (usage, AHI, mask leak, myAir score), following Gladys' declara-
// tive widget content vocabulary (capabilities/dashboard-widgets.md).
//
// The integration describes WHAT to show (typed components, semantic colors);
// Gladys decides HOW to render it. No HTML/CSS/colors of our own.
// -----------------------------------------------------------------------------

import { MINUTES_PER_HOUR } from './constants.js';
import { latestSleepRecord } from './MyAirApiClient.js';

export const WIDGET_KEY = 'last_night';

/** Round to `digits` decimals. */
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Build the widget content for the latest night from a list of sleep records.
 * @param {Array<object>} records - The sleep records (as getSleepRecords returns).
 * @returns {object} A Gladys widget content tree ({ version, ttl_seconds, components }).
 * @example
 * buildWidgetContent([{ startDate: '2026-11-12', totalUsage: 420, ahi: 3, sleepScore: 88 }]);
 */
export function buildWidgetContent(records) {
  const record = latestSleepRecord(records);
  if (!record) {
    return {
      version: 1,
      ttl_seconds: 3600,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: {
            en: 'No sleep data in the last 30 days.',
            fr: 'Aucune donnée de sommeil sur les 30 derniers jours.',
          },
        },
      ],
    };
  }

  const components = [];
  if (record.startDate) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: { en: `Night of ${record.startDate}`, fr: `Nuit du ${record.startDate}` },
    });
  }
  if (typeof record.totalUsage === 'number') {
    const hours = round(record.totalUsage / MINUTES_PER_HOUR, 1);
    components.push({
      type: 'value',
      label: { en: 'Usage', fr: 'Usage' },
      value: hours,
      unit: { en: 'h', fr: 'h' },
      icon: 'clock',
      // 4h is the usual CPAP compliance threshold.
      color: hours >= 4 ? 'success' : 'warning',
    });
  }
  if (typeof record.ahi === 'number') {
    components.push({
      type: 'value',
      label: { en: 'AHI', fr: 'IAH' },
      value: round(record.ahi, 1),
      unit: { en: '/h', fr: '/h' },
      icon: 'activity',
      color: record.ahi < 5 ? 'success' : record.ahi < 15 ? 'warning' : 'danger',
    });
  }
  if (typeof record.leakPercentile === 'number') {
    components.push({
      type: 'value',
      label: { en: 'Mask leak', fr: 'Fuite' },
      value: round(record.leakPercentile, 1),
      unit: { en: 'L/min', fr: 'L/min' },
      icon: 'wind',
    });
  }
  if (typeof record.sleepScore === 'number') {
    components.push({
      type: 'value',
      label: { en: 'Score', fr: 'Score' },
      value: record.sleepScore,
      unit: { en: '/100', fr: '/100' },
      icon: 'award',
      color: record.sleepScore >= 70 ? 'success' : record.sleepScore >= 50 ? 'warning' : 'danger',
    });
  }
  return { version: 1, ttl_seconds: 3600, components };
}

/**
 * Widget content shown when the integration is not connected to myAir.
 * @returns {object} A Gladys widget content tree.
 * @example
 * buildDisconnectedWidgetContent();
 */
export function buildDisconnectedWidgetContent() {
  return {
    version: 1,
    ttl_seconds: 300,
    components: [
      {
        type: 'text',
        variant: 'body',
        text: {
          en: 'Not connected. Set up myAir in the integration configuration.',
          fr: "Non connecté. Configurez myAir dans la configuration de l'intégration.",
        },
      },
    ],
  };
}
