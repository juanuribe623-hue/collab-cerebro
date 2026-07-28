/**
 * Transcripcion de audio para "Revisa un video" (Gemini).
 *   GET  /api/transcribe/estado -> { disponible } segun GEMINI_API_KEY
 *   POST /api/transcribe { audioBase64 } -> { texto } (WAV 16k mono, extraido en el navegador)
 * El nombre del modelo cambia por cuenta/version: se listan los modelos, se
 * ordenan los flash del mas nuevo al mas viejo y se prueba hasta que uno
 * responda; el que sirve se cachea. Llave en env: GEMINI_API_KEY.
 */
const router = require('express').Router();
const https  = require('https');
const { requireAuth } = require('./_auth');

const HOST = 'generativelanguage.googleapis.com';
const MAX_AUDIO_B64 = 6000000; // ~4.5 MB (~2 min de WAV 16k mono)
let modeloOk = null;

function gReq(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const headers = { 'x-goog-api-key': key };
    if (b) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(b); }
    const r = https.request({ hostname: HOST, path, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d || '{}'); } catch (e) {}
        resolve({ status: resp.statusCode, json: j, raw: d });
      });
    });
    r.on('error', reject);
    if (b) r.write(b);
    r.end();
  });
}

function score(name) {
  if (/latest/i.test(name)) return 1000;
  const m = name.match(/gemini-(\d+)(?:\.(\d+))?/i);
  if (!m) return 0;
  return Number(m[1]) * 10 + Number(m[2] || 0);
}

async function candidatos(key) {
  const res = await gReq('GET', '/v1beta/models?pageSize=200', key);
  if (res.status >= 400) throw new Error('ListModels ' + res.status + ': ' + (res.raw || '').slice(0, 200));
  const usables = (res.json.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
  const flash = usables
    .filter(m => /flash/i.test(m.name) && !/(image|vision|tts|live|thinking|native-audio|exp)/i.test(m.name))
    .sort((a, b) => score(b.name) - score(a.name));
  const resto = usables.filter(m => !flash.includes(m)).sort((a, b) => score(b.name) - score(a.name));
  const pref = (process.env.GEMINI_MODEL || '').trim();
  const orden = [];
  if (pref) orden.push(pref);
  [...flash, ...resto].forEach(m => orden.push(m.name.replace(/^models\//, '')));
  return [...new Set(orden)];
}

async function generar(model, key, wavBase64) {
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'audio/wav', data: wavBase64 } },
      { text: 'Transcribe este audio palabra por palabra, en espanol. Devuelve SOLO la transcripcion, sin comentarios ni marcas de tiempo. Si no hay voz, responde vacio.' },
    ]}],
    generationConfig: { temperature: 0 },
  };
  const res = await gReq('POST', '/v1beta/models/' + model + ':generateContent', key, body);
  if (res.status >= 400) throw new Error(model + ' -> ' + res.status + ': ' + (res.raw || '').slice(0, 200));
  return ((res.json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(' ')).trim().slice(0, 2500);
}

router.get('/estado', requireAuth, (_req, res) => {
  res.json({ disponible: Boolean((process.env.GEMINI_API_KEY || '').trim()) });
});

router.post('/', requireAuth, async (req, res) => {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return res.status(503).json({ error: 'Falta GEMINI_API_KEY en el servidor (Railway, Variables).' });
  const audioBase64 = (req.body || {}).audioBase64 || '';
  if (!audioBase64 || audioBase64.length > MAX_AUDIO_B64) {
    return res.status(413).json({ error: 'El audio pesa demasiado o esta vacio. Usa un video mas corto.' });
  }
  try {
    if (modeloOk) {
      try { return res.json({ texto: await generar(modeloOk, key, audioBase64) }); }
      catch (e) { modeloOk = null; }
    }
    const cands = await candidatos(key);
    let ultimo = 'la cuenta no devolvio modelos usables';
    for (const model of cands) {
      try {
        const texto = await generar(model, key, audioBase64);
        modeloOk = model;
        return res.json({ texto });
      } catch (e) { ultimo = e.message; }
    }
    throw new Error(ultimo);
  } catch (e) {
    console.error('[transcribe] Gemini fallo:', e.message);
    res.status(502).json({ error: 'No se pudo sacar el audio: ' + e.message });
  }
});

module.exports = router;
