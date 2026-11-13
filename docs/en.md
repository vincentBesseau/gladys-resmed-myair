# ResMed myAir

This integration reads the nightly therapy data of your ResMed CPAP machine (AirSense, AirCurve…) from the **ResMed myAir** cloud — the same account used by the [myAir](https://myair.resmed.eu) app and website.

It is **read-only**: it never changes any setting on your machine. It creates one "CPAP" device with, for the most recent night, the following sensors:

| Sensor                | Description                        | Unit     |
| --------------------- | ---------------------------------- | -------- |
| **Usage**             | How long the machine was used      | hours    |
| **AHI**               | Apnea-Hypopnea Index               | events/h |
| **Mask leak**         | Leak level (`leakPercentile`)      | L/min    |
| **myAir score**       | Overall score for the night        | /100     |
| **Mask on/off count** | How many times the mask was put on | —        |

> ⚠️ **Unofficial API.** ResMed publishes no API. This integration reproduces how the myAir website works (Okta authentication + GraphQL API). ResMed can change it without notice; if it breaks, check the [reference Home Assistant component](https://github.com/Snuffy2/resmed_myair_sensors).

## Requirements

- An active **myAir** account linked to a ResMed machine that syncs its data.
- Your account **region**:
  - **Europe** → `myair.resmed.eu`
  - **North America** → `myair.resmed.com`

## Configuration

1. In Gladys, open the **ResMed myAir** integration.
2. Pick your **myAir region**.
3. Enter the **email** and **password** of your myAir account.
4. Save.

### Verification code (two-factor authentication)

On the first connection, ResMed emails you a **one-time verification code**. The connection status asks for it:

1. Check your inbox.
2. Use the **"Enter verification code"** action and type the code you received.

The device is then **remembered**: you should not be asked for a code again. If the remembered device ever expires, the status will prompt you to use the **"Reconnect"** action to get a fresh code.

## Available actions

- **Enter verification code** — finishes the connection after you receive the emailed code.
- **Reconnect (send a new code)** — forces a fresh login; emails a code if needed.
- **Test connection** — checks that account access works.
- **Refresh sleep data now** — fetches the latest data immediately.
- **Disconnect** — removes the stored tokens.

## Dashboard widget

The integration provides a **"Last night"** widget for your dashboards (editor → **+** → "Last night"). It shows the four latest-night metrics (usage, AHI, mask leak, score) as color-coded tiles (green / amber / red by threshold). With no recent data, it shows a clear empty state.

## Update frequency

ResMed machines only sync their data **about once a day**. The integration polls the cloud hourly to pick up the latest night as soon as it appears, so it is normal for the values to change only once a day.
