/**
 * GET /api/watchlist  -> creadores en seguimiento de la empresa (con snapshots)
 * PUT /api/watchlist  -> guarda el array completo
 *
 * Per-company. data por item: { handle, plataforma, nombre, seguidores, er, medianViews,
 *   verified, agregado_en, snapshots:[ { fecha, seguidores, er, medianViews } ] }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('watchlist_creators')
    .select('wl_id, data')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(r => ({ ...r.data, id: r.wl_id })));
});

router.put('/', async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });
  const now = Date.now();
  await supabase.from('watchlist_creators').delete().eq('company_id', req.companyId);
  if (items.length > 0) {
    const rows = items.map(s => ({
      company_id: req.companyId,
      wl_id:      s.id || ('wl_' + Math.random().toString(36).slice(2, 10)),
      data:       s,
      updated_at: now,
    }));
    const { error } = await supabase.from('watchlist_creators').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, count: items.length });
});

module.exports = router;
