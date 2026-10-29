-- =====================================================================
-- Como se llaman las tiendas cuando Pris habla de ellas
-- 29 de octubre de 2026
--
-- Shopify tiene las sedes cargadas como "Precis 109", "Precis 79" y
-- "Precis Cartagena", que es como las nombro quien las configuro. Pero la
-- marca las llama "Calle 109" y "Calle 79" en todas partes: en la pauta,
-- en Instagram y en la conversacion del equipo.
--
-- "Para medirtelo: Precis 109" suena a sistema interno. "Para medirtelo:
-- Calle 109" suena a la tienda. Es un detalle y por eso mismo se nota.
--
-- Si Shopify devuelve un nombre que no este aqui, se usa tal cual: mejor
-- un nombre feo que ningun nombre.
--
-- Correr en el editor SQL de Supabase.
-- =====================================================================

UPDATE wa_config
SET catalogo = catalogo || '{
  "sedes": {
    "Precis 79":        "Calle 79",
    "Precis 109":       "Calle 109",
    "Precis Cartagena": "Cartagena"
  }
}'::jsonb,
    updated_at = now()
WHERE company_id IN (
  SELECT id FROM companies WHERE name ILIKE '%casa precis%'
)
AND catalogo IS NOT NULL;   -- si es null, falta correr whatsapp-catalogo.sql

-- Verificacion: deben salir dos filas, las dos con el dominio Y los alias.
-- Si "sedes" sale vacio, es que catalogo venia en null.
SELECT c.name,
       w.catalogo ->> 'shopify' AS dominio,
       w.catalogo -> 'sedes'    AS alias_de_sedes
FROM wa_config w
JOIN companies c ON c.id = w.company_id
WHERE c.name ILIKE '%casa precis%';
