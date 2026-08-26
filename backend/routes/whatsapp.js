/**
 * Modulo WhatsApp del Cerebro.
 *
 * Bandeja de entrada con asistente automatico e intervencion humana.
 * Portado de la arquitectura que ya corre en produccion en Senzo 104,
 * con tres cambios: los datos viven en Supabase y no en disco, el cerebro
 * se configura por empresa desde la base, y el escalamiento a persona es
 * por tema y no solo por horario.
 *
 * FASE ACTUAL: sin linea real. Si no hay WHATSAPP_TOKEN configurado el
 * modulo corre en MODO PRUEBA: todo el flujo funciona igual, pero los
 * mensajes salientes se guardan en vez de enviarse a Meta. Cuando llegue
 * la linea, se llenan las variables de entorno y no se cambia una linea
 * de codigo.
 *
 * Variables de entorno (cuando entre la linea):
 *   WHATSAPP_TOKEN         token permanente de la app de Meta
 *   WHATSAPP_PHONE_ID      id del numero en Cloud API
 *   WHATSAPP_VERIFY_TOKEN  el que se pone al conectar el webhook
 *   WHATSAPP_COMPANY_ID    empresa a la que entran los mensajes de esa linea
 */
const router   = require('express').Router();
const supabase = require('./_supabase');
const { requireAuth } = require('./_auth');

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_TURNOS = 14;

const modoPrueba = () => !(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

/* ------------------------------------------------------------------ */
/* Configuracion del asistente                                        */
/* ------------------------------------------------------------------ */

const PROMPT_BASE = `Eres el asistente de atencion al cliente de una tienda. Atiendes por WhatsApp: mensajes cortos, calidos y directos, en espanol colombiano, de tu. Nada de lenguaje corporativo.

REGLAS QUE NO PUEDES ROMPER:
- Nunca confirmes disponibilidad, tallas, colores ni precios que no te hayan dado explicitamente en el contexto o en el resultado de una herramienta. Si no lo tienes, no lo inventes: usa la herramienta pasar_a_humano.
- Nunca prometas descuentos, plazos de entrega ni excepciones.
- No mandes a la persona a otro numero ni a otro canal. La atienden por aqui mismo.
- Si la persona pide hablar con alguien del equipo, usa pasar_a_humano de inmediato, sin insistir.
- Si hay un reclamo, una garantia, un problema con un pago o un pedido que salio mal, usa pasar_a_humano. No intentes resolverlo tu.
- Mensajes de maximo 4 lineas. Si necesitas mas, parte en dos ideas y pregunta antes de seguir.

EN TU PRIMER MENSAJE de la conversacion es obligatorio por ley que digas que eres un asistente virtual con inteligencia artificial y que una persona del equipo retoma esta misma conversacion. Hazlo natural y breve, y no lo repitas despues.`;

async function leerConfig(companyId) {
  const { data } = await supabase
    .from('wa_config').select('*').eq('company_id', companyId).maybeSingle();
  return data || {
    company_id: companyId, activo: true, nombre_bot: 'Asistente',
    nombre_humano: 'nuestro equipo', system_prompt: null,
    base_conocimiento: null, horario: { modo: 'siempre' }, silencio_min: 45,
  };
}

function armarSystem(cfg) {
  const partes = [cfg.system_prompt || PROMPT_BASE];
  partes.push(`\nTe llamas ${cfg.nombre_bot}. La persona del equipo que retoma se llama ${cfg.nombre_humano}.`);
  if (cfg.base_conocimiento) {
    partes.push(`\nBASE DE CONOCIMIENTO (respuestas aprobadas por el cliente, usalas como fuente de verdad):\n${cfg.base_conocimiento}`);
  }
  return partes.join('\n');
}

/* Salvavidas legal: si el modelo olvida el aviso en el primer mensaje, se agrega.
   No dependemos de que el modelo se acuerde, porque es una obligacion legal. */
function conAvisoLegal(esPrimero, texto, cfg) {
  if (!esPrimero) return texto;
  /* tolerante a saltos de linea: el modelo puede partir la frase en dos renglones */
  const faltaIA     = !/inteligencia\s+artificial/i.test(texto);
  const primerNombre = String(cfg.nombre_humano || '').split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const faltaHumano = primerNombre ? !new RegExp(primerNombre, 'i').test(texto) : false;
  if (!faltaIA && !faltaHumano) return texto;
  const extra = [];
  if (faltaIA)     extra.push(`Te escribe ${cfg.nombre_bot}, asistente virtual con inteligencia artificial.`);
  if (faltaHumano) extra.push(`${cfg.nombre_humano} retoma esta conversacion en horario de atencion.`);
  return texto + '\n\n' + extra.join(' ');
}

/* Horario. modo "siempre" = el bot contesta 24/7.
   modo "fuera_de_horario" = calla de lunes a viernes entre inicio y fin (hora Bogota). */
function botDebeResponder(horario, now = new Date()) {
  const h = horario || { modo: 'siempre' };
  if (h.modo !== 'fuera_de_horario') return true;
  const bog = new Date(now.getTime() - 5 * 3600 * 1000);
  const dow = bog.getUTCDay(), hora = bog.getUTCHours();
  if (dow === 0 || dow === 6) return true;
  const ini = Number.isFinite(h.inicio) ? h.inicio : 9;
  const fin = Number.isFinite(h.fin)    ? h.fin    : 19;
  return hora < ini || hora >= fin;
}

/* ------------------------------------------------------------------ */
/* Herramientas del asistente                                          */
/* ------------------------------------------------------------------ */

const HERRAMIENTAS = [
  {
    name: 'pasar_a_humano',
    description: 'Pasa la conversacion a una persona del equipo. Usala cuando el cliente lo pida, cuando haya un reclamo o garantia, cuando haya un problema con un pago o un pedido, o cuando necesites confirmar disponibilidad, talla o precio real que no tengas.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por que se escala, en una frase' },
        resumen: { type: 'string', description: 'Resumen de lo que el cliente necesita, para que la persona no tenga que leer todo' },
      },
      required: ['motivo'],
    },
  },
  {
    name: 'guardar_contacto',
    description: 'Guarda el nombre del cliente cuando te lo diga, para poder saludarlo por su nombre despues.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
  },
];

async function llamarClaude(system, messages) {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error('CLAUDE_API_KEY no configurada');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system,
      tools: HERRAMIENTAS,
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/**
 * Corre el cerebro sobre el historial. Devuelve el texto y si pidio escalar.
 */
async function correrAsistente(cfg, historial) {
  const system = armarSystem(cfg);
  const messages = historial.slice(-MAX_TURNOS).map(m => ({
    role: m.de === 'cliente' ? 'user' : 'assistant',
    content: String(m.texto || '').slice(0, 1500) || '(sin texto)',
  }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return { texto: null, escalar: null, nombre: null };
  }

  let escalar = null, nombre = null;
  let resp = await llamarClaude(system, messages);

  for (let i = 0; i < 3 && resp.stop_reason === 'tool_use'; i++) {
    const results = [];
    for (const b of resp.content) {
      if (b.type !== 'tool_use') continue;
      let out = 'ok';
      if (b.name === 'pasar_a_humano') {
        escalar = b.input || {};
        out = 'Listo, la conversacion queda marcada para que la retome una persona. Despidete con calma y dile que en un momento le responden por aqui mismo.';
      } else if (b.name === 'guardar_contacto') {
        nombre = (b.input || {}).nombre || null;
        out = 'Nombre guardado.';
      } else {
        out = 'Herramienta desconocida';
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
    }
    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: results });
    resp = await llamarClaude(system, messages);
  }

  const texto = (resp.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto: texto || null, escalar, nombre };
}

/* ------------------------------------------------------------------ */
/* Envio                                                               */
/* ------------------------------------------------------------------ */

async function enviarWhatsApp(telefono, texto) {
  if (modoPrueba()) return { ok: true, simulado: true };
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: telefono,
      text: { body: String(texto).slice(0, 4000) },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('[wa] envio fallo', r.status, t.slice(0, 300));
    let error = 'No se pudo enviar el mensaje.';
    if (/131047|re-?engag|24[\s-]?hour/i.test(t)) {
      error = 'Pasaron mas de 24 horas desde el ultimo mensaje del cliente. WhatsApp solo permite plantillas aprobadas en ese caso.';
    }
    return { ok: false, error };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Acceso a datos                                                      */
/* ------------------------------------------------------------------ */

const normTel = t => String(t || '').replace(/\D/g, '');

async function buscarOCrearChat(companyId, telefono, nombre) {
  const tel = normTel(telefono);
  const { data: existente } = await supabase
    .from('wa_chats').select('*')
    .eq('company_id', companyId).eq('telefono', tel).maybeSingle();
  if (existente) {
    if (nombre && !existente.nombre) {
      await supabase.from('wa_chats').update({ nombre }).eq('id', existente.id);
      existente.nombre = nombre;
    }
    return existente;
  }
  const { data, error } = await supabase
    .from('wa_chats')
    .insert({ company_id: companyId, telefono: tel, nombre: nombre || null })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function agregarMensaje(chat, de, datos, autorId) {
  const d = typeof datos === 'string' ? { texto: datos } : (datos || {});
  const fila = {
    chat_id: chat.id, company_id: chat.company_id, de,
    autor_id: autorId || null,
    tipo: d.tipo || 'text',
    texto: String(d.texto || '').slice(0, 4000),
    media_id: d.mediaId || null, mime: d.mime || null, filename: d.filename || null,
  };
  const { data, error } = await supabase.from('wa_mensajes').insert(fila).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function historialDe(chatId) {
  const { data } = await supabase
    .from('wa_mensajes').select('de, texto, tipo, ts')
    .eq('chat_id', chatId).order('ts', { ascending: true }).limit(60);
  return data || [];
}

/**
 * El corazon: procesa un mensaje entrante del cliente y decide si el bot contesta.
 * Lo usan por igual el webhook real y el simulador de pruebas.
 */
async function procesarEntrante(companyId, telefono, contenido, nombreSugerido) {
  const cfg  = await leerConfig(companyId);
  const chat = await buscarOCrearChat(companyId, telefono, nombreSugerido);

  await agregarMensaje(chat, 'cliente', contenido);
  await supabase.from('wa_chats')
    .update({ no_leido: true, ultimo_ts: new Date().toISOString() })
    .eq('id', chat.id);

  const enSilencio = chat.silencio_hasta && new Date(chat.silencio_hasta) > new Date();
  if (!cfg.activo || chat.tomado || enSilencio || !botDebeResponder(cfg.horario)) {
    return { chat_id: chat.id, respuesta: null, motivo: chat.tomado ? 'chat tomado por una persona' : (enSilencio ? 'el bot esta en silencio' : 'fuera del horario del bot') };
  }

  const historial = await historialDe(chat.id);
  const esPrimero = !historial.some(m => m.de === 'bot');

  let salida;
  try {
    salida = await correrAsistente(cfg, historial);
  } catch (e) {
    console.error('[wa asistente]', e.message);
    return { chat_id: chat.id, respuesta: null, motivo: 'error del asistente: ' + e.message };
  }
  if (!salida.texto) return { chat_id: chat.id, respuesta: null, motivo: 'el asistente no genero respuesta' };

  const texto = conAvisoLegal(esPrimero, salida.texto, cfg);
  const env = await enviarWhatsApp(chat.telefono, texto);
  if (!env.ok) return { chat_id: chat.id, respuesta: null, motivo: env.error };

  await agregarMensaje(chat, 'bot', texto);

  const patch = { ultimo_ts: new Date().toISOString() };
  if (salida.nombre && !chat.nombre) patch.nombre = salida.nombre;
  if (salida.escalar) { patch.tomado = true; patch.no_leido = true; }
  await supabase.from('wa_chats').update(patch).eq('id', chat.id);

  if (salida.escalar) {
    await agregarMensaje(chat, 'bot', {
      texto: `[El asistente paso esta conversacion a una persona. Motivo: ${salida.escalar.motivo}${salida.escalar.resumen ? '. ' + salida.escalar.resumen : ''}]`,
      tipo: 'nota',
    });
  }

  return { chat_id: chat.id, respuesta: texto, escalado: Boolean(salida.escalar) };
}

/* ------------------------------------------------------------------ */
/* Webhook de Meta (publico, sin auth: lo llama Meta)                  */
/* ------------------------------------------------------------------ */

router.get('/webhook', (req, res) => {
  const t = process.env.WHATSAPP_VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && t && req.query['hub.verify_token'] === t) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  res.sendStatus(200); /* Meta exige un 200 inmediato */
  try {
    const companyId = process.env.WHATSAPP_COMPANY_ID;
    if (!companyId) return console.error('[wa] falta WHATSAPP_COMPANY_ID');

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg   = value?.messages?.[0];
    if (!msg) return;

    const perfil = value?.contacts?.[0]?.profile?.name || null;
    let cont = null;
    if (msg.type === 'text')          cont = { tipo: 'text', texto: (msg.text?.body || '').slice(0, 1500) };
    else if (msg.type === 'audio')    cont = { tipo: 'audio', mediaId: msg.audio.id, mime: msg.audio.mime_type, texto: '[nota de voz]' };
    else if (msg.type === 'image')    cont = { tipo: 'image', mediaId: msg.image.id, mime: msg.image.mime_type, texto: msg.image.caption || '[imagen]' };
    else if (msg.type === 'document') cont = { tipo: 'document', mediaId: msg.document.id, mime: msg.document.mime_type, filename: msg.document.filename, texto: msg.document.caption || '[documento]' };
    else if (msg.type === 'video')    cont = { tipo: 'video', mediaId: msg.video.id, mime: msg.video.mime_type, texto: msg.video.caption || '[video]' };
    else return;

    await procesarEntrante(companyId, msg.from, cont, perfil);
  } catch (e) {
    console.error('[wa webhook]', e.message);
  }
});

/* ------------------------------------------------------------------ */
/* API de la bandeja (autenticada)                                     */
/* ------------------------------------------------------------------ */

router.use(requireAuth);

router.get('/estado', async (req, res) => {
  const cfg = await leerConfig(req.companyId);
  res.json({
    modo: modoPrueba() ? 'prueba' : 'real',
    numero: cfg.numero || process.env.WHATSAPP_PHONE_ID || null,
    activo: cfg.activo,
    nombre_bot: cfg.nombre_bot,
    nombre_humano: cfg.nombre_humano,
  });
});

router.get('/chats', async (req, res) => {
  const { data: chats, error } = await supabase
    .from('wa_chats').select('*')
    .eq('company_id', req.companyId)
    .order('ultimo_ts', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  if (!chats.length) return res.json({ chats: [] });

  const { data: ultimos } = await supabase
    .from('wa_mensajes').select('chat_id, de, texto, ts')
    .in('chat_id', chats.map(c => c.id))
    .order('ts', { ascending: false }).limit(600);

  const porChat = new Map();
  (ultimos || []).forEach(m => { if (!porChat.has(m.chat_id)) porChat.set(m.chat_id, m); });

  res.json({
    chats: chats.map(c => {
      const u = porChat.get(c.id) || {};
      return {
        id: c.id, telefono: c.telefono, nombre: c.nombre || '',
        tomado: c.tomado, no_leido: c.no_leido,
        ultimo: (u.texto || '').slice(0, 90), ultimo_de: u.de || '', ts: c.ultimo_ts,
      };
    }),
  });
});

router.get('/chats/:id', async (req, res) => {
  const { data: chat } = await supabase
    .from('wa_chats').select('*')
    .eq('company_id', req.companyId).eq('id', req.params.id).maybeSingle();
  if (!chat) return res.status(404).json({ error: 'Esa conversacion no existe' });

  if (chat.no_leido) await supabase.from('wa_chats').update({ no_leido: false }).eq('id', chat.id);

  const { data: mensajes } = await supabase
    .from('wa_mensajes').select('id, de, tipo, texto, media_id, mime, filename, ts')
    .eq('chat_id', chat.id).order('ts', { ascending: true }).limit(300);

  res.json({
    chat: {
      id: chat.id, telefono: chat.telefono, nombre: chat.nombre || '',
      tomado: chat.tomado, silencio_hasta: chat.silencio_hasta,
    },
    mensajes: mensajes || [],
  });
});

router.post('/chats/:id/enviar', async (req, res) => {
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje' });

  const { data: chat } = await supabase
    .from('wa_chats').select('*')
    .eq('company_id', req.companyId).eq('id', req.params.id).maybeSingle();
  if (!chat) return res.status(404).json({ error: 'Esa conversacion no existe' });

  const env = await enviarWhatsApp(chat.telefono, texto);
  if (!env.ok) return res.status(400).json({ error: env.error });

  await agregarMensaje(chat, 'humano', texto, req.userId);

  /* Si una persona escribe, el bot se calla un rato en esa conversacion. */
  const cfg = await leerConfig(req.companyId);
  const hasta = new Date(Date.now() + (cfg.silencio_min || 45) * 60000).toISOString();
  await supabase.from('wa_chats')
    .update({ silencio_hasta: hasta, no_leido: false, ultimo_ts: new Date().toISOString() })
    .eq('id', chat.id);

  res.json({ ok: true, simulado: Boolean(env.simulado), silencio_hasta: hasta });
});

router.post('/chats/:id/tomar', async (req, res) => {
  const tomado = Boolean(req.body?.tomado);
  const { data: chat } = await supabase
    .from('wa_chats').select('*')
    .eq('company_id', req.companyId).eq('id', req.params.id).maybeSingle();
  if (!chat) return res.status(404).json({ error: 'Esa conversacion no existe' });

  await supabase.from('wa_chats').update({
    tomado,
    tomado_por: tomado ? req.userId : null,
    silencio_hasta: null,   /* al tomar o al devolver, el reloj de silencio se reinicia */
  }).eq('id', chat.id);

  res.json({ ok: true, tomado });

  /* El fix del limbo, heredado de Senzo: si la persona devuelve el chat al
     asistente y el cliente quedo esperando respuesta, el asistente contesta ya. */
  if (!tomado) {
    try {
      const hist = await historialDe(chat.id);
      const ult  = hist[hist.length - 1];
      if (ult && ult.de === 'cliente') {
        const cfg = await leerConfig(req.companyId);
        if (cfg.activo) {
          const salida = await correrAsistente(cfg, hist);
          if (salida.texto) {
            const esPrimero = !hist.some(m => m.de === 'bot');
            const texto = conAvisoLegal(esPrimero, salida.texto, cfg);
            const env = await enviarWhatsApp(chat.telefono, texto);
            if (env.ok) {
              await agregarMensaje({ id: chat.id, company_id: chat.company_id }, 'bot', texto);
              await supabase.from('wa_chats')
                .update({ ultimo_ts: new Date().toISOString() }).eq('id', chat.id);
            }
          }
        }
      }
    } catch (e) { console.error('[wa devolver]', e.message); }
  }
});

/* Simulador: mismo camino que el webhook real, sin linea conectada. */
router.post('/simular', async (req, res) => {
  const telefono = String(req.body?.telefono || '').trim();
  const texto    = String(req.body?.texto || '').trim();
  if (!telefono || !texto) return res.status(400).json({ error: 'Falta el telefono o el mensaje' });
  try {
    const r = await procesarEntrante(req.companyId, telefono, { tipo: 'text', texto }, req.body?.nombre || null);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[wa simular]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Configuracion del cerebro, editable sin desplegar. */
router.get('/config', async (req, res) => res.json(await leerConfig(req.companyId)));

router.put('/config', async (req, res) => {
  const b = req.body || {};
  const fila = {
    company_id: req.companyId,
    activo:            b.activo !== undefined ? Boolean(b.activo) : true,
    numero:            b.numero || null,
    nombre_bot:        b.nombre_bot || 'Asistente',
    nombre_humano:     b.nombre_humano || 'nuestro equipo',
    system_prompt:     b.system_prompt || null,
    base_conocimiento: b.base_conocimiento || null,
    horario:           b.horario || { modo: 'siempre' },
    silencio_min:      Number(b.silencio_min) || 45,
    updated_at:        new Date().toISOString(),
  };
  const { error } = await supabase.from('wa_config').upsert(fila, { onConflict: 'company_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
module.exports.procesarEntrante = procesarEntrante;

/* Expuesto solo para pruebas de la logica pura, sin base de datos. */
module.exports._test = { botDebeResponder, conAvisoLegal, armarSystem, normTel };
