'use strict';
/**
 * Browser end-to-end test (optional). Drives the real UI in Chromium.
 *   npm install --no-save playwright && npx playwright install chromium
 *   node test/e2e.browser.js
 * Uses a temporary database and a fake geocoder; screenshots are written to test/screenshots/.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeGeocoder, startServer, tempDir, isoDate } = require('./helpers');
const Database = require('better-sqlite3');

const SHOTS = path.join(__dirname, 'screenshots');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let currentPage = null;
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✔ ${name}`); }
  catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✘ ${name}\n      ${e.message.split('\n')[0]}`);
    try { await currentPage?.screenshot({ path: path.join(SHOTS, `FAILED-${results.length}.png`), fullPage: true }); console.log(`      url: ${currentPage.url()}`); } catch { /* ignore */ }
  }
}

/** Writes a real landscape PNG (no dependencies) to test photo upload and full-image display. */
function makePng(file, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const border = x < 12 || y < 12 || x >= w - 12 || y >= h - 12; // red border proves nothing is cropped
      raw[i] = border ? 220 : 23 + (x / w) * 120; raw[i + 1] = border ? 40 : 107 + (y / h) * 100; raw[i + 2] = border ? 40 : 98;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
  const geo = await startFakeGeocoder();
  const dir = tempDir();
  const srv = await startServer({ dir, geocoderUrl: geo.url });
  const BASE = srv.base;
  const photoFile = path.join(dir, 'wide-photo.png');
  makePng(photoFile, 1200, 500);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  currentPage = page;
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) pageErrors.push(m.text()); });
  page.on('dialog', d => d.accept());
  const shot = async (name, p = page) => p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  const noOverflow = async (p = page) => {
    const r = await p.evaluate(() => {
      const W = window.innerWidth, culprits = [];
      document.querySelectorAll('body *').forEach(el => { const b = el.getBoundingClientRect(); if (b.width && b.right > W + 1 && getComputedStyle(el).position !== 'fixed') culprits.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`); });
      return { o: document.documentElement.scrollWidth - W, culprits: culprits.slice(0, 4), url: location.pathname + location.hash };
    });
    assert.ok(r.o <= 1, `horizontal overflow ${r.o}px on ${r.url}: ${r.culprits.join(', ')}`);
  };
  const eventIdByName = async name => (await (await fetch(BASE + '/api/events/public')).json()).events.find(e => e.name === name).id;
  const count = async () => page.locator('#communityGrid .community-card').count();

  console.log('\nVisitor');
  await step('homepage loads with design and public events (no login)', async () => {
    await page.goto(BASE + '/');
    await page.waitForSelector('#homeEventGrid .event-card');
    assert.match(await page.textContent('.hero-v2 h1'), /Your people are/);
    assert.ok(await page.locator('#homeEventGrid .event-card').count() >= 1);
    await shot('01-home-desktop');
  });
  await step('explore communities without an account', async () => {
    await page.click('#exploreBtn');
    await page.waitForSelector('#communityGrid .community-card:not(.skeleton)');
    assert.equal(await count(), 7);
    assert.ok(await page.isVisible('#dashboardLocked'));
    assert.ok(await page.isDisabled('#distanceRange'), 'distance disabled until a location is chosen');
  });
  await step('failed external images fall back to the placeholder', async () => {
    await page.waitForTimeout(800);
    const srcs = await page.$$eval('#communityGrid .photo-main', imgs => imgs.map(i => [i.currentSrc || i.src, i.naturalWidth]));
    assert.ok(srcs.every(([, w]) => w > 0), 'every card shows an image (photo or fallback)');
  });
  await step('town autocomplete → select suggestion → distance search', async () => {
    await page.fill('#locationSearch', 'Middles');
    await page.waitForSelector('#locationSuggestions .suggestion');
    assert.match(await page.textContent('#locationSuggestions'), /Middlesbrough/);
    await page.click('#locationSuggestions .suggestion >> nth=0');
    await page.waitForFunction(() => /Within 10 miles of Middlesbrough/.test(document.getElementById('resultsSummary').textContent));
    await page.waitForSelector('#communityGrid .community-card:not(.skeleton)');
    const d = await page.$$eval('#communityGrid .community-meta strong', els => els.map(e => parseFloat(e.textContent)));
    assert.ok(d.length >= 4 && d.every(x => x <= 10), `distances ${d}`);
    assert.deepEqual(d, [...d].sort((a, b) => a - b), 'nearest first');
    assert.ok(!(await page.textContent('#communityGrid')).includes('Tyneside'), 'Newcastle not within 10 miles');
    await shot('02-discovery-search');
  });
  await step('distance filter changes the results', async () => {
    const at10 = await count();
    await page.locator('#distanceRange').fill('50');
    await page.waitForFunction(() => /Within 50 miles/.test(document.getElementById('resultsSummary').textContent));
    await page.waitForFunction(n => document.querySelectorAll('#communityGrid .community-card:not(.skeleton)').length > n, at10);
    assert.ok((await page.textContent('#communityGrid')).includes('Tyneside'));
    await page.locator('#distanceRange').fill('1');
    await page.waitForFunction(() => /Within 1 mile of/.test(document.getElementById('resultsSummary').textContent));
    await page.waitForTimeout(400);
    assert.ok((await count()) < at10, 'fewer communities within 1 mile');
    await page.locator('#distanceRange').fill('10');
    await page.waitForTimeout(500);
  });
  await step('category filter', async () => {
    await page.selectOption('#categoryFilter', 'Technology');
    await page.waitForFunction(() => /Technology/.test(document.getElementById('resultsSummary').textContent));
    await page.waitForTimeout(300);
    const cats = await page.$$eval('#communityGrid .category-tag', els => els.map(e => e.textContent));
    assert.ok(cats.length >= 1 && cats.every(c => c === 'Technology'));
    await page.selectOption('#categoryFilter', 'all');
    await page.waitForTimeout(300);
  });
  await step('postcode search via suggestion', async () => {
    await page.fill('#locationSearch', 'TS1 3BX');
    await page.waitForSelector('#locationSuggestions .suggestion');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /TS1 3BX/.test(document.getElementById('resultsSummary').textContent));
  });
  await step('invalid postcode shows a helpful message', async () => {
    await page.fill('#locationSearch', 'ZZ99 9ZZ');
    await page.click('#searchLocationBtn');
    await page.waitForFunction(() => /could not find that postcode/i.test(document.getElementById('locationStatus').textContent));
    assert.match(await page.getAttribute('#locationStatus', 'class'), /is-error/);
  });
  await step('network error while loading communities is reported with retry', async () => {
    await page.route('**/api/communities?*', r => r.abort());
    await page.selectOption('#categoryFilter', 'Social');
    await page.waitForFunction(() => /could not reach/i.test(document.getElementById('emptyText').textContent));
    assert.ok(await page.isVisible('#retryCommunities'));
    await page.unroute('**/api/communities?*');
    await page.click('#retryCommunities');
    await page.waitForSelector('#communityGrid .community-card:not(.skeleton)');
    await page.selectOption('#categoryFilter', 'all');
    await page.waitForTimeout(300);
  });

  console.log('\nTest A — organizer (UI)');
  await step('organizer preview requires an account to publish', async () => {
    await page.click('#organizerNav');
    assert.ok(await page.isVisible('#organizerPreviewBanner'));
    assert.ok(await page.isDisabled('#communityName'));
    await page.click('#communitySubmit');
    await page.waitForSelector('#authModal:not(.hidden)');
    assert.equal(await page.isChecked('input[name=authRole][value=organizer]'), true);
  });
  await step('register organizer with validation errors first', async () => {
    await page.fill('#authName', 'Olivia Organizer');
    await page.fill('#authEmail', 'olivia@example.com');
    await page.fill('#authPassword', 'short');
    await page.click('#authSubmit');
    await page.waitForFunction(() => /at least 8 characters/.test(document.getElementById('authMessage').textContent));
    await page.fill('#authPassword', 'Organise123');
    await page.click('#authSubmit');
    await page.waitForSelector('#authModal.hidden', { state: 'attached' });
    await page.waitForSelector('#organizerStats:not(.hidden)');
    assert.match(await page.textContent('#accountSlot'), /Olivia/);
  });
  await step('create community with autocomplete location and uploaded photo', async () => {
    await page.fill('#communityName', 'Linthorpe Coders');
    await page.selectOption('#communityCategory', 'Technology');
    await page.fill('#communityDescription', 'Weekly coding evenings for all levels.');
    await page.fill('#communityStory', 'We started in a café in 2024 and now meet every Thursday.');
    await page.fill('#communityTown', 'Middles');
    await page.waitForSelector('#communityTownSuggestions .suggestion');
    await page.click('#communityTownSuggestions .suggestion >> nth=0');
    assert.equal(await page.inputValue('#communityTown'), 'Middlesbrough');
    assert.equal(await page.inputValue('#communityLatitude'), '54.5742');
    await page.fill('#communityAddress', 'Linthorpe Road');
    await page.setInputFiles('[data-photo-field=community] [data-photo-file]', photoFile);
    await page.waitForFunction(() => /^\/uploads\//.test(document.getElementById('communityImage').value));
    await shot('03-organizer-create-community');
    await page.click('#communitySubmit');
    await page.waitForFunction(() => /visible in public discovery/.test(document.getElementById('communityMessage').textContent));
    await page.click('[data-panel=manageCommunityPanel]');
    assert.match(await page.textContent('#organizerCommunities'), /Linthorpe Coders/);
  });
  await step('event validation: past date is rejected with a clear message', async () => {
    await page.click('[data-panel=createEventPanel]');
    await page.selectOption('#eventCommunity', { label: 'Linthorpe Coders' });
    await page.fill('#eventName', 'Intro to JavaScript');
    await page.fill('#eventDate', '2020-01-01');
    await page.fill('#eventTime', '18:30');
    await page.fill('#eventVenue', 'Linthorpe Library');
    await page.click('#eventSubmit');
    await page.waitForFunction(() => /cannot be in the past/.test(document.getElementById('eventMessage').textContent));
    assert.match(await page.getAttribute('#eventDate', 'class') || '', /field-error/);
  });
  await step('publish event; it appears in My events', async () => {
    await page.fill('#eventDate', isoDate(7));
    await page.fill('#eventDescription', 'Bring a laptop. Tea provided.');
    await page.fill('#eventPrice', '5');
    await page.fill('#eventCapacity', '20');
    await page.click('#eventSubmit');
    await page.waitForFunction(() => /listed in public events/.test(document.getElementById('eventMessage').textContent));
    await page.click('[data-panel=organizerEventsPanel]');
    assert.match(await page.textContent('#organizerEventList'), /Intro to JavaScript[\s\S]*0\/20 booked · £5/);
    await shot('04-organizer-events');
  });
  await step('organizer cannot use the participant space', async () => {
    await page.click('#participantNav');
    await page.waitForFunction(() => /signed in as an organizer/.test(document.getElementById('toast').textContent));
    assert.ok(await page.isVisible('#organizerView'));
  });
  await step('new community is in public discovery and events after logout', async () => {
    await page.click('#logoutBtn');
    await page.click('#eventsNav');
    await page.waitForFunction(() => /Intro to JavaScript/.test(document.getElementById('publicEvents').textContent));
    assert.match(await page.textContent('#communityGrid'), /Linthorpe Coders/);
  });

  console.log('\nTest B — participant (UI)');
  let communityUrl;
  await step('open community story: full photo shown uncropped', async () => {
    const card = page.locator('.community-card', { hasText: 'Linthorpe Coders' });
    await card.locator('a.join-btn').click();
    await page.waitForSelector('#communityContent h1:has-text("Linthorpe Coders")');
    communityUrl = page.url();
    assert.match(await page.textContent('#communityContent'), /We started in a café/);
    const img = await page.$eval('#communityContent .photo-main', i => ({ fit: getComputedStyle(i).objectFit, w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src') }));
    assert.equal(img.fit, 'contain');
    assert.ok(img.src.startsWith('/uploads/') && img.w > 0, 'uploaded photo loads from the server');
    await shot('05-community-story');
  });
  await step('join → asked to register → account created → joined', async () => {
    await page.click('#joinCommunity');
    await page.waitForSelector('#communityAuth:not(.hidden)');
    await page.fill('#authName', 'Priya Participant');
    await page.fill('#authEmail', 'priya@example.com');
    await page.fill('#authPassword', 'Participate1');
    await page.click('#authSubmit');
    await page.waitForFunction(() => /You joined Linthorpe Coders/.test(document.getElementById('joinNote').textContent));
    await page.waitForFunction(() => /You are part of this community/.test(document.getElementById('joinPanel').textContent));
    assert.match(await page.textContent('#communityContent'), /1 member/);
  });
  await step('register for the event from the event page', async () => {
    await page.click('#communityEvents a:has-text("View event")');
    await page.waitForSelector('#eventContent h1:has-text("Intro to JavaScript")');
    for (const t of ['Linthorpe Coders', '18:30', 'Linthorpe Library', 'Bring a laptop']) assert.ok((await page.textContent('#eventContent')).includes(t), t);
    await page.click('#registerForEvent');
    await page.waitForFunction(() => /You're registered for Intro to JavaScript/.test(document.getElementById('eventNote').textContent));
    assert.match(await page.textContent('#eventAccess'), /You are registered/);
    await shot('06-event-registered');
  });
  await step('participant dashboard shows joined community and registered event', async () => {
    await page.click('#eventAccess a:has-text("View my events")');
    await page.waitForSelector('#registeredEvents .event-item');
    assert.match(await page.textContent('#joinedCommunities'), /Linthorpe Coders/);
    assert.match(await page.textContent('#registeredEvents'), /Intro to JavaScript[\s\S]*Registered/);
    await shot('07-participant-dashboard');
  });
  await step('persistent login: reload keeps the participant signed in', async () => {
    await page.reload();
    await page.waitForSelector('#accountSlot .account-label');
    assert.match(await page.textContent('#accountSlot'), /Priya/);
  });
  await step('participant cannot open the organizer space', async () => {
    await page.click('#organizerNav');
    await page.waitForFunction(() => /signed in as a participant/.test(document.getElementById('toast').textContent));
  });

  console.log('\nEvent journey for a new visitor (requirement 8)');
  await step('visitor → event → register account → join community → register', async () => {
    await page.click('#logoutBtn');
    await page.goto(BASE + '/index.html#events');
    await page.waitForSelector('#publicEvents .event-card');
    await page.locator('#publicEvents .event-card', { hasText: 'Intro to JavaScript' }).locator('a.join-btn').click();
    await page.waitForSelector('#startRegister');
    await page.click('#startRegister');
    await page.fill('#authName', 'Sam Second');
    await page.fill('#authEmail', 'sam@example.com');
    await page.fill('#authPassword', 'Participate2');
    await page.click('#authSubmit');
    await page.waitForSelector('#joinThenRegister');
    assert.match(await page.textContent('#eventAccess'), /STEP 1 OF 2/);
    await page.click('#joinThenRegister');
    await page.waitForSelector('#registerForEvent');
    await page.click('#registerForEvent');
    await page.waitForFunction(() => /You're registered/.test(document.getElementById('eventNote').textContent));
  });
  await step('duplicate email shows an error on the detail page form', async () => {
    await page.click('#detailLogout');
    await page.click('#startRegister');
    await page.fill('#authName', 'Copy Cat');
    await page.fill('#authEmail', 'SAM@example.com');
    await page.fill('#authPassword', 'Participate2');
    await page.click('#authSubmit');
    await page.waitForFunction(() => /already exists/.test(document.getElementById('authMessage').textContent));
  });
  await step('wrong password and organizer login are explained', async () => {
    await page.click('#authToggle');
    await page.fill('#authEmail', 'sam@example.com');
    await page.fill('#authPassword', 'WrongPass9');
    await page.click('#authSubmit');
    await page.waitForFunction(() => /incorrect/.test(document.getElementById('authMessage').textContent));
    await page.fill('#authEmail', 'olivia@example.com');
    await page.fill('#authPassword', 'Organise123');
    await page.click('#authSubmit');
    await page.waitForFunction(() => /organizer account/.test(document.getElementById('authMessage').textContent));
  });
  await step('invalid community and event links show a not-found page', async () => {
    await page.goto(BASE + '/community.html?id=999999');
    await page.waitForSelector('#communityContent h1:has-text("Community not found")');
    await page.goto(BASE + '/event.html?id=abc');
    await page.waitForSelector('#eventContent h1:has-text("Event not found")');
  });

  console.log('\nTest C — persistence (restart server, log in again)');
  await step('restart server and log back in; data still there', async () => {
    await srv.stop();
    const again = await startServer({ dir, geocoderUrl: geo.url, env: { PORT: new URL(BASE).port } });
    srv.stop = again.stop;
    await page.goto(BASE + '/index.html');
    await page.click('#loginBtn');
    await page.fill('#authEmail', 'priya@example.com');
    await page.fill('#authPassword', 'Participate1');
    await page.click('#authSubmit');
    await page.waitForSelector('#registeredEvents .event-item');
    assert.match(await page.textContent('#joinedCommunities'), /Linthorpe Coders/);
    assert.match(await page.textContent('#registeredEvents'), /Intro to JavaScript/);
  });


  console.log('\nNew features — analytics, run again, attendance, ratings');
  const login = async (email, pw) => {
    await page.goto(BASE + '/index.html');
    if (await page.isVisible('#logoutBtn')) { await page.click('#logoutBtn'); }
    await page.click('#loginBtn');
    await page.fill('#authEmail', email);
    await page.fill('#authPassword', pw);
    await page.click('#authSubmit');
    await page.waitForSelector('#authModal.hidden', { state: 'attached' });
  };
  await step('event page shows the ticket price, places left and Add to calendar', async () => {
    await page.goto(BASE + `/event.html?id=${await eventIdByName('Intro to JavaScript')}`);
    await page.waitForSelector('#eventContent h1:has-text("Intro to JavaScript")');
    const t = await page.textContent('#eventContent');
    assert.match(t, /£5 \(pay on the day\)/);
    assert.match(t, /18 of 20 left/);
    const href = await page.getAttribute('.calendar-btn', 'href');
    const ics = await (await fetch(BASE + href)).text();
    assert.match(ics, /SUMMARY:Intro to JavaScript/);
  });
  await step('demo organizer opens straight onto the analytics dashboard with graphs', async () => {
    await login('demo-organizer@communityconnect.local', 'Demo12345');
    await page.waitForSelector('#analyticsPanel:not(.hidden) #chartPerEvent svg');
    assert.equal(await page.locator('#analyticsContent svg').count(), 4, 'per-event bars, revenue bars, monthly line, member line');
    assert.ok(await page.locator('#chartCommunity .viz-hrow').count() >= 5);
    assert.ok(await page.locator('#chartUpcoming .viz-hrow').count() >= 4);
    const kpis = await page.textContent('.kpi-row');
    assert.match(kpis, /Ticket revenue\s*£[\d,]+/);
    assert.match(kpis, /Attendance rate\s*\d+%/);
    assert.match(kpis, /★ \d/);
    await shot('14-analytics-dashboard');
  });
  await step('chart tooltip shows registered, attended, revenue and rating', async () => {
    const hit = (await page.$$('#chartPerEvent rect.viz-hit'))[2];
    await hit.scrollIntoViewIfNeeded();
    const bb = await hit.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height - 30);
    await page.waitForSelector('.viz-tooltip.show');
    assert.match(await page.textContent('.viz-tooltip'), /Registered\s*\d+[\s\S]*Attended\s*\d+[\s\S]*% attended · £/);
    await page.mouse.move(5, 5);
  });
  await step('analytics period switch and CSV download', async () => {
    await page.selectOption('#analyticsMonths', '12');
    await page.waitForFunction(() => document.querySelectorAll('#chartRevenue .viz-label').length === 12);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(csv.split('\n')[0], /Event.*Registered.*Attended.*Revenue/);
    assert.ok(csv.split('\n').length >= 16);
  });
  await step('"Run again" schedules a past event for next week in one click', async () => {
    await page.click('[data-panel=organizerEventsPanel]');
    const item = page.locator('#organizerEventList .manage-item', { hasText: 'October Book Night' }).first();
    await item.locator('[data-repeat]').click();
    await page.waitForFunction(() => /is scheduled again for/.test(document.getElementById('toast').textContent));
    const upcoming = page.locator('#organizerEventList .manage-item:not(.is-past)', { hasText: 'October Book Night' });
    assert.equal(await upcoming.count(), 1);
    assert.match(await upcoming.textContent(), /0\/20 booked · £3/);
  });
  await step('edit an upcoming event', async () => {
    await page.locator('#organizerEventList .manage-item:not(.is-past)', { hasText: 'October Book Night' }).locator('[data-edit-event]').click();
    assert.match(await page.textContent('#eventFormTitle'), /Edit/);
    await page.fill('#eventVenue', 'Newcastle City Library');
    await page.click('#eventSubmit');
    await page.waitForFunction(() => /has been updated/.test(document.getElementById('eventMessage').textContent));
    await page.click('[data-panel=organizerEventsPanel]');
    assert.match(await page.textContent('#organizerEventList'), /Newcastle City Library/);
  });
  await step('record attendance for a past event (Priya attended)', async () => {
    // Priya registered for a past demo event (set directly, as if she booked before it happened).
    const db = new Database(path.join(dir, 'test.sqlite'));
    const ev = db.prepare("SELECT id FROM events WHERE name = 'October Book Night' ORDER BY event_date LIMIT 1").get();
    const priya = db.prepare("SELECT id FROM users WHERE email = 'priya@example.com'").get();
    db.prepare("INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at, amount_pence) VALUES(?, ?, datetime('now'), 300)").run(priya.id, ev.id);
    db.close();
    await page.locator('#organizerEventList .manage-item.is-past', { hasText: 'October Book Night' }).locator('[data-attendance]').click();
    await page.waitForSelector('#attendancePanel:not(.hidden) .attendee');
    const before = Number(await page.textContent('#attCount'));
    const row = page.locator('.attendee', { hasText: 'Priya Participant' });
    await row.locator('input').check();
    await page.waitForFunction(n => Number(document.getElementById('attCount').textContent) === n + 1, before);
    await page.waitForSelector('.attendee.is-in:has-text("Priya Participant")');
    await shot('15-attendance');
  });
  await step('participant sees "Rate it", rates the event and gets recommendations', async () => {
    await login('priya@example.com', 'Participate1');
    await page.waitForSelector('#registeredEvents .event-item');
    await page.waitForSelector('#recommendations .recommend-card');
    assert.ok(await page.locator('#recommendations .recommend-card').count() >= 1);
    await page.click('#registeredEvents .rate-link');
    await page.waitForSelector('#feedbackForm');
    await page.click('[data-star="4"]');
    await page.fill('#feedbackComment', 'Lovely evening');
    await page.click('#feedbackForm button[type=submit]');
    await page.waitForFunction(() => /Thanks for your feedback/.test(document.getElementById('eventNote').textContent));
    assert.equal(await page.locator('.star.on').count(), 4);
    await shot('16-event-rating');
  });

  console.log('\nResponsive layouts');
  for (const [label, width, height] of [['tablet', 820, 1180], ['mobile', 390, 844]]) {
    await step(`${label} (${width}px): home, discovery, community, event, organizer — no horizontal overflow`, async () => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width, height });
      await p.goto(BASE + '/');
      await p.waitForSelector('#homeEventGrid .event-card');
      await noOverflow(p); await shot(`08-${label}-home`, p);
      await p.click('#exploreBtn');
      await p.waitForSelector('#communityGrid .community-card:not(.skeleton)');
      await p.fill('#locationSearch', 'Middles');
      await p.waitForSelector('#locationSuggestions .suggestion');
      await shot(`09-${label}-autocomplete`, p);
      await p.click('#locationSuggestions .suggestion >> nth=0');
      await p.waitForTimeout(500);
      await noOverflow(p); await shot(`10-${label}-discovery`, p);
      await p.goto(communityUrl);
      await p.waitForSelector('#communityContent h1');
      await noOverflow(p); await shot(`11-${label}-community`, p);
      await p.goto(BASE + `/event.html?id=${await eventIdByName('Intro to JavaScript')}`);
      await p.waitForSelector('#eventContent h1');
      await noOverflow(p); await shot(`12-${label}-event`, p);
      await p.goto(BASE + '/index.html');
      await p.evaluate(() => localStorage.clear());
      await p.reload();
      await p.click('#loginBtn');
      await p.fill('#authEmail', 'demo-organizer@communityconnect.local');
      await p.fill('#authPassword', 'Demo12345');
      await p.click('#authSubmit');
      await p.waitForSelector('#chartPerEvent svg');
      await p.waitForTimeout(400);
      await noOverflow(p); await shot(`14-${label}-analytics`, p);
      await p.evaluate(() => localStorage.clear());
      await p.goto(BASE + '/index.html#organizer');
      await p.reload();
      await p.waitForSelector('#organizerView:not(.hidden)');
      await noOverflow(p); await shot(`13-${label}-organizer`, p);
      await p.close();
    });
  }

  await step('no JavaScript errors were thrown on any page', async () => { assert.deepEqual(pageErrors, []); });

  await browser.close();
  await srv.stop();
  await geo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser steps passed. Screenshots: ${SHOTS}`);
  fs.writeFileSync(path.join(__dirname, 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
