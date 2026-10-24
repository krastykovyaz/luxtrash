// What a skipped collection does to notifications.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

process.env.BIN_DUTY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bin-duty-notify-"));
const push = require("../push");
const tasks = require("../tasks");
const Database = require("better-sqlite3");

test("the 'skipped' push replaces the duty reminder quietly", () => {
  const p = push.skippedPayload({ codes: "VB" }, "en", "/?h=x");
  assert.equal(p.tag, "duty");           // same tag as the reminders it replaces
  assert.equal(p.renotify, false);       // and it doesn't buzz again
  assert.match(p.title, /skipped/i);
  assert.match(p.title, /Glass/);
  assert.equal(p.url, "/?h=x");
});

test("taking a skip back sends a message that replaces 'skipped' and does alert", () => {
  const p = push.unskippedPayload({ codes: "VB" }, "en", "/?h=x");
  assert.equal(p.tag, "duty");
  assert.equal(p.renotify, true);
  assert.match(p.title, /back on/i);
});

function runPush(data) {
  const shown = [];
  const handlers = {};
  const self = {
    location: { origin: "https://x.test" },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    registration: { showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); } },
    skipWaiting() {}, clients: { claim() {}, matchAll: async () => [] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "public", "sw.js"), "utf8"), { self, URL, Response, caches: {}, Date });
  handlers.push({ data: { json: () => data }, waitUntil: () => {} });
  return shown[0].options;
}

test("the service worker: tagged messages alert, unless they say to update quietly", () => {
  assert.equal(runPush({ title: "t", tag: "chat" }).renotify, true);
  assert.equal(runPush({ title: "t", tag: "duty" }).renotify, true);
  const quiet = runPush({ title: "t", tag: "duty", renotify: false });
  assert.equal(quiet.tag, "duty");
  assert.equal(quiet.renotify, false);
  assert.equal(runPush({ title: "t" }).tag, undefined);
});

test("a skipped collection never gets a follow-up reminder or a day-before reminder", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (date_key TEXT PRIMARY KEY, codes TEXT NOT NULL, out_by TEXT, out_at TEXT, back_by TEXT, back_at TEXT,
    coins INTEGER NOT NULL DEFAULT 10, out_reminder_count INTEGER NOT NULL DEFAULT 0, skipped_by TEXT, skipped_at TEXT,
    out_photo TEXT, out_photo_mime TEXT, back_photo TEXT, back_photo_mime TEXT, out_photo_taken_at TEXT, back_photo_taken_at TEXT)`);
  const today = new Date(2026, 9, 15, 5, 30);           // Thursday 15 October, early morning
  const flat = { "2026-10-15": "VB", "2026-10-16": "P" };
  const before = tasks.getCurrentTask(db, today, flat);
  assert.equal(before.date_key, "2026-10-15");           // the one that gets follow-up reminders

  // What skipTask writes (its date rules read the real clock, so the row is made directly here;
  // the API test covers skipTask itself).
  db.prepare("INSERT INTO tasks (date_key, codes, skipped_by, skipped_at) VALUES ('2026-10-15', 'VB', 'Alex', ?)").run(today.toISOString());
  assert.equal(tasks.isSkipped(db, "2026-10-15"), true);
  const after = tasks.getCurrentTask(db, today, flat);
  assert.equal(after.date_key, "2026-10-16");            // the app and the follow-up cron both move on
});
