/**
 * Collab Cerebro — Backend API (multi-tenant, cliente-facing).
 * Reusa los patrones del Collab Manager, pero aislado: solo modulos de contenido.
 *
 *   POST /claude                 -> proxy a Claude (llave de Collab via env)
 *   POST /apify                  -> proxy a Apify (llave de Collab via env)
 *   GET/PUT /api/trends          -> Banco de Tendencias (scoped por company_id)
 *   GET  /health                 -> health check
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      'http://localhost:5173',
      'http://127.0.0.1:5500',
      process.env.FRONTEND_URL,
    ].filter(Boolean);
    if (allowed.includes(origin)) return cb(null, true);
    if (origin.startsWith('file://') || origin === 'null') return cb(null, true);
    if (origin.includes('railway.app')) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '30mb' }));
app.use(express.static('public'));

// Rutas de contenido (se iran sumando: calendar, insights)
app.use('/api/brief',       require('./routes/brief'));
app.use('/api/trends',      require('./routes/trends'));
app.use('/api/scripts',     require('./routes/scripts'));
app.use('/api/influencers', require('./routes/influencers'));
app.use('/api/watchlist',       require('./routes/watchlist'));
app.use('/api/agency-creators', require('./routes/agency'));
app.use('/api/calendar',        require('./routes/calendar'));
app.use('/api/insights',        require('./routes/insights'));
app.use('/api/tryon',           require('./routes/tryon'));
app.use('/api/i2v',             require('./routes/i2v'));
app.use('/',            require('./routes/proxy'));   // /claude y /apify

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log('\n  ✓ Collab Cerebro API corriendo en http://localhost:' + PORT + '\n');
});
