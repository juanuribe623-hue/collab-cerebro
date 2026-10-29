/**
 * Catalogo de Shopify, para que el asistente pueda mostrar producto en vez de
 * prometer que alguien mas lo hara.
 *
 * Dos caminos, y el primero que haya es el que se usa:
 *
 *   1. Storefront API (si hay token). Es la via oficial: limites documentados,
 *      no la bloquean, y ademas sabe en cual de las tiendas fisicas esta cada
 *      pieza, que es lo que de verdad le sirve al cliente.
 *   2. /products.json (sin token). El JSON publico que usa la tienda para
 *      pintarse. Sirve de respaldo, pero Shopify bloquea a los clientes que no
 *      son un navegador: probado contra la tienda real, el navegador recibia
 *      200 y el servidor 429 en el mismo segundo.
 *
 * El token NUNCA va en la base ni en el codigo: va en una variable de entorno,
 * y la configuracion de la empresa solo dice como se llama esa variable.
 *
 * Todo lo que sale de aqui pasa por limpio(), porque termina dentro del prompt
 * del modelo y el titulo de un producto lo escribe una persona: no queremos que
 * un nombre de prenda se convierta en una instruccion.
 *
 * Dos limites que el que lea esto debe tener presentes:
 *   1. Es el inventario que Shopify conoce. Hay producto en sala que nunca se
 *      subio a la tienda.
 *   2. "disponible" tambien es cierto cuando la tienda permite vender sin
 *      stock. No es una garantia. El asistente ofrece, nunca promete.
 */

const TTL_MS      = 30 * 60 * 1000;  /* el catalogo de moda se mueve, pero no cada minuto */
const TIMEOUT_MS  = 15000;
const REINTENTOS  = 5;
const ESPERA_MAX  = 30000;

/* Storefront API */
const VERSION_API  = '2026-01';
const POR_PAGINA   = 100;
const VARIANTES    = 50;             /* ninguna prenda de esta casa tiene mas */
const MAX_PAGINAS  = 60;             /* 60 x 100 = 6.000 productos, techo de seguridad */
/* Una pagina de 100 productos cuesta 226 puntos (medido). El balde se rellena
   a 100 por segundo, asi que menos de dos segundos entre paginas se gana un
   THROTTLED. Como esto corre por detras, se va con calma. */
const PAUSA_GQL_MS = 2500;

/* La Storefront traduce los nombres de opcion al idioma de quien pregunta.
   Sin este header "Talla" llega como "Size" y el emparejamiento de tallas se
   cae en silencio. Comprobado contra la tienda real. */
const IDIOMA = 'es-CO';

/* products.json, el respaldo */
const POR_PAGINA_JSON = 250;
const PAUSA_JSON_MS   = 1500;        /* aqui si hay que ir despacio o cae el 429 */
const UA = 'CollabCerebro/1.0 (asistente WhatsApp; +https://collab.com.co)';

const dormir = ms => new Promise(r => setTimeout(r, ms));

/* Cuanto puede esperar un cliente de WhatsApp a que cargue el catalogo la
   primera vez. Mas que esto se siente abandono. */
const ESPERA_CLIENTE_MS = 12000;

const cache   = new Map();  /* dominio -> { ts, productos, via } */
const enVuelo = new Map();  /* dominio -> Promise, para no pedir lo mismo dos veces a la vez */
const fallido = new Set();  /* dominios que ya no cargan ni reintentando */

/* ------------------------------------------------------------------ */
/* Normalizacion                                                       */
/* ------------------------------------------------------------------ */

const sinTildes = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/* Todo lo que viene de Shopify pasa por aqui antes de tocar el prompt:
   sin caracteres de control, sin saltos de linea, con tope de largo. */
const limpio = (s, max = 120) => String(s || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const TALLAS = {
  xs: 'xs', s: 's', small: 's', m: 'm', medium: 'm', l: 'l', large: 'l',
  xl: 'xl', xxl: 'xxl', u: 'unica', unica: 'unica', uni: 'unica', ut: 'unica',
};

/** "Talla S" -> "s", "38" -> "38", "Unica" -> "unica". */
function normTalla(t) {
  const x = sinTildes(t).replace(/^talla\s*/, '').replace(/\s+/g, '');
  if (!x) return '';
  if (TALLAS[x]) return TALLAS[x];
  return x;  /* numericas (36, 38, 8, 10) y combinadas (m/l) se dejan como vienen */
}

/* El nombre de la opcion lo escribe una persona, asi que esta mal escrito a
   veces: en este catalogo conviven "Talla", "TALLA", "Talla ", "Taller",
   "Tamano", "Tamano de accesorio", "Talla del calzado", "Color", "COLOR" y
   hasta "Color" con tilde. Por eso se compara por prefijo y sin tildes.
   Y se acepta "size" porque la Storefront API traduce los nombres segun el
   idioma de quien pregunta: sin pedirlo en espanol, "Talla" llega como
   "Size". Lo pedimos en espanol (ver IDIOMA mas abajo), pero si algun dia
   ese header se pierde, aqui no se rompe nada. */
const esNombreDe = (nombre, tipo) => {
  const n = sinTildes(nombre);
  return tipo === 'talla'
    ? (n.startsWith('tall') || n.includes('tamano') || n.startsWith('size'))
    : (n.startsWith('color') || n.startsWith('colour'));
};

function indiceOpcion(options, tipo) {
  return (options || []).findIndex(o => esNombreDe(typeof o === 'string' ? o : o && o.name, tipo));
}

/** Arma la ficha comun a partir de campos ya extraidos, venga de donde venga. */
function ficha({ handle, titulo, marca, tags, imagen, publicado, variantes }) {
  const disponibles = variantes.filter(v => v.disponible);
  return {
    handle: String(handle || ''),
    titulo: limpio(titulo, 90),
    marca:  limpio(marca, 50),
    tags:   (tags || []).map(t => sinTildes(t)).filter(Boolean).slice(0, 30),
    imagen: imagen || null,
    desde:  new Date(publicado || 0).getTime() || 0,
    variantes,
    disponibles,
    precioMin: disponibles.length ? Math.min(...disponibles.map(v => v.precio)) : null,
  };
}

/** Forma de /products.json: las opciones son option1, option2, option3. */
function normalizar(p) {
  const iTalla = indiceOpcion(p.options, 'talla');
  const iColor = indiceOpcion(p.options, 'color');
  const valor  = (v, i) => (i >= 0 ? v['option' + (i + 1)] : null);

  return ficha({
    handle: p.handle, titulo: p.title, marca: p.vendor, tags: p.tags,
    imagen: (p.images && p.images[0] && p.images[0].src) || null,
    publicado: p.published_at || p.created_at,
    variantes: (p.variants || []).map(v => ({
      id:         null,   /* products.json no da el id global, no hay sedes por este camino */
      talla:      normTalla(valor(v, iTalla)),
      color:      sinTildes(valor(v, iColor)),
      precio:     Math.round(Number(v.price) || 0),
      disponible: Boolean(v.available),
    })),
  });
}

/** Forma de la Storefront API: cada variante trae sus opciones con nombre. */
function normalizarGQL(p) {
  const opcion = (v, tipo) => {
    const o = (v.selectedOptions || []).find(x => esNombreDe(x.name, tipo));
    return o ? o.value : null;
  };
  return ficha({
    handle: p.handle, titulo: p.title, marca: p.vendor, tags: p.tags,
    imagen: p.featuredImage && p.featuredImage.url,
    publicado: p.publishedAt,
    variantes: ((p.variants && p.variants.nodes) || []).map(v => ({
      id:         v.id || null,
      talla:      normTalla(opcion(v, 'talla')),
      color:      sinTildes(opcion(v, 'color')),
      precio:     Math.round(Number(v.price && v.price.amount) || 0),
      disponible: Boolean(v.availableForSale),
      cantidad:   Number.isFinite(v.quantityAvailable) ? v.quantityAvailable : null,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Configuracion y validacion                                          */
/* ------------------------------------------------------------------ */

/* El dominio sale de la configuracion de la empresa, no del mensaje del
   cliente, pero igual se valida: sin esto un dominio mal puesto convierte
   al servidor en un cliente HTTP hacia donde sea. */
function dominioValido(d) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(String(d || ''));
}

/* La configuracion guarda el NOMBRE de la variable de entorno, no el token.
   Asi el secreto vive solo en Railway y la base se puede leer sin riesgo. */
function tokenDe(cfgCatalogo) {
  const nombre = (cfgCatalogo && cfgCatalogo.token_env) || 'SHOPIFY_STOREFRONT_TOKEN';
  if (!/^[A-Z][A-Z0-9_]*$/.test(nombre)) return null;
  return process.env[nombre] || null;
}

/* ------------------------------------------------------------------ */
/* Carga por la Storefront API                                         */
/* ------------------------------------------------------------------ */

/* quantityAvailable necesita el permiso de inventario y, si falta, Shopify no
   devuelve el campo vacio: tumba la consulta entera y nos quedamos sin
   catalogo. Como el dato es un lujo ("queda una sola") y no un requisito, se
   pide aparte y se puede quitar sin que nada mas se caiga. */
const qProductos = conCantidad => `
query Catalogo($cursor: String) {
  products(first: ${POR_PAGINA}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      handle
      title
      vendor
      tags
      publishedAt
      featuredImage { url }
      variants(first: ${VARIANTES}) {
        nodes {
          id
          availableForSale${conCantidad ? '\n          quantityAvailable' : ''}
          price { amount }
          selectedOptions { name value }
        }
      }
    }
  }
}`;

const Q_SEDES = `
query Sedes($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      storeAvailability(first: 10) {
        nodes { available location { name } }
      }
    }
  }
}`;

async function gql(dominio, token, query, variables) {
  let ultimoError;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`https://${dominio}/api/${VERSION_API}/graphql.json`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'accept-language': IDIOMA,
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (r.status === 430 || r.status === 429 || r.status >= 500) {
        ultimoError = new Error(`Storefront ${r.status}`);
        await dormir(Math.min(1000 * Math.pow(2, intento), ESPERA_MAX));
        continue;
      }
      if (!r.ok) {
        /* 401/403 = token malo o sin permisos. Reintentar no arregla eso. */
        throw new Error(`Storefront ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }

      const j = await r.json();
      if (j.errors && j.errors.length) {
        const msg = j.errors.map(e => e.message).join('; ').slice(0, 300);
        /* THROTTLED llega con 200 y errores adentro: eso si vale reintentarlo. */
        if (/throttl/i.test(msg)) {
          ultimoError = new Error('Storefront throttled');
          await dormir(Math.min(2000 * Math.pow(2, intento), ESPERA_MAX));
          continue;
        }
        throw new Error(`Storefront: ${msg}`);
      }
      return j.data;
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      ultimoError = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw ultimoError || new Error('Storefront no respondio');
}

async function cargarPorAPI(dominio, token) {
  const productos = [];
  let cursor = null;
  let conCantidad = true;

  for (let p = 0; p < MAX_PAGINAS; p++) {
    if (p > 0) await dormir(PAUSA_GQL_MS);

    let d;
    try {
      d = await gql(dominio, token, qProductos(conCantidad), { cursor });
    } catch (e) {
      /* Al token le falta el permiso de inventario. Se sigue sin ese campo en
         vez de quedarse sin catalogo, y se avisa para que alguien lo arregle. */
      if (conCantidad && /quantityAvailable/i.test(e.message)) {
        console.warn(`[catalogo] ${dominio}: el token no tiene permiso de inventario, ` +
                     'sigo sin las cantidades. Falta unauthenticated_read_product_inventory.');
        conCantidad = false;
        d = await gql(dominio, token, qProductos(false), { cursor });
      } else {
        throw e;
      }
    }

    const page = d && d.products;
    if (!page) break;
    productos.push(...(page.nodes || []).map(normalizarGQL));
    if (!page.pageInfo || !page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return productos.filter(p => p.handle && p.titulo);
}

/**
 * En que tiendas fisicas esta cada variante. Se pregunta solo por las piezas
 * que se le van a mostrar al cliente, no por las dos mil del catalogo: pedir
 * esto para todo seria carisimo y casi todo se descartaria.
 *
 * Si falla, se devuelve vacio y el asistente sigue sin el dato. Saber en que
 * sede esta es un lujo, no un requisito.
 */
async function sedesDe(dominio, token, ids) {
  if (!token || !ids.length) return new Map();
  try {
    const d = await gql(dominio, token, Q_SEDES, { ids: ids.slice(0, 10) });
    const mapa = new Map();
    for (const n of (d && d.nodes) || []) {
      if (!n || !n.id || !n.storeAvailability) continue;
      mapa.set(n.id, (n.storeAvailability.nodes || [])
        .filter(s => s.available && s.location && s.location.name)
        .map(s => limpio(s.location.name, 40)));
    }
    return mapa;
  } catch (e) {
    console.error('[catalogo] sedes:', e.message);
    return new Map();
  }
}

/* ------------------------------------------------------------------ */
/* Carga por products.json (respaldo, sin token)                       */
/* ------------------------------------------------------------------ */

async function traerPaginaJson(dominio, pagina) {
  let ultimoError;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(
        `https://${dominio}/products.json?limit=${POR_PAGINA_JSON}&page=${pagina}`,
        { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': UA } },
      );
      if (r.status === 429 || r.status >= 500) {
        const espera = Number(r.headers.get('retry-after')) * 1000 || PAUSA_JSON_MS * Math.pow(2, intento + 1);
        ultimoError = new Error(`Shopify ${r.status}`);
        await dormir(Math.min(espera, ESPERA_MAX));
        continue;
      }
      if (!r.ok) throw new Error(`Shopify ${r.status}`);
      const j = await r.json();
      return Array.isArray(j.products) ? j.products : [];
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      ultimoError = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw ultimoError || new Error('Shopify no respondio');
}

async function cargarPorJson(dominio) {
  const crudos = [];
  for (let p = 1; p <= 20; p++) {
    if (p > 1) await dormir(PAUSA_JSON_MS);
    const lote = await traerPaginaJson(dominio, p);
    crudos.push(...lote);
    if (lote.length < POR_PAGINA_JSON) break;
  }
  return crudos.map(normalizar).filter(p => p.handle && p.titulo);
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function refrescar(dominio, token) {
  if (enVuelo.has(dominio)) return enVuelo.get(dominio);
  const anterior = cache.get(dominio);
  const via = token ? 'Storefront API' : 'products.json';

  const promesa = (token ? cargarPorAPI(dominio, token) : cargarPorJson(dominio))
    .then(productos => {
      if (!productos.length) throw new Error('el catalogo vino vacio');
      cache.set(dominio, { ts: Date.now(), productos, via });
      fallido.delete(dominio);
      console.log(`[catalogo] ${dominio}: ${productos.length} productos via ${via}`);
      return productos;
    })
    .catch(e => {
      /* Si falla la recarga pero habia algo cacheado, es mejor dato viejo que
         ninguno: el asistente queda mudo si no le devolvemos nada. */
      if (anterior) {
        console.error(`[catalogo] ${dominio} fallo, sigo con lo que tenia:`, e.message);
        cache.set(dominio, { ...anterior, ts: Date.now() - TTL_MS + 60000 });
        return anterior.productos;
      }
      throw e;
    })
    .finally(() => enVuelo.delete(dominio));

  enVuelo.set(dominio, promesa);
  return promesa;
}

/**
 * Catalogo vigente del dominio.
 *
 * Cargarlo entero toma su tiempo, y el cliente esta esperando en WhatsApp. Por
 * eso cuando el cache esta vencido se devuelve lo viejo de una y se refresca
 * por detras: media hora de desfase en un catalogo de moda no le cambia la
 * vida a nadie, veinte segundos de silencio si.
 */
async function catalogoDe(dominio, token) {
  if (!dominioValido(dominio)) throw new Error('Dominio de catalogo invalido');
  const hit = cache.get(dominio);
  if (hit) {
    if (Date.now() - hit.ts >= TTL_MS) refrescar(dominio, token).catch(() => {});
    return hit.productos;
  }
  return refrescar(dominio, token);  /* primera vez: toca esperar */
}

/**
 * Si vale la pena ofrecerle la herramienta de busqueda al asistente.
 *
 * Al principio esto exigia catalogo ya cargado, y resulto peor el remedio:
 * durante el minuto que tarda en cargar despues de cada despliegue, el
 * asistente se quedaba sin la herramienta, pero el prompt le sigue diciendo
 * que muestre producto. Entonces decia "dejame busco lo que tenemos" y no
 * buscaba nada, porque no tenia con que. Paso de verdad el 29 de octubre.
 *
 * Ahora solo se niega cuando el catalogo ya se dio por vencido. Mientras
 * carga se ofrece igual, y buscarEnTienda espera un rato razonable.
 */
const sirveLaBusqueda = dominio => Boolean(dominio) && !fallido.has(dominio);

/**
 * Se llama al arrancar, para que el primer cliente no pague la espera.
 * Un fallo no es definitivo: se reintenta unas cuantas veces espaciadas.
 */
function precalentar(cfgCatalogo, intento = 0) {
  const dominio = cfgCatalogo && cfgCatalogo.shopify;
  if (!dominioValido(dominio)) return Promise.resolve();
  const token = tokenDe(cfgCatalogo);
  if (!token) {
    console.warn(`[catalogo] ${dominio} sin token de Storefront, voy por products.json ` +
                 '(Shopify suele bloquear este camino desde un servidor)');
  }
  return refrescar(dominio, token).catch(e => {
    console.error(`[catalogo] no pude precalentar ${dominio} (intento ${intento + 1}):`, e.message);
    if (intento < 4) {
      const espera = 5 * 60000 * (intento + 1);
      console.log(`[catalogo] reintento en ${espera / 60000} min`);
      setTimeout(() => precalentar(cfgCatalogo, intento + 1), espera).unref();
    } else {
      fallido.add(dominio);
      console.error(`[catalogo] ${dominio} no carga. El asistente queda sin la herramienta de busqueda.`);
    }
  });
}

/* Para que el cliente no se quede esperando a que baje el catalogo entero.
   La carga sigue por detras: lo que se abandona es la espera, no el trabajo. */
const conTiempo = (promesa, ms) => Promise.race([
  promesa,
  new Promise((_, rechazar) => {
    const t = setTimeout(() => rechazar(new Error('CATALOGO_CARGANDO')), ms);
    if (t.unref) t.unref();
  }),
]);

/* ------------------------------------------------------------------ */
/* Busqueda                                                            */
/* ------------------------------------------------------------------ */

/* Palabras que no distinguen nada y solo meten ruido en el puntaje. */
const VACIAS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'para', 'con',
  'por', 'que', 'en', 'y', 'o', 'mi', 'me', 'al', 'del', 'algo', 'tipo',
  'quiero', 'busco', 'necesito', 'tienen', 'tienes', 'hay', 'ropa',
]);

const palabras = s => sinTildes(s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !VACIAS.has(w));

/**
 * Filtra y ordena. Solo devuelve productos con al menos una variante
 * disponible que cumpla talla, color y presupuesto pedidos.
 */
function buscar(productos, f) {
  const claves    = palabras(f.texto);
  const talla     = normTalla(f.talla);
  const color     = sinTildes(f.color);
  const precioMax = Number(f.precioMax) > 0 ? Number(f.precioMax) : null;
  const precioMin = Number(f.precioMin) > 0 ? Number(f.precioMin) : null;

  const resultados = [];

  for (const p of productos) {
    /* Variantes que sirven: disponibles y dentro de lo que pidio el cliente. */
    const sirven = p.disponibles.filter(v => {
      if (color && v.color && !v.color.includes(color)) return false;
      if (precioMax && v.precio > precioMax) return false;
      if (precioMin && v.precio < precioMin) return false;
      if (!talla) return true;
      /* La talla unica sirve para cualquier pedido de talla: un accesorio o
         una prenda de talla unica le queda a quien pidio S. */
      return v.talla === talla || v.talla === 'unica' || !v.talla;
    });
    if (!sirven.length) continue;

    /* El puntaje del texto se cuenta aparte, porque es el que decide si el
       producto tiene algo que ver con lo que pidieron. Sumarle los puntos de
       talla antes de ese filtro hacia que un arete de talla unica entrara en
       una busqueda de vestidos solo por existir. */
    let puntajeTexto = 0;
    const titulo = sinTildes(p.titulo);
    const marca  = sinTildes(p.marca);
    for (const k of claves) {
      if (p.tags.includes(k))                   puntajeTexto += 4;  /* etiqueta exacta: "vestidos" */
      else if (p.tags.some(t => t.includes(k))) puntajeTexto += 2;
      if (titulo.includes(k))                   puntajeTexto += 3;
      if (marca.includes(k))                    puntajeTexto += 2;
    }
    if (claves.length && puntajeTexto === 0) continue;  /* pidio algo concreto y no se parece en nada */

    let puntaje = puntajeTexto;
    if (talla) {
      puntaje += sirven.some(v => v.talla === talla) ? 4 : 1;  /* exacta pesa mas que unica */
    }
    if (color && sirven.some(v => v.color && v.color.includes(color))) puntaje += 3;

    resultados.push({ p, sirven, puntaje });
  }

  /* A igual puntaje, lo mas nuevo primero: en moda eso es lo que vale. */
  resultados.sort((a, b) => b.puntaje - a.puntaje || b.p.desde - a.p.desde);
  return resultados;
}

const pesos = n => '$' + new Intl.NumberFormat('es-CO').format(Math.round(n));

function linkDe(dominio, handle, utm) {
  const u = new URLSearchParams({
    utm_source:   'whatsapp',
    utm_medium:   'asistente',
    utm_campaign: (utm && utm.campaign) || 'asistente-whatsapp',
    utm_content:  'catalogo',
    utm_term:     handle,
  });
  return `https://${dominio}/products/${handle}?${u}`;
}

/**
 * Lo que el asistente ve. Texto corto y plano: el modelo no necesita el JSON
 * completo y cada campo de mas es una oportunidad de que invente.
 */
function paraElModelo(items) {
  const lineas = items.map((it, i) => {
    const tallas = it.tallas.join(', ');
    return `${i + 1}. ${it.titulo} | ${it.marca} | ${pesos(it.precio)}` +
           (tallas ? ` | tallas ${tallas}` : '') +
           (it.sedes && it.sedes.length ? ` | esta en: ${it.sedes.join(', ')}` : '');
  });
  const haySedes = items.some(it => it.sedes && it.sedes.length);
  return [
    `Encontre ${items.length}:`,
    ...lineas,
    '',
    'Las fotos de estos se le envian solas al cliente despues de tu mensaje, con nombre, precio y link.',
    'Presentalos en una o dos lineas, sin repetir precios ni links, y pregunta cual le gusta.',
    haySedes
      ? 'Si el cliente pregunta donde verlo, dile en que sede esta, que es dato de Shopify.'
      : 'No tienes el dato de en que sede esta cada pieza en esta busqueda.',
    'Ojo: que aparezca disponible no es garantia. No prometas que esta,',
    'di que lo confirmas antes de que venga. Y hay producto en tienda que no esta aqui.',
  ].join('\n');
}

/**
 * Punto de entrada unico para el asistente.
 * Devuelve { items, texto }; items va vacio si no hubo nada.
 */
async function buscarEnTienda(cfgCatalogo, filtros) {
  const dominio = cfgCatalogo && cfgCatalogo.shopify;
  if (!dominio) throw new Error('La empresa no tiene catalogo configurado');
  const token = tokenDe(cfgCatalogo);

  let productos;
  try {
    productos = await conTiempo(catalogoDe(dominio, token), ESPERA_CLIENTE_MS);
  } catch (e) {
    if (e.message !== 'CATALOGO_CARGANDO') throw e;
    /* Primera busqueda despues de un despliegue: el catalogo todavia esta
       bajando. Se le dice al modelo la verdad para que diga algo util en vez
       de prometer una busqueda que no ocurrio. */
    console.warn(`[catalogo] ${dominio} todavia cargando, el cliente no espera mas`);
    return {
      items: [],
      texto: 'El catalogo todavia se esta cargando, no alcance a traer las opciones. ' +
             'No digas que vas a buscar ni que ya buscaste. Preguntale algo util ' +
             'mientras tanto, como el color o la ocasion, y con eso vuelves a buscar ' +
             'en tu siguiente mensaje.',
    };
  }

  const crudos = buscar(productos, filtros).slice(0, 3);

  if (!crudos.length) {
    return {
      items: [],
      texto: 'No hay nada con esas caracteristicas. Eso no quiere decir que no ' +
             'haya en la tienda: no todo el producto de sala esta cargado. ' +
             'Ofrecele buscar algo parecido, o pasa la conversacion a una ' +
             'persona para que revise en sala.',
    };
  }

  /* Se pregunta por las sedes de la variante mas barata de cada pieza, que es
     la que se le muestra al cliente. Si no hay token o falla, viene vacio. */
  const idsMostrados = crudos
    .map(({ sirven }) => sirven.slice().sort((a, b) => a.precio - b.precio)[0])
    .map(v => v && v.id).filter(Boolean);
  const sedes = await sedesDe(dominio, token, idsMostrados);

  const items = crudos.map(({ p, sirven }) => {
    const barata = sirven.slice().sort((a, b) => a.precio - b.precio)[0];
    return {
      titulo: p.titulo,
      marca:  p.marca,
      precio: barata.precio,
      tallas: [...new Set(sirven.map(v => v.talla).filter(Boolean))],
      sedes:  (barata.id && sedes.get(barata.id)) || [],
      imagen: p.imagen,
      url:    linkDe(dominio, p.handle, cfgCatalogo.utm),
    };
  });

  return { items, texto: paraElModelo(items) };
}

module.exports = { buscarEnTienda, precalentar, sirveLaBusqueda, pesos };

/* Expuesto para probar la logica pura sin red ni base de datos. */
module.exports._test = {
  normalizar, normalizarGQL, buscar, normTalla, indiceOpcion,
  dominioValido, tokenDe, limpio, palabras,
};
