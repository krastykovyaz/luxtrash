// One server-side secret for keyed hashes and signatures (chat identities,
// unsubscribe links, scan results). It lives next to the databases and is
// created on first start; it is the same file the chat has always used, so
// existing chat identities keep their hashes.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./db");

function loadSecret() {
  const file = path.join(DATA_DIR, "chat-secret");
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString("hex"), { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

function hmac(input) {
  return crypto.createHmac("sha256", SECRET).update(input).digest();
}

// A short signature for a value, and a constant-time check of one.
function sign(input) {
  return hmac("sig|" + input).toString("base64url").slice(0, 32);
}
function verify(input, sig) {
  if (typeof sig !== "string") return false;
  const a = Buffer.from(sign(input));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hmac, sign, verify };
