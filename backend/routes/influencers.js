/**
 * GET /api/influencers  -> array de creadores evaluados (BrandFit) de la empresa
 * PUT /api/influencers  -> guarda el array completo
 *
 * Mismo patron que trends/scripts. Scoped por company_id.
 * data: { handle, plataforma, nombre, seguidores, bio, score, veredicto,
 *         alineacion[], audiencia, riesgos[], angulo_colab, formato, evaluado_en }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('content_influencers')
    .select('inf_id, data')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(r => ({ ...r.data, id: r.inf_id })));
});

router.put('/', async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });

  const now = Date.now();
  await supabase.from('content_influencers').delete().eq('company_id', req.companyId);

  if (items.length > 0) {
    const rows = items.map(s => ({
      company_id: req.companyId,
      inf_id:     s.id || ('inf_' + Math.random().toString(36).slice(2, 10)),
      data:       s,
      updated_at: now,
    }));
    const { error } = await supabase.from('content_influencers').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, count: items.length });
});

module.exports = router;
