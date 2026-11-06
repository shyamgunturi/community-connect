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

const SEED_EVENTS = [
  { community: 0, name: 'Build Something Weekend', days: 9, time: '10:00', venue: 'Teesside University Campus Heart', description: 'A friendly build-and-learn session. Bring a laptop and an idea — mentors will be on hand.', image: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80' },
  { community: 1, name: 'Saturday Morning Run', days: 2, time: '09:00', venue: 'Albert Park main gates', description: 'A 5k loop for all paces, followed by coffee. Beginners very welcome.', image: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?auto=format&fit=crop&w=1200&q=80' },
  { community: 2, name: 'Make & Meet Workshop', days: 6, time: '13:00', venue: 'Stockton Central Library', description: 'Bring an idea and make something. Materials provided.', image: '' },
  { community: 6, name: 'November Book Night', days: 12, time: '19:00', venue: 'Grainger Market café', description: 'This month we discuss a short novel of the group\'s choosing. Newcomers welcome.', image: '' }
];

function seed(db, config) {
  if (!config.seedDemoData) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM communities').get().n;
  if (count > 0) return;
  const email = 'demo-organizer@communityconnect.local';
  const password = config.seedOrganizerPassword || crypto.randomBytes(24).toString('hex');
  const insert = db.transaction(() => {
    let owner = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!owner) {
      const hash = bcrypt.hashSync(password, 10);
      const r = db.prepare("INSERT INTO users(name, email, password_hash, role, created_at) VALUES(?, ?, ?, 'organizer', datetime('now'))")
        .run('Community Connect Team', email, hash);
      owner = { id: Number(r.lastInsertRowid) };
    }
    const ids = SEED_COMMUNITIES.map(c => Number(db.prepare(`INSERT INTO communities
      (owner_id, name, category, description, story, town, address, postcode, latitude, longitude, image_url, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'), datetime('now'))`)
      .run(owner.id, c.name, c.category, c.description, c.story, c.town, c.address, c.postcode, c.lat, c.lon, c.image).lastInsertRowid));
    for (const e of SEED_EVENTS) {
      db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, status, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'))`)
        .run(ids[e.community], e.name, isoDate(e.days), e.time, e.venue, e.description, e.image);
    }
  });
  insert();
  console.log(`[db] Added ${SEED_COMMUNITIES.length} starter communities and ${SEED_EVENTS.length} events (set SEED_DEMO_DATA=false to disable).`);
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
