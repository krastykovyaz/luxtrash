// Loads the same translation data the frontend uses (public/i18n.js), so the
// weekly reminder email is worded identically to the app instead of a
// second, hand-maintained copy that could drift out of sync.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "i18n.js"), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

function t(lang, key) {
  const dict = sandbox.window.T[lang] || sandbox.window.T.en;
  return dict[key] != null ? dict[key] : sandbox.window.T.en[key];
}

function binLabel(lang, code) {
  const dict = sandbox.window.T[lang] || sandbox.window.T.en;
  const labels = dict.binLabels || sandbox.window.T.en.binLabels;
  return labels[code] || code;
}

module.exports = {
  LANGS: sandbox.window.LANGS,
  T: sandbox.window.T,
  t,
  binLabel
};
