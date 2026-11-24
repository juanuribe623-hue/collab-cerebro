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

/* Aviso cuando hace falta una persona. El servidor solo lo manda en ese caso,
   asi que aqui no hay que filtrar nada. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Casa Precis', {
    body: d.body || 'Te escribieron por WhatsApp',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/?v=wa' },
    /* Misma etiqueta: si llegan varios seguidos se apilan en uno solo en vez
       de llenar la pantalla de avisos. */
    tag: 'wa',
    renotify: true,
  }));
});

/* Al tocarlo, se va a la bandeja. Si ya hay una ventana abierta se reutiliza
   en vez de abrir otra, que es lo que mas molesta de estos avisos. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/?v=wa';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
