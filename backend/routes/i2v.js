/**
 * Animar imagen: generacion de video via API de Higgsfield.
 *   POST /api/i2v            -> lanza el trabajo { image (data URI), prompt, duration } => { request_id }
 *   GET  /api/i2v/status/:id -> estado del trabajo (queued | in_progress | nsfw | failed | completed + video.url)
 * Llaves en env (Railway): HIGGSFIELD_API_KEY y HIGGSFIELD_API_SECRET.
 * Modelo configurable con HIGGSFIELD_MODEL (default Kling image-to-video).
 */
const router = require('express').Router();
const https  = require('https');
const { requireAuth } = require('./_auth');

const MODEL = process.env.HIGGSFIELD_MODEL || 'kling-video/v2.1/pro/image-to-video';

function hf(method, path, body) {
  return new Promise((resolve, reject) => {
    const key = process.env.HIGGSFIELD_API_KEY, sec = process.env.HIGGSFIELD_API_SECRET;
    const b = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': 'Key ' + key + ':' + sec,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const r = https.request({ hostname: 'platform.higgsfield.ai', path, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, json: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: resp.statusCode, json: { error: (d || '').slice(0, 300) } }); }
      });
    });
    r.on('error', reject);
    if (b) r.write(b);
    r.end();
  });
}

router.post('/', requireAuth, async (req, res) => {
  if (!process.env.HIGGSFIELD_API_KEY || !process.env.HIGGSFIELD_API_SECRET) {
    return res.status(500).json({ error: 'Faltan HIGGSFIELD_API_KEY y HIGGSFIELD_API_SECRET en el servidor (Railway, Variables). Se sacan en platform.higgsfield.ai.' });
  }
  const { image, prompt, duration } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: 'Faltan la imagen o el prompt.' });
  try {
    const run = await hf('POST', '/' + MODEL, { image_url: image, prompt, duration: duration || 5 });
    if (run.status >= 400 || !run.json.request_id) {
      return res.status(502).json({ error: 'Higgsfield rechazo la solicitud: ' + (run.json?.error?.message || run.json?.error || run.json?.detail || JSON.stringify(run.json).slice(0, 250)) });
    }
    res.json({ request_id: run.json.request_id });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const st = await hf('GET', '/requests/' + encodeURIComponent(req.params.id) + '/status', null);
    res.json(st.json);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
