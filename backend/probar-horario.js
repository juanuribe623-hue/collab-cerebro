/**
 * Pruebas del horario de la persona que atiende.
 *
 * Lo que cuidan: que el asistente no prometa "en un momento te responde Gabi"
 * un domingo a las nueve de la noche. Y que el fin de semana tenga su propia
 * ventana, que la forma vieja no soportaba: daba sabado y domingo por libres.
 *
 *   node probar-horario.js
 */
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://ejemplo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'llave-de-mentira';

const { _test } = require('./routes/whatsapp');
const { hayHumano, proximaApertura, botDebeResponder, textoDeHorario } = _test;

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log('  FALLA  ' + msg); fallos++; } else console.log('  ok     ' + msg); };

/* El horario real de Gabi: lunes a viernes 8 a 5, sabados y domingos 11 a 5. */
const GABI = {
  modo: 'ventanas',
  ventanas: { 1: [8, 17], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 17],
              6: [11, 17], 0: [11, 17] },
};

/* Bogota es UTC-5 todo el año, asi que la hora de Bogota + 5 da la UTC. */
const enBogota = (dia, hora) => new Date(Date.UTC(2026, 10, dia, hora + 5, 0, 0));

/* Noviembre de 2026: el 23 es lunes, el 28 sabado, el 29 domingo. */
const LUN = 23, MAR = 24, VIE = 27, SAB = 28, DOM = 29;

console.log('\nLos dias se corresponden con lo que creemos');
['domingo','lunes','martes','miércoles','jueves','viernes','sábado'].forEach(() => {});
ok(enBogota(LUN, 12).getUTCDay() === 1, 'el 23 de noviembre de 2026 es lunes');
ok(enBogota(SAB, 12).getUTCDay() === 6, 'el 28 es sábado');
ok(enBogota(DOM, 12).getUTCDay() === 0, 'el 29 es domingo');

console.log('\nEntre semana, 8 a 5');
ok(hayHumano(GABI, enBogota(MAR, 10)), 'martes 10am: Gabi está');
ok(hayHumano(GABI, enBogota(MAR, 8)),  'martes 8am en punto: ya está');
ok(!hayHumano(GABI, enBogota(MAR, 7)), 'martes 7am: todavía no');
ok(!hayHumano(GABI, enBogota(MAR, 17)), 'martes 5pm en punto: ya salió');
ok(!hayHumano(GABI, enBogota(MAR, 21)), 'martes 9pm: no está');

console.log('\nFin de semana, 11 a 5: esto no existía antes');
ok(!hayHumano(GABI, enBogota(SAB, 10)), 'sábado 10am: todavía no');
ok(hayHumano(GABI, enBogota(SAB, 12)),  'sábado mediodía: sí está');
ok(hayHumano(GABI, enBogota(DOM, 15)),  'domingo 3pm: sí está');
ok(!hayHumano(GABI, enBogota(DOM, 18)), 'domingo 6pm: no está');

console.log('\nCuándo vuelve, en palabras');
ok(proximaApertura(GABI, enBogota(MAR, 6))  === 'hoy a las 8:00',      'martes de madrugada: hoy a las 8');
ok(proximaApertura(GABI, enBogota(MAR, 21)) === 'mañana a las 8:00',   'martes de noche: mañana a las 8');
ok(proximaApertura(GABI, enBogota(VIE, 21)) === 'mañana a las 11:00',  'viernes de noche: mañana a las 11, no a las 8');
ok(proximaApertura(GABI, enBogota(SAB, 9))  === 'hoy a las 11:00',     'sábado temprano: hoy a las 11');
ok(proximaApertura(GABI, enBogota(DOM, 20)) === 'mañana a las 8:00',   'domingo de noche: mañana a las 8');

console.log('\nLo que el asistente puede prometer');
const conGabi = textoDeHorario({ nombre_humano: 'Gabi', horario: GABI }, enBogota(MAR, 10));
const sinGabi = textoDeHorario({ nombre_humano: 'Gabi', horario: GABI }, enBogota(MAR, 22));
ok(conGabi.includes('está atendiendo en este momento'), 'con Gabi: puede decir que responde ya');
ok(sinGabi.includes('NO está atendiendo'),              'sin Gabi: el prompt lo dice');
ok(sinGabi.includes('mañana a las 8:00'),               'sin Gabi: le da la hora exacta de regreso');
ok(sinGabi.includes('NO digas "en un momento"'),        'sin Gabi: se le prohíbe prometer inmediatez');
ok(sinGabi.includes('sí puedes seguir ayudando'),       'sin Gabi: igual atiende, no se queda muda');

console.log('\nPor defecto el asistente contesta siempre');
ok(botDebeResponder(GABI, enBogota(MAR, 10)), 'martes 10am con Gabi trabajando: Pris igual contesta');
ok(botDebeResponder(GABI, enBogota(DOM, 23)), 'domingo de noche: contesta');
ok(botDebeResponder(null), 'sin horario configurado: contesta');

console.log('\nY calla solo si se pide explícito');
const CALLA = { ...GABI, bot_calla_en_horario: true };
ok(!botDebeResponder(CALLA, enBogota(MAR, 10)), 'con el interruptor puesto, en horario de Gabi calla');
ok(botDebeResponder(CALLA, enBogota(MAR, 22)),  'y fuera del horario vuelve a contestar');

console.log('\nLa forma vieja sigue funcionando igual');
const VIEJO = { modo: 'fuera_de_horario', inicio: 9, fin: 19 };
ok(!botDebeResponder(VIEJO, enBogota(MAR, 12)), 'entre semana en horario: calla, como antes');
ok(botDebeResponder(VIEJO, enBogota(MAR, 20)),  'entre semana fuera de horario: contesta');
ok(botDebeResponder(VIEJO, enBogota(SAB, 12)),  'sábado: contesta, porque la forma vieja no tenía fin de semana');

console.log(fallos ? `\n${fallos} FALLAS\n` : '\nTodo pasa.\n');
process.exit(fallos ? 1 : 0);
