// Signing in as a housemate with a code emailed to them.
//
// A name on the roster is "protected" once it has a confirmed email address
// (the same address the reminder emails go to). Picking a protected name on a
// device needs a 6-digit code sent to that address; a correct code gives the
// device a long-lived session token, so it stays signed in until the person
// chooses to sign out — and then needs a fresh code to get back in. Names with
// no confirmed email stay open, exactly as before.
//
// Codes and session tokens are only ever stored hashed. A session remembers
// which email it was earned through (the address the code went to, or the
// one being confirmed by the device that set the name up), and it only counts
// while that email is a confirmed address of the name — so whoever protects a
// name with their own address can't be overridden by an older session.

const crypto = require("crypto");

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;          // wrong guesses per code
const MAX_FAILS = 20;            // wrong guesses per name per FAIL_WINDOW_MS, across all its codes and devices
                                 // (index.js also caps each device's own guesses, so one person can't trip this alone)
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 60 * 1000; // how often a session's last_seen is rewritten

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      name TEXT PRIMARY KEY,
      code_hash TEXT,
      expires_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL DEFAULT 0,
      fails INTEGER NOT NULL DEFAULT 0,
      fails_since INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )
  `);
  const cols = db.prepare("PRAGMA table_info(auth_sessions)").all().map((c) => c.name);
  if (cols.indexOf("email") === -1) {
    db.exec("ALTER TABLE auth_sessions ADD COLUMN email TEXT");
    // Sessions from before this column were all earned with a code sent to the
    // name's confirmed address, so they belong to that address.
    db.exec(`UPDATE auth_sessions SET email = (
      SELECT email FROM accounts WHERE accounts.name = auth_sessions.name AND confirmed = 1 ORDER BY created_at DESC LIMIT 1
    ) WHERE email IS NULL`);
  }
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function codeHash(name, code) {
  return sha("code:" + name + ":" + code);
}

// Names that need a code: those with a confirmed email.
function lockedNames(db) {
  return db.prepare("SELECT DISTINCT name FROM accounts WHERE confirmed = 1").all().map((r) => r.name);
}
function isLocked(db, name) {
  return !!db.prepare("SELECT 1 FROM accounts WHERE name = ? AND confirmed = 1 LIMIT 1").get(name);
}
function accountFor(db, name) {
  return db.prepare(
    "SELECT email, language FROM accounts WHERE name = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 1"
  ).get(name) || null;
}

function failBlocked(row, now) {
  return !!row && row.fails >= MAX_FAILS && now - row.fails_since < FAIL_WINDOW_MS;
}

// Makes a new code for `name`. { code } on success, { error, wait } when
// refused (too soon after the last one, or too many wrong guesses lately).
function issueCode(db, name, now) {
  now = now || Date.now();
  const row = db.prepare("SELECT * FROM auth_codes WHERE name = ?").get(name);
  if (failBlocked(row, now)) {
    return { error: "locked", wait: Math.ceil((row.fails_since + FAIL_WINDOW_MS - now) / 1000) };
  }
  if (row && now - row.sent_at < RESEND_MS) {
    return { error: "cooldown", wait: Math.ceil((row.sent_at + RESEND_MS - now) / 1000) };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const keepFails = row && now - row.fails_since < FAIL_WINDOW_MS;
  db.prepare(
    "INSERT INTO auth_codes (name, code_hash, expires_at, attempts, sent_at, fails, fails_since) VALUES (?, ?, ?, 0, ?, ?, ?) " +
    "ON CONFLICT(name) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, " +
    "sent_at = excluded.sent_at, fails = excluded.fails, fails_since = excluded.fails_since"
  ).run(name, codeHash(name, code), now + CODE_TTL_MS, now, keepFails ? row.fails : 0, keepFails ? row.fails_since : now);
  return { code };
}

// Used when the email couldn't be sent, so a code nobody received doesn't
// count against the resend cooldown.
function dropCode(db, name) {
  db.prepare("UPDATE auth_codes SET code_hash = NULL, sent_at = 0 WHERE name = ?").run(name);
}

// { token } for a right code. Otherwise { error: "none" | "expired" | "wrong" | "locked", left?, wait? }.
function verifyCode(db, name, code, now) {
  now = now || Date.now();
  const row = db.prepare("SELECT * FROM auth_codes WHERE name = ?").get(name);
  if (!row || !row.code_hash) return { error: "none" };
  if (failBlocked(row, now)) {
    return { error: "locked", wait: Math.ceil((row.fails_since + FAIL_WINDOW_MS - now) / 1000) };
  }
  if (now > row.expires_at) return { error: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { error: "expired" };

  const given = Buffer.from(codeHash(name, String(code || "").trim()), "hex");
  const want = Buffer.from(row.code_hash, "hex");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const windowOpen = now - row.fails_since < FAIL_WINDOW_MS;
    db.prepare("UPDATE auth_codes SET attempts = attempts + 1, fails = ?, fails_since = ? WHERE name = ?")
      .run(windowOpen ? row.fails + 1 : 1, windowOpen ? row.fails_since : now, name);
    return { error: "wrong", left: Math.max(0, MAX_ATTEMPTS - row.attempts - 1) };
  }

  db.prepare("UPDATE auth_codes SET code_hash = NULL, attempts = 0, fails = 0 WHERE name = ?").run(name);
  const account = accountFor(db, name);
  return { token: createSession(db, name, account ? account.email : null, now) };
}

// Signs a device in as `name` without a code. Only for the device that is
// attaching the very first email to a name that was open until now — it is
// the one setting the protection up, so it shouldn't be locked out by it.
function createSession(db, name, email, now) {
  now = now || Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO auth_sessions (token_hash, name, email, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
    .run(sha(token), name, email || null, now, now);
  return token;
}

// The name a session token belongs to, or null if it's unknown / expired.
function sessionName(db, token, now) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  now = now || Date.now();
  const h = sha(token);
  const row = db.prepare("SELECT name, email, last_seen FROM auth_sessions WHERE token_hash = ?").get(h);
  if (!row) return null;
  if (now - row.last_seen > SESSION_MS) {
    db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(h);
    return null;
  }
  // A protected name only accepts sessions earned through one of its own
  // confirmed addresses (not dropped: the address may be confirmed later).
  if (isLocked(db, row.name) &&
      !(row.email && db.prepare("SELECT 1 FROM accounts WHERE name = ? AND email = ? AND confirmed = 1").get(row.name, row.email))) {
    return null;
  }
  if (now - row.last_seen > TOUCH_MS) {
    db.prepare("UPDATE auth_sessions SET last_seen = ? WHERE token_hash = ?").run(now, h);
  }
  return row.name;
}

// Every session of a name — when the name leaves the roster.
function revokeName(db, name) {
  db.prepare("DELETE FROM auth_sessions WHERE name = ?").run(name);
  db.prepare("DELETE FROM auth_codes WHERE name = ?").run(name);
}

function revoke(db, token) {
  if (typeof token !== "string") return;
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha(token));
}

module.exports = {
  ensureTables, lockedNames, isLocked, accountFor,
  issueCode, dropCode, verifyCode, createSession, sessionName, revoke, revokeName,
  CODE_TTL_MS, RESEND_MS, MAX_ATTEMPTS
};
