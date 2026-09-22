const MODEL = "gemini-2.0-flash";

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } }
        ]
      }
    ],
    generationConfig: { responseMimeType: "application/json" }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini request failed (${res.status}): ${text.slice(0, 300)}`);
    err.code = "GEMINI_ERROR";
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
