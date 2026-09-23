// Force the house's timezone before anything else touches Date — the server
// itself may be provisioned anywhere (this one happened to be UTC+3), but
// every collection-day and task-window calculation assumes Luxembourg local
// time, same as the browser.
process.env.TZ = process.env.TZ || "Europe/Luxembourg";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// Always load the .env at the repo root, regardless of the process's cwd —
// relying on dotenv's cwd-relative default silently picks up the wrong file
// when a process manager (pm2, systemd) starts this from a different directory.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cron = require("node-cron");
const { getDb, DEFAULT_SLUG, destroyHouseDb, taskPhotoDir } = require("./db");
const houses = require("./houses");
const { checkPhoto } = require("./gemini");
const { sendDailyReminders, sendWeekAheadNotices, sendCheckResult, sendConfirmationEmail } = require("./mailer");
const { LANGS } = require("./i18n");
const { getCurrentTask, confirmOut, confirmBack } = require("./tasks");
const { SCHEDULE, DEFAULT_FLAT_SCHEDULE } = require("./rotation");
const coins = require("./coins");

// The original house's db, resolved once at startup — used unchanged by the
// background cron jobs at the bottom of this file (see the "Still open"
// note in the house-building mockup: scheduled digest emails stay scoped
// to this one house for now; interactive email actions work per-house).
const defaultDb = getDb(DEFAULT_SLUG);

// The original house now has to be opened the same way as any other one —
// a real invite link — instead of being what loads with no ?h= at all.
// This mints (once, ever — stable across restarts) a proper unguessable
// slug for it and logs it so it's recoverable from the server even if it's
// lost client-side.
const originalHouse = houses.ensureOriginalHouse("Bin Duty");
console.log(`Original house invite link: /?h=${originalHouse.slug}`);

const MAX_NAME_LENGTH = 40;
const VALID_LANGS = new Set(LANGS.map((l) => l.code));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_NAME_CHARS = /[<>&"'`\x00-\x1F]/;

function currentRoster(db) {
  // Alphabetical (case-insensitive), not insertion order — so "one
  // house-mate a week, alphabetically" (what the UI actually says) stays
  // true no matter when someone was added to or removed from the roster.
  return db.prepare("SELECT name FROM roster ORDER BY name COLLATE NOCASE ASC").all().map((r) => r.name);
}

// Same order, with occupation — a separate route/shape from GET /api/roster
// so nothing that already expects a plain array of names breaks.
function currentRosterFull(db) {
  return db.prepare("SELECT name, occupation, created_at FROM roster ORDER BY name COLLATE NOCASE ASC").all();
}

// A custom house's schedule lives in its own `schedule` table (starts
// empty — see the "no collection dates yet" state in the app); the
// original house keeps using the hardcoded, real Luxembourg calendar in
// rotation.js, exactly as before multi-house existed.
function flatScheduleFor(house) {
  if (house.slug === DEFAULT_SLUG) return DEFAULT_FLAT_SCHEDULE;
  const rows = house.db.prepare("SELECT date_key, codes FROM schedule").all();
  const flat = {};
  rows.forEach((r) => { flat[r.date_key] = r.codes; });
  return flat;
}

const app = express();
app.set("trust proxy", 1); // behind nginx — rate limiting needs the real client IP, not nginx's
app.use(helmet({ contentSecurityPolicy: false })); // CSP needs a real policy pass against this page's inline <style> + Google Fonts; everything else (HSTS, frameguard, no-sniff) applies as-is
app.use(express.json());

// Generous limits for a house of a handful of people, tight enough to stop
// a script from hammering the Gemini bill or the mail queue.
const checkLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const mailLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const buildLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// --- House resolution: every /api request (except building/looking up a
// house) carries its house as ?h=<slug> — no more implicit default. No
// slug at all means no house was specified (the client should never send
// this; it shows a "build or join" landing page instead of ever calling
// these routes with no house picked). An unknown slug is a 404. ---
function resolveHouse(req, res, next) {
  const raw = typeof req.query.h === "string" ? req.query.h.trim().toLowerCase() : "";
  if (!raw) {
    return res.status(400).json({ error: "No house specified — use your house's invite link.", code: "NO_HOUSE_SPECIFIED" });
  }
  const row = houses.getHouse(raw);
  if (!row) {
    return res.status(404).json({ error: "That house doesn't exist. Check the link or code.", code: "HOUSE_NOT_FOUND" });
  }
  // The original house's public slug still opens its original database —
  // req.house.slug stays the internal DEFAULT_SLUG sentinel so every other
  // "is this the original house" check in this file keeps working.
  // publicSlug is always the real, URL-usable slug (row.slug) — needed
  // anywhere a link back into this house gets built (e.g. the subscribe
  // confirmation email), since req.house.slug becomes the internal
  // DEFAULT_SLUG sentinel for the original house.
  if (row.is_original) {
    req.house = { slug: DEFAULT_SLUG, publicSlug: row.slug, db: defaultDb, name: row.name, city: row.city, language: row.language };
  } else {
    req.house = { slug: row.slug, publicSlug: row.slug, db: getDb(row.slug), name: row.name, city: row.city, language: row.language };
  }
  next();
}

// --- Build / look up a house (unscoped — these resolve which house to use,
// so they run before resolveHouse would even make sense) ---
app.post("/api/houses", buildLimiter, (req, res) => {
  const body = req.body || {};
  try {
    const { house, ownerToken } = houses.createHouse({ name: body.name, city: body.city, language: body.language });
    // ownerToken is the builder's proof of ownership — returned only here,
    // once; the browser keeps it, and it's what DELETE below checks.
    res.status(201).json({ slug: house.slug, name: house.name, city: house.city, language: house.language, ownerToken });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Destroy a house — only whoever built it (holds its owner key) can. The
// original house never has an owner key, so it can never be destroyed here.
// Irreversible: the registry row and the house's whole database file go.
app.delete("/api/houses/:slug", buildLimiter, (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const house = houses.getHouse(slug);
  if (!house) {
    return res.status(404).json({ error: "That house doesn't exist.", code: "HOUSE_NOT_FOUND" });
  }
  const token = req.body && req.body.ownerToken;
  if (!houses.isOwner(slug, token)) {
    return res.status(403).json({ error: "Only the person who built this house can destroy it.", code: "NOT_OWNER" });
  }
  try {
    houses.deleteHouse(slug);
    destroyHouseDb(slug);
    console.log(`House destroyed by its builder: ${slug}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`Destroying house ${slug} failed: ${err.message}`);
    res.status(500).json({ error: "Couldn't destroy that house — try again." });
  }
});

app.get("/api/houses/:slug", (req, res) => {
  const house = houses.getHouse(req.params.slug.toLowerCase());
  if (!house) {
    return res.status(404).json({ error: "That house doesn't exist. Check the link or code.", code: "HOUSE_NOT_FOUND" });
  }
  const db = house.is_original ? defaultDb : getDb(house.slug);
  const memberCount = db.prepare("SELECT COUNT(*) AS n FROM roster").get().n;
  res.json({ slug: house.slug, name: house.name, city: house.city, language: house.language, memberCount });
});

// Everything below operates on req.house, resolved from ?h=<slug>. Scoped
// to /api only — mounting this with no path would also run it for the
// static page/asset requests (GET / , /app.js, ...), where a bad ?h= on
// the page URL would hijack the whole page load into a raw JSON 404
// instead of letting index.html load and show its own "not found" state.
app.use("/api", resolveHouse);

// --- Camera bin-check (Gemini) ---
// multer.memoryStorage() above means the photo only ever exists as an
// in-memory buffer for this one request — it's never written to disk or a
// database, and is discarded the moment the response is sent.
app.post("/api/check", checkLimiter, (req, res) => {
  upload.single("photo")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That photo is too large (20MB max).", code: "TOO_LARGE" });
      }
      return res.status(400).json({ error: "Couldn't read that upload.", code: "UPLOAD_ERROR" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded." });
    }
    try {
      const result = await checkPhoto(req.file.buffer, req.file.mimetype);
      // "name" is who the browser is currently set as (a local-only, no-login
      // preference — see the "You" picker) — not sent, not credited, when
      // nobody's picked who they are.
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      let unlocked = [];
      if (name && currentRoster(req.house.db).includes(name)) {
        unlocked = coins.afterScan(req.house.db, name);
      }
      res.json({ ...result, unlocked });
    } catch (checkErr) {
      console.error(
        `/api/check failed — mimetype: ${req.file.mimetype}, size: ${req.file.size} bytes, ` +
        `code: ${checkErr.code}, message: ${checkErr.message}` +
        (checkErr.detail ? `, detail: ${checkErr.detail}` : "")
      );
      const status = (checkErr.code === "NO_API_KEY" || checkErr.code === "GEMINI_BUSY") ? 503 : 502;
      res.status(status).json({ error: checkErr.message, code: checkErr.code || "UNKNOWN" });
    }
  });
});

// Emails a copy of one already-returned check result. Takes the result back
// from the client rather than re-running Gemini — this is just "send what
// you already showed me", not a second classification.
app.post("/api/check/email", mailLimiter, async (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const lang = VALID_LANGS.has(body.lang) ? body.lang : "en";
  const item = typeof body.item === "string" ? body.item.slice(0, 200) : "";
  const code = body.code;
  const why = typeof body.why === "string" ? body.why.slice(0, 500) : "";

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }
  if (!/^[MEPVBR]$/.test(code) || !why) {
    return res.status(400).json({ error: "Nothing to send yet — check a photo first." });
  }
  try {
    await sendCheckResult(email, lang, { item, code, why });
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === "NO_SMTP" ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code || "UNKNOWN" });
  }
});

// --- Collection schedule — the original house's is the hardcoded, real
// Luxembourg calendar in rotation.js; a custom house's is whatever's in its
// own `schedule` table (starts empty). Served as the same nested
// {"YYYY-MM": {day: code}} shape either way, so the frontend doesn't need
// to know which kind of house it's looking at. ---
app.get("/api/schedule", (req, res) => {
  if (req.house.slug === DEFAULT_SLUG) {
    return res.json(SCHEDULE);
  }
  const rows = req.house.db.prepare("SELECT date_key, codes FROM schedule").all();
  const nested = {};
  rows.forEach((r) => {
    const [y, m, d] = r.date_key.split("-");
    const monthKey = `${y}-${m}`;
    if (!nested[monthKey]) nested[monthKey] = {};
    nested[monthKey][Number(d)] = r.codes;
  });
  res.json(nested);
});

// --- Roster (housemates) ---
app.get("/api/roster", (req, res) => {
  res.json(currentRoster(req.house.db));
});

app.get("/api/roster/full", (req, res) => {
  res.json(currentRosterFull(req.house.db));
});

const MAX_OCCUPATION_LENGTH = 60;

app.patch("/api/roster/:name", writeLimiter, (req, res) => {
  const roster = currentRoster(req.house.db);
  if (!roster.includes(req.params.name)) {
    return res.status(404).json({ error: "That name isn't on the roster." });
  }
  const raw = req.body && req.body.occupation;
  const occupation = typeof raw === "string" ? raw.trim().slice(0, MAX_OCCUPATION_LENGTH) : "";
  if (occupation && UNSAFE_NAME_CHARS.test(occupation)) {
    return res.status(400).json({ error: "Occupation can't contain <, >, &, quotes, or control characters." });
  }
  req.house.db.prepare("UPDATE roster SET occupation = ? WHERE name = ?").run(occupation || null, req.params.name);
  res.json(currentRosterFull(req.house.db));
});

app.post("/api/roster", writeLimiter, (req, res) => {
  const raw = req.body && req.body.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "Name can't be empty." });
  }
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }
  if (UNSAFE_NAME_CHARS.test(name)) {
    return res.status(400).json({ error: "Name can't contain <, >, &, quotes, or control characters." });
  }
  const roster = currentRoster(req.house.db);
  if (roster.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "That name is already on the roster." });
  }
  const nextPos = req.house.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM roster").get().pos;
  req.house.db.prepare("INSERT INTO roster (name, position, created_at) VALUES (?, ?, ?)").run(name, nextPos, new Date().toISOString());
  res.status(201).json(currentRoster(req.house.db));
});

app.delete("/api/roster/:name", writeLimiter, (req, res) => {
  const name = req.params.name;
  const roster = currentRoster(req.house.db);
  if (roster.length <= 1) {
    return res.status(400).json({ error: "At least one housemate has to stay on the roster." });
  }
  req.house.db.prepare("DELETE FROM roster WHERE name = ?").run(name);
  res.json(currentRoster(req.house.db));
});

// --- Bin duty tasks: two-step out/back confirmation, each optionally with
// a proof photo (bin at the curb / bin back in place) ---
const PHOTO_MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heic" };

function savePhoto(house, dateKey, which, buffer, mime) {
  const ext = PHOTO_MIME_EXT[mime] || "jpg";
  const filename = `${dateKey}-${which}.${ext}`;
  fs.writeFileSync(path.join(taskPhotoDir(house.slug), filename), buffer);
  return filename;
}

function deletePhotoFile(house, filename) {
  if (!filename) return;
  const file = path.join(taskPhotoDir(house.slug), filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// A proof photo only needs to outlive its own collection cycle: once a new
// task with the SAME codes is confirmed out, every older task sharing those
// codes has its photos deleted (file + columns) — "stored until the next
// same-kind collection", not kept forever.
function cleanupOldPhotos(house, codes, beforeDateKey) {
  const rows = house.db.prepare(
    "SELECT date_key, out_photo, back_photo FROM tasks WHERE codes = ? AND date_key < ? AND (out_photo IS NOT NULL OR back_photo IS NOT NULL)"
  ).all(codes, beforeDateKey);
  if (!rows.length) return;
  rows.forEach((r) => {
    deletePhotoFile(house, r.out_photo);
    deletePhotoFile(house, r.back_photo);
  });
  house.db.prepare(
    "UPDATE tasks SET out_photo = NULL, out_photo_mime = NULL, back_photo = NULL, back_photo_mime = NULL WHERE codes = ? AND date_key < ?"
  ).run(codes, beforeDateKey);
}

app.get("/api/tasks/current", (req, res) => {
  res.json(getCurrentTask(req.house.db, new Date(), flatScheduleFor(req.house)));
});

app.post("/api/tasks/:dateKey/out", writeLimiter, (req, res) => {
  upload.single("photo")(req, res, (uploadErr) => {
    if (uploadErr) {
      const status = uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: "Couldn't read that photo.", code: uploadErr.code || "UPLOAD_ERROR" });
    }
    const name = req.body && req.body.name;
    try {
      const row = confirmOut(req.house.db, req.params.dateKey, currentRoster(req.house.db), name, flatScheduleFor(req.house));
      let unlocked = [];
      let photoBonus = 0;
      if (req.file) {
        const filename = savePhoto(req.house, req.params.dateKey, "out", req.file.buffer, req.file.mimetype);
        req.house.db.prepare("UPDATE tasks SET out_photo = ?, out_photo_mime = ? WHERE date_key = ?")
          .run(filename, req.file.mimetype, req.params.dateKey);
        row.out_photo = filename;
        row.out_photo_mime = req.file.mimetype;
        // Proof photos earn Scrap coins too, same tier as a scan — always
        // credited to whoever marked the bin out (row.out_by, just set by
        // confirmOut above), the same person every other task reward goes to.
        photoBonus = 5;
        unlocked = coins.afterPhoto(req.house.db, row.out_by, "out");
      }
      cleanupOldPhotos(req.house, row.codes, req.params.dateKey);
      res.json({ ...row, unlocked, photoBonus });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
});

app.post("/api/tasks/:dateKey/back", writeLimiter, (req, res) => {
  upload.single("photo")(req, res, (uploadErr) => {
    if (uploadErr) {
      const status = uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: "Couldn't read that photo.", code: uploadErr.code || "UPLOAD_ERROR" });
    }
    const name = req.body && req.body.name;
    try {
      const row = confirmBack(req.house.db, req.params.dateKey, currentRoster(req.house.db), name);
      let photoBonus = 0;
      let photoUnlocked = [];
      if (req.file) {
        const filename = savePhoto(req.house, req.params.dateKey, "back", req.file.buffer, req.file.mimetype);
        req.house.db.prepare("UPDATE tasks SET back_photo = ?, back_photo_mime = ? WHERE date_key = ?")
          .run(filename, req.file.mimetype, req.params.dateKey);
        row.back_photo = filename;
        row.back_photo_mime = req.file.mimetype;
        // Same +5 bonus as the out photo — still credited to whoever
        // marked the bin OUT, even though this photo comes in at the back
        // step and may be confirmed by someone else entirely.
        if (row.out_by) { photoBonus = 5; photoUnlocked = coins.afterPhoto(req.house.db, row.out_by, "back"); }
      }
      // Coins go to whoever took the bin OUT (matches how the leaderboard has
      // always credited a task — see coin_ledger's backfill in db.js), not
      // necessarily whoever confirmed it back, since those can be different
      // people.
      const unlocked = row.out_by ? coins.afterTaskCompleted(req.house.db, row.out_by) : [];
      res.json({ ...row, unlocked: [...unlocked, ...photoUnlocked], photoBonus });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
});

// Serves a stored proof photo. 404 with no body when there isn't one —
// the client treats that as "no photo", not an error worth surfacing.
app.get("/api/tasks/:dateKey/photo/:which", (req, res) => {
  const which = req.params.which;
  if (which !== "out" && which !== "back") return res.status(400).end();
  const row = req.house.db.prepare(
    `SELECT ${which}_photo AS photo, ${which}_photo_mime AS mime FROM tasks WHERE date_key = ?`
  ).get(req.params.dateKey);
  if (!row || !row.photo) return res.status(404).end();
  const file = path.join(taskPhotoDir(req.house.slug), row.photo);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400");
  res.type(row.mime || "image/jpeg");
  fs.createReadStream(file).pipe(res);
});

app.get("/api/tasks/leaderboard", (req, res) => {
  res.json(coins.getLeaderboard(req.house.db));
});

// Every task that was ever started, most recent first — the full calendar
// uses this to show who actually confirmed each collection out/back (not
// just whose rotation turn it theoretically was) and whether photos exist
// for it. Capped generously; nobody's calendar needs unbounded history.
app.get("/api/tasks/history", (req, res) => {
  const rows = req.house.db.prepare(
    `SELECT date_key, codes, out_by, out_at, back_by, back_at,
            out_photo IS NOT NULL AS hasOutPhoto, back_photo IS NOT NULL AS hasBackPhoto
     FROM tasks WHERE out_at IS NOT NULL ORDER BY date_key DESC LIMIT 400`
  ).all();
  res.json(rows.map((r) => ({ ...r, hasOutPhoto: !!r.hasOutPhoto, hasBackPhoto: !!r.hasBackPhoto })));
});

// --- Scrap coins: balance/history/achievements for one person, donations,
// and the Sort It quiz's perfect-round bonus ---
app.get("/api/coins/:name", (req, res) => {
  const name = req.params.name;
  if (!currentRoster(req.house.db).includes(name)) {
    return res.status(404).json({ error: "That name isn't on the roster." });
  }
  const turnsRow = req.house.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE out_by = ? AND back_at IS NOT NULL").get(name);
  res.json({
    name,
    balance: coins.getBalance(req.house.db, name),
    history: coins.getHistory(req.house.db, name, 20),
    achievements: coins.getAchievements(req.house.db, name),
    turnsTaken: turnsRow.n
  });
});

app.post("/api/coins/donate", writeLimiter, (req, res) => {
  const body = req.body || {};
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const amount = Number(body.amount);
  const roster = currentRoster(req.house.db);
  if (!roster.includes(from) || !roster.includes(to)) {
    return res.status(400).json({ error: "Pick two names that are on the roster." });
  }
  if (from === to) {
    return res.status(400).json({ error: "Pick someone else to give coins to." });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1000) {
    return res.status(400).json({ error: "Amount has to be a whole number between 1 and 1000." });
  }
  try {
    const unlocked = coins.donate(req.house.db, from, to, amount);
    res.json({ ok: true, balance: coins.getBalance(req.house.db, from), unlocked });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Sort It is otherwise entirely client-side (see public/app.js) — this is
// the one moment it touches the server, and only when the house member has
// picked who they are locally. A perfect round pays out once; nothing stops
// someone re-running easy rounds for coins beyond "it isn't very many
// coins" — same trust model as the rest of this app.
app.post("/api/quiz/complete", writeLimiter, (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const correct = Number(body.correct);
  const total = Number(body.total);
  if (!currentRoster(req.house.db).includes(name)) {
    return res.status(400).json({ error: "That name isn't on the roster." });
  }
  if (!Number.isInteger(correct) || !Number.isInteger(total) || total <= 0 || correct > total) {
    return res.status(400).json({ error: "That doesn't look like a real round result." });
  }
  if (correct < total) {
    return res.json({ awarded: false, unlocked: [] });
  }
  const unlocked = coins.afterPerfectRound(req.house.db, name);
  res.json({ awarded: true, unlocked, balance: coins.getBalance(req.house.db, name) });
});

// --- Reactions on tonight's task (heart / thumbs up / thumbs down) ---
const REACTION_EMOJI = new Set(["heart", "up", "down"]);

app.get("/api/reactions/:dateKey", (req, res) => {
  const rows = req.house.db.prepare("SELECT name, emoji FROM reactions WHERE date_key = ?").all(req.params.dateKey);
  const counts = { heart: 0, up: 0, down: 0 };
  rows.forEach((r) => { if (counts[r.emoji] !== undefined) counts[r.emoji]++; });
  res.json({ counts, mine: {}, rows });
});

app.post("/api/reactions/:dateKey", writeLimiter, (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const emoji = body.emoji;
  if (!currentRoster(req.house.db).includes(name)) {
    return res.status(400).json({ error: "That name isn't on the roster." });
  }
  if (!REACTION_EMOJI.has(emoji)) {
    return res.status(400).json({ error: "Unknown reaction." });
  }
  req.house.db.prepare(
    "INSERT INTO reactions (date_key, name, emoji, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(date_key, name) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at"
  ).run(req.params.dateKey, name, emoji, new Date().toISOString());
  const rows = req.house.db.prepare("SELECT name, emoji FROM reactions WHERE date_key = ?").all(req.params.dateKey);
  const counts = { heart: 0, up: 0, down: 0 };
  rows.forEach((r) => { if (counts[r.emoji] !== undefined) counts[r.emoji]++; });
  res.json({ counts, rows });
});

// --- Notification subscriptions (double opt-in) ---
// Only ever lists/emails CONFIRMED accounts — an unconfirmed row is just a
// pending request nobody else can see or be notified from.
app.get("/api/subscribe", (req, res) => {
  const rows = req.house.db.prepare("SELECT name, language FROM accounts WHERE confirmed = 1 ORDER BY created_at ASC").all();
  res.json(rows);
});

app.post("/api/subscribe", mailLimiter, async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const language = VALID_LANGS.has(body.language) ? body.language : "en";

  if (!currentRoster(req.house.db).includes(name)) {
    return res.status(400).json({ error: "Pick a name that's on the housemate roster." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }

  const token = crypto.randomBytes(24).toString("hex");
  req.house.db.prepare(
    "INSERT INTO accounts (email, name, language, created_at, confirmed, confirm_token) VALUES (?, ?, ?, ?, 0, ?) " +
    "ON CONFLICT(email) DO UPDATE SET name = excluded.name, language = excluded.language, confirmed = 0, confirm_token = excluded.confirm_token"
  ).run(email, name, language, new Date().toISOString(), token);

  // Always carries ?h= now — there's no implicit default house left for a
  // bare confirm link to fall back to.
  const confirmUrl = `${req.protocol}://${req.get("host")}/api/subscribe/confirm/${token}` +
    `?h=${encodeURIComponent(req.house.publicSlug)}`;
  try {
    await sendConfirmationEmail(email, language, name, confirmUrl, req.house.publicSlug);
    res.status(202).json({ pending: true });
  } catch (err) {
    const status = err.code === "NO_SMTP" ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code || "UNKNOWN" });
  }
});

app.get("/api/subscribe/confirm/:token", (req, res) => {
  const row = req.house.db.prepare("SELECT email, name FROM accounts WHERE confirm_token = ?").get(req.params.token);
  if (!row) {
    return res.status(404).send("<p>That confirmation link is invalid or already used. Close this tab and subscribe again from Bin Duty.</p>");
  }
  req.house.db.prepare("UPDATE accounts SET confirmed = 1, confirm_token = NULL WHERE email = ?").run(row.email);
  // One-time signup bonus — guarded so re-subscribing under a new email
  // later doesn't pay out twice for the same person.
  let bonusLine = "";
  if (currentRoster(req.house.db).includes(row.name)) {
    const already = req.house.db.prepare("SELECT 1 FROM coin_ledger WHERE name = ? AND reason = 'subscribe' LIMIT 1").get(row.name);
    if (!already) {
      coins.afterSubscribe(req.house.db, row.name);
      bonusLine = " You've also earned +10 Scrap coins for subscribing.";
    }
  }
  res.send(`<p>Confirmed — you'll get an email the evening before bin duty, plus a heads-up on who's up next week.${bonusLine} You can close this tab.</p>`);
});

// The "You" screen's view of one person's own subscription. The address is
// masked (j•••@house.lu) so the roster's emails aren't readable house-wide;
// unsubscribing by name below means nobody has to type it back in either.
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 1) return email;
  return email[0] + "•••" + email.slice(at);
}

app.get("/api/subscribe/status/:name", (req, res) => {
  const name = req.params.name;
  if (!currentRoster(req.house.db).includes(name)) {
    return res.status(404).json({ error: "That name isn't on the roster." });
  }
  const row = req.house.db.prepare(
    "SELECT email, language FROM accounts WHERE name = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 1"
  ).get(name);
  const bonus = req.house.db.prepare("SELECT 1 FROM coin_ledger WHERE name = ? AND reason = 'subscribe' LIMIT 1").get(name);
  res.json({
    subscribed: !!row,
    email: row ? maskEmail(row.email) : null,
    language: row ? row.language : null,
    bonusAwarded: !!bonus
  });
});

app.delete("/api/subscribe/by-name/:name", writeLimiter, (req, res) => {
  req.house.db.prepare("DELETE FROM accounts WHERE name = ?").run(req.params.name);
  res.json({ ok: true });
});

app.delete("/api/subscribe/:email", writeLimiter, (req, res) => {
  req.house.db.prepare("DELETE FROM accounts WHERE email = ?").run(req.params.email.toLowerCase());
  res.json({ ok: true });
});

// RFC 8058 one-click unsubscribe target for the List-Unsubscribe-Post
// header below — mail clients' own "Unsubscribe" button POSTs here directly,
// no page load or confirmation click required. Same effect as the DELETE
// route above, just reachable the way a mail client actually calls it.
app.post("/api/subscribe/unsubscribe/:token", writeLimiter, (req, res) => {
  const row = req.house.db.prepare("SELECT email FROM accounts WHERE confirm_token = ? OR email = ?")
    .get(req.params.token, req.params.token.toLowerCase());
  if (row) req.house.db.prepare("DELETE FROM accounts WHERE email = ?").run(row.email);
  res.status(200).send("OK");
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bin Duty server listening on http://localhost:${PORT} (TZ=${process.env.TZ})`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set — the camera check will return a 503 until it is.");
  }
});

// Checked every day at 18:00 Luxembourg time — "6pm the day before" — same
// window rule the in-app task card already uses. Most days there's nothing
// due tomorrow, so most runs send zero mail; that's expected, not a bug.
// Validated at startup: an invalid cron expression must not crash the whole
// server, and a typo in .env must not silently disable the reminder either.
//
// Scoped to the original house only — a custom house's members can still
// subscribe and get a one-off confirmation/scan-result email (both routes
// above are per-house), but this scheduled digest doesn't yet iterate every
// house. Worth building once there's more than a couple of custom houses.
const DEFAULT_NOTIFY_CRON = "0 18 * * *";
const NOTIFY_CRON = process.env.NOTIFY_CRON || DEFAULT_NOTIFY_CRON;
if (!cron.validate(NOTIFY_CRON)) {
  console.error(`NOTIFY_CRON "${NOTIFY_CRON}" is not a valid cron expression — falling back to "${DEFAULT_NOTIFY_CRON}".`);
}
cron.schedule(cron.validate(NOTIFY_CRON) ? NOTIFY_CRON : DEFAULT_NOTIFY_CRON, async () => {
  try {
    const result = await sendDailyReminders(defaultDb, currentRoster(defaultDb), originalHouse.slug);
    if (!result.dueTomorrow) {
      console.log("Reminder check: nothing due tomorrow, no mail sent.");
      return;
    }
    console.log(`Reminder run: sent ${result.sent}, skipped ${result.skipped}` +
      (result.errors.length ? `, ${result.errors.length} error(s): ${JSON.stringify(result.errors)}` : ""));
  } catch (err) {
    // An error here must never take the whole process down with it — it's
    // a background job, not a request handler.
    console.error("Reminder run threw:", err.message);
  }
});

// End-of-week heads-up — who's on duty starting tomorrow, sent to
// everyone (not just that person) so the whole house finds out in advance
// instead of mid-week. Sunday 18:00 by default, independently configurable
// from NOTIFY_CRON since it's a different kind of message on its own cadence.
const DEFAULT_WEEK_AHEAD_CRON = "0 18 * * 0";
const WEEK_AHEAD_CRON = process.env.WEEK_AHEAD_CRON || DEFAULT_WEEK_AHEAD_CRON;
if (!cron.validate(WEEK_AHEAD_CRON)) {
  console.error(`WEEK_AHEAD_CRON "${WEEK_AHEAD_CRON}" is not a valid cron expression — falling back to "${DEFAULT_WEEK_AHEAD_CRON}".`);
}
cron.schedule(cron.validate(WEEK_AHEAD_CRON) ? WEEK_AHEAD_CRON : DEFAULT_WEEK_AHEAD_CRON, async () => {
  try {
    const result = await sendWeekAheadNotices(defaultDb, currentRoster(defaultDb), originalHouse.slug);
    console.log(`Week-ahead notice run: sent ${result.sent}, skipped ${result.skipped}` +
      (result.errors.length ? `, ${result.errors.length} error(s): ${JSON.stringify(result.errors)}` : ""));
  } catch (err) {
    console.error("Week-ahead notice run threw:", err.message);
  }
});
