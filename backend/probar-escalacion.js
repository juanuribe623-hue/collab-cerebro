/**
 * Pruebas de la compuerta que decide si el asistente contesta.
 *
 * El bug que estas pruebas cuidan: el asistente marcaba "tomado" al escalar,
 * y "tomado" es permanente, asi que quedaba mudo con ese cliente para
 * siempre. El 29 de octubre de 2026 dos personas del equipo le escribieron a
 * Pris y no les contesto nunca por esa razon.
 *
 *   node probar-escalacion.js
 */
process.env.SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://ejemplo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'llave-de-mentira';

const { _test } = require('./routes/whatsapp');
const { razonParaCallar } = _test;

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log('  FALLA  ' + msg); fallos++; } else console.log('  ok     ' + msg); };

const AHORA   = new Date('2026-10-29T15:00:00-05:00');
const enMin   = m => new Date(AHORA.getTime() + m * 60000).toISOString();
const cfg     = { activo: true, horario: { modo: 'siempre' } };
const chat    = (x = {}) => ({ tomado: false, silencio_hasta: null, escalado_hasta: null, ...x });
const callar  = (c, ch) => razonParaCallar(c, ch, AHORA);

console.log('\nCuando el asistente SI debe contestar');
ok(callar(cfg, chat()) === null, 'chat normal');
ok(callar(cfg, chat({ escalado_hasta: enMin(-1) })) === null,
   'escalado hace un minuto que ya vencio: RETOMA, este es el bug arreglado');
ok(callar(cfg, chat({ silencio_hasta: enMin(-5) })) === null, 'silencio vencido');
ok(callar(cfg, chat({ escalado_hasta: enMin(-60 * 24 * 30) })) === null,
   'escalado hace un mes y nadie atendio: retoma igual');

console.log('\nCuando NO debe contestar');
ok(callar(cfg, chat({ tomado: true })) === 'chat tomado por una persona',
   'una persona se apropio del chat: permanente, y asi debe ser');
ok(/escalado/.test(callar(cfg, chat({ escalado_hasta: enMin(90) })) || ''),
   'escalado hace nada: espera a que llegue una persona');
ok(/silencio/.test(callar(cfg, chat({ silencio_hasta: enMin(45) })) || ''),
   'una persona acaba de escribir');
ok(callar({ ...cfg, activo: false }, chat()) === 'el asistente esta apagado', 'asistente apagado');

console.log('\nPrioridad entre razones');
ok(callar(cfg, chat({ tomado: true, escalado_hasta: enMin(-1) })) === 'chat tomado por una persona',
   'tomado manda por encima de un escalamiento vencido');
ok(/silencio/.test(callar(cfg, chat({ silencio_hasta: enMin(10), escalado_hasta: enMin(90) })) || ''),
   'si una persona escribio, esa es la razon que se reporta');

console.log('\nEl mensaje dice a que hora retoma');
/* es-CO formatea en 12 horas: 90 minutos despues de las 3:00 p.m. son las
   4:30 p.m. de Bogota, no las 21:30 UTC. */
const m = callar(cfg, chat({ escalado_hasta: enMin(90) }));
ok(/4:30/.test(m) && /p\.?\s?m/i.test(m), `dice la hora de regreso en hora de Bogota: "${m}"`);

console.log('\nHorario del bot');
ok(callar({ activo: true, horario: { modo: 'fuera_de_horario', inicio: 9, fin: 19 } }, chat())
   === 'fuera del horario del bot', 'a las 3 de la tarde de un jueves, con horario 9 a 19, calla');

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo pasa.\n');
process.exit(fallos ? 1 : 0);
