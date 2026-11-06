'use strict';
/** Test helpers: start the real server in a child process with an isolated database and a fake geocoder. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Fake postcodes.io + Nominatim, so tests are deterministic and never call real services. */
function startFakeGeocoder() {
  const calls = [];
  const places = {
    middlesbrough: [
      { name_1: 'Middlesbrough', local_type: 'Town', county_unitary: 'Middlesbrough', region: 'North East', latitude: 54.5742, longitude: -1.2348 },
      { name_1: 'Middlesbrough Road', local_type: 'Named Road', latitude: 54.5, longitude: -1.2 }
    ],
    stockton: [{ name_1: 'Stockton-on-Tees', local_type: 'Town', county_unitary: 'Stockton-on-Tees', latitude: 54.5705, longitude: -1.3187 }],
    newcastle: [{ name_1: 'Newcastle upon Tyne', local_type: 'City', county_unitary: 'Tyne and Wear', latitude: 54.9783, longitude: -1.6178 }],
    london: [{ name_1: 'London', local_type: 'City', county_unitary: 'Greater London', latitude: 51.5072, longitude: -0.1276 }]
  };
  const postcodes = { TS13BX: { postcode: 'TS1 3BX', latitude: 54.5707, longitude: -1.2347, admin_district: 'Middlesbrough', region: 'North East' } };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, q: u.searchParams.get('q'), at: Date.now(), ua: req.headers['user-agent'] });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    let m;
    if (u.pathname === '/places') {
      const key = Object.keys(places).find(k => k.startsWith(String(u.searchParams.get('q')).toLowerCase().slice(0, 5)));
      return send(200, { status: 200, result: key ? places[key] : [] });
    }
    if ((m = /^\/postcodes\/(.+)$/.exec(u.pathname))) {
      const pc = postcodes[decodeURIComponent(m[1]).toUpperCase()];
      return pc ? send(200, { status: 200, result: pc }) : send(404, { status: 404, error: 'Invalid postcode' });
    }
    if (u.pathname === '/postcodes') {
      const q = String(u.searchParams.get('q')).replace(/\s/g, '').toUpperCase();
      const list = Object.values(postcodes).filter(p => p.postcode.replace(/\s/g, '').startsWith(q));
      return send(200, { status: 200, result: list.length ? list : null });
    }
    if ((m = /^\/outcodes\/(.+)$/.exec(u.pathname))) {
      return m[1].toUpperCase() === 'TS1'
        ? send(200, { status: 200, result: { outcode: 'TS1', latitude: 54.5703, longitude: -1.2361, admin_district: ['Middlesbrough'] } })
        : send(404, { status: 404, error: 'Outcode not found' });
    }
    if (u.pathname === '/search') {
      const q = String(u.searchParams.get('q')).toLowerCase();
      if (q.includes('teesside university')) return send(200, [{ lat: '54.5710', lon: '-1.2340', display_name: 'Teesside University, Borough Road, Middlesbrough, England', addresstype: 'university' }]);
      if (q.includes('paris')) return send(200, [{ lat: '48.85', lon: '2.35', display_name: 'Paris, France', addresstype: 'city' }]);
      return send(200, []);
    }
    send(404, { error: 'unknown' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) })));
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-')); }

function freePort() {
  return new Promise(resolve => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer({ dir, geocoderUrl, env = {} }) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DATA_DIR: dir, DATABASE_PATH: path.join(dir, 'test.sqlite'), UPLOAD_DIR: path.join(dir, 'uploads'),
      JWT_SECRET: 'test-secret-test-secret-test-secret-1234', BCRYPT_ROUNDS: '10', AUTH_RATE_LIMIT: '10000',
      POSTCODES_API_URL: geocoderUrl, NOMINATIM_URL: geocoderUrl, GEOCODER_TIMEOUT_MS: '2000',
      NODE_ENV: 'test', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start:\n' + output)), 15000);
    const check = () => { if (output.includes('running at')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}):\n${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, child, get output() { return output; },
    stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.removeAllListeners('exit'); child.on('exit', resolve); child.kill('SIGTERM'); })
  };
}

function client(base) {
  return async function request(method, url, { token, body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
}

function isoDate(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A real 1×1 PNG.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

module.exports = { startFakeGeocoder, startServer, client, tempDir, isoDate, PNG_1PX, ROOT };
