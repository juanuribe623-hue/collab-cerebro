/**
 * GET /api/scripts  -> array de guiones producidos por la empresa
 * PUT /api/scripts  -> guardar el array completo de la biblioteca de guiones
 *
 * Datos en content_scripts (JSONB), scoped por company_id. Mismo patron que trends.
 * data: { titulo, angulo, pilar, tema, plataformas[],
 *         ig:  { hook, desarrollo[], cierre, caption, hashtags[], cta },
 *         tiktok: { hook, desarrollo[], cierre, caption, hashtags[], audio, cta },
 *         utm, creado_en }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('content_scripts')
    .select('script_id, data')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || []).map(r => ({ ...r.data, id: r.script_id }));
  res.json(result);
});

router.put('/', async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });

  const now = Date.now();
  await supabase.from('content_scripts').delete().eq('company_id', req.companyId);

  if (items.length > 0) {
    const rows = items.map(s => ({
      company_id: req.companyId,
      script_id:  s.id || ('scr_' + Math.random().toString(36).slice(2, 10)),
      data:       s,
      updated_at: now,
    }));
    const { error } = await supabase.from('content_scripts').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, count: items.length });
});

module.exports = router;
