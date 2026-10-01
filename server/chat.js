// Anonymous house chat. Everyone in a house shares one thread and posts under
// a codename that changes every week — nobody's name is ever shown, and none
// is ever stored: a device is just a random token it generates for itself,
// kept here only as a keyed hash.
//
// Anonymity is from the other housemates. The server can still tell that two
// messages came from one device (that's what makes "your" messages, delete,
// and a stable weekly codename possible), and — as everywhere in this app —
// there's no login, so whoever holds a device's token can post as it.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { weekKeyOf } = require("./rotation");
const { DATA_DIR, chatPhotoDir } = require("./db");

const MAX_BODY = 1000;
const REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}"];
const FEED_SIZE = 100;
const RETENTION_DAYS = 30;       // message text
const PHOTO_RETENTION_DAYS = 7;  // pictures are the heavy part, so they go sooner

const ADJECTIVES = ["Amber", "Brisk", "Cosmic", "Dusty", "Eager", "Frosty", "Gentle", "Hazy", "Icy", "Jolly", "Keen", "Lucky", "Mellow", "Nimble", "Odd", "Plucky", "Quiet", "Rusty", "Sunny", "Tidy", "Umber", "Vivid", "Witty", "Zesty", "Bold", "Calm", "Daring", "Fuzzy", "Glad", "Humble", "Sly", "Swift"];
const ANIMALS = ["Badger", "Beetle", "Crow", "Dingo", "Ferret", "Gecko", "Heron", "Ibis", "Jackal", "Koala", "Lemur", "Mole", "Newt", "Otter", "Panda", "Quokka", "Raven", "Stoat", "Toad", "Vole", "Walrus", "Yak", "Zebra", "Falcon", "Hedgehog", "Lynx", "Moose", "Owl", "Pigeon", "Robin", "Seal", "Wombat"];

// Generated once and kept next to the databases. Without it the hashes can't
// be recomputed, and nobody can work out which token a stored key came from.
function loadSecret() {
  const file = path.join(DATA_DIR, "chat-secret");
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

function hmac(input) {
  return crypto.createHmac("sha256", SECRET).update(input).digest();
}

function validToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

function authorKey(token) {
  return hmac("author|" + token).toString("hex").slice(0, 32);
}

// One codename per device per week, unique within the house that week. If a
// freshly derived one is already taken, the next derivation is tried — still
// deterministic, so it never depends on who asked first beyond that.
function aliasFor(db, key, now) {
  const week = weekKeyOf(now || new Date());
  const existing = db.prepare("SELECT codename, hue FROM chat_aliases WHERE author_key = ? AND week_key = ?").get(key, week);
  if (existing) return existing;
  const taken = new Set(db.prepare("SELECT codename FROM chat_aliases WHERE week_key = ?").all(week).map((r) => r.codename));
  for (let i = 0; i < 200; i++) {
    const h = hmac(`alias|${key}|${week}|${i}`);
    const codename = `${ADJECTIVES[h.readUInt16BE(0) % ADJECTIVES.length]} ${ANIMALS[h.readUInt16BE(2) % ANIMALS.length]}`;
    if (taken.has(codename) && i < 199) continue;
    const hue = h.readUInt16BE(4) % 360;
    db.prepare("INSERT OR IGNORE INTO chat_aliases (author_key, week_key, codename, hue) VALUES (?, ?, ?, ?)").run(key, week, codename, hue);
    return db.prepare("SELECT codename, hue FROM chat_aliases WHERE author_key = ? AND week_key = ?").get(key, week);
  }
}

// Judged from the bytes, never from what the client claims the file is.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.length > 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

function snippet(body) {
  const flat = String(body || "").replace(/\s+/g, " ").trim();
  return flat.length > 90 ? flat.slice(0, 89) + "…" : flat;
}

function shape(db, row, key) {
  let replyTo = null;
  if (row.reply_to != null) {
    const parent = db.prepare("SELECT id, codename, hue, body, photo IS NOT NULL AS hasPhoto FROM chat_messages WHERE id = ?").get(row.reply_to);
    replyTo = parent
      ? { id: parent.id, codename: parent.codename, hue: parent.hue, snippet: snippet(parent.body), hasPhoto: !!parent.hasPhoto }
      : { id: row.reply_to, deleted: true };
  }
  const counts = db.prepare("SELECT emoji, COUNT(*) AS n, SUM(author_key = ?) AS mine FROM chat_reactions WHERE message_id = ? GROUP BY emoji").all(key, row.id);
  const reactions = REACTIONS.map((emoji) => {
    const c = counts.find((r) => r.emoji === emoji);
    return { emoji, count: c ? c.n : 0, mine: !!(c && c.mine) };
  });
  return {
    id: row.id,
    codename: row.codename,
    hue: row.hue,
    body: row.body,
    hasPhoto: !!row.photo,
    photoExpired: !!row.photo_expired,
    replyTo,
    reactions,
    createdAt: row.created_at,
    mine: row.author_key === key
  };
}

function list(db, slug, key) {
  maybePrune(db, slug);
  const rows = db.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?").all(FEED_SIZE).reverse();
  return { me: aliasFor(db, key), messages: rows.map((r) => shape(db, r, key)) };
}

function unreadCount(db, key, afterId) {
  return db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE id > ? AND author_key != ?").get(afterId, key).n;
}

function removePhotoFile(slug, filename) {
  if (!filename) return;
  const file = path.join(chatPhotoDir(slug), filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Pictures older than PHOTO_RETENTION_DAYS are deleted from disk (the message
// stays, marked as expired, so the thread still reads properly); whole
// messages go after RETENTION_DAYS. There's no timer: this runs whenever a
// house's chat is read or posted to, at most once every ten minutes per house,
// so it covers every house (the scheduled jobs here only look at the original).
const lastPrune = new Map();
function maybePrune(db, slug) {
  const last = lastPrune.get(slug) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  lastPrune.set(slug, Date.now());
  prune(db, slug);
}

function prune(db, slug) {
  const photoCutoff = new Date(Date.now() - PHOTO_RETENTION_DAYS * 86400000).toISOString();
  db.prepare("SELECT photo FROM chat_messages WHERE created_at < ? AND photo IS NOT NULL").all(photoCutoff)
    .forEach((r) => removePhotoFile(slug, r.photo));
  db.prepare("UPDATE chat_messages SET photo = NULL, photo_mime = NULL, photo_expired = 1 WHERE created_at < ? AND photo IS NOT NULL").run(photoCutoff);

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  db.prepare("DELETE FROM chat_messages WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM chat_reactions WHERE message_id NOT IN (SELECT id FROM chat_messages)").run();
  const oldWeek = weekKeyOf(new Date(Date.now() - 8 * 7 * 86400000));
  db.prepare("DELETE FROM chat_aliases WHERE week_key < ?").run(oldWeek);
}

function post(db, slug, key, { body, replyTo, file }) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text.length > MAX_BODY) throw Object.assign(new Error(`Keep it under ${MAX_BODY} characters.`), { status: 400 });
  let image = null;
  if (file) {
    image = sniffImage(file.buffer);
    if (!image) throw Object.assign(new Error("That file isn't a JPEG, PNG or WebP image."), { status: 400 });
  }
  if (!text && !image) throw Object.assign(new Error("Write something or attach a picture."), { status: 400 });

  let parentId = null;
  if (replyTo != null && replyTo !== "") {
    parentId = parseInt(replyTo, 10);
    if (!parentId || !db.prepare("SELECT 1 FROM chat_messages WHERE id = ?").get(parentId)) {
      throw Object.assign(new Error("The message you're replying to is gone."), { status: 400 });
    }
  }

  maybePrune(db, slug);
  const alias = aliasFor(db, key);
  const info = db.prepare(
    "INSERT INTO chat_messages (author_key, codename, hue, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(key, alias.codename, alias.hue, text, parentId, new Date().toISOString());
  const id = Number(info.lastInsertRowid);

  if (image) {
    const filename = `${id}.${image.ext}`;
    try {
      fs.writeFileSync(path.join(chatPhotoDir(slug), filename), file.buffer);
    } catch (err) {
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
      throw err;
    }
    db.prepare("UPDATE chat_messages SET photo = ?, photo_mime = ? WHERE id = ?").run(filename, image.mime, id);
  }
  return shape(db, db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id), key);
}

function remove(db, slug, key, id) {
  const row = db.prepare("SELECT author_key, photo FROM chat_messages WHERE id = ?").get(id);
  if (!row) return "missing";
  if (row.author_key !== key) return "forbidden";
  removePhotoFile(slug, row.photo);
  db.prepare("DELETE FROM chat_reactions WHERE message_id = ?").run(id);
  db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
  return "ok";
}

// Tapping an emoji sets it; tapping the same one again takes it back;
// tapping a different one swaps it. One reaction per device per message.
function react(db, key, id, emoji) {
  if (!REACTIONS.includes(emoji)) throw Object.assign(new Error("That reaction isn't available."), { status: 400 });
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id);
  if (!row) throw Object.assign(new Error("That message is already gone."), { status: 404 });
  const existing = db.prepare("SELECT emoji FROM chat_reactions WHERE message_id = ? AND author_key = ?").get(id, key);
  if (existing && existing.emoji === emoji) {
    db.prepare("DELETE FROM chat_reactions WHERE message_id = ? AND author_key = ?").run(id, key);
  } else {
    db.prepare("INSERT INTO chat_reactions (message_id, author_key, emoji) VALUES (?, ?, ?) ON CONFLICT(message_id, author_key) DO UPDATE SET emoji = excluded.emoji").run(id, key, emoji);
  }
  return shape(db, row, key).reactions;
}

// Who wrote a message — only ever used server-side, to aim a "someone
// replied to you" notification at the right device.
function authorKeyOf(db, id) {
  const row = db.prepare("SELECT author_key FROM chat_messages WHERE id = ?").get(id);
  return row ? row.author_key : null;
}

function photoOf(db, slug, id) {
  const row = db.prepare("SELECT photo, photo_mime FROM chat_messages WHERE id = ?").get(id);
  if (!row || !row.photo) return null;
  const file = path.join(chatPhotoDir(slug), row.photo);
  return fs.existsSync(file) ? { file, mime: row.photo_mime } : null;
}

module.exports = { MAX_BODY, REACTIONS, validToken, authorKey, list, unreadCount, post, remove, react, authorKeyOf, photoOf };
