# Community Connect

A location-based community discovery platform. Visitors explore local communities and public events without an account; **participants** join communities and register for events; **organizers** publish communities (with photographs) and events.

**Stack:** Node.js · Express 4 · SQLite (better-sqlite3) · JWT authentication · bcrypt password hashing · vanilla HTML/CSS/JS frontend.

---

## 1. Requirements

- **Node.js 22 LTS or 24 LTS** (minimum 20). Download from <https://nodejs.org> (choose "LTS").
- An internet connection for `npm install`, the Unsplash starter photos and live location search. Without internet the app still runs: location search falls back to a built-in list of about 60 UK towns.

## 2. Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**. The health check is at **http://localhost:3000/api/health**.

On Windows you can instead double-click **`START-WINDOWS.bat`**. It checks Node.js, runs `npm install` the first time, opens your browser and starts the server.

Stop the server with **Ctrl + C**. Your data stays in `data/community-connect.sqlite`.

## 3. Opening the project in VS Code

1. Unzip the project to a folder such as `Documents\community-connect`. Do **not** run it from inside the ZIP.
2. Open VS Code → **File → Open Folder…** → select the `community-connect` folder (the one containing `package.json`) → **Select Folder**. If asked, choose **Yes, I trust the authors**.
3. Open a terminal: **Terminal → New Terminal** (or <kbd>Ctrl</kbd> + <kbd>`</kbd>).
4. Run `node -v` and check it prints v20 or higher.
5. Run `npm install`, then `npm start`.
6. <kbd>Ctrl</kbd>-click `http://localhost:3000` in the terminal output.
7. Optional: copy `.env.example` to `.env` to change settings (see section 7).

To run the automated tests: `npm test` (uses a temporary database — your real data is never touched).

## 4. Project structure

```
community-connect/
├── server.js               Entry point (npm start)
├── src/
│   ├── app.js              Express app: all API routes, auth, permissions, uploads
│   ├── db.js               SQLite connection, migrations, starter data
│   ├── config.js           Settings from environment / .env
│   ├── validation.js       Input validation rules
│   ├── geocode.js          UK location search (postcodes.io + Nominatim fallback, cache, throttle)
│   ├── gazetteer.js        Offline fallback list of UK towns
│   └── security.js         Security headers, rate limiting
├── public/                 Everything the browser can see (only this folder is served)
│   ├── index.html          Homepage, discovery, participant + organizer dashboards
│   ├── community.html      Community story page   (community.html?id=1)
│   ├── event.html          Public event page      (event.html?id=1)
│   ├── styles.css, detail-pages.css
│   ├── images/community-fallback.svg
│   └── js/ common.js, app.js, detail-shared.js, community-page.js, event-page.js
├── data/                   SQLite database + uploaded photos (created automatically)
├── test/                   api.test.js (npm test), e2e.browser.js (optional browser test)
├── docs/                   API guide, testing report, screenshots
├── .env.example            Configuration template
└── START-WINDOWS.bat       One-click start for Windows
```

## 5. How to demonstrate it

**Starter data:** on first run, with an empty database, 7 communities (Middlesbrough, Stockton, Yarm, Newcastle) and 4 upcoming events are added as real SQLite records. Turn this off with `SEED_DEMO_DATA=false`. They belong to `demo-organizer@communityconnect.local`; set `SEED_ORGANIZER_PASSWORD` in `.env` **before the first run** if you want to log in as that organizer.

Suggested demo:

1. **Visitor** — Home → *Explore communities*. Type `Middles`, pick **Middlesbrough** from the suggestions, move the distance slider, change the category. Try a postcode such as `TS1 3BX`.
2. **Organizer** — *Organizer* → *Create an organizer account to publish*. Create a community: start typing the town and pick a suggestion (this fills the map position), upload a photo, then **Publish community**. Then **Publish an event**. Log out.
3. **Participant** — *Events* → open your event → *Log in / Register to take part* → create a participant account → **Join** (step 1) → **Register** (step 2). *My dashboard* shows the community and the event.
4. **Persistence** — stop the server (Ctrl+C), `npm start` again, log in: everything is still there.

## 6. Features and how they work

| Area | Implementation |
|---|---|
| Accounts | Participant / organizer registration, login, persistent login (token in `localStorage`), logout. Email unique (case-insensitive). Passwords: bcrypt, at least 8 characters with a letter and a number. |
| Roles | Enforced by the **backend**: organizers can't join or register; participants can't create communities or events; organizers can only edit or delete their own communities and events (403 otherwise). |
| Discovery | `GET /api/communities` with `lat`, `lon`, `radius` (1–50 miles) and `category`. The server filters by real distance (haversine) and sorts nearest first. |
| Location search | Autocomplete via `/api/locations/search` → **postcodes.io** (ONS / Ordnance Survey open data: towns, cities, full and partial postcodes). Pressing **Search**/Enter can also fall back to **Nominatim**, never for autocomplete, at most **1 request/second app-wide**, with a User-Agent and cached results, following the OSM usage policy. Results are cached on the server for 24 hours and in the browser. The browser debounces typing (320 ms) and cancels stale requests. |
| Photos | Organizers upload a JPG/PNG/WebP/GIF. It's resized in the browser to at most 1600 px, checked on the server by file signature, size-limited to 4 MB and stored in `data/uploads/`, or they paste an `https://` link. The URL is saved in the database. Every photo is shown **whole** (`object-fit: contain`) over a blurred copy of itself, so frames are consistent and nothing is cropped. Broken links fall back to a placeholder. |
| Events | Public previews (name, community, date, time, venue, description, photo) for everyone. Registration requires a participant account **and** membership of the community (checked by the server). Dates must be real, not in the past and at most two years ahead. |
| Dashboards | Participant: joined communities (leave), registered events (cancel). Organizer: stats, communities (view/edit/delete/add event), events with registration counts (view/delete). |

## 7. Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional in development. Key ones: `PORT`, `JWT_SECRET`, `DATABASE_PATH`, `SEED_DEMO_DATA`, `SEED_ORGANIZER_PASSWORD`, `GEOCODER_USER_AGENT`, `GEOCODER_CONTACT_EMAIL`.

If `JWT_SECRET` is empty in development, a random secret is generated once in `data/.dev-jwt-secret`, so logins survive restarts and no secret is hardcoded in the code.

## 8. Database

SQLite file: `data/community-connect.sqlite`. If an **older** `community-connect.sqlite` exists in the project root, from the original starter, it is used automatically so existing accounts aren't lost.

Tables: `users`, `communities`, `memberships` (primary key user+community → no duplicates), `events`, `event_registrations` (primary key user+event → no duplicates). Foreign keys are enforced with `ON DELETE CASCADE`. Deleting a community removes its events, memberships and registrations, so nothing is left orphaned.

**Migrations** are versioned (`PRAGMA user_version`) and additive only. They never drop tables or rows, and run automatically on start. Migration 2 adds photos, postcode, status, timestamps and indexes to an older database.

To inspect the data, use the VS Code extension "SQLite Viewer", or [DB Browser for SQLite](https://sqlitebrowser.org/), and open `data/community-connect.sqlite`. Stop the server first if you want to edit data.

To start completely fresh: stop the server and delete `data/community-connect.sqlite*` (this deletes all accounts).

## 9. API

See **[docs/API.md](docs/API.md)** for every endpoint with request and response examples.

## 10. Testing

- `npm test` runs **31 automated API tests**: registration/login, validation, permissions, joining, registration, location search, distance filtering, uploads, restart persistence, cascades, migrations, and damaged-database and geocoder-outage handling.
- Optional browser test (30 steps across desktop, tablet and mobile):
  ```bash
  npm install --no-save playwright
  npx playwright install chromium
  node test/e2e.browser.js
  ```
- Results: **[docs/TESTING-REPORT.md](docs/TESTING-REPORT.md)**.

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` fails building `better-sqlite3` (mentions node-gyp / Python / Visual Studio) | You are probably on a very new or very old Node.js. Install **Node 22 or 24 LTS**, delete `node_modules` and `package-lock.json`, run `npm install` again. |
| `Port 3000 is already in use` | Close the other server, or set `PORT=3001` in `.env`. |
| "A required package is missing" | Run `npm install` in the project folder (the one with `package.json`). |
| Location search says it is unavailable | Check your internet connection. The offline town list still covers major towns. |
| Photos from Unsplash don't show | They need internet. Uploaded photos are stored locally and always work. |
| Logged out unexpectedly | Logins last 7 days (`JWT_EXPIRES_IN`). Changing `JWT_SECRET` logs everyone out. |

## 12. Before production deployment

This build is ready for a university demonstration on `localhost`. Before putting it on the public internet:

- Set `NODE_ENV=production` and a strong random `JWT_SECRET` (the server refuses to start in production without it).
- Serve over **HTTPS** behind a reverse proxy (set `TRUST_PROXY=true`).
- Set `GEOCODER_USER_AGENT` / `GEOCODER_CONTACT_EMAIL` to real contact details. For real traffic, use a commercial geocoder or your own Nominatim instance. The public one allows 1 request/second for the whole application.
- Add email verification, password reset, organizer verification and content moderation.
- Move rate-limiting to a shared store (e.g. Redis) if you run more than one server process.
- Consider storing tokens in `HttpOnly` cookies with CSRF protection instead of `localStorage`.
- Back up `data/` (database and uploads) regularly, and add a privacy policy (UK GDPR).
- Unused uploaded photos aren't cleaned up automatically. Add a periodic clean-up job.

## Credits

Location data: [postcodes.io](https://postcodes.io) (Office for National Statistics and Ordnance Survey open data, Open Government Licence) and © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors via Nominatim. Starter photographs: Unsplash.

## 13. Known limitations

- No email verification, password reset or account deletion screen yet.
- Communities are published immediately. There is no draft or moderation step.
- Events can be deleted but not edited. To change one, delete it and publish it again.
- Live geocoding depends on postcodes.io and Nominatim being reachable. Offline, only about 60 larger UK towns are recognised.
- Distances are straight-line ("as the crow flies"), not travel distance.
- Rate limiting and the geocoding cache are in memory: they reset on restart and assume a single server process.
- Uploaded photos that are later replaced are not deleted from `data/uploads/`.
