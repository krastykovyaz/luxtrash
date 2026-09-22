// Two-step bin duty: "out" (bin taken to the curb) and "back" (empty bin
// brought back in) — a task only counts as done, and only pays out Scrap,
// once both are confirmed. A task becomes actionable the evening before its
// collection date ("occurs a day before expiration") and stays open — even
// past its date, as overdue — until someone closes the loop.

const { codesFor } = require("./rotation");

const COINS_PER_TASK = 10;
const LOOKBACK_DAYS = 14; // how far back to surface a missed, still-open task

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(key) {
  const [y, m, day] = key.split("-").map(Number);
  return new Date(y, m - 1, day);
}

// Every real collection date (codes present, not a holiday) from
// `from` to `to` inclusive, oldest first.
function collectionDatesInRange(from, to) {
  const dates = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor <= to) {
    const codes = codesFor(cursor);
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
function getCurrentTask(db, today) {
  const openRow = db.prepare(
    "SELECT * FROM tasks WHERE out_at IS NOT NULL AND back_at IS NULL ORDER BY date_key ASC LIMIT 1"
  ).get();
  if (openRow) {
    return { ...openRow, overdue: openRow.date_key < dateKeyOf(today), started: true };
  }

  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3);
  const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const candidates = collectionDatesInRange(from, windowEnd);

  for (const date of candidates) {
    const opensAt = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    if (today < opensAt) continue; // window not open yet
    const dateKey = dateKeyOf(date);
    if (dateKey < dateKeyOf(today)) continue; // never started and already past — let it go
    const codes = codesFor(date);
    const row = getTaskRow(db, dateKey) || { date_key: dateKey, codes, out_by: null, out_at: null, back_by: null, back_at: null, coins: COINS_PER_TASK };
    if (!row.back_at) {
      return { ...row, overdue: false, started: false };
    }
  }
  return null;
}

function confirmOut(db, dateKey, roster, name) {
  const date = parseDateKey(dateKey);
  const codes = codesFor(date);
  if (!codes || codes === "HOLIDAY") {
    const err = new Error("There's no collection on that date.");
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
