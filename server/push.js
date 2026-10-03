// Web Push notifications — the same trigger points as mailer.js's emails
// (tomorrow's reminder, the "still not out" follow-ups, the week-ahead
// notice), but delivered as a real OS-level push notification instead of
// an email, so they land on a phone's lock screen. Works in any browser
// that supports the Push API: desktop Chrome/Firefox/Edge directly, Android
// Chrome directly, and iOS Safari only after the page has been added to
// the Home Screen (iOS 16.4+) — a plain Safari tab on iOS cannot receive
// push at all, which is a platform limitation, not something this code
// can work around.

const webpush = require("web-push");
const { t, binLabel } = require("./i18n");
const { codesFor, personForWeek } = require("./rotation");

let configured = false;
let warnedMissingConfig = false;

function configure() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    if (!warnedMissingConfig) {
      console.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled until they are.");
      warnedMissingConfig = true;
    }
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Browser push services — the only places a subscription may point, since
// the server POSTs to that address later.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
function isPushServiceUrl(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  let url;
  try { url = new URL(endpoint); } catch (e) { return false; }
  return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const MAX_SUBSCRIPTIONS_PER_HOUSE = 100;
function hasRoomFor(db, endpoint) {
  if (db.prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint)) return true;
  return db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n < MAX_SUBSCRIPTIONS_PER_HOUSE;
}

function saveSubscription(db, sub) {
  db.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth"
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
}

function removeSubscription(db, endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

// Sends one payload to every subscribed device, pruning any subscription
// the push service reports as gone (410/404 — the browser install was
// uninstalled, the permission revoked, etc.) instead of retrying it forever.
async function sendToAll(db, payload) {
  if (!configure()) return { sent: 0, pruned: 0, errors: [] };
  const subs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all();
  const body = JSON.stringify(payload);
  const errors = [];
  let sent = 0;
  let pruned = 0;
  for (const row of subs) {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(db, row.endpoint);
        pruned++;
      } else {
        errors.push({ endpoint: row.endpoint, message: err.message });
      }
    }
  }
  return { sent, pruned, errors };
}

// Same "tonight's bins" heads-up as buildTomorrowMessage in mailer.js, as a
// push payload instead of an email. Sent in whatever language each account
// reads email in isn't possible here — a push has no per-recipient
// rendering, it's one payload broadcast to every subscribed device — so
// this uses the house's own default language.
async function sendDailyReminderPush(db, roster, lang, url) {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const codes = codesFor(tomorrow);
  if (!codes || codes === "HOLIDAY" || !roster.length) return { sent: 0, pruned: 0, errors: [] };
  const label = codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
  const person = personForWeek(tomorrow, roster);
  return sendToAll(db, {
    title: `${t(lang, "tonightLabel")} ${label}`,
    body: `${t(lang, "dutyMsgHeading")} ${person}`,
    url: url || "/"
  });
}

async function sendOutFollowUpPush(db, task, lang, url) {
  const label = task.codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
  return sendToAll(db, {
    title: `${t(lang, "outReminderHeading")} — ${label}`,
    body: t(lang, "outReminderPushBody").replace("{label}", label),
    url: url || "/"
  });
}

async function sendWeekAheadPush(db, roster, lang, url) {
  if (!roster.length) return { sent: 0, pruned: 0, errors: [] };
  const today = new Date();
  const nextMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const person = personForWeek(nextMonday, roster);
  return sendToAll(db, {
    title: t(lang, "weekAheadSubject"),
    body: t(lang, "weekAheadBody").replace("{name}", person),
    url: url || "/"
  });
}

// ---- chat notifications ----

// Opt a subscription in or out of chat notifications. authorKey ties it to the
// chat identity of the device that turned it on (so that device is skipped
// when it's the one posting); null turns them off. False = no such subscription.
function setChatPush(db, endpoint, authorKey) {
  return db.prepare("UPDATE push_subscriptions SET chat_author_key = ?, chat_pushed_at = NULL WHERE endpoint = ?")
    .run(authorKey, endpoint).changes > 0;
}

function chatPushEnabled(db, endpoint) {
  const row = db.prepare("SELECT chat_author_key FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  return !!(row && row.chat_author_key);
}

const CHAT_PUSH_COOLDOWN_MS = 60 * 1000;

// One push per new message to every opted-in device except the author's —
// deliberately saying nothing about who wrote it or what it says, only that
// something's new. A device that was just notified is left alone for a
// minute so a quick back-and-forth doesn't buzz it for every line; a reply
// aimed at a device's own message always goes through, worded as a reply.
async function notifyChat(db, { authorKey, parentAuthorKey, lang, url, now }) {
  if (!configure()) return { sent: 0, pruned: 0, skipped: 0 };
  const at = now || Date.now();
  const subs = db.prepare(
    "SELECT endpoint, p256dh, auth, chat_author_key, chat_pushed_at FROM push_subscriptions WHERE chat_author_key IS NOT NULL AND chat_author_key != ?"
  ).all(authorKey);
  let sent = 0, pruned = 0, skipped = 0;
  for (const row of subs) {
    const isReply = !!parentAuthorKey && row.chat_author_key === parentAuthorKey;
    if (!isReply && row.chat_pushed_at && at - Date.parse(row.chat_pushed_at) < CHAT_PUSH_COOLDOWN_MS) { skipped++; continue; }
    const payload = JSON.stringify({
      title: t(lang, "chatPushTitle"),
      body: t(lang, isReply ? "chatPushReply" : "chatPushNew"),
      url,
      tag: "chat"
    });
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload);
      db.prepare("UPDATE push_subscriptions SET chat_pushed_at = ? WHERE endpoint = ?").run(new Date(at).toISOString(), row.endpoint);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { removeSubscription(db, row.endpoint); pruned++; }
      else console.error("Chat push failed:", err.message);
    }
  }
  return { sent, pruned, skipped };
}

module.exports = {
  setChatPush, chatPushEnabled, notifyChat,
  isPushServiceUrl, hasRoomFor,
  configure, publicKey, saveSubscription, removeSubscription, sendToAll,
  sendDailyReminderPush, sendOutFollowUpPush, sendWeekAheadPush
};
