// Free-tier keys get a small per-model daily quota (20 requests/day on
// gemini-2.5-flash as of Sep 2026), so one busy evening of scanning empties
// it. Each model has its own quota, so we walk this list and fall through
// on 429 (quota), 503 (overloaded) and 404 (model retired) — anything else
// (bad image, auth) is a real error and stops the loop.
// Override with GEMINI_MODELS="a,b,c" in .env.
const DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
  "gemini-3.5-flash"
];
const MODELS = (process.env.GEMINI_MODELS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!MODELS.length) MODELS.push(...DEFAULT_MODELS);

const FALLTHROUGH_STATUSES = new Set([404, 429, 503]);

const PROMPT =
  "You're looking at a photo of one household waste item in a shared house in Luxembourg, " +
  "which sorts waste into six categories:\n" +
  "M Household waste - non-recyclable items (cotton buds, cat litter, food-soiled paper, used foil).\n" +
  "E Valorlux packaging - plastic bottles, tubs, trays, cups, bags, wrap, metal cans, drink cartons; blue bag.\n" +
  "P Paper & cardboard - clean paper and cardboard only.\n" +
  "V Glass - bottles and jars only, no lids, no ceramics, no window glass, no light bulbs.\n" +
  "B Biowaste - food scraps, cooked or raw.\n" +
  "R Bulky, hazardous & special - furniture, appliances, batteries, light bulbs, textiles, scrap metal, paint; a drop-off item, never curbside.\n" +
  "Identify the item in a few words, then pick exactly one code, and give a one-sentence reason a housemate would find useful. " +
  "Reply with only JSON: {\"item\": string, \"code\": \"M\"|\"E\"|\"P\"|\"V\"|\"B\"|\"R\", \"why\": string}.";

async function checkPhoto(buffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not configured on the server.");
    err.code = "NO_API_KEY";
    throw err;
  }

  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }
        ]
      }
    ],
    generationConfig: { responseMimeType: "application/json" }
  });

  let res = null;
  const attempts = [];
  for (const model of MODELS) {
    // Auth keys (the current key type — see Google AI Studio's API key
    // docs) authenticate via the x-goog-api-key header, not the old ?key=
    // query param used by legacy standard keys.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body
    });
    if (res.ok) {
      if (attempts.length) console.warn(`/api/check: fell back to ${model} after ${attempts.join(", ")}`);
      break;
    }
    const text = await res.text().catch(() => "");
    attempts.push(`${model}=${res.status}`);
    if (!FALLTHROUGH_STATUSES.has(res.status)) {
      // Keep the raw upstream body out of the thrown message — it's only
      // for the server log (detail), never forwarded to the client, which
      // should see a fixed, safe message instead.
      const err = new Error("Gemini couldn't process that photo.");
      err.code = "GEMINI_ERROR";
      err.detail = `${model} HTTP ${res.status}: ${text.slice(0, 300)}`;
      throw err;
    }
    res = null;
  }

  if (!res) {
    // Every model was out of quota / overloaded — a temporary condition the
    // client can explain honestly ("try again in a bit") rather than "failed".
    const err = new Error("All Gemini models are busy or over quota right now.");
    err.code = "GEMINI_BUSY";
    err.detail = attempts.join(", ");
    throw err;
  }

  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;

  if (!text) {
    const err = new Error("Gemini returned no usable text.");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error("Gemini's reply wasn't valid JSON.");
    err.code = "BAD_JSON";
    throw err;
  }

  if (!parsed || !/^[MEPVBR]$/.test(parsed.code) || !parsed.why) {
    const err = new Error("Gemini's reply was missing a valid code or reason.");
    err.code = "BAD_SHAPE";
    throw err;
  }

  return parsed;
}

module.exports = { checkPhoto };
