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
async function sendDailyReminderPush(db, roster, lang) {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const codes = codesFor(tomorrow);
  if (!codes || codes === "HOLIDAY" || !roster.length) return { sent: 0, pruned: 0, errors: [] };
  const label = codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
  const person = personForWeek(tomorrow, roster);
  return sendToAll(db, {
    title: `${t(lang, "tonightLabel")} ${label}`,
    body: `${t(lang, "dutyMsgHeading")} ${person}`,
    url: "/"
  });
}

async function sendOutFollowUpPush(db, task, lang) {
  const label = task.codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
  return sendToAll(db, {
    title: `${t(lang, "outReminderHeading")} — ${label}`,
    body: t(lang, "outReminderPushBody").replace("{label}", label),
    url: "/"
  });
}

async function sendWeekAheadPush(db, roster, lang) {
  if (!roster.length) return { sent: 0, pruned: 0, errors: [] };
  const today = new Date();
  const nextMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const person = personForWeek(nextMonday, roster);
  return sendToAll(db, {
    title: t(lang, "weekAheadSubject"),
    body: t(lang, "weekAheadBody").replace("{name}", person),
    url: "/"
  });
}

module.exports = {
  configure, publicKey, saveSubscription, removeSubscription, sendToAll,
  sendDailyReminderPush, sendOutFollowUpPush, sendWeekAheadPush
};
