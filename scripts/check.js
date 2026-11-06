'use strict';
/** Quick project check: syntax of every JS file + required files present. Run: npm run check */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(root).filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error('✘ syntax error in', path.relative(root, f), '\n', String(e.stderr)); }
}
for (const f of ['server.js', 'public/index.html', 'public/community.html', 'public/event.html', '.env.example', 'START-WINDOWS.bat']) {
  if (!fs.existsSync(path.join(root, f))) { failed++; console.error('✘ missing', f); }
}
for (const dep of ['express', 'better-sqlite3', 'bcryptjs', 'jsonwebtoken']) {
  try { require.resolve(dep, { paths: [root] }); } catch { console.warn(`! ${dep} not installed yet — run "npm install"`); }
}
console.log(failed ? `${failed} problem(s) found.` : '✔ All JavaScript files parse and required files are present.');
process.exit(failed ? 1 : 0);
