'use strict';
/**
 * Community Connect — server entry point.
 * Start with:  npm start   →  http://localhost:3000
 */
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Community Connect needs Node.js 20 or newer (22 or 24 LTS recommended). You have ${process.version}.`);
  process.exit(1);
}

let config;
try {
  config = require('./src/config');
} catch (err) {
  console.error('[config]', err.message);
  process.exit(1);
}

let openDatabase, createApp;
try {
  ({ openDatabase } = require('./src/db'));
  ({ createApp } = require('./src/app'));
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error('\nA required package is missing. Run "npm install" in this folder, then "npm start" again.\n');
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

let db;
try {
  db = openDatabase(config);
} catch (err) {
  console.error(`\n[db] Could not open the database at ${config.databasePath}`);
  console.error(`[db] ${err.message}`);
  console.error('[db] If the file is damaged, restore a backup or set DATABASE_PATH in .env to a new file. The existing file has NOT been modified.\n');
  process.exit(1);
}
const app = createApp({ db, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`Community Connect running at http://localhost:${config.port}`);
  console.log(`Health check:              http://localhost:${config.port}/api/health`);
  console.log(`Database file:             ${config.databasePath}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Close the other program or set PORT in .env (e.g. PORT=3001).`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n${signal} received — closing server and database.`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
