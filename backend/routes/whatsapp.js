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
const catalogo = require('./_catalogo');
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
- Si tienes la herramienta buscar_producto y el cliente te dice que busca algo, usala antes de pensar en pasar la conversacion a una persona. Mostrar es mejor que prometer que alguien mostrara.
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
    escalamiento_min: 90, catalogo: null,
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

/* WhatsApp no entiende Markdown: la negrita es *un* asterisco, no dos.
   Sin esta limpieza el cliente ve los asteriscos escritos en el mensaje. */
function aFormatoWhatsApp(texto) {
  return String(texto)
    .replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*')   /* ***x*** -> *x*   */
    .replace(/\*\*(.+?)\*\*/gs,     '*$1*')   /* **x**   -> *x*   */
    .replace(/^#{1,6}\s+/gm,        '')       /* quita encabezados */
    .replace(/^\s*[-*]\s+/gm,       '• ')     /* vinetas legibles  */
    /* Guion largo y guion medio: nadie los escribe en WhatsApp, delatan
       que el texto lo redacto una IA. Se pide tambien en el prompt, pero
       el modelo lo olvida, asi que aqui se garantiza. */
    .replace(/\s*[—–]\s*/g,         ', ')
    .replace(/,\s*,/g,              ',')      /* evita ", ," al reemplazar */
    .replace(/\s+([,.;:!?])/g,      '$1');    /* evita " ," suelto         */
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

/**
 * Por que el asistente no contesta. Devuelve null si si debe contestar.
 *
 * Son cuatro razones y solo una es permanente. La diferencia importa:
 *
 *   tomado         una persona se apropio del chat desde el panel. Dura hasta
 *                  que esa persona lo suelte, y asi debe ser.
 *   silencio_hasta una persona acaba de escribir. Se vence solo.
 *   escalado_hasta el asistente pidio ayuda. Se vence solo.
 *
 * Esa ultima antes se guardaba en "tomado", y como "tomado" es permanente, el
 * asistente quedaba mudo con ese cliente para siempre: el 29 de octubre dos
 * personas del equipo escribieron a Pris y no les contesto nunca, por chats
 * que el bot habia escalado semanas antes y nadie habia desmarcado.
 *
 * Se separa en hora para poder probarla sin base de datos y sin reloj real.
 */
function razonParaCallar(cfg, chat, ahora = new Date()) {
  const vigente = t => Boolean(t && new Date(t) > ahora);
  if (!cfg.activo)   return 'el asistente esta apagado';
  if (chat.tomado)   return 'chat tomado por una persona';
  if (vigente(chat.silencio_hasta)) return 'el bot esta en silencio porque escribio una persona';
  if (vigente(chat.escalado_hasta)) {
    const h = new Date(chat.escalado_hasta)
      .toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });
    return `escalado, el bot retoma a las ${h}`;
  }
  if (!botDebeResponder(cfg.horario, ahora)) return 'fuera del horario del bot';
  return null;
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

/* Solo se le ofrece a las empresas que tienen catalogo configurado. Si no
   existe la herramienta, el modelo no puede intentar usarla y caer en error. */
const HERRAMIENTA_CATALOGO = {
  name: 'buscar_producto',
  description:
    'Busca en el catalogo de la tienda online lo que esta disponible ahora. ' +
    'Usala apenas el cliente diga que busca algo (una prenda, un accesorio, un regalo), ' +
    'antes de pensar en pasar la conversacion a una persona. ' +
    'No necesitas saber talla ni presupuesto para buscar: busca con lo que tengas y ' +
    'afina despues con lo que el cliente te responda.',
  input_schema: {
    type: 'object',
    properties: {
      que:        { type: 'string', description: 'Lo que busca, en las palabras del cliente: "vestido de fiesta", "sets urbanos", "zapatos negros", "aretes"' },
      talla:      { type: 'string', description: 'Solo si la dijo: S, M, L, XS, 38, unica' },
      color:      { type: 'string', description: 'Solo si lo dijo' },
      precio_max: { type: 'number', description: 'Presupuesto maximo en pesos, solo si lo dijo' },
    },
    required: ['que'],
  },
};

/* La herramienta solo se ofrece si el catalogo ya esta cargado. Prometer una
   busqueda que no se puede hacer es peor que no ofrecerla: si Shopify esta
   bloqueando, el asistente se comporta como antes y nadie queda esperando. */
const herramientasDe = cfg =>
  (cfg.catalogo && cfg.catalogo.shopify && catalogo.estaListo(cfg.catalogo.shopify))
    ? [...HERRAMIENTAS, HERRAMIENTA_CATALOGO]
    : HERRAMIENTAS;

async function llamarClaude(system, messages, herramientas = HERRAMIENTAS) {
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
      tools: herramientas,
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
    return { texto: null, escalar: null, nombre: null, productos: [] };
  }

  const herramientas = herramientasDe(cfg);
  let escalar = null, nombre = null, productos = [];
  let resp = await llamarClaude(system, messages, herramientas);

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
      } else if (b.name === 'buscar_producto') {
        const inp = b.input || {};
        try {
          const r = await catalogo.buscarEnTienda(cfg.catalogo, {
            texto: inp.que, talla: inp.talla, color: inp.color, precioMax: inp.precio_max,
          });
          /* Solo se envian fotos de la ultima busqueda que trajo algo: si el
             modelo busca otra vez y no encuentra, no mandamos fotos viejas. */
          productos = r.items;
          out = r.texto;
        } catch (e) {
          console.error('[wa catalogo]', e.message);
          productos = [];
          out = 'El catalogo no respondio. No inventes producto: ofrecele que una persona del equipo le muestre opciones.';
        }
      } else {
        out = 'Herramienta desconocida';
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
    }
    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: results });
    resp = await llamarClaude(system, messages, herramientas);
  }

  const texto = (resp.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { texto: texto || null, escalar, nombre, productos };
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

/* Meta descarga la imagen desde el link, asi que tiene que ser publica y
   https. Las de Shopify lo son. Si una falla no se cae la conversacion:
   el mensaje de texto ya salio. */
async function enviarImagen(telefono, url, pie) {
  if (modoPrueba()) return { ok: true, simulado: true };
  if (!/^https:\/\//i.test(String(url || ''))) return { ok: false, error: 'Imagen no valida' };
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: telefono,
      type: 'image', image: { link: url, caption: String(pie).slice(0, 1000) },
    }),
  });
  if (!r.ok) {
    console.error('[wa] foto fallo', r.status, (await r.text().catch(() => '')).slice(0, 200));
    return { ok: false, error: 'No se pudo enviar la foto.' };
  }
  return { ok: true };
}

/* Pie de foto: lo unico donde el cliente ve precio y link. El texto del
   asistente no los repite, para que el mensaje no quede como un catalogo. */
function pieDeFoto(p) {
  const tallas = (p.tallas || []).filter(t => t && t !== 'unica');
  return [
    `*${p.titulo}*`,
    p.marca,
    catalogo.pesos(p.precio) + (tallas.length ? `  ·  tallas ${tallas.join(', ')}` : ''),
    p.url,
  ].filter(Boolean).join('\n');
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
  /* Una sola linea que responde las tres preguntas de siempre cuando el bot
     se queda callado: que config cargo (si dice "Asistente" es la empresa
     equivocada), si esta encendido, y si hay token para enviar de verdad. */
  console.log('[wa] config', cfg.nombre_bot, 'activo=' + cfg.activo,
              'modo=' + (modoPrueba() ? 'PRUEBA' : 'real'));
  const chat = await buscarOCrearChat(companyId, telefono, nombreSugerido);

  await agregarMensaje(chat, 'cliente', contenido);
  await supabase.from('wa_chats')
    .update({ no_leido: true, ultimo_ts: new Date().toISOString() })
    .eq('id', chat.id);

  const callar = razonParaCallar(cfg, chat);
  if (callar) return { chat_id: chat.id, respuesta: null, motivo: callar };

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

  const texto = aFormatoWhatsApp(conAvisoLegal(esPrimero, salida.texto, cfg));
  const env = await enviarWhatsApp(chat.telefono, texto);
  if (!env.ok) return { chat_id: chat.id, respuesta: null, motivo: env.error };

  await agregarMensaje(chat, 'bot', texto);

  /* Las fotos van detras del mensaje, no en vez de el: primero el asistente
     dice algo, despues llega el producto. Si escalo, no se mandan: la
     persona que retoma decide que mostrar. */
  if (!salida.escalar && salida.productos && salida.productos.length) {
    for (const p of salida.productos.slice(0, 3)) {
      if (!p.imagen) continue;
      const pie = pieDeFoto(p);
      const e = await enviarImagen(chat.telefono, p.imagen, pie);
      if (e.ok) await agregarMensaje(chat, 'bot', { tipo: 'image', texto: pie });
    }
  }

  const patch = { ultimo_ts: new Date().toISOString() };
  if (salida.nombre && !chat.nombre) patch.nombre = salida.nombre;
  if (salida.escalar) {
    /* Se calla un rato para no hablar encima de quien llegue, pero no se
       apropia del chat: "tomado" es de las personas. Si nadie atiende dentro
       de la ventana, el asistente retoma. Un cliente esperando sin respuesta
       es peor que un asistente que vuelve a contestar. */
    const minutos = Number(cfg.escalamiento_min) > 0 ? Number(cfg.escalamiento_min) : 90;
    patch.escalado_hasta = new Date(Date.now() + minutos * 60000).toISOString();
    patch.no_leido = true;
  }
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

    /* procesarEntrante devuelve un motivo cada vez que decide no contestar.
       Antes se descartaba y el bot se quedaba mudo sin dejar rastro. */
    console.log('[wa] entra', msg.type, 'de', msg.from);
    const r = await procesarEntrante(companyId, msg.from, cont, perfil);
    if (r && r.respuesta) console.log('[wa] respondido ok, chat', r.chat_id);
    else console.log('[wa] SIN RESPUESTA:', (r && r.motivo) || 'sin motivo');
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
        /* El asistente pidio ayuda y todavia nadie llego. Es distinto de
           "tomado": esto se vence solo y hay que atenderlo ya. */
        escalado: Boolean(c.escalado_hasta && new Date(c.escalado_hasta) > new Date()),
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
      escalado_hasta: chat.escalado_hasta,
      escalado: Boolean(chat.escalado_hasta && new Date(chat.escalado_hasta) > new Date()),
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

  /* Si una persona escribe, el bot se calla un rato en esa conversacion.
     Y si el chat venia escalado, ya llego quien tenia que llegar: se limpia
     la marca para que no siga pintada de rojo en el panel. */
  const cfg = await leerConfig(req.companyId);
  const hasta = new Date(Date.now() + (cfg.silencio_min || 45) * 60000).toISOString();
  await supabase.from('wa_chats')
    .update({ silencio_hasta: hasta, escalado_hasta: null, no_leido: false, ultimo_ts: new Date().toISOString() })
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
    escalado_hasta: null,   /* alguien se hizo cargo, o lo devolvio: la peticion de ayuda ya no aplica */
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
            const texto = aFormatoWhatsApp(conAvisoLegal(esPrimero, salida.texto, cfg));
            const env = await enviarWhatsApp(chat.telefono, texto);
            if (env.ok) {
              await agregarMensaje({ id: chat.id, company_id: chat.company_id }, 'bot', texto);
              for (const p of (salida.productos || []).slice(0, 3)) {
                if (!p.imagen) continue;
                const pie = pieDeFoto(p);
                const e = await enviarImagen(chat.telefono, p.imagen, pie);
                if (e.ok) await agregarMensaje({ id: chat.id, company_id: chat.company_id }, 'bot', { tipo: 'image', texto: pie });
              }
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
    escalamiento_min:  Number(b.escalamiento_min) || 90,
    catalogo:          b.catalogo || null,
    updated_at:        new Date().toISOString(),
  };
  const { error } = await supabase.from('wa_config').upsert(fila, { onConflict: 'company_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* Al arrancar se deja el catalogo cargado para las empresas que lo tengan.
   Sin esto, el primer cliente que pregunte por producto espera los diez
   segundos que toma bajar el catalogo entero. Si falla no pasa nada: se
   carga sola en la primera busqueda. */
setTimeout(async () => {
  try {
    const { data } = await supabase.from('wa_config').select('catalogo').not('catalogo', 'is', null);
    const vistos = new Set();
    for (const fila of data || []) {
      const c = fila.catalogo;
      if (!c || !c.shopify || vistos.has(c.shopify)) continue;
      vistos.add(c.shopify);
      await catalogo.precalentar(c);
    }
  } catch (e) {
    console.error('[catalogo] precalentado:', e.message);
  }
}, 3000).unref();   /* que no sea esto lo que mantenga vivo al proceso */

module.exports = router;
module.exports.procesarEntrante = procesarEntrante;

/* Expuesto solo para pruebas de la logica pura, sin base de datos. */
module.exports._test = { botDebeResponder, conAvisoLegal, armarSystem, normTel, razonParaCallar };
