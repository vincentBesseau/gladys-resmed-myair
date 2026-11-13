// -----------------------------------------------------------------------------
// Entry point of the ResMed myAir external integration.
//
// Role of this file: wire the Gladys SDK to the myAir auth/API clients and the
// device orchestration (src/devices.js). Auth model: the user picks a region
// and enters the email/password of their myAir account in the Configuration
// screen; this integration then drives ResMed's Okta login flow itself
// (MyAirAuthClient.js) - including the email verification code (MFA) via the
// "Enter verification code" action below - and persists the resulting tokens
// through gladys.setConfig() (keys NOT declared in the config_schema).
//
// This integration is READ-ONLY: it discovers the account's CPAP machine and
// polls the previous night's therapy data. There is no onSetValue handler
// because there is nothing to control.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { MyAirAuthClient, MFARequiredError } from './src/MyAirAuthClient.js';
import { MyAirApiClient } from './src/MyAirApiClient.js';
import { buildDiscoveredDevices, pollDevice } from './src/devices.js';
import { REFRESH_INTERVAL_MS } from './src/constants.js';

const gladys = new GladysIntegration();
const auth = new MyAirAuthClient(gladys);
const apiClient = new MyAirApiClient(auth);

// Gladys ticks onPoll every minute (its slowest allowed frequency), but the
// myAir data only changes ~once a day, so we actually refresh at most every
// REFRESH_INTERVAL_MS. Reset to 0 on each process start so a restart refreshes
// promptly.
let lastRefreshAt = 0;

const STATUS = {
  enterCredentials: {
    en: 'Pick your myAir region, enter your email and password, then save.',
    fr: 'Choisissez votre région myAir, renseignez votre email et mot de passe, puis enregistrez.',
  },
  enterCode: {
    en: 'ResMed emailed you a verification code. Use the "Enter verification code" action below to finish connecting.',
    fr: "ResMed vous a envoyé un code de vérification par email. Utilisez l'action « Saisir le code de vérification » ci-dessous pour terminer la connexion.",
  },
  reconnectNeeded: {
    en: 'The remembered device expired. Use the "Reconnect" action to receive a new verification code.',
    fr: "L'appareil mémorisé a expiré. Utilisez l'action « Reconnecter » pour recevoir un nouveau code de vérification.",
  },
};

/**
 * Ensure we hold a usable myAir session, authenticating from the configured
 * credentials when needed, and reflecting the outcome through the connection
 * status.
 * @param {object} [options] - Options.
 * @param {boolean} [options.allowMfaEmail] - Whether a verification code may be
 *   emailed when MFA is required (true for an explicit (re)connect, false for a
 *   background poll).
 * @returns {Promise<boolean>} True when authenticated.
 */
async function ensureAuthenticated({ allowMfaEmail = false } = {}) {
  await auth.loadConfig();
  if (!auth.hasCredentials()) {
    await gladys.setConnectionStatus(false, STATUS.enterCredentials).catch(() => {});
    return false;
  }
  try {
    await auth.ensureAuthenticated({ allowMfaEmail });
    return true;
  } catch (e) {
    if (e instanceof MFARequiredError) {
      const message = allowMfaEmail ? STATUS.enterCode : STATUS.reconnectNeeded;
      logger.info(`ResMed myAir: verification code required (${e.message}).`);
      await gladys.setConnectionStatus(false, message).catch(() => {});
      return false;
    }
    logger.error(`ResMed myAir: authentication failed: ${e.message}`);
    await gladys
      .setConnectionStatus(false, {
        en: `Connection failed: ${e.message}`,
        fr: `Échec de la connexion : ${e.message}`,
      })
      .catch(() => {});
    return false;
  }
}

/**
 * Discover the account's CPAP machine and publish it, reflecting the outcome
 * through the connection status.
 * @param {object} [options] - Options.
 * @param {boolean} [options.allowMfaEmail] - Passed through to ensureAuthenticated.
 * @returns {Promise<void>} Resolves once done.
 */
async function discoverAndPublish({ allowMfaEmail = false } = {}) {
  if (!(await ensureAuthenticated({ allowMfaEmail }))) {
    return;
  }
  try {
    const devices = await buildDiscoveredDevices(gladys, apiClient);
    await gladys.publishDiscoveredDevices(devices);
    await gladys.setConnectionStatus(true).catch(() => {});
    logger.info(`ResMed myAir: published ${devices.length} device(s).`);
  } catch (e) {
    if (e instanceof MFARequiredError) {
      await gladys.setConnectionStatus(false, STATUS.reconnectNeeded).catch(() => {});
      return;
    }
    logger.error(`ResMed myAir: unable to publish devices: ${e.message}`);
    await gladys
      .setConnectionStatus(false, {
        en: `ResMed myAir error: ${e.message}`,
        fr: `Erreur ResMed myAir : ${e.message}`,
      })
      .catch(() => {});
  }
}

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> discovering the ResMed CPAP machine');
  await discoverAndPublish({ allowMfaEmail: false });
});

// --- Poll: Gladys asks for the current state of a device ---------------------
gladys.onPoll(async (device) => {
  // Throttle: Gladys polls every minute, but we only hit the cloud hourly.
  if (Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) {
    return;
  }
  if (!(await ensureAuthenticated({ allowMfaEmail: false }))) {
    return;
  }
  await pollDevice(gladys, apiClient, device);
  lastRefreshAt = Date.now();
});

// --- Manifest action: finish signing in with the emailed code ----------------
gladys.onAction('submit_mfa_code', async (fields) => {
  const code = String(fields.mfa_code || '').trim();
  if (!code) {
    return {
      en: 'Enter the verification code first.',
      fr: "Renseignez d'abord le code de vérification.",
    };
  }
  try {
    await auth.loadConfig();
    await auth.verifyMfaCode(code);
    await discoverAndPublish({ allowMfaEmail: false });
    return { en: 'Connected to ResMed myAir.', fr: 'Connecté à ResMed myAir.' };
  } catch (e) {
    logger.error(`ResMed myAir: verification code failed: ${e.message}`);
    return {
      en: `Verification failed: ${e.message}`,
      fr: `Échec de la vérification : ${e.message}`,
    };
  }
});

// --- Manifest action: force a fresh login (and email a new code) -------------
gladys.onAction('reconnect', async () => {
  logger.info('Action reconnect -> forcing a fresh myAir login');
  await discoverAndPublish({ allowMfaEmail: true });
  return {
    en: 'Reconnecting. If a verification code was requested, check your email, then use "Enter verification code".',
    fr: 'Reconnexion en cours. Si un code de vérification a été demandé, consultez vos emails, puis utilisez « Saisir le code de vérification ».',
  };
});

// --- Manifest action: test the connection ------------------------------------
gladys.onAction('test_connection', async () => {
  if (!(await ensureAuthenticated({ allowMfaEmail: false }))) {
    return {
      en: 'Not connected. Enter your credentials and save, or use "Reconnect".',
      fr: 'Non connecté. Renseignez vos identifiants et enregistrez, ou utilisez « Reconnecter ».',
    };
  }
  try {
    const device = await apiClient.getUserDeviceData();
    return {
      en: `Connection OK: found "${device.localizedName || device.deviceSeries}".`,
      fr: `Connexion OK : « ${device.localizedName || device.deviceSeries} » trouvée.`,
    };
  } catch (e) {
    return {
      en: `Connection failed: ${e.message}`,
      fr: `Échec de la connexion : ${e.message}`,
    };
  }
});

// --- Manifest action: refresh the sleep data now -----------------------------
gladys.onAction('scan_now', async () => {
  logger.info('Action scan_now -> refreshing the ResMed CPAP machine');
  await discoverAndPublish({ allowMfaEmail: false });
  return { en: 'Refresh complete.', fr: 'Actualisation terminée.' };
});

// --- Manifest action: disconnect ---------------------------------------------
gladys.onAction('disconnect', async () => {
  logger.info('Action disconnect -> clearing the stored ResMed tokens');
  await auth.loadConfig();
  await auth.clearTokens();
  await gladys.setConnectionStatus(false).catch(() => {});
  return {
    en: 'Disconnected from ResMed myAir. The stored tokens have been removed.',
    fr: 'Déconnecté de ResMed myAir. Les jetons stockés ont été supprimés.',
  };
});

// --- Configuration updated by the user (credentials / region) ----------------
gladys.onConfigUpdated(async () => {
  logger.info('onConfigUpdated -> reloading credentials and re-checking connection');
  // Initial setup saves here: allow the first verification code to be emailed.
  await discoverAndPublish({ allowMfaEmail: true }).catch((e) =>
    logger.error(`Re-publish after config update failed: ${e.message}`),
  );
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  // Silent re-auth via the remembered-device cookie; never email on reconnect.
  await discoverAndPublish({ allowMfaEmail: false });
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the ResMed myAir integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
