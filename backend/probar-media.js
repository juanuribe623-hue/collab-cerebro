/**
 * Pruebas del manejo de archivos de WhatsApp.
 *
 * Lo que cuidan:
 *  - que el id que llega por la URL no pueda salirse de su sitio
 *  - que un archivo demasiado grande se rechace ACA y no en Meta, que
 *    devuelve un error que no dice nada
 *  - que cada tipo de archivo se mande como lo que es
 *
 *   node probar-media.js
 */
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ejemplo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'llave-de-mentira';

const media = require('./routes/_media');

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log('  FALLA  ' + msg); fallos++; } else console.log('  ok     ' + msg); };

console.log('\nCada archivo se manda como lo que es');
ok(media.tipoDeMime('image/jpeg')      === 'image',    'jpeg es imagen');
ok(media.tipoDeMime('image/png')       === 'image',    'png es imagen');
ok(media.tipoDeMime('video/mp4')       === 'video',    'mp4 es video');
ok(media.tipoDeMime('audio/ogg')       === 'audio',    'ogg es audio');
ok(media.tipoDeMime('application/pdf') === 'document', 'pdf es documento');
ok(media.tipoDeMime('')                === 'document', 'sin mime, documento');
ok(media.tipoDeMime(null)              === 'document', 'mime nulo no rompe');

console.log('\nSeguridad: el id viene por la URL, o sea de afuera');
ok(media.idLimpio('../../etc/passwd') === '',       'no se puede saltar de carpeta');
ok(media.idLimpio('123/../456')       === '123456', 'las barras desaparecen');
ok(media.idLimpio('abc')              === '',       'sin cifras queda vacío, y vacío se rechaza');
ok(media.idLimpio('')                 === '',       'vacío no rompe');
ok(media.idLimpio(null)               === '',       'nulo no rompe');
ok(media.idLimpio('9'.repeat(200)).length === 40,   'un id larguísimo se topa');
ok(media.idLimpio('1234567890')       === '1234567890', 'un id normal pasa entero');

console.log('\nLos topes se aplican antes de molestar a Meta');
process.env.WHATSAPP_TOKEN    = 'token-de-mentira';
process.env.WHATSAPP_PHONE_ID = '123';

(async () => {
  const grande = Buffer.alloc(6 * 1024 * 1024);          /* 6 MB */
  const r1 = await media.subirAMeta(grande, 'image/jpeg', 'foto.jpg');
  ok(r1.ok === false, 'una imagen de 6 MB se rechaza');
  ok(/5 MB/.test(r1.error), 'y el mensaje dice cuál es el máximo: ' + JSON.stringify(r1.error));

  const r2 = await media.subirAMeta(Buffer.alloc(20 * 1024 * 1024), 'video/mp4', 'v.mp4');
  ok(r2.ok === false && /16 MB/.test(r2.error), 'un video de 20 MB se rechaza con su propio tope');

  /* El mismo peso que sobra para imagen cabe de sobra en un PDF: cada tipo
     tiene su tope y no se puede usar uno solo para todos. */
  const r3 = await media.subirAMeta(grande, 'application/pdf', 'plano.pdf');
  ok(r3.ok !== false || !/demasiado/.test(r3.error || ''),
     'esos mismos 6 MB en PDF no se rechazan por tamaño');

  console.log('\nSin configuración de WhatsApp avisa, no revienta');
  const tok = process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_TOKEN;
  const r4 = await media.subirAMeta(Buffer.alloc(10), 'image/jpeg', 'x.jpg');
  ok(r4.ok === false && /no está configurado/.test(r4.error), 'dice que falta configuración');
  process.env.WHATSAPP_TOKEN = tok;

  console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo pasa.\n');
  process.exit(fallos ? 1 : 0);
})();
