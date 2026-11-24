/**
 * Service worker del Cerebro.
 *
 * Existe para una sola cosa: que el panel se pueda instalar en el celular como
 * aplicacion. Android exige un service worker con manejador de fetch para
 * ofrecer "Instalar app".
 *
 * A PROPOSITO NO GUARDA NADA EN CACHE. Esto es un panel con sesion y datos en
 * vivo: si se cacheara, despues de un despliegue la gente seguiria viendo la
 * version vieja y los mensajes no se actualizarian. El fetch pasa derecho a la
 * red, siempre.
 *
 * skipWaiting y clients.claim hacen que una version nueva tome el control de
 * una vez, sin esperar a que se cierren todas las pestañas.
 */
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',    (e) => e.respondWith(fetch(e.request)));
