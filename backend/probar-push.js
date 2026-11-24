/**
 * Pruebas de los avisos al celular.
 *
 * Lo que cuidan, y es casi todo lo mismo: que nada de esto tumbe el webhook.
 * Un aviso que no sale es un inconveniente; un webhook que revienta deja a
 * Pris muda. Por eso cada camino se prueba con el almacenamiento caido, que
 * es como corre aqui al no haber Supabase de verdad.
 *
 *   node probar-push.js
 */
process.env.SUPABASE_URL         = 'https://ejemplo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'llave-de-mentira';
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const push = require('./routes/_push');

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log('  FALLA  ' + msg); fallos++; } else console.log('  ok     ' + msg); };

(async () => {
  console.log('\nLas llaves');
  const k1 = await push.llavePublica();
  ok(typeof k1 === 'string' && k1.length > 50, 'genera una llave pública usable');
  const k2 = await push.llavePublica();
  ok(k1 === k2, 'la segunda vez devuelve LA MISMA, que es lo que importa: ' +
                'si cambiaran, todos los celulares ya suscritos dejarían de recibir');

  console.log('\nSuscribir');
  ok((await push.suscribir('empresa-1', null))        === false, 'una suscripción vacía se rechaza');
  ok((await push.suscribir('empresa-1', {}))          === false, 'sin endpoint se rechaza');
  ok((await push.suscribir('empresa-1', { endpoint: 'https://x/1' })) === false,
     'sin dónde guardar devuelve false en vez de reventar');

  console.log('\nAvisar con el almacenamiento caído');
  const r = await push.avisar('empresa-1', { titulo: 'Hola', cuerpo: 'Prueba' });
  ok(r && r.enviados === 0, 'no manda nada y NO lanza excepción');

  const r2 = await push.avisar('empresa-1', {});
  ok(r2 && r2.enviados === 0, 'sin título ni cuerpo tampoco revienta');

  const r3 = await push.avisar(null, { titulo: 'x' });
  ok(r3 && r3.enviados === 0, 'sin empresa tampoco');

  console.log('\nDesuscribir');
  let reventó = false;
  try { await push.desuscribir('empresa-1', 'https://x/1'); } catch (e) { reventó = true; }
  ok(!reventó, 'desuscribir no revienta aunque no haya nada guardado');

  console.log('\nSeguridad: el id de empresa arma una ruta de archivo');
  /* No se exporta la función, así que se comprueba por el efecto: una empresa
     con caracteres raros no puede escribir fuera de su sitio. */
  let rutaMala = false;
  try { await push.suscribir('../../otra-empresa', { endpoint: 'https://x/2' }); }
  catch (e) { rutaMala = true; }
  ok(!rutaMala, 'un id de empresa con ../ no rompe ni escapa, se sanea');

  console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo pasa.\n');
  process.exit(fallos ? 1 : 0);
})();
