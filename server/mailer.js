const { t, binLabel } = require("./i18n");
const { codesFor, mondayOf, personForWeek } = require("./rotation");
const { wrapEmail, binBadges, escapeHtml, COLORS } = require("./emailTemplate");

let transporter = null;
let warnedMissingConfig = false;

const PUBLIC_URL = process.env.PUBLIC_URL || "https://binduty.sococoffee.com";

// A friendly display name (not a bare address) and a real List-Unsubscribe
// header are the two concrete things that actually move the needle on spam
// placement for a low-volume sender — everything else (account age, prior
// sending history) is reputation that only builds up over time and use.
function fromHeader() {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER;
  return `"Bin Duty" <${addr}>`;
}

// RFC 8058 one-click unsubscribe headers. Mail clients that support it show
// their own "Unsubscribe" button next to the sender and POST straight to
// the URL — no page load, no confirmation click. Only meaningful on
// recurring subscription mail, not a one-off action email like a camera
// check result.
function unsubscribeHeaders(email, houseSlug) {
  // ?h= is required now — there's no implicit default house for a bare
  // unsubscribe link to fall back to.
  const url = `${PUBLIC_URL}/api/subscribe/unsubscribe/${encodeURIComponent(email)}?h=${encodeURIComponent(houseSlug)}`;
  return {
    "List-Unsubscribe": `<mailto:${process.env.SMTP_USER}?subject=unsubscribe>, <${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  };
}

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
  const html = wrapEmail(`
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${COLORS.inkFaint};margin-bottom:10px;">${escapeHtml(t(lang, "tonightLabel"))}</div>
    <div style="margin-bottom:18px;">${binBadges(codes, (c) => binLabel(lang, c))}</div>
    <div style="padding-top:14px;border-top:1px dashed ${COLORS.line};font-size:14px;">
      ${escapeHtml(t(lang, "dutyMsgHeading"))} <strong style="color:${COLORS.accent};">${escapeHtml(person)}</strong>
    </div>
    <div style="margin-top:14px;font-size:13px;color:${COLORS.inkSoft};">${escapeHtml(t(lang, "dutyMsgFooter"))}</div>
  `);
  return { subject, text, html, person, label };
}

// Sends a "click to confirm" email for double opt-in — an open, unverified
// /api/subscribe would otherwise let anyone sign up anyone else's address,
// which is exactly the pattern that gets an SMTP account flagged as spam.
async function sendConfirmationEmail(email, lang, name, confirmUrl, houseSlug) {
  const transport = getTransporter();
  if (!transport) {
    const err = new Error("Email isn't configured on the server.");
    err.code = "NO_SMTP";
    throw err;
  }
  const bodyText = t(lang, "confirmBody").replace("{name}", name);
  const html = wrapEmail(`
    <p style="margin:0 0 20px;">${escapeHtml(bodyText)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:${COLORS.accent};border-radius:6px;">
      <a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:${COLORS.accentInk};text-decoration:none;">${escapeHtml(t(lang, "confirmCta"))}</a>
    </td></tr></table>
    <p style="margin:18px 0 0;font-size:12px;color:${COLORS.inkFaint};word-break:break-all;">${escapeHtml(confirmUrl)}</p>
  `);
  await transport.sendMail({
    from: fromHeader(),
    to: email,
    subject: t(lang, "confirmSubject"),
    text: `${bodyText}\n\n${confirmUrl}`,
    html,
    headers: unsubscribeHeaders(email, houseSlug)
  });
}

// Sends tomorrow's reminder to every CONFIRMED account, each in their own
// preferred language — but only on days that actually have a collection
// tomorrow. Returns { sent, skipped, errors, dueTomorrow } for logging.
async function sendDailyReminders(db, roster, houseSlug) {
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
        from: fromHeader(),
        to: account.email,
        subject: msg.subject,
        text: `${t(account.language, "dutyHeading")} — ${account.name}\n\n${msg.text}`,
        html: msg.html,
        headers: unsubscribeHeaders(account.email, houseSlug)
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
  const html = wrapEmail(`
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${COLORS.inkFaint};margin-bottom:10px;">${escapeHtml(t(lang, "weekAheadSubject"))}</div>
    <div style="font-size:22px;font-weight:700;color:${COLORS.accent};">${escapeHtml(person)}</div>
  `);
  return { subject, text, html, person };
}

async function sendWeekAheadNotices(db, roster, houseSlug) {
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
        from: fromHeader(),
        to: account.email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: unsubscribeHeaders(account.email, houseSlug)
      });
      sent++;
    } catch (err) {
      errors.push({ email: account.email, message: err.message });
    }
  }
  return { sent, skipped: 0, errors };
}

// Emails a copy of one camera-check result to whoever asked for it. Text
// only in the sense that no photo is ever attached or saved anywhere — the
// email itself is still styled HTML, same as the rest.
async function sendCheckResult(email, lang, data) {
  const transport = getTransporter();
  if (!transport) {
    const err = new Error("Email isn't configured on the server.");
    err.code = "NO_SMTP";
    throw err;
  }
  const title = binLabel(lang, data.code);
  const html = wrapEmail(`
    <div style="margin-bottom:14px;">${binBadges(data.code, () => title)}</div>
    <p style="margin:0;font-size:14px;line-height:1.5;">
      ${data.item ? `<strong style="color:${COLORS.accent};">${escapeHtml(data.item)}.</strong> ` : ""}${escapeHtml(data.why || "")}
    </p>
  `);
  await transport.sendMail({
    from: fromHeader(),
    to: email,
    subject: `${t(lang, "scanHeading")} — ${title}`,
    text: `${data.item || ""}\n\n${title} (${data.code})\n${data.why || ""}`,
    html
  });
}

module.exports = {
  sendDailyReminders, buildTomorrowMessage,
  sendWeekAheadNotices, buildWeekAheadMessage,
  getTransporter, sendCheckResult, sendConfirmationEmail
};
