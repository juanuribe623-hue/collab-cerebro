-- =====================================================================
-- Catalogo para el asistente de WhatsApp
-- 29 de octubre de 2026
--
-- Le da al asistente una herramienta para buscar producto real en la
-- tienda online y mandar fotos, en vez de prometer que una persona lo
-- mostrara despues.
--
-- La columna es JSONB y no un TEXT con el dominio porque despues van a
-- entrar mas cosas ahi (la campana de UTM ya entra, el inventario de las
-- tiendas fisicas entrara) y no queremos otra migracion por cada una.
--
-- Correr en el editor SQL de Supabase.
-- =====================================================================

ALTER TABLE wa_config ADD COLUMN IF NOT EXISTS catalogo JSONB;

COMMENT ON COLUMN wa_config.catalogo IS
  'Catalogo de la tienda para el asistente. {"shopify":"dominio.com","token_env":"NOMBRE_DE_LA_VARIABLE","utm":{"campaign":"..."}}. token_env es el NOMBRE de la variable de entorno donde vive el token de Storefront, nunca el token. Null = la empresa no tiene catalogo y el asistente no recibe la herramienta.';

-- Casa Precis. Cubre las dos empresas duplicadas en Supabase, igual que
-- el resto de actualizaciones del asistente.
--
-- Ojo con token_env: aqui va el NOMBRE de la variable, no el token. El token
-- vive solo en Railway. Si algun dia alguien lee esta tabla, no se lleva nada.
UPDATE wa_config
SET catalogo = '{"shopify":"casaprecis.com","token_env":"SHOPIFY_STOREFRONT_TOKEN","utm":{"campaign":"pris-whatsapp"}}'::jsonb,
    updated_at = now()
WHERE company_id IN (
  SELECT id FROM companies WHERE name ILIKE '%casa precis%'
);

-- Verificacion: deben salir dos filas, las dos con el dominio puesto.
SELECT c.name, w.catalogo, w.updated_at
FROM wa_config w
JOIN companies c ON c.id = w.company_id
WHERE c.name ILIKE '%casa precis%';
