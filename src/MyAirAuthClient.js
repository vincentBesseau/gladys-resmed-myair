// -----------------------------------------------------------------------------
// ResMed myAir authentication (Okta OAuth2 + PKCE, with optional email MFA).
//
// myAir sits behind Okta. The login flow, reproduced here from the myAir web
// app (see constants.js for provenance), is:
//
//   1. GET /authorize (no params)        -> grab the remembered-device "DT"
//                                           cookie (the request itself 400s,
//                                           that is fine).
//   2. POST /api/v1/authn {user,pass}    -> either SUCCESS (+ sessionToken) or
//                                           MFA_REQUIRED (+ stateToken). A valid
//                                           DT cookie usually yields SUCCESS
//                                           with no MFA.
//   3. (MFA only) POST factors/.../verify {passCode:'', stateToken}  -> ResMed
//                                           emails a one-time code.
//      then        POST factors/.../verify {passCode:code, stateToken} -> SUCCESS
//                                           (+ sessionToken).
//   4. GET /authorize (PKCE, sessionToken) -> OAuth code in the redirect's URL
//                                           fragment.
//      POST /token (code + verifier)      -> access_token + id_token.
//
// The access token is a bearer for ResMed's AppSync GraphQL API. There is no
// refresh token: when the token expires we re-run the flow, and the DT cookie
// keeps that silent (no new email) until the remembered device itself expires.
// -----------------------------------------------------------------------------

import { randomBytes, createHash } from 'node:crypto';
import { logger } from '@gladysassistant/integration-sdk';
import { httpFetch, formEncode } from './httpClient.js';
import {
  AUTHN_SUCCESS,
  AUTH_NEEDS_MFA,
  GRAPHQL_STATIC_HEADERS,
  CONFIG_SCHEMA_KEYS,
  CONFIG_KEYS,
  getRegionConfig,
} from './constants.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const FORM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json',
};

/** Raised when myAir needs an email verification code to finish signing in. */
export class MFARequiredError extends Error {
  constructor(message) {
    super(message || 'ResMed myAir sent a verification code by email to finish signing in.');
    this.name = 'MFARequiredError';
  }
}

/** Raised when credentials or the auth state are rejected. */
export class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** base64url (no padding) of a Buffer. */
function base64url(buffer) {
  return buffer.toString('base64url');
}

/** Decode the payload of a JWT without verifying its signature. */
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) {
    throw new Error('Malformed JWT');
  }
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

export class MyAirAuthClient {
  constructor(gladys) {
    this._gladys = gladys;
    this._region = null;
    this._regionConfig = null;
    this._username = null;
    this._password = null;
    // OAuth tokens.
    this._accessToken = null;
    this._idToken = null;
    this._countryCode = null;
    // Okta auth-flow state.
    this._stateToken = null;
    this._sessionToken = null;
    this._emailFactorId = null;
    this._mfaUrl = null;
    // Cookies.
    this._cookieDt = null; // remembered device
    this._cookieSid = null; // Okta session
  }

  /**
   * Load credentials (from the config schema) and any persisted tokens.
   * @returns {Promise<void>} Resolves once state is loaded.
   */
  async loadConfig() {
    const config = (await this._gladys.getConfig()) || {};
    this._region = config[CONFIG_SCHEMA_KEYS.REGION] || 'EU';
    this._username = config[CONFIG_SCHEMA_KEYS.USERNAME] || null;
    this._password = config[CONFIG_SCHEMA_KEYS.PASSWORD] || null;
    this._regionConfig = getRegionConfig(this._region);
    this._emailFactorId = this._regionConfig.emailFactorId;
    this._mfaUrl = this._regionConfig.mfaUrl(this._emailFactorId);
    this._accessToken = config[CONFIG_KEYS.ACCESS_TOKEN] || null;
    this._idToken = config[CONFIG_KEYS.ID_TOKEN] || null;
    this._cookieDt = config[CONFIG_KEYS.DEVICE_TOKEN] || null;
    this._countryCode = config[CONFIG_KEYS.COUNTRY_CODE] || null;
    // Restore an in-flight MFA challenge. This MUST come after the defaults
    // above: Okta's email factor id is per-account (discovered from the authn
    // response), so verifying against the regional default factor fails with
    // "UserFactor not found". The trigger persisted the exact verify URL.
    const persistedStateToken = config[CONFIG_KEYS.MFA_STATE_TOKEN] || null;
    const persistedMfaUrl = config[CONFIG_KEYS.MFA_URL] || null;
    if (persistedStateToken) {
      this._stateToken = persistedStateToken;
    }
    if (persistedMfaUrl) {
      this._mfaUrl = persistedMfaUrl;
    }
  }

  /** True once an access token has been obtained (not necessarily still fresh). */
  isConnected() {
    return Boolean(this._accessToken);
  }

  /** True when both an email and a password are configured. */
  hasCredentials() {
    return Boolean(this._username && this._password);
  }

  get accessToken() {
    return this._accessToken;
  }

  get region() {
    return this._region;
  }

  get graphqlUrl() {
    return this._regionConfig.graphqlUrl;
  }

  // --- Cookies ---------------------------------------------------------------

  _cookieHeader() {
    const parts = [];
    if (this._cookieDt) {
      parts.push(`DT=${this._cookieDt}`);
    }
    if (this._cookieSid) {
      parts.push(`sid=${this._cookieSid}`);
    }
    return parts.join('; ');
  }

  async _captureCookies(response) {
    let dtChanged = false;
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const index = pair.indexOf('=');
      if (index === -1) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name.toLowerCase() === 'dt' && value && value !== this._cookieDt) {
        this._cookieDt = value;
        dtChanged = true;
      } else if (name.toLowerCase() === 'sid' && value) {
        this._cookieSid = value;
      }
    }
    if (dtChanged) {
      await this._gladys.setConfig({ [CONFIG_KEYS.DEVICE_TOKEN]: this._cookieDt });
    }
  }

  // --- Public flow -----------------------------------------------------------

  /**
   * Ensure we hold a usable access token, authenticating if needed. A valid
   * remembered-device cookie keeps this silent; otherwise it may raise
   * MFARequiredError (only after sending a fresh code, when allowed).
   * @param {object} [options] - Options.
   * @param {boolean} [options.allowMfaEmail] - Whether an email code may be
   *   sent when MFA is required (true during an explicit (re)connect, false on
   *   a background poll, where we surface the state instead of emailing).
   * @returns {Promise<void>} Resolves once a usable token is held.
   */
  async ensureAuthenticated({ allowMfaEmail = false } = {}) {
    if (this._accessToken && (await this._isTokenActive())) {
      return;
    }
    await this.authenticate({ sendMfaEmail: allowMfaEmail });
  }

  /**
   * Run the Okta login flow from username/password.
   * @param {object} [options] - Options.
   * @param {boolean} [options.sendMfaEmail] - Whether to trigger the email code
   *   when MFA is required (and then raise MFARequiredError).
   * @returns {Promise<void>} Resolves when an access token is obtained.
   */
  async authenticate({ sendMfaEmail = false } = {}) {
    if (!this.hasCredentials()) {
      throw new AuthenticationError('Missing myAir email or password.');
    }
    if (!this._cookieDt) {
      await this._getInitialDt();
    }
    const status = await this._authnCheck();
    if (status === AUTH_NEEDS_MFA) {
      if (sendMfaEmail) {
        await this._triggerMfa();
        throw new MFARequiredError();
      }
      throw new MFARequiredError(
        'The remembered device expired; a new verification code is needed.',
      );
    }
    await this._getAccessToken();
  }

  /**
   * Complete an MFA challenge with the code the user received by email.
   * @param {string} verificationCode - The one-time code.
   * @returns {Promise<void>} Resolves when an access token is obtained.
   */
  async verifyMfaCode(verificationCode) {
    if (!this._stateToken) {
      // No challenge in flight (e.g. after a restart): restart the flow so a
      // fresh stateToken + code pair is issued.
      await this.authenticate({ sendMfaEmail: true });
      return;
    }
    await this._verifyMfa(verificationCode);
    await this._getAccessToken();
  }

  /** Forget every stored token and cookie (the "disconnect" action). */
  async clearTokens() {
    this._accessToken = null;
    this._idToken = null;
    this._countryCode = null;
    this._cookieDt = null;
    this._cookieSid = null;
    this._stateToken = null;
    this._sessionToken = null;
    await this._gladys.setConfig({
      [CONFIG_KEYS.ACCESS_TOKEN]: '',
      [CONFIG_KEYS.ID_TOKEN]: '',
      [CONFIG_KEYS.DEVICE_TOKEN]: '',
      [CONFIG_KEYS.COUNTRY_CODE]: '',
      [CONFIG_KEYS.MFA_STATE_TOKEN]: '',
      [CONFIG_KEYS.MFA_URL]: '',
    });
  }

  // --- GraphQL headers -------------------------------------------------------

  /**
   * Build the headers ResMed's AppSync GraphQL endpoint expects.
   * @returns {object} The headers (x-api-key, bearer token, rmd* metadata).
   */
  graphqlHeaders() {
    return {
      ...GRAPHQL_STATIC_HEADERS,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this._regionConfig.myairApiKey,
      Authorization: `Bearer ${this._accessToken}`,
      rmdproduct: this._regionConfig.product,
      rmdcountry: this._getCountryCode(),
    };
  }

  _getCountryCode() {
    if (this._countryCode) {
      return this._countryCode;
    }
    if (!this._idToken) {
      throw new Error('No id_token available to derive the myAir country code.');
    }
    const payload = decodeJwtPayload(this._idToken);
    const countryCode = payload.myAirCountryId;
    if (typeof countryCode !== 'string' || !countryCode) {
      throw new Error('myAirCountryId claim not found in id_token.');
    }
    this._countryCode = countryCode;
    return countryCode;
  }

  // --- Okta steps ------------------------------------------------------------

  async _getInitialDt() {
    // GET /authorize with no query params: this 400s, we only want the DT
    // cookie it sets on the response.
    const response = await httpFetch(this._regionConfig.authorizeUrl, { headers: JSON_HEADERS });
    await this._captureCookies(response);
    if (!this._cookieDt) {
      logger.debug('ResMed myAir: no device token obtained; MFA may be required more often.');
    }
  }

  async _isTokenActive() {
    try {
      const response = await httpFetch(this._regionConfig.introspectUrl, {
        method: 'POST',
        headers: { ...FORM_HEADERS, Cookie: this._cookieHeader() },
        body: formEncode({
          client_id: this._regionConfig.authorizeClientId,
          token_type_hint: 'access_token',
          token: this._accessToken,
        }),
      });
      const data = await response.json();
      return data.active === true;
    } catch (e) {
      logger.debug(`ResMed myAir: token introspection failed: ${e.message}`);
      return false;
    }
  }

  async _authnCheck() {
    const response = await httpFetch(this._regionConfig.authnUrl, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: this._cookieHeader() },
      body: JSON.stringify({ username: this._username, password: this._password }),
    });
    const data = await response.json();
    this._throwOnOktaError('authn', response, data);
    const status = data.status;
    if (status === AUTH_NEEDS_MFA) {
      if (!data.stateToken) {
        throw new AuthenticationError('Missing stateToken in the authn response.');
      }
      this._stateToken = data.stateToken;
      this._resolveMfaFactor(data);
      logger.info('ResMed myAir: primary auth done, verification code required.');
    } else if (status === AUTHN_SUCCESS) {
      if (!data.sessionToken) {
        throw new AuthenticationError('Missing sessionToken in the authn response.');
      }
      this._sessionToken = data.sessionToken;
      logger.info('ResMed myAir: primary auth done, no verification code required.');
    } else {
      throw new AuthenticationError(`Unexpected authn status: ${status}`);
    }
    return status;
  }

  _resolveMfaFactor(authnData) {
    // Prefer the factor Okta advertises; fall back to the regional default.
    this._emailFactorId = this._regionConfig.emailFactorId;
    this._mfaUrl = this._regionConfig.mfaUrl(this._emailFactorId);
    const factor = authnData?._embedded?.factors?.[0];
    if (factor?.id) {
      this._emailFactorId = factor.id;
      this._mfaUrl = this._regionConfig.mfaUrl(factor.id);
    }
    const href = factor?._links?.verify?.href;
    if (typeof href === 'string' && href) {
      this._mfaUrl = `${href}?rememberDevice=true`;
    }
  }

  async _triggerMfa() {
    const response = await httpFetch(this._mfaUrl, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: this._cookieHeader() },
      body: JSON.stringify({ passCode: '', stateToken: this._stateToken }),
    });
    const data = await response.json();
    this._throwOnOktaError('trigger_mfa', response, data);
    // Persist the challenge so the verify step (a later, possibly fresh
    // process) uses the SAME state token and the exact factor verify URL.
    await this._gladys.setConfig({
      [CONFIG_KEYS.MFA_STATE_TOKEN]: this._stateToken,
      [CONFIG_KEYS.MFA_URL]: this._mfaUrl,
    });
    logger.info('ResMed myAir: verification code emailed.');
  }

  async _verifyMfa(verificationCode) {
    const response = await httpFetch(this._mfaUrl, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Cookie: this._cookieHeader() },
      body: JSON.stringify({
        passCode: String(verificationCode).trim(),
        stateToken: this._stateToken,
      }),
    });
    const data = await response.json();
    this._throwOnOktaError('verify_mfa', response, data);
    if (data.status !== AUTHN_SUCCESS || !data.sessionToken) {
      throw new AuthenticationError(`Verification failed (status: ${data.status}).`);
    }
    this._sessionToken = data.sessionToken;
    this._stateToken = null;
    // Challenge consumed: drop the persisted state so a later poll never
    // replays it.
    await this._gladys.setConfig({
      [CONFIG_KEYS.MFA_STATE_TOKEN]: '',
      [CONFIG_KEYS.MFA_URL]: '',
    });
    logger.info('ResMed myAir: verification code accepted.');
  }

  async _getAccessToken() {
    // Authorization Code + PKCE: build the verifier/challenge pair.
    const codeVerifier = base64url(randomBytes(40)).replace(/[^a-zA-Z0-9]/g, '');
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

    // Exchange the Okta session token for an OAuth code (returned in the
    // redirect's URL fragment; we must NOT follow the redirect).
    const authorizeQuery = formEncode({
      client_id: this._regionConfig.authorizeClientId,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'none',
      redirect_uri: this._regionConfig.oauthRedirectUrl,
      response_mode: 'fragment',
      response_type: 'code',
      sessionToken: this._sessionToken,
      scope: 'openid profile email',
      state: 'abcdef',
    });
    const codeResponse = await httpFetch(`${this._regionConfig.authorizeUrl}?${authorizeQuery}`, {
      headers: { ...JSON_HEADERS, Cookie: this._cookieHeader() },
    });
    const location = codeResponse.headers.get('location');
    if (!location) {
      throw new AuthenticationError('No redirect location returned by the authorize step.');
    }
    await this._captureCookies(codeResponse);
    const fragment = location.includes('#') ? location.slice(location.indexOf('#') + 1) : '';
    const code = new URLSearchParams(fragment).get('code');
    if (!code) {
      throw new AuthenticationError('Authorization code missing from the redirect fragment.');
    }

    // Exchange the code for tokens.
    const tokenResponse = await httpFetch(this._regionConfig.tokenUrl, {
      method: 'POST',
      headers: { ...FORM_HEADERS, Cookie: this._cookieHeader() },
      body: formEncode({
        client_id: this._regionConfig.authorizeClientId,
        redirect_uri: this._regionConfig.oauthRedirectUrl,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
        code,
      }),
    });
    const data = await tokenResponse.json();
    this._throwOnOktaError('token', tokenResponse, data);
    if (!data.access_token || !data.id_token) {
      throw new AuthenticationError('Token response missing access_token or id_token.');
    }
    this._accessToken = data.access_token;
    this._idToken = data.id_token;
    this._countryCode = null; // re-derive from the new id_token on next use
    this._sessionToken = null;
    await this._persistTokens();
    logger.info('ResMed myAir: access token obtained.');
  }

  async _persistTokens() {
    await this._gladys.setConfig({
      [CONFIG_KEYS.ACCESS_TOKEN]: this._accessToken,
      [CONFIG_KEYS.ID_TOKEN]: this._idToken,
      [CONFIG_KEYS.COUNTRY_CODE]: this._getCountryCode(),
    });
  }

  /**
   * Turn an Okta / ResMed error payload into an exception. Okta reports errors
   * as `{ errorCode, errorSummary }`; a successful step carries neither.
   * @param {string} step - The step name, for diagnostics.
   * @param {object} response - The Response-like object.
   * @param {object} data - The decoded JSON body.
   */
  _throwOnOktaError(step, response, data) {
    if (data && (data.errorCode || data.errorSummary)) {
      const summary = data.errorSummary || data.errorCode;
      throw new AuthenticationError(`${step} step failed: ${summary}`);
    }
    if (!response.ok && !data.status) {
      throw new AuthenticationError(`${step} step failed with HTTP ${response.status}.`);
    }
  }
}
