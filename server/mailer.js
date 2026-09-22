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

function weekdayShort(lang, d) {
  return t(lang, "weekdays")[(d.getDay() + 6) % 7];
}

function buildWeeklyMessage(lang, roster, today) {
  const person = personForWeek(today, roster);
  const lines = [`${t(lang, "dutyMsgHeading")} ${person}`, ""];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const codes = codesFor(d);
    if (!codes) continue;
    const label = codes === "HOLIDAY"
      ? t(lang, "publicHolidayShort")
      : codes.split("").map((c) => binLabel(lang, c)).filter(Boolean).join(" + ");
    lines.push(`- ${weekdayShort(lang, d)} ${d.getDate()}: ${label}`);
  }
  lines.push("", t(lang, "dutyMsgFooter"));
  return { person, text: lines.join("\n") };
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

// Sends this week's reminder to every CONFIRMED account, each in their own
// preferred language. Returns { sent, skipped, errors } for logging/inspection.
async function sendWeeklyReminders(db, roster) {
  const transport = getTransporter();
  const accounts = db.prepare("SELECT email, name, language FROM accounts WHERE confirmed = 1").all();
  if (!transport) return { sent: 0, skipped: accounts.length, errors: [] };
  if (!roster.length) return { sent: 0, skipped: accounts.length, errors: [] };

  const today = new Date();
  const errors = [];
  let sent = 0;

  for (const account of accounts) {
    try {
      const { person, text } = buildWeeklyMessage(account.language, roster, today);
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: account.email,
        subject: `${t(account.language, "dutyMsgHeading")} ${person}`,
        text: `${t(account.language, "dutyHeading")} — ${account.name}\n\n${text}`
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

module.exports = { sendWeeklyReminders, buildWeeklyMessage, getTransporter, sendCheckResult, sendConfirmationEmail };
