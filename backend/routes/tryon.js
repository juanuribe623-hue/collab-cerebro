/**
 * POST /api/tryon -> Probador virtual (FASHN try-on).
 * Recibe { model_image, garment_image, category } (data URIs base64),
 * corre el modelo tryon-v1.6 y espera el resultado (poll) antes de responder.
 * La llave FASHN_API_KEY vive en el servidor (env de Railway), como las demas.
 */
const router = require('express').Router();
const https  = require('https');
const { requireAuth } = require('./_auth');

function fashn(method, path, body, key) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const r = https.request({ hostname: 'api.fashn.ai', path, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, json: JSON.parse(d || '{}') }); }
        catch (e) { reject(new Error('Respuesta invalida de FASHN')); }
      });
    });
    r.on('error', reject);
    if (b) r.write(b);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

router.post('/', requireAuth, async (req, res) => {
  const key = process.env.FASHN_API_KEY;
  if (!key) return res.status(500).json({ error: 'Falta configurar FASHN_API_KEY en el servidor (Railway, Variables). Crea la cuenta en fashn.ai y agrega la llave.' });

  const { model_image, garment_image, category } = req.body || {};
  if (!model_image || !garment_image) return res.status(400).json({ error: 'Faltan las dos fotos (persona y prenda).' });

  try {
    const run = await fashn('POST', '/v1/run', {
      model_name: 'tryon-v1.6',
      inputs: { model_image, garment_image, category: category || 'auto' },
    }, key);
    if (run.status >= 400 || !run.json.id) {
      return res.status(502).json({ error: 'FASHN rechazo la solicitud: ' + (run.json?.error?.message || run.json?.error || JSON.stringify(run.json).slice(0, 200)) });
    }

    // Poll hasta ~90s
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const st = await fashn('GET', '/v1/status/' + run.json.id, null, key);
      const s = st.json.status;
      if (s === 'completed') return res.json({ output: st.json.output || [] });
      if (s === 'failed' || s === 'canceled') {
        return res.status(502).json({ error: 'La generacion fallo: ' + (st.json?.error?.message || st.json?.error || s) });
      }
    }
    res.status(504).json({ error: 'La generacion tardo demasiado. Intenta de nuevo.' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
