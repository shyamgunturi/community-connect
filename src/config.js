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
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 4) * 1024 * 1024,
  trustProxy: env.TRUST_PROXY === 'true',
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
