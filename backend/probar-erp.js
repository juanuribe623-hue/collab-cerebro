/**
 * Pruebas del webhook del ERP, sin red ni base de datos.
 *
 *   node probar-erp.js
 */
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ejemplo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'llave-de-mentira';
process.env.ERP_WEBHOOK_USER = 'myprocess';
process.env.ERP_WEBHOOK_PASS = 'clave-de-prueba';

const { _test } = require('./routes/erp');
const { tipoDe, normBodega, aFecha, aNumero, limpio, autorizado } = _test;

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log('  FALLA  ' + msg); fallos++; } else console.log('  ok     ' + msg); };

console.log('\nTipo de movimiento');
ok(tipoDe({ tipoDocId: 'FCP', nroDocumento: 123, bodegaId: 1 }) === 'compra',   'factura de compra');
ok(tipoDe({ tipoDocId: 'FVE', nroDocumento: 123, bodegaId: 1 }) === 'venta',    'factura de venta');
ok(tipoDe({ tipoDocId: '',    nroDocumento: 0,   bodegaId: 1 }) === 'inventario', 'traslado entre bodegas');
ok(tipoDe({ tipoDocId: '',    nroDocumento: 0,   bodegaId: 0 }) === 'producto', 'alta de referencia');

console.log('\nCodigos de bodega (el mapa que mando Juan Manuel)');
const mapa = { '001':'79','002':'79','003':'109','004':'109','018':'cartagena','019':'cartagena','020':'web' };
const sede = v => mapa[normBodega(v)] || null;
ok(sede('1')   === '79',        'bodegaId 1 sin ceros es la 79');
ok(sede('002') === '79',        'la consignacion de la 79 tambien es la 79');
ok(sede(3)     === '109',       'numero en vez de texto');
ok(sede('004') === '109',       'consignacion de la 109');
ok(sede('019') === 'cartagena', 'Cartagena propia');
ok(sede('018') === 'cartagena', 'Cartagena consignacion');
ok(sede('020') === 'web',       'bodega de la pagina web');
ok(sede('999') === null,        'una bodega que no conocemos no se inventa');
ok(normBodega('') === null && normBodega(null) === null, 'bodega vacia');

console.log('\nFechas al estilo myProcess');
ok(aFecha('29/01/2025 12:00:00 a. m.').startsWith('2025-01-29'),
   '"29/01/2025 12:00:00 a. m." se lee como 29 de enero, no como 1 de septiembre');
ok(aFecha('2026-06-30').startsWith('2026-06-30'), 'formato ISO tambien sirve');
ok(aFecha('') === null && aFecha('basura') === null, 'una fecha ilegible queda en null, no en una fecha inventada');

console.log('\nNumeros y texto');
ok(aNumero('150000.00') === 150000, 'valor con decimales');
ok(aNumero('1,059,160.01') === 1059160.01, 'valor con separador de miles');
ok(aNumero('') === null && aNumero('abc') === null, 'lo que no es numero queda en null');
ok(limpio('PRODUCTO\u0000 CON\nBASURA') === 'PRODUCTO CON BASURA', 'se limpia el texto');
ok(limpio('x'.repeat(500)).length === 200, 'el texto se recorta');
ok(limpio('') === null, 'texto vacio queda en null');

console.log('\nAutenticacion');
const cab = (u, p) => ({ headers: { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') } });
ok(autorizado(cab('myprocess', 'clave-de-prueba')) === true,  'usuario y clave correctos');
ok(autorizado(cab('myprocess', 'otra')) === false,            'clave equivocada');
ok(autorizado(cab('otro', 'clave-de-prueba')) === false,      'usuario equivocado');
ok(autorizado({ headers: {} }) === false,                     'sin cabecera');
ok(autorizado({ headers: { authorization: 'Bearer abc' } }) === false, 'con el esquema equivocado');
ok(autorizado({ headers: { authorization: 'Basic no-es-base64-valido!!' } }) === false, 'base64 corrupto');

const u = process.env.ERP_WEBHOOK_USER, p = process.env.ERP_WEBHOOK_PASS;
delete process.env.ERP_WEBHOOK_USER; delete process.env.ERP_WEBHOOK_PASS;
ok(autorizado(cab('myprocess', 'clave-de-prueba')) === false,
   'sin clave configurada el endpoint queda CERRADO, no abierto');
process.env.ERP_WEBHOOK_USER = u; process.env.ERP_WEBHOOK_PASS = p;

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo pasa.\n');
process.exit(fallos ? 1 : 0);
