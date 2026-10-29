-- =====================================================================
-- Arreglo del escalamiento permanente
-- 29 de octubre de 2026
--
-- El bug: cuando el asistente pasaba una conversacion a una persona,
-- marcaba el chat como "tomado". Pero "tomado" es el mismo campo que usa
-- una persona cuando se apropia de un chat desde el panel, y ese es
-- permanente a proposito. Resultado: el asistente quedaba mudo con ese
-- cliente PARA SIEMPRE, hasta que alguien se acordara de desmarcar la
-- casilla "Atender yo". Si nadie la veia, el cliente escribia al vacio.
--
-- Paso de verdad: el 29 de octubre dos personas del equipo probaron el
-- agente, escribieron, y no les respondio nunca.
--
-- El arreglo separa los dos estados:
--   tomado         -> una persona se apropio del chat. Permanente, correcto.
--   escalado_hasta -> el asistente pidio ayuda. Se vence solo.
--
-- Si nadie atiende dentro de la ventana, el asistente retoma en vez de
-- dejar al cliente hablando solo.
--
-- Correr en el editor SQL de Supabase.
-- =====================================================================

ALTER TABLE wa_chats  ADD COLUMN IF NOT EXISTS escalado_hasta TIMESTAMPTZ;
ALTER TABLE wa_config ADD COLUMN IF NOT EXISTS escalamiento_min INT NOT NULL DEFAULT 90;

COMMENT ON COLUMN wa_chats.escalado_hasta IS
  'El asistente pidio ayuda y calla hasta esta hora. Se vence solo, a diferencia de tomado. Lo limpia cualquier persona que escriba o se apropie del chat.';
COMMENT ON COLUMN wa_config.escalamiento_min IS
  'Minutos que el asistente espera despues de escalar antes de retomar la conversacion, si nadie la atendio.';

-- Arrastre: los chats que quedaron tomados por el bug y que nadie atendio.
-- Se sueltan los que llevan mas de un dia sin que una persona escriba,
-- porque esos son escalaciones viejas, no chats que alguien este atendiendo.
UPDATE wa_chats c
SET tomado = false, tomado_por = NULL
WHERE c.tomado = true
  AND c.tomado_por IS NULL            -- ninguna persona se apropio: lo marco el bot
  AND NOT EXISTS (
    SELECT 1 FROM wa_mensajes m
    WHERE m.chat_id = c.id AND m.de = 'humano' AND m.ts > now() - interval '1 day'
  );

-- Verificacion: cuantos chats quedan tomados y por quien.
SELECT c.name AS empresa,
       count(*) FILTER (WHERE ch.tomado AND ch.tomado_por IS NOT NULL) AS tomados_por_persona,
       count(*) FILTER (WHERE ch.tomado AND ch.tomado_por IS NULL)     AS tomados_sin_dueno,
       count(*) FILTER (WHERE ch.escalado_hasta > now())               AS escalados_ahora
FROM wa_chats ch
JOIN companies c ON c.id = ch.company_id
GROUP BY c.name;
