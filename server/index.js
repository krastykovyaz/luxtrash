require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
const db = require("./db");
const { checkPhoto } = require("./gemini");

const ROSTER = ["Akemi", "Alex", "Diana", "James", "Wenxuan", "Zheng Lin"];
const COINS_PER_CLAIM = 10;

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

// --- Scrap leaderboard ---
app.get("/api/claims", (req, res) => {
  const rows = db.prepare("SELECT week_key, name, coins, claimed_at FROM claims").all();
  res.json(rows);
});

app.post("/api/claims", (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !ROSTER.includes(name)) {
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
