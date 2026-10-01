const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const HOUSES_DIR = path.join(DATA_DIR, "houses");
if (!fs.existsSync(HOUSES_DIR)) fs.mkdirSync(HOUSES_DIR, { recursive: true });

const PHOTOS_DIR = path.join(DATA_DIR, "task-photos");
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const CHAT_PHOTOS_DIR = path.join(DATA_DIR, "chat-photos");
if (!fs.existsSync(CHAT_PHOTOS_DIR)) fs.mkdirSync(CHAT_PHOTOS_DIR, { recursive: true });

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

  // Proof-of-duty photos: one for the bin out at the curb, one for it back
  // in place, stored as filenames (the bytes live on disk — see
  // server/index.js's taskPhotoDir) with the mime type needed to serve them
  // correctly. Deliberately not kept forever: whenever a new collection of
  // the same codes is confirmed out, index.js clears every older task's
  // photos for that same codes value — a photo only has to outlive its own
  // collection cycle, not the whole house's history.
  var taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(function (c) { return c.name; });
  ["out_photo", "out_photo_mime", "back_photo", "back_photo_mime", "out_photo_taken_at", "back_photo_taken_at"].forEach(function (col) {
    if (taskCols.indexOf(col) === -1) {
      db.exec("ALTER TABLE tasks ADD COLUMN " + col + " TEXT");
    }
  });
  // How many "still not out" follow-up reminders have gone out for this
  // task — capped at 2 (see server/index.js's outReminderCron) so someone
  // who never confirms doesn't get emailed forever.
  if (taskCols.indexOf("out_reminder_count") === -1) {
    db.exec("ALTER TABLE tasks ADD COLUMN out_reminder_count INTEGER NOT NULL DEFAULT 0");
  }

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

  // Web Push subscriptions — one row per browser/device that's turned
  // notifications on, keyed by its push endpoint (unique per browser
  // install). Not tied to a roster name: like email reminders, a push goes
  // to every subscribed device in the house, not filtered by whose turn it
  // is — same reasoning as sendDailyReminders in mailer.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Anonymous house chat. author_key is a keyed hash of the posting device's
  // random token — it lets a device recognise (and delete) its own messages
  // and keeps one codename per device per week, and is never sent to clients.
  // No name, email or roster entry is stored anywhere in these tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_key TEXT NOT NULL,
      codename TEXT NOT NULL,
      hue INTEGER NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      photo TEXT,
      photo_mime TEXT,
      photo_expired INTEGER NOT NULL DEFAULT 0,
      reply_to INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_aliases (
      author_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      codename TEXT NOT NULL,
      hue INTEGER NOT NULL,
      PRIMARY KEY (author_key, week_key)
    );
    -- One reaction per device per message (tapping the same emoji again
    -- takes it back). Only counts ever leave the server, never who reacted.
    CREATE TABLE IF NOT EXISTS chat_reactions (
      message_id INTEGER NOT NULL,
      author_key TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, author_key)
    );
  `);

  var chatCols = db.prepare("PRAGMA table_info(chat_messages)").all().map(function (c) { return c.name; });
  if (chatCols.indexOf("photo_expired") === -1) db.exec("ALTER TABLE chat_messages ADD COLUMN photo_expired INTEGER NOT NULL DEFAULT 0");

  // Chat notifications are an opt-in per push subscription. chat_author_key
  // being set means "this device wants them", and it's the same keyed hash
  // chat messages carry, so a device is never notified about its own posts.
  var pushCols = db.prepare("PRAGMA table_info(push_subscriptions)").all().map(function (c) { return c.name; });
  if (pushCols.indexOf("chat_author_key") === -1) db.exec("ALTER TABLE push_subscriptions ADD COLUMN chat_author_key TEXT");
  if (pushCols.indexOf("chat_pushed_at") === -1) db.exec("ALTER TABLE push_subscriptions ADD COLUMN chat_pushed_at TEXT");

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

  require("./auth").ensureTables(db);
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

// Permanently removes a custom house's database: closes the cached
// connection, then deletes the file and its WAL/SHM siblings. Refuses the
// original house outright, whatever slug is passed.
function destroyHouseDb(slug) {
  if (!slug || slug === DEFAULT_SLUG || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Refusing to destroy that database.");
  }
  var db = cache.get(slug);
  if (db) {
    db.close();
    cache.delete(slug);
  }
  ["", "-wal", "-shm"].forEach(function (suffix) {
    var file = path.join(HOUSES_DIR, slug + ".sqlite" + suffix);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  [PHOTOS_DIR, CHAT_PHOTOS_DIR].forEach(function (base) {
    var photoDir = path.join(base, slug);
    if (fs.existsSync(photoDir)) fs.rmSync(photoDir, { recursive: true, force: true });
  });
}

// Where a house's proof-of-duty photos live on disk — one subfolder per
// house, named the same way its database file is (the default house's
// internal sentinel, or a custom house's slug). Created on first use.
function taskPhotoDir(slug) {
  var key = !slug || slug === DEFAULT_SLUG ? DEFAULT_SLUG : slug;
  var dir = path.join(PHOTOS_DIR, key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Same layout for a house's anonymous-chat pictures.
function chatPhotoDir(slug) {
  var key = !slug || slug === DEFAULT_SLUG ? DEFAULT_SLUG : slug;
  var dir = path.join(CHAT_PHOTOS_DIR, key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { getDb, DEFAULT_SLUG, HOUSES_DIR, DATA_DIR, destroyHouseDb, taskPhotoDir, chatPhotoDir };
