-- =====================================================================
-- Modulo WhatsApp del Cerebro: bandeja de entrada con asistente + humano
-- Multi empresa: todo va scoped por company_id, igual que el resto.
-- Correr en el editor SQL de Supabase.
-- =====================================================================

-- 1. Configuracion del asistente por empresa.
--    El prompt vive aqui y no en el codigo, para que el cliente pueda
--    ajustar el tono sin que tengamos que desplegar.
CREATE TABLE IF NOT EXISTS wa_config (
  company_id      UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  activo          BOOLEAN NOT NULL DEFAULT true,
  numero          TEXT,                    -- numero de la linea, solo informativo
  nombre_bot      TEXT NOT NULL DEFAULT 'Asistente',
  nombre_humano   TEXT NOT NULL DEFAULT 'nuestro equipo',
  system_prompt   TEXT,                    -- cerebro editable desde el Cerebro
  base_conocimiento TEXT,                  -- respuestas del manual del cliente
  horario         JSONB NOT NULL DEFAULT '{"modo":"siempre"}'::jsonb,
  silencio_min    INT NOT NULL DEFAULT 45, -- minutos que el bot calla tras hablar un humano
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Conversaciones.
CREATE TABLE IF NOT EXISTS wa_chats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  telefono      TEXT NOT NULL,
  nombre        TEXT,
  tomado        BOOLEAN NOT NULL DEFAULT false,   -- un humano se apropio del chat
  tomado_por    UUID,                             -- usuario de Supabase Auth
  silencio_hasta TIMESTAMPTZ,                     -- el bot calla hasta esta hora
  no_leido      BOOLEAN NOT NULL DEFAULT false,
  ultimo_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, telefono)
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_company ON wa_chats (company_id, ultimo_ts DESC);

-- 3. Mensajes.
CREATE TABLE IF NOT EXISTS wa_mensajes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  de          TEXT NOT NULL CHECK (de IN ('cliente','bot','humano')),
  autor_id    UUID,                    -- si de = humano, quien escribio
  tipo        TEXT NOT NULL DEFAULT 'text',
  texto       TEXT,
  media_id    TEXT,                    -- para cuando entre la linea real
  mime        TEXT,
  filename    TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_mensajes_chat ON wa_mensajes (chat_id, ts);

-- 4. Seguridad a nivel de fila, igual que las demas tablas del Cerebro.
--    El backend entra con la llave de servicio, asi que la politica
--    solo blinda el acceso directo desde el cliente.
ALTER TABLE wa_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_chats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_mensajes ENABLE ROW LEVEL SECURITY;

-- 5. Verificacion
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE tablename IN ('wa_config','wa_chats','wa_mensajes');
