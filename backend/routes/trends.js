/**
 * GET /api/trends  -> array del Banco de Tendencias/Gaps de la empresa
 * PUT /api/trends  -> guardar el array completo del banco
 *
 * Datos en content_trends (JSONB), scoped por company_id. Filtrado en el frontend.
 * data: { titulo, descripcion, pilar, plataformas[], formato, tipo ('tendencia'|'gap'),
 *         tags[], estado ('nueva'|'en_uso'|'guardada'|'descartada'),
 *         videos[ { url, plataforma, vistas, likes, engagement } ], fuente, creado_en }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('content_trends')
    .select('trend_id, data')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || []).map(r => ({ ...r.data, id: r.trend_id }));
  res.json(result);
});

router.put('/', async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });

  const now = Date.now();
  await supabase.from('content_trends').delete().eq('company_id', req.companyId);

  if (items.length > 0) {
    const rows = items.map(t => ({
      company_id: req.companyId,
      trend_id:   t.id || ('trend_' + Math.random().toString(36).slice(2, 10)),
      data:       t,
      updated_at: now,
    }));
    const { error } = await supabase.from('content_trends').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, count: items.length });
});

module.exports = router;
