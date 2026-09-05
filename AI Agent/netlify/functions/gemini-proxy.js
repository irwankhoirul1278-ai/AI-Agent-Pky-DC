// netlify/functions/gemini-proxy.js
// [rebuild-marker: force fresh deploy processing]
//
// Proxy sederhana ke Google Gemini API (free tier). API key DISIMPAN di
// Environment Variable Netlify (GEMINI_API_KEY), jadi gak pernah kelihatan
// di browser/client-side.
//
// Cara pakai dari frontend (report-agent.html):
//   fetch("/.netlify/functions/gemini-proxy", {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ system: "...", contents: [...] })
//   })
//
// Setup di Netlify:
// 1. Generate API key gratis di https://aistudio.google.com/app/apikey
// 2. Buka dashboard Netlify > Site configuration > Environment variables
// 3. Tambah variable: GEMINI_API_KEY = AIzaSy... (API key dari langkah 1)
// 4. Deploy ulang site (env var baru butuh deploy baru biar ke-pickup)

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL + ":generateContent";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "GEMINI_API_KEY belum di-set di Environment Variables Netlify"
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Body request bukan JSON valid" })
    };
  }

  const { system, contents, max_tokens, thinking_level } = payload;

  if (!contents || !Array.isArray(contents)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Field 'contents' wajib ada dan berupa array" })
    };
  }

  // Frontend boleh minta level thinking lebih tinggi buat task yang butuh AI
  // teliti (misal nyisir JSON data satu-satu) lewat field "thinking_level"
  // ("minimal"/"low"/"medium"/"high"). Default "minimal" kalau gak dikirim,
  // biar obrolan ringan tetep hemat token/latency.
  const allowedThinkingLevels = ["minimal", "low", "medium", "high"];
  const thinkingLevel = allowedThinkingLevels.includes(thinking_level) ? thinking_level : "minimal";

  const geminiBody = {
    contents: contents,
    generationConfig: {
      maxOutputTokens: max_tokens || 1000,
      thinkingConfig: { thinkingLevel: thinkingLevel }
    }
  };
  if (system) {
    geminiBody.system_instruction = { parts: [{ text: system }] };
  }

  try {
    const geminiRes = await fetch(GEMINI_URL + "?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody)
    });

    const data = await geminiRes.json();

    return {
      statusCode: geminiRes.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Gagal menghubungi Gemini API: " + e.message })
    };
  }
};
