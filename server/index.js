// Force the house's timezone before anything else touches Date — the server
// itself may be provisioned anywhere (this one happened to be UTC+3), but
// every collection-day and task-window calculation assumes Luxembourg local
// time, same as the browser.
process.env.TZ = process.env.TZ || "Europe/Luxembourg";

const path = require("path");
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
const db = require("./db");
const { checkPhoto } = require("./gemini");
const { sendDailyReminders, sendWeekAheadNotices, sendCheckResult, sendConfirmationEmail } = require("./mailer");
const { LANGS } = require("./i18n");
const { getCurrentTask, confirmOut, confirmBack, getLeaderboard } = require("./tasks");
const { SCHEDULE } = require("./rotation");

const MAX_NAME_LENGTH = 40;
const VALID_LANGS = new Set(LANGS.map((l) => l.code));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_NAME_CHARS = /[<>&"'`\x00-\x1F]/;

function currentRoster() {
  // Alphabetical (case-insensitive), not insertion order — so "one
  // house-mate a week, alphabetically" (what the UI actually says) stays
  // true no matter when someone was added to or removed from the roster.
  return db.prepare("SELECT name FROM roster ORDER BY name COLLATE NOCASE ASC").all().map((r) => r.name);
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

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
      res.json(result);
    } catch (checkErr) {
      console.error(
        `/api/check failed — mimetype: ${req.file.mimetype}, size: ${req.file.size} bytes, ` +
        `code: ${checkErr.code}, message: ${checkErr.message}` +
        (checkErr.detail ? `, detail: ${checkErr.detail}` : "")
      );
      const status = checkErr.code === "NO_API_KEY" ? 503 : 502;
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

// --- Collection schedule (kept server-side only, in rotation.js — this
// just serves it, so the frontend doesn't carry a second hand-copied
// version that can silently drift from the one the API actually uses) ---
app.get("/api/schedule", (req, res) => {
  res.json(SCHEDULE);
});

// --- Roster (housemates) ---
app.get("/api/roster", (req, res) => {
  res.json(currentRoster());
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
  const roster = currentRoster();
  if (roster.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "That name is already on the roster." });
  }
  const nextPos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM roster").get().pos;
  db.prepare("INSERT INTO roster (name, position) VALUES (?, ?)").run(name, nextPos);
  res.status(201).json(currentRoster());
});

app.delete("/api/roster/:name", writeLimiter, (req, res) => {
  const name = req.params.name;
  const roster = currentRoster();
  if (roster.length <= 1) {
    return res.status(400).json({ error: "At least one housemate has to stay on the roster." });
  }
  db.prepare("DELETE FROM roster WHERE name = ?").run(name);
  res.json(currentRoster());
});

// --- Bin duty tasks: two-step out/back confirmation ---
app.get("/api/tasks/current", (req, res) => {
  res.json(getCurrentTask(db, new Date()));
});

app.post("/api/tasks/:dateKey/out", writeLimiter, (req, res) => {
  const name = req.body && req.body.name;
  try {
    res.json(confirmOut(db, req.params.dateKey, currentRoster(), name));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/tasks/:dateKey/back", writeLimiter, (req, res) => {
  const name = req.body && req.body.name;
  try {
    res.json(confirmBack(db, req.params.dateKey, currentRoster(), name));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/tasks/leaderboard", (req, res) => {
  res.json(getLeaderboard(db));
});

// --- Notification subscriptions (double opt-in) ---
// Only ever lists/emails CONFIRMED accounts — an unconfirmed row is just a
// pending request nobody else can see or be notified from.
app.get("/api/subscribe", (req, res) => {
  const rows = db.prepare("SELECT name, language FROM accounts WHERE confirmed = 1 ORDER BY created_at ASC").all();
  res.json(rows);
});

app.post("/api/subscribe", mailLimiter, async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const language = VALID_LANGS.has(body.language) ? body.language : "en";

  if (!currentRoster().includes(name)) {
    return res.status(400).json({ error: "Pick a name that's on the housemate roster." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }

  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO accounts (email, name, language, created_at, confirmed, confirm_token) VALUES (?, ?, ?, ?, 0, ?) " +
    "ON CONFLICT(email) DO UPDATE SET name = excluded.name, language = excluded.language, confirmed = 0, confirm_token = excluded.confirm_token"
  ).run(email, name, language, new Date().toISOString(), token);

  const confirmUrl = `${req.protocol}://${req.get("host")}/api/subscribe/confirm/${token}`;
  try {
    await sendConfirmationEmail(email, language, name, confirmUrl);
    res.status(202).json({ pending: true });
  } catch (err) {
    const status = err.code === "NO_SMTP" ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code || "UNKNOWN" });
  }
});

app.get("/api/subscribe/confirm/:token", (req, res) => {
  const row = db.prepare("SELECT email FROM accounts WHERE confirm_token = ?").get(req.params.token);
  if (!row) {
    return res.status(404).send("<p>That confirmation link is invalid or already used. Close this tab and subscribe again from Bin Duty.</p>");
  }
  db.prepare("UPDATE accounts SET confirmed = 1, confirm_token = NULL WHERE email = ?").run(row.email);
  res.send("<p>Confirmed — you'll get an email the evening before bin duty, plus a heads-up on who's up next week. You can close this tab.</p>");
});

app.delete("/api/subscribe/:email", writeLimiter, (req, res) => {
  db.prepare("DELETE FROM accounts WHERE email = ?").run(req.params.email.toLowerCase());
  res.json({ ok: true });
});

// RFC 8058 one-click unsubscribe target for the List-Unsubscribe-Post
// header below — mail clients' own "Unsubscribe" button POSTs here directly,
// no page load or confirmation click required. Same effect as the DELETE
// route above, just reachable the way a mail client actually calls it.
app.post("/api/subscribe/unsubscribe/:token", writeLimiter, (req, res) => {
  const row = db.prepare("SELECT email FROM accounts WHERE confirm_token = ? OR email = ?")
    .get(req.params.token, req.params.token.toLowerCase());
  if (row) db.prepare("DELETE FROM accounts WHERE email = ?").run(row.email);
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
const DEFAULT_NOTIFY_CRON = "0 18 * * *";
const NOTIFY_CRON = process.env.NOTIFY_CRON || DEFAULT_NOTIFY_CRON;
if (!cron.validate(NOTIFY_CRON)) {
  console.error(`NOTIFY_CRON "${NOTIFY_CRON}" is not a valid cron expression — falling back to "${DEFAULT_NOTIFY_CRON}".`);
}
cron.schedule(cron.validate(NOTIFY_CRON) ? NOTIFY_CRON : DEFAULT_NOTIFY_CRON, async () => {
  try {
    const result = await sendDailyReminders(db, currentRoster());
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
    const result = await sendWeekAheadNotices(db, currentRoster());
    console.log(`Week-ahead notice run: sent ${result.sent}, skipped ${result.skipped}` +
      (result.errors.length ? `, ${result.errors.length} error(s): ${JSON.stringify(result.errors)}` : ""));
  } catch (err) {
    console.error("Week-ahead notice run threw:", err.message);
  }
});
