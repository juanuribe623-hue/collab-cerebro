/**
 * GET /api/brief  -> el brief de marca de la empresa (o {} si no existe)
 * PUT /api/brief  -> guarda (upsert) el brief de la empresa
 *
 * Un unico brief por company_id. Alimenta el contexto de marca de todos los modulos.
 * data: { nombre, descripcion, voz, audiencia, pilares[], reglas, objetivo_engagement }
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('company_brief')
    .select('data')
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ? data.data : {});
});

router.put('/', async (req, res) => {
  const body = req.body || {};
  const { error } = await supabase
    .from('company_brief')
    .upsert({ company_id: req.companyId, data: body, updated_at: Date.now() }, { onConflict: 'company_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
