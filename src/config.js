'use strict';
/**
 * Configuration loader.
 * Reads a local .env file (if present) without needing the dotenv package,
 * then exposes validated settings. Real environment variables always win.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

// Event dates and early-bird deadlines are UK local times. Hosting servers (e.g. Render) run on UTC,
// so default the process time zone to London unless TZ is set explicitly.
if (!process.env.TZ) process.env.TZ = 'Europe/London';

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

// Database location. Older versions of the project stored the database in the
// project root. If that file exists (and no path is configured) keep using it,
// so existing accounts and communities are never lost.
function resolveDatabasePath() {
  if (env.DATABASE_PATH) return resolveFromRoot(env.DATABASE_PATH);
  const legacy = path.join(ROOT, 'community-connect.sqlite');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(ROOT, 'data', 'community-connect.sqlite');
}

const dataDir = resolveFromRoot(env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

// JWT secret. Production must supply one. In development a random secret is
// generated once and stored in data/ so logins survive a server restart.
function resolveJwtSecret() {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 32) return env.JWT_SECRET;
  if (env.JWT_SECRET) {
    if (isProduction) throw new Error('JWT_SECRET must be at least 32 characters in production.');
    console.warn('[config] JWT_SECRET is shorter than 32 characters. Use a longer value before deployment.');
    return env.JWT_SECRET;
  }
  if (isProduction) throw new Error('JWT_SECRET is required when NODE_ENV=production.');
  const file = path.join(dataDir, '.dev-jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log('[config] No JWT_SECRET set. Generated a development secret in data/.dev-jwt-secret');
  return secret;
}

const config = {
  root: ROOT,
  isProduction,
  port: Number(env.PORT) || 3000,
  host: env.HOST || undefined,
  publicDir: path.join(ROOT, 'public'),
  dataDir,
  uploadDir: resolveFromRoot(env.UPLOAD_DIR || path.join('data', 'uploads')),
  databasePath: resolveDatabasePath(),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: Math.min(Math.max(Number(env.BCRYPT_ROUNDS) || 12, 10), 14),
  seedDemoData: env.SEED_DEMO_DATA !== 'false',
  seedOrganizerPassword: env.SEED_ORGANIZER_PASSWORD || '',
  // Platform admin + commission (platform fee kept from every paid ticket; the rest is paid out to the organizer after the event)
  adminEmail: (env.ADMIN_EMAIL || 'admin@communityconnect.local').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  platformFeePercent: String(env.PLATFORM_FEE_PERCENT ?? '').trim() === '' ? 10 : (Math.min(50, Math.max(0, Math.round(Number(env.PLATFORM_FEE_PERCENT)))) || 0),
  // Continue with Google (optional): create an OAuth Client ID at console.cloud.google.com
  googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
  googleTokenInfoUrl: env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo',
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 4) * 1024 * 1024,
  trustProxy: env.TRUST_PROXY === 'true',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  payments: {
    // "stripe" when a Stripe secret key is configured, otherwise "demo" (built-in test checkout, no real money).
    mode: env.STRIPE_SECRET_KEY ? 'stripe' : 'demo',
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeApiUrl: (env.STRIPE_API_URL || 'https://api.stripe.com').replace(/\/$/, ''),
    currency: 'gbp',
    holdMinutes: Number(env.PAYMENT_HOLD_MINUTES) || 30
  },
  geocoder: {
    postcodesUrl: (env.POSTCODES_API_URL || 'https://api.postcodes.io').replace(/\/$/, ''),
    nominatimUrl: (env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    nominatimEnabled: env.NOMINATIM_ENABLED !== 'false',
    userAgent: env.GEOCODER_USER_AGENT || 'CommunityConnect-StudentProject/1.0 (local development)',
    contactEmail: env.GEOCODER_CONTACT_EMAIL || '',
    timeoutMs: Number(env.GEOCODER_TIMEOUT_MS) || 6000,
    offlineFallback: env.GEOCODER_OFFLINE_FALLBACK !== 'false'
  }
};

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

module.exports = config;
