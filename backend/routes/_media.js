/**
 * Archivos de WhatsApp: subirlos a Meta para enviarlos, y traerlos de vuelta
 * para mostrarlos en la bandeja.
 *
 * Dos cosas que no son obvias y por las que existe este archivo:
 *
 * 1. La URL que devuelve Meta para un archivo recibido NO se puede poner en un
 *    <img>: hay que pedirla con el token desde el servidor. Por eso el panel
 *    nunca habla con Meta directo, siempre pasa por aqui.
 *
 * 2. Meta borra los archivos a los 30 dias. Si no guardamos copia, una foto
 *    vieja desaparece de la bandeja. Se guarda en Supabase Storage y no en
 *    disco, porque el disco de Railway se borra en cada despliegue.
 *
 * Si el bucket no se puede usar, todo sigue funcionando: simplemente se le
 * pide a Meta cada vez. Se pierde la copia, no el servicio.
 */
const supabase = require('./_supabase');

const GRAPH  = 'https://graph.facebook.com/v21.0';
const BUCKET = 'wa-media';

/* Topes de WhatsApp, en bytes. Mandar algo mas grande falla del lado de Meta
   con un error que no dice nada util, asi que se corta antes. */
const TOPES = {
  image:    5 * 1024 * 1024,
  video:   16 * 1024 * 1024,
  audio:   16 * 1024 * 1024,
  document: 95 * 1024 * 1024,
};

const tipoDeMime = mime => {
  const m = String(mime || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
};

/* Los id de Meta son numericos. Sanear antes de usarlos en una ruta o en un
   nombre de archivo evita que alguien se salga de la carpeta. */
const idLimpio = id => String(id || '').replace(/\D/g, '').slice(0, 40);

let bucketListo = null;   /* null sin probar, true disponible, false no se pudo */

async function asegurarBucket() {
  if (bucketListo !== null) return bucketListo;
  try {
    const { data } = await supabase.storage.listBuckets();
    if ((data || []).some(b => b.name === BUCKET)) { bucketListo = true; return true; }
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    bucketListo = !error;
    if (error) console.warn('[media] sin bucket, se servira siempre desde Meta:', error.message);
  } catch (e) {
    bucketListo = false;
    console.warn('[media] Storage no disponible:', e.message);
  }
  return bucketListo;
}

async function guardarCopia(mediaId, buf, mime) {
  const id = idLimpio(mediaId);
  if (!id || !(await asegurarBucket())) return;
  try {
    await supabase.storage.from(BUCKET)
      .upload(id, buf, { contentType: mime || 'application/octet-stream', upsert: true });
  } catch (e) {
    console.warn('[media] no se pudo guardar la copia:', e.message);
  }
}

async function leerCopia(mediaId) {
  const id = idLimpio(mediaId);
  if (!id || !(await asegurarBucket())) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(id);
    if (error || !data) return null;
    return { buf: Buffer.from(await data.arrayBuffer()), mime: data.type || null };
  } catch (e) {
    return null;
  }
}

/** Trae un archivo de Meta. Son dos llamadas: primero la URL, luego el archivo. */
async function bajarDeMeta(mediaId) {
  const id = idLimpio(mediaId);
  const token = process.env.WHATSAPP_TOKEN;
  if (!id || !token) return null;

  const metaR = await fetch(`${GRAPH}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaR.ok) {
    console.error('[media] Meta no da la url', metaR.status);
    return null;
  }
  const meta = await metaR.json();
  if (!meta.url) return null;

  /* La URL del archivo tambien pide el token. Sin el devuelve 401. */
  const archivoR = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!archivoR.ok) {
    console.error('[media] Meta no da el archivo', archivoR.status);
    return null;
  }
  return {
    buf:  Buffer.from(await archivoR.arrayBuffer()),
    mime: meta.mime_type || 'application/octet-stream',
  };
}

/**
 * El archivo que se le muestra a quien atiende: copia propia si existe, y si
 * no, se le pide a Meta y se guarda para la proxima.
 */
async function obtener(mediaId) {
  const copia = await leerCopia(mediaId);
  if (copia && copia.buf && copia.buf.length) return copia;

  const deMeta = await bajarDeMeta(mediaId);
  if (!deMeta) return null;
  await guardarCopia(mediaId, deMeta.buf, deMeta.mime);
  return deMeta;
}

/**
 * Sube un archivo a Meta y devuelve su id, que es lo que se manda en el
 * mensaje. Guarda la copia de una, para que quien lo envio lo siga viendo en
 * la bandeja despues de los 30 dias.
 */
async function subirAMeta(buf, mime, filename) {
  const token = process.env.WHATSAPP_TOKEN;
  const phone = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phone) return { ok: false, error: 'WhatsApp no está configurado en el servidor.' };

  const tipo = tipoDeMime(mime);
  if (buf.length > TOPES[tipo]) {
    const mb = Math.round(TOPES[tipo] / 1024 / 1024);
    return { ok: false, error: `El archivo pesa demasiado. El máximo para este tipo son ${mb} MB.` };
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buf], { type: mime }), filename || 'archivo');

  const r = await fetch(`${GRAPH}/${phone}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!r.ok) {
    console.error('[media] subida fallo', r.status, (await r.text().catch(() => '')).slice(0, 200));
    return { ok: false, error: 'No se pudo subir el archivo a WhatsApp.' };
  }
  const { id } = await r.json();
  if (!id) return { ok: false, error: 'WhatsApp no devolvió el archivo.' };

  await guardarCopia(id, buf, mime);
  return { ok: true, mediaId: String(id), tipo };
}

/**
 * Manda el archivo ya subido. El pie solo lo aceptan imagen, video y
 * documento: en audio lo ignora Meta, asi que ni se envia.
 */
async function enviarArchivo(telefono, mediaId, tipo, pie, filename) {
  const token = process.env.WHATSAPP_TOKEN;
  const phone = process.env.WHATSAPP_PHONE_ID;
  const cuerpo = { messaging_product: 'whatsapp', to: telefono, type: tipo };
  const parte = { id: mediaId };
  if (pie && tipo !== 'audio') parte.caption = String(pie).slice(0, 1000);
  if (tipo === 'document') parte.filename = filename || 'documento';
  cuerpo[tipo] = parte;

  const r = await fetch(`${GRAPH}/${phone}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (r.ok) return { ok: true };

  const t = await r.text().catch(() => '');
  console.error('[media] envio fallo', r.status, t.slice(0, 300));
  /* El error mas comun y el mas confuso: WhatsApp no deja escribirle a alguien
     que lleva mas de 24h sin responder. El mensaje de Meta no lo explica. */
  if (/131047|re-?engag|24[\s-]?hour/i.test(t)) {
    return {
      ok: false,
      error: 'Pasaron más de 24 horas desde el último mensaje del cliente, ' +
             'así que WhatsApp no deja enviarle archivos. Espera a que escriba.',
    };
  }
  return { ok: false, error: 'No se pudo enviar el archivo.' };
}

/* ------------------------------------------------------------------ */
/* JSON pequeños en el mismo bucket                                     */
/* ------------------------------------------------------------------ */
/* Lo usa _push.js para las llaves y las suscripciones. Son cuatro datos y no
   justifican una tabla nueva, pero tampoco pueden vivir en el disco de
   Railway, que se borra en cada despliegue.
   No chocan con los archivos de WhatsApp porque esas rutas llevan letras y el
   endpoint de media solo acepta cifras. */
async function guardarJson(ruta, obj) {
  if (!(await asegurarBucket())) return false;
  try {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const { error } = await supabase.storage.from(BUCKET)
      .upload(ruta, buf, { contentType: 'application/json', upsert: true });
    return !error;
  } catch (e) {
    console.warn('[almacen] no se pudo guardar', ruta, e.message);
    return false;
  }
}

async function leerJson(ruta) {
  if (!(await asegurarBucket())) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(ruta);
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch (e) {
    return null;
  }
}

module.exports = { obtener, subirAMeta, enviarArchivo, tipoDeMime, idLimpio, TOPES,
                   guardarJson, leerJson };
