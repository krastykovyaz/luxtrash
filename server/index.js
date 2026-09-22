require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
const cron = require("node-cron");
const db = require("./db");
const { checkPhoto } = require("./gemini");
const { sendWeeklyReminders } = require("./mailer");
const { LANGS } = require("./i18n");
const { getCurrentTask, confirmOut, confirmBack, getLeaderboard } = require("./tasks");

const MAX_NAME_LENGTH = 40;
const VALID_LANGS = new Set(LANGS.map((l) => l.code));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function currentRoster() {
  return db.prepare("SELECT name FROM roster ORDER BY position ASC").all().map(function (r) { return r.name; });
}

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// --- Camera bin-check (Gemini) ---
app.post("/api/check", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo uploaded." });
  }
  try {
    const result = await checkPhoto(req.file.buffer, req.file.mimetype);
    res.json(result);
  } catch (err) {
    const status = err.code === "NO_API_KEY" ? 503 : 502;
    res.status(status).json({ error: err.message, code: err.code || "UNKNOWN" });
  }
});

// --- Roster (housemates) ---
app.get("/api/roster", (req, res) => {
  res.json(currentRoster());
});

app.post("/api/roster", (req, res) => {
  const raw = req.body && req.body.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "Name can't be empty." });
  }
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }
  const roster = currentRoster();
  if (roster.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "That name is already on the roster." });
  }
  const nextPos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM roster").get().pos;
  db.prepare("INSERT INTO roster (name, position) VALUES (?, ?)").run(name, nextPos);
  res.status(201).json(currentRoster());
});

app.delete("/api/roster/:name", (req, res) => {
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

app.post("/api/tasks/:dateKey/out", (req, res) => {
  const name = req.body && req.body.name;
  try {
    res.json(confirmOut(db, req.params.dateKey, currentRoster(), name));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/tasks/:dateKey/back", (req, res) => {
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

// --- Notification subscriptions ---
app.get("/api/subscribe", (req, res) => {
  const rows = db.prepare("SELECT name, language FROM accounts ORDER BY created_at ASC").all();
  res.json(rows);
});

app.post("/api/subscribe", (req, res) => {
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
  db.prepare(
    "INSERT INTO accounts (email, name, language, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(email) DO UPDATE SET name = excluded.name, language = excluded.language"
  ).run(email, name, language, new Date().toISOString());
  res.status(201).json({ name, language });
});

app.delete("/api/subscribe/:email", (req, res) => {
  db.prepare("DELETE FROM accounts WHERE email = ?").run(req.params.email.toLowerCase());
  res.json({ ok: true });
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bin Duty server listening on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set — the camera check will return a 503 until it is.");
  }
});

// Weekly reminder email — Mondays at 7:00 server time by default.
const NOTIFY_CRON = process.env.NOTIFY_CRON || "0 7 * * 1";
cron.schedule(NOTIFY_CRON, async () => {
  const result = await sendWeeklyReminders(db, currentRoster());
  console.log(`Weekly reminder run: sent ${result.sent}, skipped ${result.skipped}` +
    (result.errors.length ? `, ${result.errors.length} error(s): ${JSON.stringify(result.errors)}` : ""));
});
