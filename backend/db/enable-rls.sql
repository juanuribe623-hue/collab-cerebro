-- Collab Cerebro — SEGURIDAD: cerrar la puerta publica activando RLS.
--
-- Contexto: sin Row-Level Security, cualquiera con la URL del proyecto y la
-- llave publica (anon, visible en el frontend) puede leer/editar/borrar TODAS
-- las tablas por la API publica de Supabase, saltandose el backend y el filtro
-- por empresa. Esto expone datos de todos los clientes.
--
-- Por que es seguro: el backend usa SUPABASE_SERVICE_KEY (service_role), que
-- ignora RLS, asi que sigue funcionando. El frontend solo usa Auth (login),
-- nunca lee tablas directo. Con RLS activo y SIN politicas, la API publica
-- queda bloqueada (deny-by-default) y el backend sigue entrando con su llave.
--
-- COMO CORRERLO: Supabase -> SQL Editor del proyecto -> pegar todo -> Run.

ALTER TABLE companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_trends       ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_scripts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_brief        ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_influencers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_creators   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_creators      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_calendar     ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_insights     ENABLE ROW LEVEL SECURITY;

-- Verificar que quedaron todas en TRUE:
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public';
