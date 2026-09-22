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

// Idempotent migration: occupation is optional flavor text shown on the
// roster and "You" screens, added after roster already shipped.
var rosterCols = db.prepare("PRAGMA table_info(roster)").all().map(function (c) { return c.name; });
if (rosterCols.indexOf("occupation") === -1) {
  db.exec("ALTER TABLE roster ADD COLUMN occupation TEXT");
}
// created_at is only known going forward (new roster additions set it);
// existing rows stay NULL — nobody's actual join date can be reconstructed,
// so the "You" screen just omits the line rather than guessing one.
if (rosterCols.indexOf("created_at") === -1) {
  db.exec("ALTER TABLE roster ADD COLUMN created_at TEXT");
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

// coin_ledger is the single source of truth for Scrap coins going forward
// (tasks.coins stays put for backward compat, but leaderboard/balance/
// donations all read this instead). Every award is one row: task
// completion, a scan, a perfect Sort It round, subscribing, or a donation
// (recorded as a debit from the sender and a credit to the recipient).
db.exec(`
  CREATE TABLE IF NOT EXISTS coin_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  )
`);

// One-time backfill so historical completed tasks still count toward the
// balance once the ledger becomes the source of truth — only runs while
// the ledger is empty, so it's safe to leave in place permanently.
var ledgerCount = db.prepare("SELECT COUNT(*) AS n FROM coin_ledger").get().n;
if (ledgerCount === 0) {
  var pastTasks = db.prepare("SELECT out_by, coins, back_at FROM tasks WHERE back_at IS NOT NULL AND out_by IS NOT NULL").all();
  if (pastTasks.length) {
    var creditPast = db.prepare("INSERT INTO coin_ledger (name, delta, reason, note, created_at) VALUES (?, ?, 'task', NULL, ?)");
    var backfill = db.transaction(function () {
      pastTasks.forEach(function (t) { creditPast.run(t.out_by, t.coins, t.back_at); });
    });
    backfill();
  }
}

// name+code is the primary key: each person can unlock a given badge once.
db.exec(`
  CREATE TABLE IF NOT EXISTS achievements (
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    unlocked_at TEXT NOT NULL,
    PRIMARY KEY (name, code)
  )
`);

// One reaction per person per task date; re-reacting overwrites (upsert).
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    date_key TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (date_key, name)
  )
`);

module.exports = db;
