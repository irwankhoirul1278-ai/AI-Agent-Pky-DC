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

// Dulu cuma 1 model tetap (GEMINI_MODEL), sekarang diganti jadi RANTAI FALLBACK:
// proxy nyoba model pertama dulu, kalau kena limit (429 / RESOURCE_EXHAUSTED)
// otomatis lanjut ke model berikutnya di daftar — user gak perlu ngapa-ngapain,
// gak perlu ganti kode/redeploy tiap kali satu model abis jatah harian.
// Urutan ini yang jadi urutan DEFAULT (mode "Auto" di toggle frontend). Kalau
// mau ubah urutan/isi daftar, edit array di bawah ini.
//
// CATATAN soal "antigravity-preview-05-2026": ini BUKAN model chat/text biasa
// kayak Gemini Flash — itu produk agentic coding dari Google (kategori "Agents"
// di halaman Rate Limit AI Studio), statusnya masih PREVIEW jadi model ID-nya
// bisa berubah/expired kapan aja, dan cara dia jawab bisa beda dari model Flash
// biasa (kurang predictable buat kebutuhan "balikin JSON ketat" kayak app ini).
const GEMINI_MODEL_CHAIN = [
  "gemini-3.6-flash",
  "antigravity-preview-05-2026",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite"
];

function geminiUrlFor(model) {
  return "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent";
}

// True kalau response Gemini nunjukin RATE LIMIT (429 / RESOURCE_EXHAUSTED) —
// KHUSUS kasus ini yang boleh lanjut coba model berikutnya. Error lain (400
// bad request, safety block, dll) JANGAN di-retry ke model lain karena
// penyebabnya bukan soal kuota, kemungkinan besar bakal gagal lagi juga di
// model manapun (buang-buang waktu/token doang).
function isRateLimitError(status, data){
  if (status === 429) return true;
  const msg = JSON.stringify((data && data.error) || "");
  return /RESOURCE_EXHAUSTED/i.test(msg);
}

// Kalau frontend ngirim "preferred_model" (dari toggle pilihan model di UI),
// model itu digeser ke PALING DEPAN antrian — tapi fallback ke sisa daftar
// TETEP jalan kalau model pilihan itu kena limit. Kalau preferred_model gak
// dikirim / gak dikenal / user pilih "Auto", ya pakai urutan default apa
// adanya.
function buildChain(preferredModel){
  if (!preferredModel || GEMINI_MODEL_CHAIN.indexOf(preferredModel) === -1){
    return GEMINI_MODEL_CHAIN;
  }
  return [preferredModel].concat(GEMINI_MODEL_CHAIN.filter(m => m !== preferredModel));
}

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

  const { system, contents, max_tokens, thinking_level, preferred_model } = payload;

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

  // Coba tiap model di GEMINI_MODEL_CHAIN berurutan. Berhenti begitu ada yang
  // BUKAN error rate-limit (baik itu sukses ATAU error lain yang emang harus
  // ditampilin apa adanya, misal safety block/bad request). Kalau SEMUA model
  // di daftar abis kena rate limit, balikin error dari model TERAKHIR yang
  // dicoba (paling informatif — nunjukin semua opsi udah abis).
  const modelChain = buildChain(preferred_model);
  let lastResult = null;
  for (let i = 0; i < modelChain.length; i++){
    const model = modelChain[i];
    try {
      const geminiRes = await fetch(geminiUrlFor(model) + "?key=" + apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody)
      });
      const data = await geminiRes.json();
      lastResult = { status: geminiRes.status, data: data };

      if (!isRateLimitError(geminiRes.status, data)){
        // Sisipin info model mana yang kepake — cuma buat debugging/log,
        // frontend gak wajib baca field ini, aman diabaikan.
        data._modelUsed = model;
        return {
          statusCode: geminiRes.status,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        };
      }
      // Kena rate limit di model ini — lanjut coba model berikutnya di daftar
      // (kalau masih ada), atau abis loop kalau ini model terakhir.
    } catch (e) {
      lastResult = { status: 502, data: { error: "Gagal menghubungi Gemini API (" + model + "): " + e.message } };
      // Error jaringan/koneksi juga boleh lanjut ke model berikutnya, siapa
      // tau cuma masalah sesaat di endpoint model itu doang.
    }
  }

  // Semua model di daftar udah dicoba dan gagal (rate limit semua / error
  // jaringan semua) — balikin hasil dari percobaan terakhir apa adanya.
  const finalData = lastResult ? lastResult.data : { error: "Semua model di GEMINI_MODEL_CHAIN gagal, gak ada respons." };
  return {
    statusCode: (lastResult && lastResult.status) || 502,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(finalData)
  };
};
