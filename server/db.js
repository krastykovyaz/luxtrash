const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const HOUSES_DIR = path.join(DATA_DIR, "houses");
if (!fs.existsSync(HOUSES_DIR)) fs.mkdirSync(HOUSES_DIR, { recursive: true });

// The original single house this app was built for keeps its original file
// and path, completely untouched by multi-house support — no migration, no
// renaming, zero risk to existing production data. Every other house gets
// its own file under data/houses/<slug>.sqlite.
const DEFAULT_SLUG = "__default__";
const DEFAULT_SEED_ROSTER = ["Akemi", "Alex", "Diana", "James", "Wenxuan", "Zheng Lin"];

// Applies the full schema (idempotent — safe on a brand-new file or one
// that already has some of these tables/columns) to any house's database,
// default or custom, so every house gets the identical shape.
function ensureSchema(db, opts) {
  opts = opts || {};
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

  var accountCols = db.prepare("PRAGMA table_info(accounts)").all().map(function (c) { return c.name; });
  if (accountCols.indexOf("confirmed") === -1) {
    db.exec("ALTER TABLE accounts ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0");
  }
  if (accountCols.indexOf("confirm_token") === -1) {
    db.exec("ALTER TABLE accounts ADD COLUMN confirm_token TEXT");
  }

  var rosterCols = db.prepare("PRAGMA table_info(roster)").all().map(function (c) { return c.name; });
  if (rosterCols.indexOf("occupation") === -1) {
    db.exec("ALTER TABLE roster ADD COLUMN occupation TEXT");
  }
  if (rosterCols.indexOf("created_at") === -1) {
    db.exec("ALTER TABLE roster ADD COLUMN created_at TEXT");
  }

  // Only the original house gets the fixed starter roster — every new house
  // starts with an empty roster; each member adds themselves once they join
  // (nobody, including the house's builder, types anyone else's name).
  if (opts.seedRoster) {
    var rosterCount = db.prepare("SELECT COUNT(*) AS n FROM roster").get().n;
    if (rosterCount === 0) {
      var seed = db.prepare("INSERT INTO roster (name, position) VALUES (?, ?)");
      var insertSeed = db.transaction(function () {
        DEFAULT_SEED_ROSTER.forEach(function (name, i) { seed.run(name, i); });
      });
      insertSeed();
    }
  }

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS achievements (
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      unlocked_at TEXT NOT NULL,
      PRIMARY KEY (name, code)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      date_key TEXT NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (date_key, name)
    )
  `);

  // Per-house collection schedule. The original house keeps using the
  // hardcoded calendar in rotation.js (real Luxembourg collection dates);
  // every other house's schedule lives here instead, starting empty — see
  // the "not set up yet" state in the app until someone adds dates.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule (
      date_key TEXT PRIMARY KEY,
      codes TEXT NOT NULL
    )
  `);
}

var cache = new Map();

function openDefaultDb() {
  var db = new Database(path.join(DATA_DIR, "bin-duty.sqlite"));
  ensureSchema(db, { seedRoster: true });
  return db;
}

function openHouseDb(slug) {
  var db = new Database(path.join(HOUSES_DIR, slug + ".sqlite"));
  ensureSchema(db, { seedRoster: false });
  return db;
}

// Returns the shared connection for a house, opening and caching it on
// first use. Pass no slug (or the default slug) for the original house.
function getDb(slug) {
  var key = !slug || slug === DEFAULT_SLUG ? DEFAULT_SLUG : slug;
  if (!cache.has(key)) {
    cache.set(key, key === DEFAULT_SLUG ? openDefaultDb() : openHouseDb(key));
  }
  return cache.get(key);
}

module.exports = { getDb, DEFAULT_SLUG, HOUSES_DIR };
