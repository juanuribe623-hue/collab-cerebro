/**
 * Webhook del ERP (myProcess).
 *
 * myProcess empuja un aviso cada vez que algo se mueve en el inventario:
 * entra mercancia, se traslada entre bodegas, se vende, o se crea una
 * referencia. Aqui se reciben, se normalizan y se guardan.
 *
 * Para que sirve: saber cuando una pieza LLEGA a una tienda, que es la
 * diferencia entre "te confirmo" y "ya llego a la 109".
 *
 * Por ahora solo registra. Avisarle al cliente necesita una plantilla
 * aprobada por Meta, porque pasadas 24 horas desde su ultimo mensaje
 * WhatsApp no deja mandar texto libre.
 *
 * Variables de entorno:
 *   ERP_WEBHOOK_USER   usuario de la autenticacion basica
 *   ERP_WEBHOOK_PASS   clave de la autenticacion basica
 *   ERP_COMPANY_ID     empresa a la que pertenecen estos movimientos
 *                      (si falta, se usa WHATSAPP_COMPANY_ID)
 *
 * NOTA DE SEGURIDAD: lo que llega aqui lo manda un tercero y cualquiera que
 * averigue la URL puede intentarlo. Por eso:
 *   - se compara la clave en tiempo constante, para no filtrarla a punta de
 *     medir cuanto tarda la respuesta
 *   - si no hay clave configurada el endpoint se apaga, en vez de quedar
 *     abierto de par en par
 *   - nada de lo que llega dispara una accion: solo se guarda
 *   - el texto se recorta antes de guardarlo
 */
const router   = require('express').Router();
const crypto   = require('crypto');
const supabase = require('./_supabase');

const MAX_TEXTO = 200;

const limpio = (s, max = MAX_TEXTO) => {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, max) : null;
};

/* Ojo con el vacio: Number('') es 0, no NaN. Sin este corte, una cantidad
   que no viene se guardaria como cero, y "cero unidades" no es lo mismo que
   "no me dijeron cuantas". */
const aNumero = v => {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/* myProcess manda las fechas como "29/01/2025 12:00:00 a. m.", que Date no
   entiende. Se arma a mano y si no se puede, se deja en null: una fecha mal
   leida es peor que no tenerla. */
function aFecha(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, d, mes, a] = m;
    const f = new Date(Date.UTC(+a, +mes - 1, +d));
    return isNaN(f) ? null : f.toISOString();
  }
  const f = new Date(s);
  return isNaN(f) ? null : f.toISOString();
}

/* Comparacion en tiempo constante. timingSafeEqual exige largos iguales, asi
   que se compara el hash y no el texto. */
function igualSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function autorizado(req) {
  const user = process.env.ERP_WEBHOOK_USER;
  const pass = process.env.ERP_WEBHOOK_PASS;
  if (!user || !pass) return false;   /* sin clave configurada, cerrado */

  const cab = req.headers.authorization || '';
  const m = cab.match(/^Basic\s+(.+)$/i);
  if (!m) return false;

  let plano;
  try { plano = Buffer.from(m[1], 'base64').toString('utf8'); }
  catch { return false; }

  const corte = plano.indexOf(':');
  if (corte < 0) return false;

  /* Las dos comparaciones siempre, sin cortar en la primera: asi el tiempo de
     respuesta no delata cual de las dos fallo. */
  const okUser = igualSeguro(plano.slice(0, corte), user);
  const okPass = igualSeguro(plano.slice(corte + 1), pass);
  return okUser && okPass;
}

/**
 * De que tipo es el aviso. myProcess no manda un campo que lo diga, se
 * deduce de lo que viene lleno y lo que viene vacio, tal como lo documentan:
 *   compra     tipoDocId de factura de compra
 *   venta      tipoDocId de factura de venta
 *   producto   sin documento y sin bodega: es alta o cambio de referencia
 *   inventario sin documento pero con bodega: es un traslado
 */
function tipoDe(b) {
  const doc = String(b.tipoDocId || '').toUpperCase();
  if (doc.startsWith('FC')) return 'compra';
  if (doc.startsWith('FV')) return 'venta';
  const bodega = String(b.bodegaId == null ? '' : b.bodegaId);
  if (!bodega || bodega === '0') return 'producto';
  return 'inventario';
}

/* El codigo de bodega llega con y sin ceros a la izquierda segun el campo,
   asi que se normaliza a tres digitos antes de buscarlo en el mapa. */
const normBodega = v => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
};

const cacheCfg = { ts: 0, valor: null };

async function configDe(companyId) {
  if (cacheCfg.valor && Date.now() - cacheCfg.ts < 5 * 60000) return cacheCfg.valor;
  const { data } = await supabase
    .from('wa_config').select('erp').eq('company_id', companyId).maybeSingle();
  cacheCfg.valor = (data && data.erp) || {};
  cacheCfg.ts = Date.now();
  return cacheCfg.valor;
}

/* Prueba de vida, para que puedan confirmar que la URL responde antes de
   configurar nada. No dice nada que no se sepa ya. */
router.get('/movimiento', (_req, res) =>
  res.json({ ok: true, servicio: 'webhook de movimientos del ERP', metodo: 'POST' }));

router.post('/movimiento', async (req, res) => {
  if (!autorizado(req)) {
    res.set('WWW-Authenticate', 'Basic realm="erp"');
    return res.status(401).json({ error: 'No autorizado' });
  }

  const companyId = process.env.ERP_COMPANY_ID || process.env.WHATSAPP_COMPANY_ID;
  if (!companyId) {
    console.error('[erp] falta ERP_COMPANY_ID');
    return res.status(500).json({ error: 'Servicio sin configurar' });
  }

  /* myProcess puede mandar un aviso o una lista. Se aceptan los dos. */
  const cuerpo = Array.isArray(req.body) ? req.body : [req.body];
  if (!cuerpo.length || cuerpo.length > 500) {
    return res.status(400).json({ error: 'Cuerpo vacio o demasiado grande' });
  }

  try {
    const cfg     = await configDe(companyId);
    const bodegas = (cfg && cfg.bodegas) || {};
    const filas   = [];

    for (const b of cuerpo) {
      if (!b || typeof b !== 'object') continue;
      const codigo = limpio(b.codigoProducto, 60);
      if (!codigo) continue;   /* sin referencia no sirve de nada */

      const bodegaCod = normBodega(b.codigoBodega != null ? b.codigoBodega : b.bodegaId);

      filas.push({
        company_id:      companyId,
        tipo:            tipoDe(b),
        tipo_doc:        limpio(b.tipoDocId, 10),
        nro_documento:   limpio(b.nroDocumento, 30),
        fecha_doc:       aFecha(b.fechaDoc),
        codigo_producto: codigo,
        nombre_producto: limpio(b.nombreProducto),
        bodega_codigo:   bodegaCod,
        bodega_nombre:   limpio(b.nombreBodega, 60),
        sede:            (bodegaCod && bodegas[bodegaCod]) || null,
        cantidad:        aNumero(b.cantidad),
        valor:           aNumero(b.valorProducto),
        bodega_entrada:  normBodega(b.bodegaEntrada),
        bodega_salida:   normBodega(b.bodegaSalida),
        payload:         b,
      });
    }

    if (!filas.length) return res.status(400).json({ error: 'Ningun movimiento utilizable' });

    const { error } = await supabase.from('erp_movimientos').insert(filas);
    if (error) throw new Error(error.message);

    /* Una linea por lote, no por movimiento: si entra un inventario completo
       no queremos mil lineas de log. */
    const sedes = [...new Set(filas.map(f => f.sede || 'sin sede'))].join(', ');
    console.log(`[erp] ${filas.length} movimiento(s), sedes: ${sedes}`);

    res.json({ ok: true, recibidos: filas.length });
  } catch (e) {
    console.error('[erp]', e.message);
    res.status(500).json({ error: 'No se pudo registrar el movimiento' });
  }
});

module.exports = router;

/* Expuesto para probar la logica pura, sin red ni base de datos. */
module.exports._test = { tipoDe, normBodega, aFecha, aNumero, limpio, igualSeguro, autorizado };
