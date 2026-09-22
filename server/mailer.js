const { t, binLabel } = require("./i18n");
const { codesFor, mondayOf, personForWeek } = require("./rotation");

let transporter = null;
let warnedMissingConfig = false;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    if (!warnedMissingConfig) {
      console.warn("SMTP_HOST/SMTP_USER/SMTP_PASS not set — email notifications are disabled until they are.");
      warnedMissingConfig = true;
    }
    return null;
  }
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return transporter;
}

// Builds the reminder for one specific collection day — sent the evening
// before ("6pm the day before", same "opens the evening before" rule as the
// in-app task card), not a fixed weekly digest. Returns null when the given
// date has no real collection (weekend gap or public holiday), so the
// caller knows to send nothing that day.
function buildTomorrowMessage(lang, roster, tomorrow) {
  const codes = codesFor(tomorrow);
  if (!codes || codes === "HOLIDAY") return null;
  const label = codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
  const person = personForWeek(tomorrow, roster);
  const subject = `${t(lang, "tonightLabel")} ${label}`;
  const text = [
    `${t(lang, "tonightLabel")} ${label}`,
    "",
    `${t(lang, "dutyMsgHeading")} ${person}`,
    "",
    t(lang, "dutyMsgFooter")
  ].join("\n");
  return { subject, text, person, label };
}

// Sends a "click to confirm" email for double opt-in — an open, unverified
// /api/subscribe would otherwise let anyone sign up anyone else's address,
// which is exactly the pattern that gets an SMTP account flagged as spam.
async function sendConfirmationEmail(email, lang, name, confirmUrl) {
  const transport = getTransporter();
  if (!transport) {
    const err = new Error("Email isn't configured on the server.");
    err.code = "NO_SMTP";
    throw err;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: t(lang, "confirmSubject"),
    text: `${t(lang, "confirmBody").replace("{name}", name)}\n\n${confirmUrl}`
  });
}

// Sends tomorrow's reminder to every CONFIRMED account, each in their own
// preferred language — but only on days that actually have a collection
// tomorrow. Returns { sent, skipped, errors, dueTomorrow } for logging.
async function sendDailyReminders(db, roster) {
  const transport = getTransporter();
  const accounts = db.prepare("SELECT email, name, language FROM accounts WHERE confirmed = 1").all();

  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const dueTomorrow = !!(codesFor(tomorrow) && codesFor(tomorrow) !== "HOLIDAY");

  if (!dueTomorrow) return { sent: 0, skipped: accounts.length, errors: [], dueTomorrow: false };
  if (!transport) return { sent: 0, skipped: accounts.length, errors: [], dueTomorrow: true };
  if (!roster.length) return { sent: 0, skipped: accounts.length, errors: [], dueTomorrow: true };

  const errors = [];
  let sent = 0;

  for (const account of accounts) {
    try {
      const msg = buildTomorrowMessage(account.language, roster, tomorrow);
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: account.email,
        subject: msg.subject,
        text: `${t(account.language, "dutyHeading")} — ${account.name}\n\n${msg.text}`
      });
      sent++;
    } catch (err) {
      errors.push({ email: account.email, message: err.message });
    }
  }
  return { sent, skipped: 0, errors, dueTomorrow: true };
}

// End-of-week heads-up: who's on duty for the week that starts tomorrow —
// sent to EVERY confirmed account, not just that person, so the whole
// house knows in advance instead of finding out from the app mid-week.
// Meant to run on a Sunday-evening schedule; "tomorrow" from there is
// always the coming Monday.
function buildWeekAheadMessage(lang, roster, nextMonday) {
  const person = personForWeek(nextMonday, roster);
  const subject = `${t(lang, "weekAheadSubject")} ${person}`;
  const text = t(lang, "weekAheadBody").replace("{name}", person);
  return { subject, text, person };
}

async function sendWeekAheadNotices(db, roster) {
  const transport = getTransporter();
  const accounts = db.prepare("SELECT email, name, language FROM accounts WHERE confirmed = 1").all();
  if (!transport) return { sent: 0, skipped: accounts.length, errors: [] };
  if (!roster.length) return { sent: 0, skipped: accounts.length, errors: [] };

  const today = new Date();
  const nextMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const errors = [];
  let sent = 0;

  for (const account of accounts) {
    try {
      const msg = buildWeekAheadMessage(account.language, roster, nextMonday);
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: account.email,
        subject: msg.subject,
        text: msg.text
      });
      sent++;
    } catch (err) {
      errors.push({ email: account.email, message: err.message });
    }
  }
  return { sent, skipped: 0, errors };
}

// Emails a copy of one camera-check result to whoever asked for it. Text
// only — the photo itself is never saved anywhere (server or email), only
// the identification Gemini returned.
async function sendCheckResult(email, lang, data) {
  const transport = getTransporter();
  if (!transport) {
    const err = new Error("Email isn't configured on the server.");
    err.code = "NO_SMTP";
    throw err;
  }
  const title = binLabel(lang, data.code);
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `${t(lang, "scanHeading")} — ${title}`,
    text: `${data.item || ""}\n\n${title} (${data.code})\n${data.why || ""}`
  });
}

module.exports = {
  sendDailyReminders, buildTomorrowMessage,
  sendWeekAheadNotices, buildWeekAheadMessage,
  getTransporter, sendCheckResult, sendConfirmationEmail
};
