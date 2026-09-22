const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "bin-duty.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    week_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    coins INTEGER NOT NULL,
    claimed_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS roster (
    name TEXT PRIMARY KEY,
    position INTEGER NOT NULL
  )
`);

var rosterCount = db.prepare("SELECT COUNT(*) AS n FROM roster").get().n;
if (rosterCount === 0) {
  var seed = db.prepare("INSERT INTO roster (name, position) VALUES (?, ?)");
  var seedNames = ["Akemi", "Alex", "Diana", "James", "Wenxuan", "Zheng Lin"];
  var insertSeed = db.transaction(function () {
    seedNames.forEach(function (name, i) { seed.run(name, i); });
  });
  insertSeed();
}

module.exports = db;
