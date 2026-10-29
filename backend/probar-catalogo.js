/**
 * Probador del catalogo, sin base de datos, sin token de WhatsApp y sin
 * gastar llamadas a Claude. Pega contra la tienda real y muestra lo mismo
 * que veria el asistente.
 *
 *   node probar-catalogo.js "vestido de fiesta" --talla=S --max=500000
 *   node probar-catalogo.js "zapatos negros" --talla=38
 *   node probar-catalogo.js "aretes"
 *
 * Con --tienda=otrodominio.com se prueba otra tienda.
 */
const { buscarEnTienda, pesos } = require('./routes/_catalogo');

const args  = process.argv.slice(2);
const texto = args.filter(a => !a.startsWith('--')).join(' ');
const flag  = n => {
  const a = args.find(x => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : undefined;
};

if (!texto) {
  console.log('Uso: node probar-catalogo.js "lo que busca el cliente" [--talla=S] [--color=negro] [--max=500000]');
  process.exit(1);
}

const cfg = { shopify: flag('tienda') || 'casaprecis.com', utm: { campaign: 'prueba' } };

(async () => {
  const t0 = Date.now();
  const r = await buscarEnTienda(cfg, {
    texto,
    talla:     flag('talla'),
    color:     flag('color'),
    precioMax: flag('max'),
  });

  console.log(`\n  Busqueda: "${texto}"` +
    (flag('talla') ? ` | talla ${flag('talla')}` : '') +
    (flag('color') ? ` | color ${flag('color')}` : '') +
    (flag('max')   ? ` | hasta ${pesos(flag('max'))}` : '') +
    `\n  ${Date.now() - t0} ms\n`);

  if (!r.items.length) {
    console.log('  Sin resultados.\n');
    console.log('  --- lo que lee el asistente ---');
    console.log('  ' + r.texto.replace(/\n/g, '\n  ') + '\n');
    return;
  }

  r.items.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.titulo}`);
    console.log(`     ${p.marca}  ·  ${pesos(p.precio)}  ·  tallas ${p.tallas.join(', ') || 'n/a'}`);
    console.log(`     ${p.url}`);
    console.log(`     foto: ${p.imagen ? 'si' : 'NO (no se podra enviar)'}\n`);
  });

  console.log('  --- lo que lee el asistente ---');
  console.log('  ' + r.texto.replace(/\n/g, '\n  ') + '\n');
})().catch(e => {
  console.error('\n  Fallo:', e.message, '\n');
  process.exit(1);
});
