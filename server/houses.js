// The house registry: one row per house (name, city, language, when it was
// built), keyed by the slug that's also its invite code and its URL param
// (?h=slug). Kept in its own small database, separate from any single
// house's data — this is the directory, not a house's own roster/tasks/etc.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "houses.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS houses (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    created_at TEXT NOT NULL,
    is_original INTEGER NOT NULL DEFAULT 0
  )
`);

// Idempotent migration for installs that had the houses table before
// is_original existed.
var houseCols = db.prepare("PRAGMA table_info(houses)").all().map(function (c) { return c.name; });
if (houseCols.indexOf("is_original") === -1) {
  db.exec("ALTER TABLE houses ADD COLUMN is_original INTEGER NOT NULL DEFAULT 0");
}
// Proof of "who built this house", with no accounts: a random owner key is
// handed to the builder's browser exactly once, and only its SHA-256 hash is
// kept here — so the key itself never sits in the database. Houses built
// before this existed (and the original house) have none, and so can't be
// destroyed from the app.
if (houseCols.indexOf("owner_token_hash") === -1) {
  db.exec("ALTER TABLE houses ADD COLUMN owner_token_hash TEXT");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const MAX_NAME_LENGTH = 60;
const MAX_CITY_LENGTH = 60;
// Blocks the characters that matter once this becomes a page title or gets
// rendered — apostrophes are deliberately allowed (unlike the roster name
// check elsewhere): "Rue d'Ostende Crew" is exactly the kind of real house
// name this field needs to accept, and the value only ever reaches the page
// via textContent, never raw HTML, so an apostrophe carries no risk.
const UNSAFE_CHARS = /[<>&"`\x00-\x1F]/;

function slugifyBase(name) {
  var base = name
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip accents (é → e)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "house";
}

function randomSuffix() {
  return crypto.randomBytes(3).toString("hex"); // 6 hex chars, e.g. "7f2a4c"
}

function getHouse(slug) {
  if (!slug) return null;
  return db.prepare("SELECT * FROM houses WHERE slug = ?").get(slug.toLowerCase());
}

// Builds a house — anyone can do this, no approval or account needed,
// consistent with the rest of the app's "no accounts" design. Retries the
// random suffix on the astronomically unlikely slug collision.
function createHouse({ name, city, language }) {
  var cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName) {
    var err = new Error("House name can't be empty.");
    err.status = 400;
    throw err;
  }
  if (cleanName.length > MAX_NAME_LENGTH) {
    var errLen = new Error(`House name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    errLen.status = 400;
    throw errLen;
  }
  if (UNSAFE_CHARS.test(cleanName)) {
    var errChars = new Error("House name can't contain <, >, &, quotes, or control characters.");
    errChars.status = 400;
    throw errChars;
  }
  var cleanCity = typeof city === "string" ? city.trim().slice(0, MAX_CITY_LENGTH) : "";
  if (cleanCity && UNSAFE_CHARS.test(cleanCity)) {
    var errCity = new Error("City can't contain <, >, &, quotes, or control characters.");
    errCity.status = 400;
    throw errCity;
  }
  var cleanLang = typeof language === "string" && language ? language : "en";

  var base = slugifyBase(cleanName);
  var slug;
  for (var attempt = 0; attempt < 8; attempt++) {
    slug = base + "-" + randomSuffix();
    if (!getHouse(slug)) break;
  }

  var ownerToken = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO houses (slug, name, city, language, created_at, owner_token_hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, cleanName, cleanCity || null, cleanLang, new Date().toISOString(), hashToken(ownerToken));

  // The plaintext owner key is returned only here, once, to the builder.
  return { house: getHouse(slug), ownerToken: ownerToken };
}

// True only for the house's builder: a real (non-original) house whose
// stored hash matches the key presented. Constant-time compare.
function isOwner(slug, token) {
  var row = getHouse(slug);
  if (!row || row.is_original || !row.owner_token_hash || typeof token !== "string" || !token) return false;
  var a = Buffer.from(row.owner_token_hash, "hex");
  var b = Buffer.from(hashToken(token), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deleteHouse(slug) {
  db.prepare("DELETE FROM houses WHERE slug = ? AND is_original = 0").run(slug);
}

// The app's original house (the one that existed before multi-house
// support) now has to be reached the same way as any other — a real,
// unguessable invite slug — instead of being whatever loads with no ?h= at
// all. This mints that slug exactly once (persisted here, so it's stable
// across restarts and deploys) and is idempotent: every later call just
// returns the same row.
function ensureOriginalHouse(name) {
  var existing = db.prepare("SELECT * FROM houses WHERE is_original = 1").get();
  if (existing) return existing;

  var base = slugifyBase(name);
  var slug;
  for (var attempt = 0; attempt < 8; attempt++) {
    slug = base + "-" + randomSuffix();
    if (!getHouse(slug)) break;
  }
  db.prepare(
    "INSERT INTO houses (slug, name, city, language, created_at, is_original) VALUES (?, ?, NULL, 'en', ?, 1)"
  ).run(slug, name, new Date().toISOString());
  return getHouse(slug);
}

module.exports = { getHouse, createHouse, ensureOriginalHouse, isOwner, deleteHouse };
