/**
 * POST /api/agency-creators  -> upsert de creador(es) en la base GLOBAL de Collab (cross-tenant).
 *
 * Insumo de la agencia: cada creador que pasa por Radar / BrandFit / Watchlist se registra
 * aqui por (plataforma, handle), sin scope de empresa. La vista Collab y el snapshot-history
 * global son fase 2; por ahora se captura existencia + ultimas metricas para no perder insumo.
 *
 * Body: un objeto creador o un array de creadores { handle, plataforma, nombre, seguidores, er, medianViews, verified }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.post('/', async (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : [req.body];
  const now = Date.now();
  const rows = arr
    .filter(c => c && c.handle && c.plataforma)
    .map(c => ({ plataforma: c.plataforma, handle: c.handle, data: { ...c, last_seen: now }, updated_at: now }));
  if (!rows.length) return res.json({ ok: true, count: 0 });

  const { error } = await supabase
    .from('agency_creators')
    .upsert(rows, { onConflict: 'plataforma,handle' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, count: rows.length });
});

module.exports = router;
