const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "bin-duty.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    date_key TEXT PRIMARY KEY,
    codes TEXT NOT NULL,
    out_by TEXT,
    out_at TEXT,
    back_by TEXT,
    back_at TEXT,
    coins INTEGER NOT NULL DEFAULT 10
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS roster (
    name TEXT PRIMARY KEY,
    position INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    created_at TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    confirm_token TEXT
  )
`);

// Idempotent migration for the confirmed/confirm_token columns on a
// database that already existed before double opt-in was added.
var accountCols = db.prepare("PRAGMA table_info(accounts)").all().map(function (c) { return c.name; });
if (accountCols.indexOf("confirmed") === -1) {
  db.exec("ALTER TABLE accounts ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0");
}
if (accountCols.indexOf("confirm_token") === -1) {
  db.exec("ALTER TABLE accounts ADD COLUMN confirm_token TEXT");
}

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
