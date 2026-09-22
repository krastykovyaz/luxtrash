require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
const db = require("./db");
const { checkPhoto } = require("./gemini");

const COINS_PER_CLAIM = 10;
const MAX_NAME_LENGTH = 40;

function currentRoster() {
  return db.prepare("SELECT name FROM roster ORDER BY position ASC").all().map(function (r) { return r.name; });
}

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function pad(n) {
  return String(n).padStart(2, "0");
}

function mondayKeyOf(date) {
  const day = (date.getDay() + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

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

// --- Scrap leaderboard ---
app.get("/api/claims", (req, res) => {
  const rows = db.prepare("SELECT week_key, name, coins, claimed_at FROM claims").all();
  res.json(rows);
});

app.post("/api/claims", (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !currentRoster().includes(name)) {
    return res.status(400).json({ error: "Unknown roster name." });
  }
  const weekKey = mondayKeyOf(new Date());
  const claimedAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO claims (week_key, name, coins, claimed_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(week_key) DO UPDATE SET name = excluded.name, coins = excluded.coins, claimed_at = excluded.claimed_at"
  ).run(weekKey, name, COINS_PER_CLAIM, claimedAt);
  res.json({ weekKey, name, coins: COINS_PER_CLAIM, claimedAt });
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
