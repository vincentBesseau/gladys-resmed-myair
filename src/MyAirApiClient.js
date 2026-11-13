// -----------------------------------------------------------------------------
// ResMed myAir data access (AWS AppSync GraphQL).
//
// Two operations, ported from the reference Home Assistant component:
//   - getUserDeviceData(): the account's flow-generator (CPAP) device, plus
//     its current mask code.
//   - getSleepRecords(): the last ~30 nights of therapy data (usage, AHI, mask
//     leak, myAir score...).
//
// The bearer token can expire between polls; an "unauthorized" GraphQL error
// triggers a single silent re-authentication + retry (which stays silent as
// long as the remembered-device cookie is valid - see MyAirAuthClient).
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { httpFetch } from './httpClient.js';

/** Raised when myAir rejects the session and a re-auth did not recover it. */
export class StaleSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleSessionError';
  }
}

/** Format a Date as a local `YYYY-MM-DD` string. */
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class MyAirApiClient {
  constructor(auth) {
    this._auth = auth;
  }

  /**
   * Run a GraphQL operation, re-authenticating once if the session is rejected.
   * @param {string} operationName - The GraphQL operation name.
   * @param {string} query - The GraphQL document.
   * @returns {Promise<object>} The decoded `data` object.
   */
  async _query(operationName, query) {
    try {
      return await this._rawQuery(operationName, query);
    } catch (e) {
      if (!(e instanceof StaleSessionError)) {
        throw e;
      }
      logger.info('ResMed myAir: session expired, re-authenticating.');
      // Re-auth without emailing a new code: this only recovers while the
      // remembered device is still valid; otherwise it raises and the caller
      // surfaces the "reconnect" state.
      await this._auth.ensureAuthenticated({ allowMfaEmail: false });
      return this._rawQuery(operationName, query);
    }
  }

  async _rawQuery(operationName, query) {
    const response = await httpFetch(this._auth.graphqlUrl, {
      method: 'POST',
      headers: this._auth.graphqlHeaders(),
      body: JSON.stringify({ operationName, variables: {}, query }),
    });
    const body = await response.json();
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const info = body.errors[0].errorInfo;
      const message = info
        ? `${info.errorType}: ${info.errorCode}`
        : body.errors[0].message || JSON.stringify(body.errors[0]);
      if (info?.errorType === 'unauthorized') {
        throw new StaleSessionError(`myAir unauthorized on ${operationName}: ${message}`);
      }
      throw new Error(`myAir GraphQL error on ${operationName}: ${message}`);
    }
    if (!body.data) {
      throw new StaleSessionError(`myAir returned no data on ${operationName}.`);
    }
    return body.data;
  }

  /**
   * Fetch the account's CPAP device and current mask code.
   * @returns {Promise<object>} `{ serialNumber, localizedName, deviceSeries,
   *   deviceFamily, lastSleepDataReportTime, fgDeviceManufacturerName,
   *   maskCode }`.
   */
  async getUserDeviceData() {
    const query = `query getPatientWrapper {
      getPatientWrapper {
        masks {
          maskCode
        }
        fgDevices {
          serialNumber
          localizedName
          deviceSeries
          deviceFamily
          lastSleepDataReportTime
          fgDeviceManufacturerName
          fgDevicePatientId
        }
      }
    }`;
    const data = await this._query('getPatientWrapper', query);
    const wrapper = data.getPatientWrapper;
    const device = wrapper?.fgDevices?.[0];
    if (!device) {
      throw new Error('No ResMed device found on this myAir account.');
    }
    const maskCode = wrapper?.masks?.find((mask) => mask?.maskCode)?.maskCode || null;
    return { ...device, maskCode };
  }

  /**
   * Fetch the last ~30 nights of sleep records (newest last, as returned).
   * @returns {Promise<Array<object>>} The `sleepRecords.items` array.
   */
  async getSleepRecords() {
    const today = new Date();
    const oneMonthAgo = new Date(today);
    oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
    const query = `query GetPatientSleepRecords {
      getPatientWrapper {
        sleepRecords(startMonth: "${isoDate(oneMonthAgo)}", endMonth: "${isoDate(today)}") {
          items {
            startDate
            totalUsage
            sleepScore
            usageScore
            ahiScore
            maskScore
            leakScore
            ahi
            maskPairCount
            leakPercentile
            sleepRecordPatientId
            __typename
          }
          __typename
        }
        __typename
      }
    }`;
    const data = await this._query('GetPatientSleepRecords', query);
    const items = data.getPatientWrapper?.sleepRecords?.items;
    if (!Array.isArray(items)) {
      throw new Error('Unexpected sleep records payload from myAir.');
    }
    return items;
  }
}

/**
 * Pick the most recent sleep record from a list (by startDate).
 * @param {Array<object>} records - The sleep records.
 * @returns {object|null} The latest record, or null when the list is empty.
 * @example
 * latestSleepRecord([{ startDate: '2026-11-10' }, { startDate: '2026-11-12' }]);
 */
export function latestSleepRecord(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }
  return records.reduce((latest, record) =>
    record.startDate > latest.startDate ? record : latest,
  );
}
