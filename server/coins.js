// Scrap coins: a flat append-only ledger (coin_ledger) is the source of
// truth for balances, the leaderboard, and donations. Task completion still
// writes the legacy `tasks.coins` column too (nothing reads it anymore
// except the one-time backfill in db.js, but there's no reason to drop it).
//
// Achievement badges are unlocked here, right after the ledger row that
// could trigger them — never polled, never computed lazily on read.

const ACHIEVEMENTS = ["first_scrap", "perfect_round", "on_time_streak", "house_hero", "generous_scrapper"];

function award(db, name, delta, reason, note) {
  db.prepare(
    "INSERT INTO coin_ledger (name, delta, reason, note, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(name, delta, reason, note || null, new Date().toISOString());
}

function getBalance(db, name) {
  const row = db.prepare("SELECT COALESCE(SUM(delta), 0) AS coins FROM coin_ledger WHERE name = ?").get(name);
  return row.coins;
}

function getLeaderboard(db) {
  return db.prepare(
    "SELECT name, SUM(delta) AS coins FROM coin_ledger GROUP BY name ORDER BY coins DESC"
  ).all();
}

function getHistory(db, name, limit) {
  return db.prepare(
    "SELECT delta, reason, note, created_at FROM coin_ledger WHERE name = ? ORDER BY id DESC LIMIT ?"
  ).all(name, limit || 20);
}

function unlock(db, name, code) {
  const info = db.prepare(
    "INSERT INTO achievements (name, code, unlocked_at) VALUES (?, ?, ?) ON CONFLICT(name, code) DO NOTHING"
  ).run(name, code, new Date().toISOString());
  return info.changes > 0; // true only the first time this person unlocks this badge
}

function getAchievements(db, name) {
  const rows = db.prepare("SELECT code, unlocked_at FROM achievements WHERE name = ?").all(name);
  const byCode = {};
  rows.forEach((r) => { byCode[r.code] = r.unlocked_at; });
  return ACHIEVEMENTS.map((code) => ({ code, unlockedAt: byCode[code] || null }));
}

// Was this person already strictly ahead of everyone else before their
// latest award? If not, and they are now, "house_hero" just unlocked.
function maybeUnlockHouseHero(db, name) {
  const board = getLeaderboard(db);
  if (!board.length || board[0].name !== name) return false;
  if (board.length > 1 && board[0].coins === board[1].coins) return false; // tie isn't a lead
  return unlock(db, name, "house_hero");
}

function afterTaskCompleted(db, name) {
  award(db, name, 10, "task", null);
  const unlocked = [];
  if (maybeUnlockHouseHero(db, name)) unlocked.push("house_hero");

  // Trailing streak of this person's own tasks, most recent first, that
  // they both took out AND brought back — an unbroken run of their turns
  // going all the way through, not just "completed at some point."
  const rows = db.prepare(
    "SELECT out_by, back_by, back_at FROM tasks WHERE out_by = ? AND back_at IS NOT NULL ORDER BY date_key DESC"
  ).all(name);
  let streak = 0;
  for (const r of rows) {
    if (r.back_by === name) streak++;
    else break;
  }
  if (streak >= 3 && unlock(db, name, "on_time_streak")) unlocked.push("on_time_streak");
  return unlocked;
}

function afterScan(db, name) {
  if (!name) return [];
  award(db, name, 5, "scan", null);
  const unlocked = [];
  if (unlock(db, name, "first_scrap")) unlocked.push("first_scrap");
  if (maybeUnlockHouseHero(db, name)) unlocked.push("house_hero");
  return unlocked;
}

function afterPerfectRound(db, name) {
  award(db, name, 10, "sortit", "5/5");
  const unlocked = [];
  if (unlock(db, name, "perfect_round")) unlocked.push("perfect_round");
  if (maybeUnlockHouseHero(db, name)) unlocked.push("house_hero");
  return unlocked;
}

// A photo attached to the out or back confirmation — same +5 tier as a
// scan. Always credited to whoever marked the bin OUT (the task's owner
// for every reward, same rule afterTaskCompleted already follows), even
// when it's the *back* photo and a different person confirmed that step.
function afterPhoto(db, name, which) {
  award(db, name, 5, "photo", which);
  const unlocked = [];
  if (maybeUnlockHouseHero(db, name)) unlocked.push("house_hero");
  return unlocked;
}

function afterSubscribe(db, name) {
  award(db, name, 10, "subscribe", null);
  const unlocked = [];
  if (maybeUnlockHouseHero(db, name)) unlocked.push("house_hero");
  return unlocked;
}

function donate(db, from, to, amount) {
  const balance = getBalance(db, from);
  if (balance < amount) {
    const err = new Error("Not enough Scrap coins.");
    err.status = 400;
    throw err;
  }
  award(db, from, -amount, "donate_out", to);
  award(db, to, amount, "donate_in", from);
  const unlocked = [];
  if (unlock(db, from, "generous_scrapper")) unlocked.push("generous_scrapper");
  if (maybeUnlockHouseHero(db, to)) unlocked.push("house_hero");
  return unlocked;
}

module.exports = {
  ACHIEVEMENTS,
  award,
  getBalance,
  getLeaderboard,
  getHistory,
  getAchievements,
  afterTaskCompleted,
  afterScan,
  afterPerfectRound,
  afterPhoto,
  afterSubscribe,
  donate
};
