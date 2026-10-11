// gemini.js with the network stubbed: model order, fallback, the 404 skip,
// and that every answer logs the model that gave it (and never the key).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.GEMINI_API_KEY = "test-key-not-real";
delete process.env.GEMINI_MODELS;
const { checkPhoto, MODELS } = require("../gemini");

const OK = { candidates: [{ content: { parts: [{ text: JSON.stringify({ item: "Jar", code: "V", why: "Glass." }) }] } }] };
let calls, logs, warns, plan;

function reply(status, body) {
  return { ok: status === 200, status, json: async () => body || OK, text: async () => JSON.stringify(body || { error: { status: "X" } }) };
}
beforeEach(() => {
  calls = []; logs = []; warns = []; plan = {};
  global.fetch = async (url, opts) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    return reply(plan[model] || 200);
  };
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
});

const photo = Buffer.from([1, 2, 3]);

test("the default chain: stable models first, previews last, no retired or duplicate-backend names", () => {
  assert.deepEqual(MODELS, ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3-flash-preview"]);
  assert.ok(!MODELS.some((m) => /^gemini-2\.0|gemini-3\.7-flash/.test(m)));
  const firstPreview = MODELS.findIndex((m) => /preview/.test(m));
  assert.ok(MODELS.slice(firstPreview).every((m) => /preview/.test(m)), "previews come last");
  assert.ok(new Set(MODELS.map((m) => m.match(/gemini-(\d+(\.\d+)?)/)?.[1] || "alias")).size >= 2, "at least two model generations");
});

test("every answer logs which model gave it", async () => {
  await checkPhoto(photo, "image/png");
  assert.deepEqual(calls, ["gemini-2.5-flash"]);
  assert.ok(logs.some((l) => l.includes("answered by gemini-2.5-flash")), logs.join("|"));
});

test("a quota (429) falls through to the next model and the log says so", async () => {
  plan["gemini-2.5-flash"] = 429;
  await checkPhoto(photo, "image/png");
  assert.deepEqual(calls, ["gemini-2.5-flash", "gemini-3.5-flash"]);
  assert.ok(logs.some((l) => l.includes("answered by gemini-3.5-flash") && l.includes("gemini-2.5-flash=429")));
});

test("a 404 model logs a warning and is skipped for an hour", async () => {
  plan["gemini-2.5-flash"] = 404;
  await checkPhoto(photo, "image/png");
  assert.ok(warns.some((w) => w.includes("WARNING") && w.includes('"gemini-2.5-flash"') && w.includes("404")));
  assert.equal(calls[0], "gemini-2.5-flash");

  calls.length = 0;
  await checkPhoto(photo, "image/png");
  assert.ok(!calls.includes("gemini-2.5-flash"), "not asked again: " + calls.join(","));
  assert.equal(calls[0], "gemini-3.5-flash");
});

test("if every model is 404, they are all tried again rather than failing for an hour", async () => {
  for (const m of MODELS) plan[m] = 404;
  await assert.rejects(checkPhoto(photo, "image/png"));
  calls.length = 0;
  plan = {};
  await checkPhoto(photo, "image/png");
  assert.ok(calls.length >= 1);
});

test("the API key is never logged", async () => {
  plan["gemini-2.5-flash"] = 404;
  await checkPhoto(photo, "image/png");
  assert.ok(![...logs, ...warns].some((l) => l.includes("test-key-not-real")));
});
