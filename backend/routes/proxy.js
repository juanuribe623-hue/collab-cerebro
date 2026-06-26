/**
 * POST /claude  -> proxy a Anthropic API
 * POST /apify   -> proxy a Apify API
 *
 * Las llaves las pone COLLAB (env vars del servidor), no el cliente.
 * Soporta caché de prompt: el frontend manda el system como bloques con cache_control
 * y este proxy lo reenvia tal cual (Anthropic lo procesa).
 */
const router = require('express').Router();
const https  = require('https');
const { requireAuth } = require('./_auth');

function proxyHttps(hostname, path, method, headers, body, res) {
  const opts = { hostname, path, method, headers };
  const r = https.request(opts, resp => {
    let d = '';
    resp.on('data', c => d += c);
    resp.on('end', () => { res.status(resp.statusCode).json(JSON.parse(d || '{}')); });
  });
  r.on('error', e => res.status(502).json({ error: e.message }));
  if (body) r.write(body);
  r.end();
}

router.post('/claude', requireAuth, (req, res) => {
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (!claudeKey) return res.status(500).json({ error: 'CLAUDE_API_KEY no configurada en el servidor' });

  const { apiKey, ...rest } = req.body;  // ignorar cualquier key que mande el cliente
  const b = JSON.stringify(rest);

  proxyHttps('api.anthropic.com', '/v1/messages', 'POST', {
    'Content-Type':      'application/json',
    'x-api-key':         claudeKey,
    'anthropic-version': '2023-06-01',
    'Content-Length':    Buffer.byteLength(b),
  }, b, res);
});

router.post('/apify', requireAuth, (req, res) => {
  const apifyKey = process.env.APIFY_API_KEY;
  if (!apifyKey) return res.status(500).json({ error: 'APIFY_API_KEY no configurada en el servidor' });

  const { path: aPath, method: aMethod = 'GET', body: aBody } = req.body;
  if (!aPath) return res.status(400).json({ error: 'Falta path' });

  const decoded  = decodeURIComponent(aPath);
  const sep      = decoded.includes('?') ? '&' : '?';
  const fullPath = decoded + sep + 'token=' + encodeURIComponent(apifyKey);
  const bodyStr  = (aMethod !== 'GET' && aBody) ? JSON.stringify(aBody) : null;
  const headers  = { 'Content-Type': 'application/json' };
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  proxyHttps('api.apify.com', fullPath, aMethod, headers, bodyStr, res);
});

module.exports = router;
