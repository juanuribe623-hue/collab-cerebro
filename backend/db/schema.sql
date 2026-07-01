-- Collab Cerebro — esquema base (multi-tenant).
-- INSTRUCCIONES: pegar y correr en Supabase -> SQL Editor del proyecto NUEVO.

-- Empresas (cada cliente = una company)
CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Miembros: mapea cada usuario de Supabase Auth a su empresa
CREATE TABLE IF NOT EXISTS company_members (
  user_id    UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members (user_id);

-- Banco de Tendencias / Gaps (Señales del cerebro), por empresa
-- data: { titulo, descripcion, pilar, plataformas[], formato, tipo ('tendencia'|'gap'),
--         tags[], estado ('nueva'|'en_uso'|'guardada'|'descartada'),
--         videos[ { url, plataforma, vistas, likes, engagement } ], fuente, creado_en }
CREATE TABLE IF NOT EXISTS content_trends (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID   NOT NULL,
  trend_id   TEXT   NOT NULL,
  data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_content_trends_company ON content_trends (company_id);

-- Biblioteca de Guiones producidos (Modulo Produccion: angulos -> guiones), por empresa
-- data: { titulo, angulo, pilar, tema, plataformas[],
--         ig:     { hook, desarrollo[], cierre, caption, hashtags[], cta },
--         tiktok: { hook, desarrollo[], cierre, caption, hashtags[], audio, cta },
--         utm, creado_en }
CREATE TABLE IF NOT EXISTS content_scripts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID   NOT NULL,
  script_id  TEXT   NOT NULL,
  data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_content_scripts_company ON content_scripts (company_id);

-- Brief de marca por empresa (contexto que alimenta todos los modulos). Uno por company.
-- data: { nombre, descripcion, voz, audiencia, pilares[], reglas, objetivo_engagement }
CREATE TABLE IF NOT EXISTS company_brief (
  company_id UUID   PRIMARY KEY,
  data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);

-- Creadores evaluados (BrandFit de colaboraciones), por empresa
-- data: { handle, plataforma, nombre, seguidores, bio, score, veredicto,
--         alineacion[], audiencia, riesgos[], angulo_colab, formato, evaluado_en }
CREATE TABLE IF NOT EXISTS content_influencers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID   NOT NULL,
  inf_id     TEXT   NOT NULL,
  data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_content_influencers_company ON content_influencers (company_id);

-- ───────────────────────────────────────────────────────────────────────────
-- SEMBRAR EL PRIMER CLIENTE (Casa Precis)
-- 1) Crear la empresa:
--    INSERT INTO companies (name) VALUES ('Casa Precis') RETURNING id;
-- 2) Con ese id y el UUID de cada usuario (de Supabase Auth -> Users), asignar:
--    INSERT INTO company_members (user_id, company_id, role)
--    VALUES ('<uuid-del-usuario>', '<id-de-la-empresa>', 'admin');
