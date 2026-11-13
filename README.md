# gladys-resmed-myair

External [Gladys Assistant](https://gladysassistant.com) integration that reads your **ResMed CPAP** sleep data (usage, AHI, mask leak, myAir score) from the **ResMed myAir** cloud.

It is **read-only** — it never changes any setting on your machine — and works for both the **European** (`myair.resmed.eu`) and **North American** (`myair.resmed.com`) myAir regions.

> ⚠️ **Unofficial API.** ResMed publishes no public API. This integration reverse-engineers the myAir web app (Okta authentication + AWS AppSync GraphQL), cross-checked against the actively maintained Home Assistant component [Snuffy2/resmed_myair_sensors](https://github.com/Snuffy2/resmed_myair_sensors). ResMed can change it without notice; that project is the first place to check if login or data retrieval starts failing.

## Data exposed

One device (your CPAP machine) with, for the most recent night, these read-only sensors:

| Feature key   | Sensor            | myAir field       | Unit     |
| ------------- | ----------------- | ----------------- | -------- |
| `usage`       | Usage             | `totalUsage` ÷ 60 | hours    |
| `ahi`         | AHI               | `ahi`             | events/h |
| `mask-leak`   | Mask leak         | `leakPercentile`  | L/min    |
| `score`       | myAir score       | `sleepScore`      | /100     |
| `mask-events` | Mask on/off count | `maskPairCount`   | —        |

ResMed machines sync roughly once a day, so the values update once a day (polled hourly to catch the sync promptly).

## Dashboard widget

Declares a **`last_night`** dashboard widget (manifest `widgets` + SDK `onWidgetGet`, see [`src/widget.js`](src/widget.js)): the latest night's usage, AHI, mask leak and score as color-coded `value` tiles, with a clear empty state when there is no recent data. Requires a widget-capable Gladys (`gladys_version >= 5.2.0`).

## How authentication works

myAir sits behind Okta. The integration runs Okta's OAuth2 authorization-code + PKCE flow itself:

1. grab the remembered-device (`DT`) cookie;
2. `POST /api/v1/authn` with email/password → `SUCCESS` or `MFA_REQUIRED`;
3. on MFA, ResMed emails a one-time code → verified via the **"Enter verification code"** action;
4. exchange the Okta session token for an access token (bearer for the GraphQL API).

The `DT` cookie is persisted, so subsequent logins skip the email code until the remembered device expires — then use the **"Reconnect"** action to receive a fresh code. There is no refresh token; the token is re-obtained silently when it expires.

See [`src/MyAirAuthClient.js`](src/MyAirAuthClient.js) for the full flow.

## Install in Gladys (developer mode)

1. In Gladys, open **Integrations → Install an integration → Developer mode**.
2. Paste the manifest ([`gladys-assistant-integration.json`](gladys-assistant-integration.json)); its `docker_image` points at the published image.
3. Open the integration, pick your **region**, enter your myAir **email/password**, save, then complete the **verification code** step.

A ready-to-paste manifest is also printed in the summary of every image build (see the GitHub Actions **Build** workflow).

## Development

Requires Node.js ≥ 20 (the Docker image ships Node 24).

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test (no network)
```

The tests cover the pure logic (region config, PKCE/JWT helpers, record-to-state mapping) without any network access.

## Release

Cut a release entirely from GitHub: **Actions → Release → Run workflow → patch/minor/major**. It bumps the version in `package.json` and the manifest, tags `vX.Y.Z`, and publishes a multi-arch image (`linux/amd64` + `linux/arm64`) to `ghcr.io`.

## License

Apache-2.0
