// -----------------------------------------------------------------------------
// Minimal fetch-like HTTP client built on Node's raw http/https modules.
//
// Used for the Okta login flow (MyAirAuthClient.js), which needs precise
// control the global `fetch` (undici) does not give:
//   - send ONLY the headers we set (undici injects `sec-fetch-*` and a
//     `user-agent: node` with no way to remove them; auth endpoints behind
//     anomaly detection can key off exactly that kind of fingerprint);
//   - never follow redirects (we read the `Location` header - and its URL
//     fragment - ourselves to pull the OAuth code out);
//   - read every `Set-Cookie` header back (the remembered-device `DT` and
//     session `sid` cookies are captured across requests).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * A small Response-like object, just enough of the Fetch Response API for the
 * auth client: `status`, `ok`, `headers.get`/`getSetCookie`, `text()`,
 * `json()`. The body is already fully buffered, so `text()`/`json()` can be
 * called more than once (no `.clone()` needed).
 * @param {number} statusCode - HTTP status code.
 * @param {object} rawHeaders - Node's raw response headers.
 * @param {Buffer} buffer - The fully buffered response body.
 * @returns {object} The Response-like object.
 */
function buildResponse(statusCode, rawHeaders, buffer) {
  const setCookie = Array.isArray(rawHeaders['set-cookie'])
    ? rawHeaders['set-cookie']
    : rawHeaders['set-cookie']
      ? [rawHeaders['set-cookie']]
      : [];
  return {
    status: statusCode,
    ok: statusCode >= 200 && statusCode < 300,
    headers: {
      get: (name) => {
        const value = rawHeaders[name.toLowerCase()];
        return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
      },
      getSetCookie: () => setCookie,
    },
    text: async () => buffer.toString('utf8'),
    json: async () => JSON.parse(buffer.toString('utf8')),
  };
}

/**
 * Fetch-like request, deliberately sending ONLY the headers passed in (see the
 * file header). Never follows redirects - the caller reads
 * `headers.get('location')` itself.
 * @param {string} url - The absolute URL to request.
 * @param {object} [options] - Options.
 * @param {string} [options.method] - HTTP method, default GET.
 * @param {object} [options.headers] - Request headers, sent verbatim.
 * @param {string} [options.body] - Request body, already serialized.
 * @returns {Promise<object>} The Response-like object described above.
 * @example
 * const response = await httpFetch('https://example.com/x', { method: 'POST', body: '{}' });
 */
export function httpFetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers };
    if (body !== undefined) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve(buildResponse(res.statusCode, res.headers, Buffer.concat(chunks))),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Serialize a plain object as `application/x-www-form-urlencoded`.
 * @param {object} data - Key/value pairs (values are coerced to strings).
 * @returns {string} The encoded body.
 * @example
 * formEncode({ grant_type: 'authorization_code', code: 'abc' });
 */
export function formEncode(data) {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
