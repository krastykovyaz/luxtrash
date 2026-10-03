// End-to-end tests: boots the real server on a throwaway data folder (email
// goes to a file — see mail-stub.js) and drives it over HTTP.
// Run with: cd server && npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bin-duty-test-"));
const MAIL = path.join(DATA, "mail.jsonl");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.BIN_DUTY_DATA_DIR = DATA; // so this process can open the same files

let server;
let original;   // the seeded original house: Akemi, Alex, Diana, James, Wenxuan, Zheng Lin
let custom;     // a house built in the tests, with a schedule we control
let ipCounter = 1;

// Each call looks like a different visitor unless one is given, so the
// per-address rate limits don't interfere with tests that aren't about them.
function freshIp() { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; }

async function call(method, url, { json, form, headers = {}, ip } = {}) {
  const h = { "x-forwarded-for": ip || freshIp(), ...headers };
  let body;
  if (json !== undefined) { h["content-type"] = "application/json"; body = typeof json === "string" ? json : JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(BASE + url, { method, headers: h, body });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text, headers: res.headers };
}

function db(slug) {
  const Database = require("better-sqlite3");
  return new Database(slug ? path.join(DATA, "houses", slug + ".sqlite") : path.join(DATA, "bin-duty.sqlite"));
}
function mails(kind) {
  if (!fs.existsSync(MAIL)) return [];
  return fs.readFileSync(MAIL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => !kind || m.kind === kind);
}
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function protect(slugOrNull, name, email) {
  db(slugOrNull).prepare("INSERT INTO accounts (email, name, language, created_at, confirmed) VALUES (?, ?, 'en', ?, 1)")
    .run(email, name, new Date().toISOString());
}
// Tests sign in several times a minute; the real 60 s resend wait would refuse that.
function skipResendWait() { db(null).prepare("UPDATE auth_codes SET sent_at = 0").run(); }
async function signIn(q, name) {
  skipResendWait();
  const before = mails("code").length;
  const r = await call("POST", `/api/auth/request${q}`, { json: { name } });
  assert.equal(r.status, 200, r.text);
  const code = mails("code")[before].args[3];
  const v = await call("POST", `/api/auth/verify${q}`, { json: { name, code } });
  assert.equal(v.status, 200, v.text);
  return v.data.token;
}
function photoForm(name, bytes, type) {
  const f = new FormData();
  f.append("name", name);
  if (bytes) f.append("photo", new Blob([bytes], { type }), "p");
  return f;
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

before(async () => {
  server = spawn(process.execPath, ["-r", path.join(__dirname, "mail-stub.js"), path.join(__dirname, "..", "index.js")], {
    env: { ...process.env, PORT: String(PORT), BIN_DUTY_DATA_DIR: DATA, MAIL_SINK_FILE: MAIL, PUBLIC_URL: "https://bins.example",
      SMTP_HOST: "", GEMINI_API_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  original = await new Promise((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (b) => {
      out += b;
      const m = out.match(/invite link: \/\?h=([a-z0-9-]+)/);
      if (m && out.includes("listening")) resolve(m[1]);
    });
    server.on("exit", (c) => reject(new Error("server exited " + c + "\n" + out)));
    setTimeout(() => reject(new Error("server didn't start\n" + out)), 10000);
  });

  const built = await call("POST", "/api/houses", { json: { name: "Test Flat", language: "fr" } });
  assert.equal(built.status, 201);
  custom = built.data;
  for (const n of ["Ana", "Ben", "Cleo"]) await call("POST", `/api/roster?h=${custom.slug}`, { json: { name: n } });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const d = db(custom.slug);
  for (const day of [yesterday, today, tomorrow]) d.prepare("INSERT INTO schedule (date_key, codes) VALUES (?, 'M')").run(dateKey(day));
});

after(() => {
  if (server) server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
});

const qo = () => `?h=${original}`;
const qc = () => `?h=${custom.slug}`;

// ---------- server basics ----------

test("errors never show a stack trace or server paths", async () => {
  const r = await call("POST", "/api/houses", { json: "{bad" });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /\s+at \S+ \(|node_modules|SyntaxError/);
});

test("pages carry a content-security policy", async () => {
  const r = await call("GET", `/${qo()}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy") || "", /script-src 'self'/);
});

test("link previews use the public URL, not the request's Host header", async () => {
  const r = await fetch(`${BASE}/${qo()}`, { headers: { host: "evil.example" } }).then((x) => x.text());
  assert.match(r, /https:\/\/bins\.example/);
  assert.doesNotMatch(r, /evil\.example/);
});

test("new house codes are 8 random characters and the language is checked", async () => {
  assert.match(custom.slug, /^test-flat-[0-9a-f]{8}$/);
  const r = await call("POST", "/api/houses", { json: { name: "X", language: "zz<b>" } });
  assert.equal(r.data.language, "en");
});

// ---------- photos ----------

test("a non-image 'photo' is refused and the task is left alone", async () => {
  const r = await call("POST", `/api/tasks/${dateKey(new Date())}/out${qc()}`, { form: photoForm("Ana", "<script>alert(1)</script>", "text/html") });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "NOT_AN_IMAGE");
  const cur = await call("GET", `/api/tasks/current${qc()}`);
  assert.equal(cur.data.out_at, null);
});

// ---------- tasks and coins ----------

test("a task is confirmed out and back once — repeats don't pay again", async () => {
  const key = dateKey(new Date());
  const out = await call("POST", `/api/tasks/${key}/out${qc()}`, { form: photoForm("Ana", JPEG, "text/html") });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.data.out_by, "Ana");
  const served = await call("GET", `/api/tasks/${key}/photo/out${qc()}`);
  assert.equal(served.headers.get("content-type"), "image/jpeg"); // judged by its bytes, not the claimed type

  assert.equal((await call("POST", `/api/tasks/${key}/out${qc()}`, { form: photoForm("Ben", JPEG, "image/jpeg") })).status, 409);

  const balance = async () => (await call("GET", `/api/coins/Cleo${qc()}`)).data.balance;
  const start = await balance();
  assert.equal((await call("POST", `/api/tasks/${key}/back${qc()}`, { form: photoForm("Cleo") })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", `/api/tasks/${key}/back${qc()}`, { form: photoForm("Cleo") })).status, 409);
  assert.equal(await balance(), start + 10);
});

test("a collection that already passed can't be confirmed (it would hijack tonight's task)", async () => {
  const y = new Date(); y.setDate(y.getDate() - 1);
  const r = await call("POST", `/api/tasks/${dateKey(y)}/out${qc()}`, { form: photoForm("Ben") });
  assert.equal(r.status, 400);
});

test("Sort It pays only for full rounds, a few times a day", async () => {
  const q = qc();
  assert.equal((await call("POST", `/api/quiz/complete${q}`, { json: { name: "Ben", correct: 1, total: 1 } })).status, 400);
  const awarded = [];
  for (let i = 0; i < 5; i++) awarded.push((await call("POST", `/api/quiz/complete${q}`, { json: { name: "Ben", correct: 18, total: 18 } })).data.awarded);
  assert.deepEqual(awarded, [true, true, true, false, false]);
});

// ---------- signing in ----------

test("a protected name needs the emailed code; sign-out ends it", async () => {
  protect(null, "Alex", "alex@example.test");
  const state = await call("GET", `/api/auth/state${qo()}`);
  assert.ok(state.data.locked.includes("Alex"));

  const r = await call("POST", `/api/auth/request${qo()}`, { json: { name: "Alex" } });
  assert.equal(r.data.email, "a•••@example.test");
  const code = mails("code").at(-1).args[3];
  const wrong = await call("POST", `/api/auth/verify${qo()}`, { json: { name: "Alex", code: code === "000000" ? "111111" : "000000" } });
  assert.equal(wrong.data.code, "AUTH_WRONG");
  const ok = await call("POST", `/api/auth/verify${qo()}`, { json: { name: "Alex", code } });
  const token = ok.data.token;
  assert.equal((await call("GET", `/api/auth/state${qo()}`, { headers: { "x-auth-token": token } })).data.session, "Alex");

  await call("POST", `/api/auth/logout${qo()}`, { headers: { "x-auth-token": token } });
  assert.equal((await call("GET", `/api/auth/state${qo()}`, { headers: { "x-auth-token": token } })).data.session, null);
});

test("acting as a protected name needs its session (quiz, reactions, profile, donations)", async () => {
  const q = qo();
  assert.equal((await call("POST", `/api/quiz/complete${q}`, { json: { name: "Alex", correct: 18, total: 18 } })).status, 401);
  assert.equal((await call("POST", `/api/reactions/2026-10-05${q}`, { json: { name: "Alex", emoji: "up" } })).status, 401);
  assert.equal((await call("PATCH", `/api/roster/Alex${q}`, { json: { occupation: "x" } })).status, 401);
  assert.equal((await call("POST", `/api/coins/donate${q}`, { json: { from: "Alex", to: "Diana", amount: 1 } })).status, 401);
  const token = await signIn(q, "Alex");
  assert.equal((await call("POST", `/api/quiz/complete${q}`, { json: { name: "Alex", correct: 18, total: 18 }, headers: { "x-auth-token": token } })).status, 200);
});

test("ten wrong codes from one address stop that address only", async () => {
  protect(null, "Wenxuan", "wen@example.test");
  await call("POST", `/api/auth/request${qo()}`, { json: { name: "Wenxuan" } });
  const ip = "10.250.0.1";
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await call("POST", `/api/auth/verify${qo()}`, { json: { name: "Wenxuan", code: "99999" + (i % 10) }, ip })).status);
  assert.equal(statuses.at(-1), 429);
});

test("a session from before the real owner protected the name stops counting", async () => {
  const q = qo();
  const attacker = await call("POST", `/api/subscribe${q}`, { json: { name: "Diana", email: "attacker@example.test" } });
  const stale = attacker.data.session;
  assert.ok(stale);
  await call("POST", `/api/subscribe${q}`, { json: { name: "Diana", email: "diana@example.test" } });
  const link = mails("confirm").at(-1).args[3];
  assert.match(link, /^https:\/\/bins\.example\//); // never the request's Host
  await call("GET", link.replace("https://bins.example", ""));
  assert.equal((await call("GET", `/api/auth/state${q}`, { headers: { "x-auth-token": stale } })).data.session, null);
  assert.equal((await call("DELETE", `/api/subscribe/by-name/Diana${q}`, { headers: { "x-auth-token": stale } })).status, 401);
});

test("one-click unsubscribe needs the signed link, not just an address", async () => {
  const q = qo();
  assert.equal((await call("POST", `/api/subscribe/unsubscribe/diana@example.test${q}`)).status, 200);
  assert.ok((await call("GET", `/api/auth/state${q}`)).data.locked.includes("Diana"));

  const secret = require("../secret");
  const s = secret.sign(`unsub|${original}|diana@example.test`);
  await call("POST", `/api/subscribe/unsubscribe/diana%40example.test${q}&s=${s}`);
  assert.ok(!(await call("GET", `/api/auth/state${q}`)).data.locked.includes("Diana"));
});

test("someone's confirmed email can't be re-registered under another name", async () => {
  const r = await call("POST", `/api/subscribe${qo()}`, { json: { name: "James", email: "alex@example.test" } });
  assert.equal(r.status, 409);
  assert.ok((await call("GET", `/api/auth/state${qo()}`)).data.locked.includes("Alex"));
});

test("a protected housemate can only be removed by themselves", async () => {
  const q = qo();
  assert.equal((await call("DELETE", `/api/roster/Alex${q}`)).status, 401);
  const token = await signIn(q, "Alex");
  const r = await call("DELETE", `/api/roster/Alex${q}`, { headers: { "x-auth-token": token } });
  assert.equal(r.status, 200);
  assert.ok(!r.data.includes("Alex"));
  assert.ok(!(await call("GET", `/api/auth/state${q}`)).data.locked.includes("Alex"));
});

// ---------- abuse limits ----------

test("push subscriptions must point at a real push service", async () => {
  const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: "k", auth: "a" } } });
  assert.equal((await call("POST", `/api/push/subscribe${qc()}`, { json: sub("http://127.0.0.1:22/x") })).status, 400);
  assert.equal((await call("POST", `/api/push/subscribe${qc()}`, { json: sub("https://evil.example/x") })).status, 400);
  assert.equal((await call("POST", `/api/push/subscribe${qc()}`, { json: sub("https://web.push.apple.com/abc") })).status, 201);
});

test("guessing house codes is cut off; normal 'not found' answers don't count", async () => {
  const ip = "10.251.0.1";
  for (let i = 0; i < 25; i++) await call("GET", `/api/tasks/2026-01-0${(i % 9) + 1}/photo/out${qc()}`, { ip }); // real house, missing photos
  assert.equal((await call("GET", `/api/houses/${custom.slug}`, { ip })).status, 200);
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await call("GET", `/api/houses/nope-${i}`, { ip })).status);
  assert.equal(statuses[0], 404);
  assert.equal(statuses.at(-1), 429);
});

test("only a real scan result can be emailed", async () => {
  const body = { email: "me@example.test", lang: "en", item: "Jar", code: "V", why: "Glass." };
  assert.equal((await call("POST", `/api/check/email${qo()}`, { json: { ...body, sig: "forged" } })).data.code, "BAD_SIGNATURE");
  const secret = require("../secret");
  const sig = secret.sign("scan|V|Jar|Glass.");
  assert.equal((await call("POST", `/api/check/email${qo()}`, { json: { ...body, sig } })).status, 200);
});
