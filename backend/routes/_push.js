/**
 * Avisos al celular de quien atiende.
 *
 * Sirve para una sola cosa: que Gabi se entere cuando la necesitan, aunque
 * tenga la bandeja cerrada. Mientras la tenga abierta ya se refresca sola.
 *
 * Dos decisiones que conviene entender antes de tocar esto:
 *
 * LAS LLAVES. El navegador exige un par de llaves VAPID y tienen que ser
 * SIEMPRE LAS MISMAS: si cambian, todos los celulares ya suscritos dejan de
 * recibir avisos y hay que volver a pedirle permiso a cada persona. Por eso no
 * se generan en cada arranque. Se leen de las variables de entorno, y si no
 * estan, se generan una vez y se guardan en Supabase, nunca en disco, porque
 * el de Railway se borra en cada despliegue.
 *
 * CUANDO SE AVISA. Solo cuando de verdad hace falta una persona. El asistente
 * contesta casi todo, asi que avisar de cada mensaje seria ruido y en dos dias
 * nadie miraria el celular.
 */
const webpush = require('web-push');
const { guardarJson, leerJson } = require('./_media');

const RUTA_LLAVES = '_push/vapid.json';
const rutaSubs = companyId => `_push/subs-${String(companyId).replace(/[^a-zA-Z0-9-]/g, '')}.json`;

let llavesCache = null;

async function llaves() {
  if (llavesCache) return llavesCache;

  const pub = process.env.VAPID_PUBLIC_KEY;
  const prv = process.env.VAPID_PRIVATE_KEY;
  if (pub && prv) {
    llavesCache = { publicKey: pub, privateKey: prv, origen: 'entorno' };
  } else {
    const guardadas = await leerJson(RUTA_LLAVES);
    if (guardadas && guardadas.publicKey && guardadas.privateKey) {
      llavesCache = { ...guardadas, origen: 'supabase' };
    } else {
      const nuevas = webpush.generateVAPIDKeys();
      const ok = await guardarJson(RUTA_LLAVES, nuevas);
      llavesCache = { ...nuevas, origen: ok ? 'generadas' : 'en memoria' };
      if (!ok) {
        /* Sin donde guardarlas, al proximo arranque serian otras y las
           suscripciones de hoy quedarian muertas. Mejor decirlo fuerte. */
        console.error('[push] no se pudieron guardar las llaves VAPID. ' +
          'Pon VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY como variables de entorno ' +
          'o los avisos dejaran de llegar en el proximo despliegue.');
      }
    }
  }

  webpush.setVapidDetails(
    process.env.VAPID_CONTACTO || 'mailto:hola@collabstudiosas.com',
    llavesCache.publicKey, llavesCache.privateKey);
  console.log('[push] llaves VAPID listas, origen:', llavesCache.origen);
  return llavesCache;
}

/** La llave publica es la unica que ve el navegador. */
async function llavePublica() {
  return (await llaves()).publicKey;
}

const mismaSub = (a, b) => a && b && a.endpoint === b.endpoint;

async function suscribir(companyId, sub) {
  if (!sub || !sub.endpoint) return false;
  await llaves();
  const ruta = rutaSubs(companyId);
  const subs = (await leerJson(ruta)) || [];
  /* Un mismo celular que vuelve a dar permiso manda el mismo endpoint: se
     reemplaza en vez de duplicar, para no mandarle el aviso dos veces. */
  const otras = subs.filter(s => !mismaSub(s, sub));
  otras.push(sub);
  return guardarJson(ruta, otras.slice(-20));
}

async function desuscribir(companyId, endpoint) {
  const ruta = rutaSubs(companyId);
  const subs = (await leerJson(ruta)) || [];
  return guardarJson(ruta, subs.filter(s => s.endpoint !== endpoint));
}

/**
 * Manda el aviso a todos los celulares registrados de esa empresa.
 *
 * Los que respondan 404 o 410 estan muertos (la persona desinstalo la app o
 * revoco el permiso) y se borran solos. Sin esta limpieza la lista crece para
 * siempre y cada aviso tarda mas.
 */
async function avisar(companyId, { titulo, cuerpo, url }) {
  try {
    await llaves();
    const ruta = rutaSubs(companyId);
    const subs = (await leerJson(ruta)) || [];
    if (!subs.length) return { enviados: 0 };

    const carga = JSON.stringify({
      title: String(titulo || 'Casa Precis').slice(0, 80),
      body:  String(cuerpo || '').slice(0, 160),
      url:   url || '/?v=wa',
    });

    const vivos = [];
    let enviados = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(s, carga);
        vivos.push(s); enviados++;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) continue;      /* muerta, se descarta */
        console.warn('[push] fallo un envio', code || e.message);
        vivos.push(s);                                   /* fallo pasajero, se conserva */
      }
    }
    if (vivos.length !== subs.length) await guardarJson(ruta, vivos);
    return { enviados };
  } catch (e) {
    console.error('[push] avisar:', e.message);
    return { enviados: 0 };
  }
}

module.exports = { llavePublica, suscribir, desuscribir, avisar };
