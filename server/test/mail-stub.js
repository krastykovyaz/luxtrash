// Loaded with `node -r` by the tests: instead of sending email, every message
// the server would send is appended (as one JSON line) to $MAIL_SINK_FILE.
const fs = require("fs");
const mailer = require("../mailer");
const sink = (kind) => async (...args) => {
  fs.appendFileSync(process.env.MAIL_SINK_FILE, JSON.stringify({ kind, args }) + "\n");
};
mailer.sendLoginCodeEmail = sink("code");
mailer.sendConfirmationEmail = sink("confirm");
mailer.sendCheckResult = sink("check");
