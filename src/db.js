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
  }
];

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
  { community: 0, name: 'Build Something Weekend', days: 9, time: '10:00', venue: 'Teesside University Campus Heart', price: 5, capacity: 30, description: 'A friendly build-and-learn session. Bring a laptop and an idea — mentors will be on hand.', image: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80' },
  { community: 1, name: 'Saturday Morning Run', days: 2, time: '09:00', venue: 'Albert Park main gates', price: 0, capacity: 40, description: 'A 5k loop for all paces, followed by coffee. Beginners very welcome.', image: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?auto=format&fit=crop&w=1200&q=80' },
  { community: 2, name: 'Make & Meet Workshop', days: 6, time: '13:00', venue: 'Stockton Central Library', price: 8, capacity: 15, description: 'Bring an idea and make something. Materials provided.', image: '' },
  { community: 6, name: 'November Book Night', days: 12, time: '19:00', venue: 'Grainger Market café', price: 3, capacity: 20, description: 'This month we discuss a short novel of the group\'s choosing. Newcomers welcome.', image: '' }
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
    const insertReg = db.prepare('INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at, attended, checked_in_at, amount_pence) VALUES(?, ?, ?, ?, ?, ?)');
    const comments = ['Really friendly group!', 'Well organised, will come again.', 'Great venue and people.', 'Loved it.', 'Good session, a bit busy.', ''];

    // Past events with registrations, attendance, revenue and ratings.
    for (const [ci, name, daysAgo, time, venue, price, capacity] of SEED_PAST_EVENTS) {
      const eventId = Number(insertEvent.run(ids[ci], name, isoDate(-daysAgo), time, venue, `${name} with ${SEED_COMMUNITIES[ci].name}.`, '', price * 100, capacity, sqlDate(-daysAgo - 14)).lastInsertRowid);
      const eligible = members.filter(m => joinedAt.has(`${m.id}:${ci}`) && joinedAt.get(`${m.id}:${ci}`) < -daysAgo);
      const pool = eligible.length >= 6 ? eligible : members; // early events: anyone could attend
      const target = Math.min(capacity, Math.max(5, Math.round(pool.length * (0.55 + rand() * 0.4))));
      const chosen = pool.slice().sort(() => rand() - 0.5).slice(0, target);
      const showRate = 0.62 + rand() * 0.3;
      for (const m of chosen) {
        const attended = rand() < showRate ? 1 : 0;
        insertReg.run(m.id, eventId, sqlDate(-daysAgo - 1 - Math.floor(rand() * 10)), attended, attended ? `${isoDate(-daysAgo)} ${time}:00` : null, price * 100);
        if (attended && rand() < 0.6) {
          const rating = rand() < 0.55 ? 5 : rand() < 0.7 ? 4 : 3;
          db.prepare('INSERT OR IGNORE INTO event_feedback(user_id, event_id, rating, comment, created_at) VALUES(?, ?, ?, ?, ?)')
            .run(m.id, eventId, rating, comments[Math.floor(rand() * comments.length)], sqlDate(-daysAgo + 1));
        }
      }
    }

    // Upcoming events, with some places already booked.
    for (const e of SEED_EVENTS) {
      const eventId = Number(insertEvent.run(ids[e.community], e.name, isoDate(e.days), e.time, e.venue, e.description, e.image, e.price * 100, e.capacity, sqlDate(-5)).lastInsertRowid);
      const pool = members.filter(m => joinedAt.has(`${m.id}:${e.community}`));
      const booked = pool.slice(0, Math.min(pool.length, Math.round((e.capacity || 20) * (0.3 + rand() * 0.4))));
      for (const m of booked) insertReg.run(m.id, eventId, sqlDate(-Math.ceil(rand() * 4)), 0, null, e.price * 100);
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
  return db;
}

module.exports = { openDatabase, migrate };
