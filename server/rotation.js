// Collection schedule and duty-rotation math, shared by the API (claims) and
// the mailer (weekly reminder emails) — kept in one place so both agree.

const SCHEDULE = {
  "2026-09": { 3: "VB", 4: "P", 7: "M", 8: "E", 10: "VB", 11: "P", 14: "M", 17: "VB", 18: "P", 21: "M", 22: "E", 24: "VB", 25: "P", 28: "M" },
  "2026-10": { 1: "VB", 2: "P", 5: "M", 6: "E", 8: "VB", 9: "P", 12: "M", 15: "VB", 16: "P", 19: "M", 20: "E", 22: "VB", 23: "P", 26: "M", 29: "VB", 30: "P" },
  "2026-11": { 1: "HOLIDAY", 2: "M", 3: "E", 5: "VB", 6: "P", 9: "M", 12: "VB", 13: "P", 16: "M", 17: "E", 19: "VB", 20: "P", 23: "M", 26: "VB", 27: "P", 30: "M" },
  "2026-12": { 1: "E", 3: "VB", 4: "P", 7: "M", 10: "VB", 11: "P", 14: "M", 15: "E", 17: "VB", 18: "P", 21: "M", 24: "VB", 25: "HOLIDAY", 28: "M", 31: "VB" }
};

const ANCHOR_MONDAY = new Date(2026, 8, 21);

function pad(n) {
  return String(n).padStart(2, "0");
}

function monthKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1);
}

function codesFor(d) {
  const map = SCHEDULE[monthKey(d)];
  if (!map) return null;
  return map[d.getDate()] || null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// A flat "date key -> code" lookup works for both the original house's
// hardcoded calendar and a custom house's DB-backed one, so the rest of the
// app (tasks.js) only ever has to know about this one shape.
function flattenSchedule(scheduleMap) {
  const flat = {};
  Object.keys(scheduleMap).forEach((monthK) => {
    const [y, m] = monthK.split("-").map(Number);
    const days = scheduleMap[monthK];
    Object.keys(days).forEach((day) => {
      flat[`${y}-${pad2(m)}-${pad2(Number(day))}`] = days[day];
    });
  });
  return flat;
}

function codesForFlat(d, flatSchedule) {
  return (flatSchedule && flatSchedule[dateKeyOf(d)]) || null;
}

const DEFAULT_FLAT_SCHEDULE = flattenSchedule(SCHEDULE);

function mondayOf(d) {
  const day = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

function weekKeyOf(d) {
  const m = mondayOf(d);
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

function personForWeek(date, roster) {
  if (!roster || !roster.length) return null;
  const mon = mondayOf(date);
  const anchorMon = mondayOf(ANCHOR_MONDAY);
  const diffWeeks = Math.round((mon - anchorMon) / (7 * 86400000));
  const idx = ((diffWeeks % roster.length) + roster.length) % roster.length;
  return roster[idx];
}

module.exports = {
  SCHEDULE, ANCHOR_MONDAY, codesFor, mondayOf, weekKeyOf, personForWeek, monthKey,
  flattenSchedule, codesForFlat, DEFAULT_FLAT_SCHEDULE
};
