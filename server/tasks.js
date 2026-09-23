// Two-step bin duty: "out" (bin taken to the curb) and "back" (empty bin
// brought back in) — a task only counts as done, and only pays out Scrap,
// once both are confirmed. A task becomes actionable the evening before its
// collection date ("occurs a day before expiration") and stays open — even
// past its date, as overdue — until someone closes the loop.

const { codesForFlat } = require("./rotation");

const COINS_PER_TASK = 10;
const LOOKBACK_DAYS = 14; // how far back to surface a missed, still-open task

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateKey(key) {
  const [y, m, day] = key.split("-").map(Number);
  return new Date(y, m - 1, day);
}

// A dateKey is only trusted once it round-trips: right shape, and it's the
// canonical form of a real calendar date (rejects "2026-9-22", "2026-13-40",
// etc. — Date silently rolls invalid month/day values over into a different
// date instead of erroring, so the round-trip is the actual validation).
function isValidDateKey(key) {
  return typeof key === "string" && DATE_KEY_RE.test(key) && dateKeyOf(parseDateKey(key)) === key;
}

// Every real collection date (codes present, not a holiday) from
// `from` to `to` inclusive, oldest first.
function collectionDatesInRange(from, to, flatSchedule) {
  const dates = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor <= to) {
    const codes = codesForFlat(cursor, flatSchedule);
    if (codes && codes !== "HOLIDAY") dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getTaskRow(db, dateKey) {
  return db.prepare("SELECT * FROM tasks WHERE date_key = ?").get(dateKey);
}

function ensureTaskRow(db, dateKey, codes) {
  db.prepare(
    "INSERT INTO tasks (date_key, codes, coins) VALUES (?, ?, ?) ON CONFLICT(date_key) DO NOTHING"
  ).run(dateKey, codes, COINS_PER_TASK);
  return getTaskRow(db, dateKey);
}

// The one task the app should show right now, in priority order:
//
// 1. A task someone already started (bin confirmed OUT) but never closed
//    out (no BACK yet) — a bin that's physically still sitting at the curb,
//    however long ago that was. This never gets buried by newer tasks.
// 2. Otherwise, the nearest not-yet-started collection date whose window
//    has opened (today is on or after the evening before it — "a day
//    before expiration"). Old, never-started dates are NOT surfaced once
//    they've passed — there's nothing left to confirm about them, so they
//    just quietly age out instead of cluttering the current task forever.
//
// Returns null when nothing is open.
function getCurrentTask(db, today, flatSchedule) {
  const openRow = db.prepare(
    "SELECT * FROM tasks WHERE out_at IS NOT NULL AND back_at IS NULL ORDER BY date_key ASC LIMIT 1"
  ).get();
  if (openRow) {
    return { ...openRow, overdue: openRow.date_key < dateKeyOf(today), started: true };
  }

  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3);
  const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const candidates = collectionDatesInRange(from, windowEnd, flatSchedule);

  for (const date of candidates) {
    const opensAt = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    if (today < opensAt) continue; // window not open yet
    const dateKey = dateKeyOf(date);
    if (dateKey < dateKeyOf(today)) continue; // never started and already past — let it go
    const codes = codesForFlat(date, flatSchedule);
    const row = getTaskRow(db, dateKey) || { date_key: dateKey, codes, out_by: null, out_at: null, back_by: null, back_at: null, coins: COINS_PER_TASK };
    if (!row.back_at) {
      return { ...row, overdue: false, started: false };
    }
  }
  return null;
}

function confirmOut(db, dateKey, roster, name, flatSchedule) {
  if (!isValidDateKey(dateKey)) {
    const err = new Error("That's not a real collection date.");
    err.status = 400;
    throw err;
  }
  const date = parseDateKey(dateKey);
  const codes = codesForFlat(date, flatSchedule);
  if (!codes || codes === "HOLIDAY") {
    const err = new Error("There's no collection on that date.");
    err.status = 400;
    throw err;
  }
  // The task's window opens the evening before its date — matches what the
  // app shows as "current". Without this, anything with a real collection
  // code (any date through the end of the published schedule) could be
  // confirmed out and paid out immediately, regardless of when it's due.
  const today = new Date();
  const opensAt = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  if (today < opensAt) {
    const err = new Error("That task isn't open yet — it opens the evening before.");
    err.status = 400;
    throw err;
  }
  if (!roster.includes(name)) {
    const err = new Error("Unknown roster name.");
    err.status = 400;
    throw err;
  }
  ensureTaskRow(db, dateKey, codes);
  db.prepare("UPDATE tasks SET out_by = ?, out_at = ? WHERE date_key = ?")
    .run(name, new Date().toISOString(), dateKey);
  return getTaskRow(db, dateKey);
}

function confirmBack(db, dateKey, roster, name) {
  if (!isValidDateKey(dateKey)) {
    const err = new Error("That's not a real collection date.");
    err.status = 400;
    throw err;
  }
  const row = getTaskRow(db, dateKey);
  if (!row || !row.out_at) {
    const err = new Error("Confirm it's out before confirming it's back.");
    err.status = 400;
    throw err;
  }
  if (!roster.includes(name)) {
    const err = new Error("Unknown roster name.");
    err.status = 400;
    throw err;
  }
  db.prepare("UPDATE tasks SET back_by = ?, back_at = ? WHERE date_key = ?")
    .run(name, new Date().toISOString(), dateKey);
  return getTaskRow(db, dateKey);
}

function getLeaderboard(db) {
  return db.prepare(
    "SELECT out_by AS name, SUM(coins) AS coins FROM tasks WHERE back_at IS NOT NULL GROUP BY out_by"
  ).all();
}

module.exports = { getCurrentTask, confirmOut, confirmBack, getLeaderboard, dateKeyOf };
