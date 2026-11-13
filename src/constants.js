// -----------------------------------------------------------------------------
// ResMed myAir integration constants.
//
// ResMed publishes no official API. Everything here is reverse-engineered from
// the myAir web app, cross-checked against the actively maintained Home
// Assistant custom component (the reference for the Okta + AppSync flow below)
// as of November 2026:
//   - https://github.com/Snuffy2/resmed_myair_sensors
//   - https://github.com/prestomation/resmed_myair_sensors (the original)
// This API is UNOFFICIAL: ResMed can change it at any time. If login or data
// retrieval ever starts failing, those projects are the first place to check
// for what changed.
//
// Auth model (identical for both regions, EU and North America): myAir sits
// behind Okta. We run Okta's OAuth2 authorization-code + PKCE flow ourselves
// (username/password -> optional email MFA -> session token -> access token),
// then call ResMed's AWS AppSync GraphQL endpoint with that bearer token. A
// remembered-device cookie ("DT") lets subsequent logins skip the email MFA.
// See MyAirAuthClient.js for the full flow.
// -----------------------------------------------------------------------------

export const DEVICE_TYPE = 'resmed-myair';

// Okta primary-authentication status strings.
export const AUTHN_SUCCESS = 'SUCCESS';
export const AUTH_NEEDS_MFA = 'MFA_REQUIRED';

// Gladys only accepts a fixed set of device poll frequencies, the slowest being
// one minute (core's DEVICE_POLL_FREQUENCIES). ResMed syncs to the cloud only
// ~once a day, so polling every minute would be wasteful and could trip abuse
// detection. We therefore register at the 1-minute frequency Gladys requires
// but throttle the actual cloud fetch to REFRESH_INTERVAL_MS inside onPoll.
export const POLL_FREQUENCY_IN_MS = 60 * 1000;

// How often we actually hit the myAir cloud (independent of Gladys' 1-minute
// poll tick above). The nightly data changes at most once a day.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Minutes of therapy per hour, used to convert the API's `totalUsage`
// (reported in minutes) into the hours we expose to Gladys.
export const MINUTES_PER_HOUR = 60;

// -----------------------------------------------------------------------------
// Region endpoints and client identifiers. These are fixed protocol constants
// baked into the myAir web app (not secrets) - every client must send them
// verbatim. Ported from the reference component's regions.py.
// -----------------------------------------------------------------------------

// @typedef RegionConfig
// @property {string} product           - `rmdproduct` header value.
// @property {string} oktaUrl            - Okta host for this region.
// @property {string} emailFactorId      - Default Okta email MFA factor id.
// @property {string} authServerId       - Okta custom auth-server id.
// @property {string} authorizeClientId  - Okta OAuth client id.
// @property {string} myairApiKey        - AppSync `x-api-key`.
// @property {string} graphqlUrl         - AppSync GraphQL endpoint.
// @property {string} oauthRedirectUrl   - OAuth redirect uri (must match Okta).

export const REGIONS = {
  EU: {
    product: 'myAir EU',
    oktaUrl: 'id.resmed.eu',
    emailFactorId: 'emfg9cmjqxEPr52cT417',
    authServerId: 'aus2uznux2sYKTsEg417',
    authorizeClientId: '0oa2uz04d2Pks2NgR417',
    myairApiKey: 'da2-o66oo6xdnfh5hlfuw5yw5g2dtm',
    graphqlUrl: 'https://graphql.hyperdrive.resmed.eu/graphql',
    oauthRedirectUrl: 'https://myair.resmed.eu',
  },
  NA: {
    product: 'myAir',
    oktaUrl: 'resmed-ext-1.okta.com',
    // Email MFA is not currently used in North America (accounts there usually
    // authenticate without an MFA challenge); kept as a non-empty placeholder
    // so the MFA url builder never produces an obviously broken path.
    emailFactorId: 'xxx',
    authServerId: 'aus4ccsxvnidQgLmA297',
    authorizeClientId: '0oa4ccq1v413ypROi297',
    myairApiKey: 'da2-cenztfjrezhwphdqtwtbpqvzui',
    graphqlUrl: 'https://graphql.myair-prd.dht.live/graphql',
    oauthRedirectUrl: 'https://myair.resmed.com',
  },
};

/**
 * Resolve a region code (as stored in the integration config) to its endpoint
 * settings, with a derived set of fully-qualified Okta URLs.
 * @param {string} region - 'EU' or 'NA'.
 * @returns {object} The region config plus `authnUrl`, `authorizeUrl`,
 *   `tokenUrl`, `introspectUrl`, `userinfoUrl` and a `mfaUrl(factorId)` helper.
 * @example
 * const r = getRegionConfig('EU');
 * r.authnUrl; // 'https://id.resmed.eu/api/v1/authn'
 */
export function getRegionConfig(region) {
  const base = REGIONS[region];
  if (!base) {
    throw new Error(`Unsupported myAir region: ${region}`);
  }
  const oauth2 = `https://${base.oktaUrl}/oauth2/${base.authServerId}/v1`;
  return {
    ...base,
    authnUrl: `https://${base.oktaUrl}/api/v1/authn`,
    authorizeUrl: `${oauth2}/authorize`,
    tokenUrl: `${oauth2}/token`,
    introspectUrl: `${oauth2}/introspect`,
    userinfoUrl: `${oauth2}/userinfo`,
    mfaUrl: (factorId) =>
      `https://${base.oktaUrl}/api/v1/authn/factors/${factorId || base.emailFactorId}/verify?rememberDevice=true`,
  };
}

// Static headers sent to the AppSync GraphQL endpoint alongside the dynamic
// ones (x-api-key, Authorization, rmdproduct, rmdcountry). These mimic the
// myAir web app; `rmdhandsetid` is a fixed client identifier from the
// reference component (not account-specific).
export const GRAPHQL_STATIC_HEADERS = {
  rmdhandsetid: '02c1c662-c289-41fd-a9ae-196ff15b5166',
  rmdlanguage: 'en',
  rmdhandsetmodel: 'Chrome',
  rmdhandsetosversion: '127.0.6533.119',
  rmdappversion: '1.0.0',
  rmdhandsetplatform: 'Web',
  'accept-language': 'en-US,en;q=0.9',
};

// Config keys DECLARED in the config_schema (typed by the user in the UI).
export const CONFIG_SCHEMA_KEYS = {
  REGION: 'region',
  USERNAME: 'username',
  PASSWORD: 'password',
};

// Config keys stored OUTSIDE the config_schema (internal token storage, never
// shown in the UI) - the external equivalent of the core's gladys.variable.
export const CONFIG_KEYS = {
  ACCESS_TOKEN: 'access_token',
  ID_TOKEN: 'id_token',
  // The Okta remembered-device cookie ("DT"): lets us re-authenticate without
  // a fresh email MFA code as long as it stays valid.
  DEVICE_TOKEN: 'device_token',
  COUNTRY_CODE: 'country_code',
  // In-flight MFA challenge state. Persisted because the code is triggered in
  // one invocation (config saved) and verified in another (the user's action),
  // possibly in a fresh process: the Okta state token AND the exact factor
  // verify URL Okta advertised must survive in between (the factor id is
  // per-account, not the regional default).
  MFA_STATE_TOKEN: 'mfa_state_token',
  MFA_URL: 'mfa_url',
};
