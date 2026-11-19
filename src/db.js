'use strict';
/**
 * SQLite database: connection, versioned migrations and optional demo seed.
 * Migrations are additive only — existing tables and rows are never dropped.
 * The schema version is tracked with PRAGMA user_version.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const migrations = [
  // 1 — base schema (compatible with the original starter project's tables)
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN('participant','organizer'))
      );
      CREATE TABLE IF NOT EXISTS communities(
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        story TEXT DEFAULT '',
        town TEXT NOT NULL,
        address TEXT DEFAULT '',
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS memberships(
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, community_id)
      );
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY,
        community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT NOT NULL,
        venue TEXT NOT NULL,
        description TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS event_registrations(
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, event_id)
      );
    `);
    addColumn(db, 'communities', 'story', "TEXT DEFAULT ''");
  },
  // 2 — photographs, timestamps, publication status and indexes
  db => {
    addColumn(db, 'users', 'created_at', 'TEXT');
    db.exec("UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL");
    addColumn(db, 'communities', 'image_url', "TEXT DEFAULT ''");
    addColumn(db, 'communities', 'postcode', "TEXT DEFAULT ''");
    addColumn(db, 'communities', 'status', "TEXT NOT NULL DEFAULT 'published'");
    addColumn(db, 'communities', 'updated_at', 'TEXT');
    db.exec("UPDATE communities SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, created_at, datetime('now'))");
    addColumn(db, 'events', 'image_url', "TEXT DEFAULT ''");
    addColumn(db, 'events', 'status', "TEXT NOT NULL DEFAULT 'published'");
    addColumn(db, 'events', 'created_at', 'TEXT');
    db.exec("UPDATE events SET created_at = datetime('now') WHERE created_at IS NULL");
    addColumn(db, 'memberships', 'joined_at', 'TEXT');
    db.exec("UPDATE memberships SET joined_at = datetime('now') WHERE joined_at IS NULL");
    addColumn(db, 'event_registrations', 'registered_at', 'TEXT');
    db.exec("UPDATE event_registrations SET registered_at = datetime('now') WHERE registered_at IS NULL");
    // Remove orphaned rows that older versions could have produced.
    db.exec(`
      DELETE FROM events WHERE community_id IS NULL OR community_id NOT IN (SELECT id FROM communities);
      DELETE FROM memberships WHERE user_id NOT IN (SELECT id FROM users) OR community_id NOT IN (SELECT id FROM communities);
      DELETE FROM event_registrations WHERE user_id NOT IN (SELECT id FROM users) OR event_id NOT IN (SELECT id FROM events);
      CREATE INDEX IF NOT EXISTS idx_communities_owner ON communities(owner_id);
      CREATE INDEX IF NOT EXISTS idx_communities_category ON communities(category);
      CREATE INDEX IF NOT EXISTS idx_communities_location ON communities(latitude, longitude);
      CREATE INDEX IF NOT EXISTS idx_events_community ON events(community_id);
      CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date, event_time);
      CREATE INDEX IF NOT EXISTS idx_memberships_community ON memberships(community_id);
      CREATE INDEX IF NOT EXISTS idx_registrations_event ON event_registrations(event_id);
    `);
  },
  // 3 — ticket prices, capacity, attendance check-in, amount paid and event feedback (analytics)
  db => {
    addColumn(db, 'events', 'price_pence', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'events', 'capacity', 'INTEGER');
    addColumn(db, 'events', 'repeated_from', 'INTEGER');
    addColumn(db, 'event_registrations', 'attended', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'event_registrations', 'checked_in_at', 'TEXT');
    addColumn(db, 'event_registrations', 'amount_pence', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_feedback(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT DEFAULT '',
        created_at TEXT,
        PRIMARY KEY(user_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_event ON event_feedback(event_id);
      CREATE INDEX IF NOT EXISTS idx_registrations_user ON event_registrations(user_id);
    `);
  },
  // 4 — ticket tiers (early bird / standard), promo codes and online payments
  db => {
    addColumn(db, 'events', 'early_price_pence', 'INTEGER');
    addColumn(db, 'events', 'early_until', 'TEXT');          // 'YYYY-MM-DDTHH:MM' UK local time
    addColumn(db, 'events', 'early_limit', 'INTEGER');       // optional number of early-bird tickets
    addColumn(db, 'event_registrations', 'ticket_type', 'TEXT');      // free | early_bird | standard
    addColumn(db, 'event_registrations', 'list_price_pence', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'event_registrations', 'promo_code', 'TEXT');
    addColumn(db, 'event_registrations', 'payment_status', "TEXT NOT NULL DEFAULT 'free'"); // free | pending | paid
    addColumn(db, 'event_registrations', 'payment_ref', 'TEXT');
    addColumn(db, 'event_registrations', 'paid_at', 'TEXT');
    db.exec(`
      UPDATE event_registrations SET
        payment_status = CASE WHEN amount_pence > 0 THEN 'paid' ELSE 'free' END,
        ticket_type = COALESCE(ticket_type, CASE WHEN amount_pence > 0 THEN 'standard' ELSE 'free' END),
        list_price_pence = CASE WHEN list_price_pence = 0 THEN amount_pence ELSE list_price_pence END,
        paid_at = CASE WHEN amount_pence > 0 THEN COALESCE(paid_at, registered_at) ELSE paid_at END;
      CREATE TABLE IF NOT EXISTS event_promo_codes(
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        code TEXT NOT NULL COLLATE NOCASE,
        percent_off INTEGER NOT NULL CHECK(percent_off BETWEEN 1 AND 100),
        max_uses INTEGER,
        created_at TEXT,
        UNIQUE(event_id, code)
      );
      CREATE INDEX IF NOT EXISTS idx_registrations_payment ON event_registrations(payment_ref);
    `);
  },
  // 5 — QR tickets & check-in, referrals, featured events, flash sales, waitlist, notifications
  db => {
    addColumn(db, 'event_registrations', 'ticket_code', 'TEXT');     // secret code inside the ticket QR
    addColumn(db, 'event_registrations', 'referral_code', 'TEXT');   // this ticket holder's "bring a friend" code
    addColumn(db, 'event_registrations', 'referred_by', 'INTEGER');  // user who referred this booking
    addColumn(db, 'event_registrations', 'checked_in_by', 'INTEGER');
    addColumn(db, 'events', 'featured', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'events', 'flash_percent', 'INTEGER');
    addColumn(db, 'events', 'flash_until', 'TEXT');                   // 'YYYY-MM-DDTHH:MM' UK local time
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_waitlist(
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN('waiting','offered')),
        created_at TEXT NOT NULL, offered_at TEXT,
        PRIMARY KEY(user_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS notifications(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', link TEXT DEFAULT '',
        created_at TEXT NOT NULL, read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_waitlist_event ON event_waitlist(event_id, status, created_at);
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_registration_codes AFTER INSERT ON event_registrations
      WHEN NEW.ticket_code IS NULL OR NEW.referral_code IS NULL
      BEGIN
        UPDATE event_registrations SET ticket_code = COALESCE(ticket_code, lower(hex(randomblob(12)))),
          referral_code = COALESCE(referral_code, lower(hex(randomblob(4))))
        WHERE user_id = NEW.user_id AND event_id = NEW.event_id;
      END;
    `);
    ensureCodes(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_ticket_code ON event_registrations(ticket_code);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_referral_code ON event_registrations(referral_code);
    `);
  },
  // 6 — platform admin, commission (platform fee) per ticket, organizer payouts, event cancellation, Google sign-in
  db => {
    addColumn(db, 'event_registrations', 'platform_fee_pence', 'INTEGER');   // our commission on this ticket
    addColumn(db, 'event_registrations', 'organizer_net_pence', 'INTEGER');  // what the organizer receives
    addColumn(db, 'event_registrations', 'fee_percent', 'INTEGER');          // commission rate at the time of sale
    addColumn(db, 'event_registrations', 'refunded_at', 'TEXT');
    addColumn(db, 'events', 'cancelled_at', 'TEXT');
    addColumn(db, 'events', 'cancel_reason', 'TEXT');
    addColumn(db, 'users', 'google_sub', 'TEXT');                             // Google account id (Continue with Google)
    db.exec(`
      CREATE TABLE IF NOT EXISTS admins(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payouts(
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
        organizer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tickets INTEGER NOT NULL DEFAULT 0,
        gross_pence INTEGER NOT NULL DEFAULT 0,
        fee_pence INTEGER NOT NULL DEFAULT 0,
        net_pence INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN('ready','paid')),
        reference TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payouts_organizer ON payouts(organizer_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub);
    `);
  }
];

/** Fills in the commission split for paid tickets that don't have it yet (fee rate = PLATFORM_FEE_PERCENT at that moment). */
function ensureFees(db, percent) {
  db.prepare(`UPDATE event_registrations SET fee_percent = ?, platform_fee_pence = CAST(ROUND(amount_pence * ? / 100.0) AS INTEGER),
      organizer_net_pence = amount_pence - CAST(ROUND(amount_pence * ? / 100.0) AS INTEGER)
    WHERE payment_status = 'paid' AND platform_fee_pence IS NULL`).run(percent, percent, percent);
  db.prepare(`UPDATE event_registrations SET fee_percent = 0, platform_fee_pence = 0, organizer_net_pence = 0
    WHERE payment_status = 'free' AND platform_fee_pence IS NULL`).run();
}

/** Gives every registration a random ticket code (QR) and referral code if it doesn't have one yet. */
function ensureCodes(db) {
  db.exec(`UPDATE event_registrations SET ticket_code = lower(hex(randomblob(12))) WHERE ticket_code IS NULL;
           UPDATE event_registrations SET referral_code = lower(hex(randomblob(4))) WHERE referral_code IS NULL;`);
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < migrations.length; v++) {
    const run = db.transaction(() => {
      migrations[v](db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
    console.log(`[db] Applied migration ${v + 1}`);
  }
}

function isoDate(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SEED_COMMUNITIES = [
  { name: 'Teesside Tech Collective', category: 'Technology', town: 'Middlesbrough', address: 'Teesside University, Middlesbrough', postcode: 'TS1 3BX', lat: 54.5707, lon: -1.2347,
    description: 'A welcoming space for developers, students and curious minds to learn and build together.',
    story: 'Teesside Tech Collective brings curious people together to learn, share ideas and build useful technology. Whether you are starting out or have years of experience, our community is a place to ask questions, collaborate and grow.',
    image: 'https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Weekend Run Club', category: 'Sports & Fitness', town: 'Middlesbrough', address: 'Albert Park, Linthorpe Road, Middlesbrough', postcode: 'TS1 3LB', lat: 54.5615, lon: -1.2390,
    description: 'Friendly weekly runs for every pace, followed by coffee and conversation.',
    story: 'Weekend Run Club began with a simple idea: make running welcoming for everyone. We meet locally, support every pace and finish with friendly conversation. New runners are always welcome.',
    image: 'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Creative Makers Circle', category: 'Arts & Hobbies', town: 'Stockton-on-Tees', address: 'Stockton High Street', postcode: '', lat: 54.5705, lon: -1.3187,
    description: 'Meet local makers, share your work and try something creative in a relaxed space.',
    story: 'Creative Makers Circle is a friendly space to experiment, share skills and celebrate creativity. Members bring projects, exchange ideas and learn from one another in relaxed workshops.',
    image: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Community Hands', category: 'Volunteering', town: 'Yarm', address: 'Yarm High Street', postcode: '', lat: 54.5090, lon: -1.3570,
    description: 'Small local actions, friendly volunteers and practical ways to make a difference.',
    story: 'Community Hands connects neighbours who want to make a practical difference. From local clean-ups to helping community projects, we believe small actions can create meaningful change.',
    image: 'https://images.unsplash.com/photo-1559027615-cd4628902d4a?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Sunday Table', category: 'Social', town: 'Stockton-on-Tees', address: 'Stockton town centre', postcode: '', lat: 54.5650, lon: -1.3150,
    description: 'Good food, new conversations and simple get-togethers for people nearby.',
    story: 'Sunday Table creates relaxed opportunities for people nearby to share food, meet new friends and enjoy conversation. Come as you are and help make everyone feel welcome.',
    image: 'https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Faith & Fellowship', category: 'Faith', town: 'Middlesbrough', address: 'Middlesbrough town centre', postcode: '', lat: 54.5760, lon: -1.2350,
    description: 'A supportive local space for fellowship, encouragement and serving others.',
    story: 'Faith & Fellowship is a welcoming local community centred on encouragement, friendship, fellowship and serving others. Visitors can learn about the group before deciding whether to join.',
    image: 'https://images.unsplash.com/photo-1438232992991-995b7058bbb3?auto=format&fit=crop&w=1200&q=85' },
  { name: 'Tyneside Book & Coffee Club', category: 'Social', town: 'Newcastle upon Tyne', address: 'Grainger Town, Newcastle upon Tyne', postcode: '', lat: 54.9738, lon: -1.6132,
    description: 'Monthly book chats, coffee and friendly debate for readers of every kind.',
    story: 'We started as four friends swapping paperbacks in a café. Today we are a relaxed monthly club where readers meet, share recommendations and enjoy good conversation.',
    image: 'https://images.unsplash.com/photo-1528605248644-14dd04022da1?auto=format&fit=crop&w=1200&q=85' }
];

// Upcoming starter events: price in pounds, capacity (null = unlimited).
const SEED_EVENTS = [
  { community: 0, name: 'Build Something Weekend', days: 9, time: '10:00', venue: 'Teesside University Campus Heart', price: 5, capacity: 30, early: { price: 3, daysLeft: 4, limit: 12 }, promo: ['STUDENT20', 20, 50], description: 'A friendly build-and-learn session. Bring a laptop and an idea — mentors will be on hand.', image: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80' },
  { community: 1, name: 'Saturday Morning Run', days: 2, time: '09:00', venue: 'Albert Park main gates', price: 0, capacity: 40, description: 'A 5k loop for all paces, followed by coffee. Beginners very welcome.', image: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?auto=format&fit=crop&w=1200&q=80' },
  { community: 2, name: 'Make & Meet Workshop', days: 6, time: '13:00', venue: 'Stockton Central Library', price: 8, capacity: 15, early: { price: 6, daysLeft: 2, limit: 8 }, promo: ['MAKER10', 10, null], description: 'Bring an idea and make something. Materials provided.', image: '' },
  { community: 6, name: 'November Book Night', days: 12, time: '19:00', venue: 'Grainger Market café', price: 3, capacity: 20, early: { price: 2, daysLeft: 7, limit: null }, description: 'This month we discuss a short novel of the group\'s choosing. Newcomers welcome.', image: '' }
];

// Past events, so the organizer analytics have real history to show.
// [community index, name, days ago, time, venue, price £, capacity]
const SEED_PAST_EVENTS = [
  [0, 'Intro to Python Night', 150, '18:30', 'Teesside University, Room G1', 0, 30],
  [1, 'Summer 5k Fun Run', 140, '09:00', 'Albert Park main gates', 0, 50],
  [2, 'Watercolour Basics', 128, '13:00', 'Stockton Central Library', 10, 16],
  [0, 'Web Dev Workshop', 115, '18:30', 'Teesside University, Room G1', 5, 30],
  [4, 'Summer Picnic Social', 104, '12:00', 'Ropner Park', 0, 40],
  [3, 'Riverside Clean-up', 95, '10:00', 'Yarm riverside', 0, 25],
  [1, 'Hill Training Session', 84, '08:30', 'Eston Hills car park', 0, 25],
  [0, 'AI Hack Evening', 72, '18:00', 'Teesside University Campus Heart', 8, 35],
  [2, 'Pottery Taster Class', 60, '14:00', 'Stockton Arts Centre', 15, 12],
  [6, 'September Book Night', 52, '19:00', 'Grainger Market café', 3, 20],
  [4, 'Autumn Supper Club', 40, '19:00', 'Stockton town centre', 12, 24],
  [0, 'Cloud Basics Meetup', 30, '18:30', 'Teesside University, Room G1', 5, 30],
  [1, 'Autumn 10k', 21, '09:00', 'Albert Park main gates', 6, 60],
  [6, 'October Book Night', 18, '19:00', 'Grainger Market café', 3, 20],
  [3, 'Food Bank Volunteering Day', 9, '10:00', 'Middlesbrough Food Bank', 0, 20]
];

const DEMO_FIRST = ['Amira', 'Ben', 'Chloe', 'Daniel', 'Ella', 'Farhan', 'Grace', 'Harry', 'Isla', 'Jack', 'Kavya', 'Liam', 'Maya', 'Noah', 'Olivia', 'Priya', 'Quinn', 'Ravi', 'Sophie', 'Tom', 'Uma', 'Vikram', 'Willow', 'Yusuf', 'Zara', 'Leo', 'Mia', 'Arjun', 'Ruby', 'Sam'];
const DEMO_LAST = ['Khan', 'Smith', 'Patel', 'Brown', 'Jones', 'Ali', 'Taylor', 'Wilson', 'Reddy', 'Evans'];

/** Small deterministic random generator so the demo data is the same every time. */
function rng(seedValue) {
  let a = seedValue >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sqlDate(daysFromToday, time = '12:00') { return `${isoDate(daysFromToday)} ${time}:00`; }

function seed(db, config) {
  if (!config.seedDemoData) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM communities').get().n;
  if (count > 0) return;
  const email = 'demo-organizer@communityconnect.local';
  const password = config.seedOrganizerPassword || (config.isProduction ? crypto.randomBytes(24).toString('hex') : 'Demo12345');
  const rand = rng(20261112);
  const insert = db.transaction(() => {
    let owner = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!owner) {
      const r = db.prepare("INSERT INTO users(name, email, password_hash, role, created_at) VALUES(?, ?, ?, 'organizer', ?)")
        .run('Alex Morgan', email, bcrypt.hashSync(password, 10), sqlDate(-200));
      owner = { id: Number(r.lastInsertRowid) };
    }
    const ids = SEED_COMMUNITIES.map((c, i) => Number(db.prepare(`INSERT INTO communities
      (owner_id, name, category, description, story, town, address, postcode, latitude, longitude, image_url, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`)
      .run(owner.id, c.name, c.category, c.description, c.story, c.town, c.address, c.postcode, c.lat, c.lon, c.image, sqlDate(-190 + i), sqlDate(-190 + i)).lastInsertRowid));

    // Demo members (they cannot log in: random passwords).
    const demoHash = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 10);
    const members = DEMO_FIRST.map((first, i) => {
      const last = DEMO_LAST[i % DEMO_LAST.length];
      const r = db.prepare("INSERT INTO users(name, email, password_hash, role, created_at) VALUES(?, ?, ?, 'participant', ?)")
        .run(`${first} ${last}`, `${first.toLowerCase()}.${last.toLowerCase()}${i}@demo.communityconnect.local`, demoHash, sqlDate(-180 + i * 5));
      return { id: Number(r.lastInsertRowid), joinedDay: -175 + Math.floor(rand() * 165) };
    });

    // Memberships spread over the last six months (gives the member-growth chart a real curve).
    const joinedAt = new Map(); // `${user}:${community}` -> days ago
    for (const m of members) {
      for (let ci = 0; ci < ids.length; ci++) {
        if (rand() < (ci === 0 || ci === 1 ? 0.55 : 0.32)) {
          const day = Math.min(-1, m.joinedDay + Math.floor(rand() * 40));
          db.prepare('INSERT OR IGNORE INTO memberships(user_id, community_id, joined_at) VALUES(?, ?, ?)').run(m.id, ids[ci], sqlDate(day));
          joinedAt.set(`${m.id}:${ci}`, day);
        }
      }
    }

    const insertEvent = db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, price_pence, capacity, status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`);
    const insertReg = db.prepare(`INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at, attended, checked_in_at, amount_pence,
      ticket_type, list_price_pence, promo_code, payment_status, payment_ref, paid_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    /** Seeds one registration with a realistic ticket type: early bird (first ~40%), promo (some), standard. */
    const seedReg = (userId, eventId, regAt, attended, checkedIn, pricePence, position, total) => {
      if (!pricePence) return insertReg.run(userId, eventId, regAt, attended, checkedIn, 0, 'free', 0, null, 'free', null, null);
      const early = position < Math.ceil(total * 0.4);
      const list = early ? Math.round(pricePence * 0.7 / 50) * 50 : pricePence;
      const promo = !early && rand() < 0.2 ? 'STUDENT20' : null;
      const amount = promo ? Math.round(list * 0.8) : list;
      return insertReg.run(userId, eventId, regAt, attended, checkedIn, amount, early ? 'early_bird' : 'standard', list, promo, 'paid', `seed_${eventId}_${userId}`, regAt);
    };
    const comments = ['Really friendly group!', 'Well organised, will come again.', 'Great venue and people.', 'Loved it.', 'Good session, a bit busy.', ''];

    // Past events with registrations, attendance, revenue and ratings.
    for (const [ci, name, daysAgo, time, venue, price, capacity] of SEED_PAST_EVENTS) {
      const eventId = Number(insertEvent.run(ids[ci], name, isoDate(-daysAgo), time, venue, `${name} with ${SEED_COMMUNITIES[ci].name}.`, '', price * 100, capacity, sqlDate(-daysAgo - 14)).lastInsertRowid);
      const eligible = members.filter(m => joinedAt.has(`${m.id}:${ci}`) && joinedAt.get(`${m.id}:${ci}`) < -daysAgo);
      const pool = eligible.length >= 6 ? eligible : members; // early events: anyone could attend
      const target = Math.min(capacity, Math.max(5, Math.round(pool.length * (0.55 + rand() * 0.4))));
      const chosen = pool.slice().sort(() => rand() - 0.5).slice(0, target);
      const showRate = 0.62 + rand() * 0.3;
      chosen.forEach((m, pos) => {
        const attended = rand() < showRate ? 1 : 0;
        seedReg(m.id, eventId, sqlDate(-daysAgo - 12 + Math.floor((pos / chosen.length) * 11)), attended, attended ? `${isoDate(-daysAgo)} ${time}:00` : null, price * 100, pos, chosen.length);
        if (attended && rand() < 0.6) {
          const rating = rand() < 0.55 ? 5 : rand() < 0.7 ? 4 : 3;
          db.prepare('INSERT OR IGNORE INTO event_feedback(user_id, event_id, rating, comment, created_at) VALUES(?, ?, ?, ?, ?)')
            .run(m.id, eventId, rating, comments[Math.floor(rand() * comments.length)], sqlDate(-daysAgo + 1));
        }
      });
    }

    // Upcoming events, with some places already booked.
    for (const e of SEED_EVENTS) {
      const eventId = Number(insertEvent.run(ids[e.community], e.name, isoDate(e.days), e.time, e.venue, e.description, e.image, e.price * 100, e.capacity, sqlDate(-5)).lastInsertRowid);
      if (e.early) {
        db.prepare('UPDATE events SET early_price_pence = ?, early_until = ?, early_limit = ? WHERE id = ?')
          .run(e.early.price * 100, `${isoDate(e.early.daysLeft)}T23:59`, e.early.limit, eventId);
      }
      if (e.promo) {
        db.prepare("INSERT INTO event_promo_codes(event_id, code, percent_off, max_uses, created_at) VALUES(?, ?, ?, ?, datetime('now'))").run(eventId, e.promo[0], e.promo[1], e.promo[2]);
      }
      const pool = members.filter(m => joinedAt.has(`${m.id}:${e.community}`));
      const booked = pool.slice(0, Math.min(pool.length, Math.round((e.capacity || 20) * (0.25 + rand() * 0.3))));
      booked.forEach((m, pos) => {
        const regAt = sqlDate(-Math.ceil(rand() * 4));
        if (!e.price) return insertReg.run(m.id, eventId, regAt, 0, null, 0, 'free', 0, null, 'free', null, null);
        const early = e.early && pos < Math.min(booked.length - 1, e.early.limit ? e.early.limit - 4 : 99); // leave a few early-bird tickets for the demo
        const list = (early ? e.early.price : e.price) * 100;
        insertReg.run(m.id, eventId, regAt, 0, null, list, early ? 'early_bird' : 'standard', list, null, 'paid', `seed_${eventId}_${m.id}`, regAt);
      });
    }
  });
  insert();
  console.log(`[db] Added starter data: ${SEED_COMMUNITIES.length} communities, ${SEED_PAST_EVENTS.length} past and ${SEED_EVENTS.length} upcoming events, ${DEMO_FIRST.length} demo members (set SEED_DEMO_DATA=false to disable).`);
  if (!config.seedOrganizerPassword && !config.isProduction) {
    console.log(`[db] Demo organizer login (for the analytics demo): ${email} / ${password}`);
  }
}

function openDatabase(config) {
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  seed(db, config);
  if (config.seedDemoData) refreshDemoExtras(db, config.platformFeePercent ?? 10);
  ensureAdmin(db, config);
  ensureFees(db, config.platformFeePercent ?? 10);
  return db;
}

/** Creates the platform admin account once (ADMIN_EMAIL / ADMIN_PASSWORD; development default Admin12345). */
function ensureAdmin(db, config) {
  const email = String(config.adminEmail || 'admin@communityconnect.local').toLowerCase();
  const row = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  const given = config.adminPassword;
  if (row) {
    if (given) db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(given, 10), row.id);
    return;
  }
  const password = given || (config.isProduction ? null : 'Admin12345');
  if (!password) {
    console.log('[db] No admin account yet: set ADMIN_PASSWORD (and optionally ADMIN_EMAIL) in the environment to create it.');
    return;
  }
  db.prepare("INSERT INTO admins(name, email, password_hash, created_at) VALUES('Admin', ?, ?, datetime('now'))").run(email, bcrypt.hashSync(password, 10));
  if (!given) console.log(`[db] Admin login (platform dashboard): ${email} / ${password}`);
}

const localStamp = d => {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/**
 * Keeps the demo data presentation-ready (only touches the demo organizer's starter events):
 * - "Open Evening & Networking" is always within the next ~26 hours, so QR check-in can be shown live;
 * - "Build Something Weekend" is featured; "November Book Night" has a live 40% flash sale.
 * Safe to run on every start; real organizers' events are never changed.
 */
const IMG = id => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1200&q=80`;
// Extra demo events (added once, by name). days = from today; negative = already happened.
const DEMO_MORE_EVENTS = [
  { community: 'Teesside Tech Collective', name: 'AI for Beginners Workshop', days: 4, time: '18:00', venue: 'Teesside University, Phoenix Building', price: 800, early: [500, 2], capacity: 30, sold: 21, img: '1677442136019-21780ecad995', desc: 'Hands-on intro to ChatGPT, Claude and image AI — no coding needed. Laptops provided.' },
  { community: 'Teesside Tech Collective', name: 'Hackathon: Build for Teesside', days: 17, time: '09:30', venue: 'Boho Zone, Middlesbrough', price: 1000, capacity: 40, sold: 12, img: '1504384308090-c894fdcc538d', desc: '24-hour hackathon with local businesses. Teams of 3–5, prizes for the best ideas.' },
  { community: 'Weekend Run Club', name: 'Riverside 10K Social Run', days: 8, time: '08:30', venue: 'Stockton Riverside, Infinity Bridge', price: 0, capacity: 60, sold: 33, img: '1452626038306-9aae5e071dd3', desc: 'A friendly 10K along the Tees. All paces welcome, coffee afterwards.' },
  { community: 'Weekend Run Club', name: 'Christmas Fun Run 5K', days: 26, time: '10:00', venue: 'Albert Park, Middlesbrough', price: 500, early: [300, 10], capacity: 80, sold: 18, img: '1513593771513-7b58b6c4af38', desc: 'Festive 5K in fancy dress. Medal and mince pie for every finisher.' },
  { community: 'Creative Makers Circle', name: 'Christmas Wreath Making', days: 14, time: '14:00', venue: 'Stockton Arts Centre', price: 1500, early: [1200, 5], capacity: 16, sold: 13, img: '1512389142860-9c449e58a543', desc: 'Make a fresh wreath to take home. All materials and mulled drinks included.' },
  { community: 'Community Hands', name: 'Riverbank Litter Pick', days: 3, time: '10:00', venue: 'Yarm Bridge', price: 0, capacity: 30, sold: 17, img: '1618477461853-cf6ed80faba5', desc: 'Two hours helping keep the Tees clean. Gloves and pickers provided.' },
  { community: 'Community Hands', name: 'Winter Food Bank Drive', days: 11, time: '11:00', venue: 'Yarm Methodist Church Hall', price: 0, capacity: 25, sold: 9, img: '1593113598332-cd288d649433', desc: 'Sort and pack food parcels for local families this winter.' },
  { community: 'Sunday Table', name: 'Street Food Night', days: 6, time: '18:30', venue: 'Stockton Globe courtyard', price: 600, capacity: 50, sold: 38, img: '1555939594-58d7cb561ad1', desc: 'Share plates from five local street food traders. Includes two tasting tokens.' },
  { community: 'Faith & Fellowship', name: 'Carols by Candlelight', days: 20, time: '19:00', venue: "St Hilda's Church, Middlesbrough", price: 0, capacity: 120, sold: 41, img: '1512389098783-66b81f86e199', desc: 'An evening of carols, readings and hot chocolate. Everyone welcome.' },
  { community: 'Tyneside Book & Coffee Club', name: 'Author Talk & Signing', days: 9, time: '18:00', venue: 'Newcastle City Library', price: 400, capacity: 40, sold: 19, img: '1524995997946-a1c2e315a42f', desc: 'A local novelist talks about writing, then signs copies. Coffee included.' }
];
const DEMO_ORGANIZERS = [
  { name: 'Sara Khan', email: 'sara.khan@demo.communityconnect.local', joined: -95,
    community: { name: 'Leeds Board Gamers', category: 'Social', town: 'Leeds', address: 'North Bar, New Briggate, Leeds', lat: 53.8008, lon: -1.5410, img: '1610890716171-6b1bb98ffd09',
      description: 'Friendly board game nights for beginners and strategy fans.', story: 'Started by Sara in a café with six people and a box of Catan. Now 40+ members meet every fortnight.' },
    events: [
      { name: 'Board Game Marathon', days: -38, time: '12:00', venue: 'Thought Bubble Café, Leeds', price: 500, capacity: 30, sold: 26, paidOut: true },
      { name: 'Strategy Games Night', days: -9, time: '18:30', venue: 'North Bar, Leeds', price: 400, capacity: 24, sold: 20 },
      { name: 'Beginners Games Evening', days: 5, time: '18:30', venue: 'North Bar, Leeds', price: 300, capacity: 24, sold: 15 },
      { name: 'Christmas Games Party', days: 23, time: '17:00', venue: 'Leeds Corn Exchange', price: 800, early: [600, 8], capacity: 50, sold: 22 }
    ] },
  { name: 'Tom Reed', email: 'tom.reed@demo.communityconnect.local', joined: -48,
    community: { name: 'Durham Photo Walks', category: 'Arts & Hobbies', town: 'Durham', address: 'Durham Market Place', lat: 54.7761, lon: -1.5733, img: '1452587925148-ce544e77e70d',
      description: 'Guided photography walks around Durham for every camera and phone.', story: 'Tom, a local photographer, started the walks to help people see Durham differently.' },
    events: [
      { name: 'Golden Hour at the Cathedral', days: -21, time: '15:30', venue: 'Palace Green, Durham', price: 1200, capacity: 15, sold: 15, paidOut: true },
      { name: 'Night Photography Walk', days: -4, time: '19:00', venue: 'Framwellgate Bridge, Durham', price: 1000, capacity: 15, sold: 12 },
      { name: 'Phone Photography Basics', days: 7, time: '11:00', venue: 'Durham Market Place', price: 600, capacity: 20, sold: 11 },
      { name: 'Winter Riverside Walk', days: 19, time: '13:00', venue: 'Prebends Bridge, Durham', price: 800, capacity: 15, sold: 6 }
    ] }
];

/** Adds the extra demo events, demo organizers and payout history (only once; matched by name). */
function ensureDemoContent(db, owner, feePercent) {
  const r = rng(424242);
  const participants = db.prepare("SELECT id FROM users WHERE role = 'participant' AND email LIKE '%@demo.communityconnect.local' ORDER BY id").all().map(x => x.id);
  if (!participants.length) return;
  const pick = n => { const a = [...participants]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, Math.min(n, a.length)); };
  const join = (uid, cid, days) => db.prepare('INSERT OR IGNORE INTO memberships(user_id, community_id, joined_at) VALUES(?, ?, ?)').run(uid, cid, sqlDate(days));
  const insertEvent = db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, price_pence, capacity,
      early_price_pence, early_until, early_limit, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'published', ?)`);
  const insertReg = db.prepare(`INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at, attended, checked_in_at, amount_pence, ticket_type, list_price_pence, payment_status, payment_ref, paid_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  function addEvent(cid, e) {
    if (db.prepare('SELECT 1 FROM events WHERE community_id = ? AND name = ?').get(cid, e.name)) return null;
    const earlyUntil = e.early && e.days - e.early[1] > 0 ? `${isoDate(e.days - e.early[1])}T23:59` : null;
    const created = Math.min(-2, e.days - 30);
    const id = Number(insertEvent.run(cid, e.name, isoDate(e.days), e.time, e.venue, e.desc || '', e.img ? IMG(e.img) : '', e.price, e.capacity,
      earlyUntil ? e.early[0] : null, earlyUntil, sqlDate(created)).lastInsertRowid);
    const buyers = pick(e.sold);
    buyers.forEach((uid, i) => {
      join(uid, cid, created - 5);
      const regDay = Math.min(e.days - 1, created + 1 + Math.floor((i / Math.max(1, buyers.length)) * Math.max(1, Math.min(-1, e.days) - created)));
      const at = sqlDate(Math.min(regDay, 0), `${String(9 + (i % 12)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`);
      const early = e.early && i < e.sold * 0.4;
      const list = early ? e.early[0] : e.price;
      const past = e.days < 0;
      const came = past && r() < 0.85 ? 1 : 0;
      insertReg.run(uid, id, at, came, came ? `${isoDate(e.days)} ${e.time}:00` : null, list, !e.price ? 'free' : early ? 'early_bird' : 'standard', list,
        e.price ? 'paid' : 'free', e.price ? `seed_more_${id}_${uid}` : null, e.price ? at : null);
    });
    return id;
  }
  db.transaction(() => {
    for (const e of DEMO_MORE_EVENTS) {
      const c = db.prepare('SELECT id FROM communities WHERE name = ? AND owner_id = ?').get(e.community, owner.id);
      if (c) addEvent(c.id, e);
    }
    const demoHash = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 8);
    for (const o of DEMO_ORGANIZERS) {
      let u = db.prepare('SELECT id FROM users WHERE email = ?').get(o.email);
      if (!u) u = { id: Number(db.prepare("INSERT INTO users(name, email, password_hash, role, created_at) VALUES(?, ?, ?, 'organizer', ?)").run(o.name, o.email, demoHash, sqlDate(o.joined)).lastInsertRowid) };
      let c = db.prepare('SELECT id FROM communities WHERE name = ?').get(o.community.name);
      if (!c) {
        const k = o.community;
        c = { id: Number(db.prepare(`INSERT INTO communities(owner_id, name, category, description, story, town, address, postcode, latitude, longitude, image_url, status, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'published', ?, ?)`).run(u.id, k.name, k.category, k.description, k.story, k.town, k.address, k.lat, k.lon, IMG(k.img), sqlDate(o.joined + 2), sqlDate(o.joined + 2)).lastInsertRowid) };
        pick(14).forEach((uid, i) => join(uid, c.id, o.joined + 4 + i * 2));
      }
      for (const e of o.events) addEvent(c.id, { ...e, img: o.community.img, desc: `${o.community.description} Hosted by ${o.name.split(' ')[0]}.` });
    }
  })();
  // Payout history: the oldest demo events were already paid out to their organizers.
  ensureFees(db, feePercent);
  const paidOut = DEMO_ORGANIZERS.flatMap(o => o.events.filter(e => e.paidOut).map(e => e.name));
  // …and the demo organizer's events from more than a month ago
  db.prepare(`SELECT e.name FROM events e JOIN communities c ON c.id = e.community_id WHERE c.owner_id = ? AND e.event_date < ?`).all(owner.id, isoDate(-30)).forEach(x => paidOut.push(x.name));
  for (const name of paidOut) {
    const ev = db.prepare(`SELECT e.id, c.owner_id, COUNT(r.user_id) AS t, COALESCE(SUM(r.amount_pence), 0) AS g, COALESCE(SUM(r.platform_fee_pence), 0) AS f, COALESCE(SUM(r.organizer_net_pence), 0) AS n
      FROM events e JOIN communities c ON c.id = e.community_id LEFT JOIN event_registrations r ON r.event_id = e.id AND r.payment_status = 'paid'
      WHERE e.name = ? AND e.event_date < ? GROUP BY e.id`).get(name, isoDate(0));
    if (ev && ev.g) db.prepare(`INSERT OR IGNORE INTO payouts(event_id, organizer_id, tickets, gross_pence, fee_pence, net_pence, status, reference, created_at, paid_at)
      VALUES(?, ?, ?, ?, ?, ?, 'paid', ?, datetime('now', '-10 days'), datetime('now', '-7 days'))`).run(ev.id, ev.owner_id, ev.t, ev.g, ev.f, ev.n, `PO-${String(ev.id).padStart(5, '0')}-DEMO`);
  }
}

function refreshDemoExtras(db, feePercent = 10) {
  const owner = db.prepare("SELECT id FROM users WHERE email = 'demo-organizer@communityconnect.local'").get();
  if (!owner) return;
  if (!refreshDemoExtras.done) { refreshDemoExtras.done = new WeakSet(); }
  if (!refreshDemoExtras.done.has(db)) { ensureDemoContent(db, owner, feePercent); refreshDemoExtras.done.add(db); }
  const tc = db.prepare("SELECT id FROM communities WHERE name = 'Teesside Tech Collective' AND owner_id = ?").get(owner.id);
  const nowD = new Date();
  const nowLocal = localStamp(nowD);
  const nextSlot = isoDate(nowD.getHours() < 17 ? 0 : 1);
  if (tc) {
    const open = db.prepare("SELECT id, event_date, event_time FROM events WHERE community_id = ? AND name = 'Open Evening & Networking'").get(tc.id);
    if (!open) {
      const r = db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, price_pence, capacity, featured, status, created_at)
        VALUES(?, 'Open Evening & Networking', ?, '19:30', 'Teesside University Campus Heart', 'Meet the community, see live demos and network. Show the QR code on your e-ticket at the door to check in.', 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1200&q=80', 400, 40, 1, 'published', datetime('now'))`)
        .run(tc.id, nextSlot);
      db.prepare("INSERT OR IGNORE INTO event_promo_codes(event_id, code, percent_off, max_uses, created_at) VALUES(?, 'OPEN50', 50, 20, datetime('now'))").run(r.lastInsertRowid);
      // A few members already have tickets, so the door check-in screen shows real numbers.
      const members = db.prepare('SELECT user_id FROM memberships WHERE community_id = ? ORDER BY user_id LIMIT 9').all(tc.id);
      const reg = db.prepare(`INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at, amount_pence, ticket_type, list_price_pence, payment_status, payment_ref, paid_at)
        VALUES(?, ?, datetime('now', ?), 400, 'standard', 400, 'paid', ?, datetime('now', ?))`);
      members.forEach((m, i) => reg.run(m.user_id, r.lastInsertRowid, `-${i + 1} hours`, `seed_open_${m.user_id}`, `-${i + 1} hours`));
    } else if (`${open.event_date}T${open.event_time}` < nowLocal) {
      db.prepare("UPDATE events SET event_date = ?, event_time = '19:30' WHERE id = ?").run(nextSlot, open.id);
    }
  }
  db.prepare("UPDATE events SET featured = 1 WHERE name = 'Build Something Weekend' AND community_id IN (SELECT id FROM communities WHERE owner_id = ?)").run(owner.id);
  const book = db.prepare("SELECT id, flash_until, event_date, event_time FROM events WHERE name = 'November Book Night' AND community_id IN (SELECT id FROM communities WHERE owner_id = ?)").get(owner.id);
  const soon = localStamp(new Date(Date.now() + 3 * 3600e3));
  if (book && `${book.event_date}T${book.event_time}` > nowLocal && (!book.flash_until || book.flash_until < soon)) {
    // ends at 23:59 tomorrow, so there is always a live countdown of at least 3 hours
    db.prepare('UPDATE events SET flash_percent = 40, flash_until = ? WHERE id = ?').run(`${isoDate(1)}T23:59`, book.id);
  }
}

module.exports = { openDatabase, migrate, ensureCodes, refreshDemoExtras, ensureFees, ensureAdmin };
