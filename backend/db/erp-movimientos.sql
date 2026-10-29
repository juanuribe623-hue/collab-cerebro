-- =====================================================================
-- Movimientos del ERP (myProcess)
-- 29 de octubre de 2026
--
-- myProcess puede empujar un aviso cada vez que algo se mueve: entra
-- mercancia, se traslada entre bodegas, se vende, o se crea una
-- referencia nueva. Aqui se guardan esos avisos.
--
-- Para que sirve: saber cuando una pieza LLEGA a una tienda. Esa es la
-- diferencia entre "te confirmo" y "ya llego a la 109, te lo aparto".
--
-- Por ahora solo se registra. Avisarle al cliente necesita una plantilla
-- aprobada por Meta, porque pasadas 24 horas desde su ultimo mensaje
-- WhatsApp no deja escribir texto libre. Pero el historial se empieza a
-- guardar desde ya: cuando la plantilla exista, los datos ya estan.
--
-- Correr en el editor SQL de Supabase.
-- =====================================================================

CREATE TABLE IF NOT EXISTS erp_movimientos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,          -- compra | venta | inventario | producto
  tipo_doc        TEXT,
  nro_documento   TEXT,
  fecha_doc       TIMESTAMPTZ,
  codigo_producto TEXT NOT NULL,
  nombre_producto TEXT,
  bodega_codigo   TEXT,
  bodega_nombre   TEXT,
  sede            TEXT,                   -- 79 | 109 | cartagena | web | outlet | principal
  cantidad        NUMERIC,
  valor           NUMERIC,
  bodega_entrada  TEXT,
  bodega_salida   TEXT,
  payload         JSONB,                  -- el aviso completo, por si despues hace falta un campo
  recibido_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta que de verdad se va a hacer: que llego a esta sede, ordenado
-- por lo mas reciente.
CREATE INDEX IF NOT EXISTS idx_erp_mov_sede
  ON erp_movimientos (company_id, sede, recibido_en DESC);
-- Y la otra: que ha pasado con esta referencia.
CREATE INDEX IF NOT EXISTS idx_erp_mov_producto
  ON erp_movimientos (company_id, codigo_producto, recibido_en DESC);

ALTER TABLE erp_movimientos ENABLE ROW LEVEL SECURITY;

-- El mapa de bodegas a sedes. Lo mando Juan Manuel el 29 de octubre.
-- Cada tienda tiene DOS bodegas, la propia y la de consignacion, y como
-- 125 de las 144 marcas estan en consignacion, mirar solo la propia seria
-- ver una fraccion de la tienda.
ALTER TABLE wa_config ADD COLUMN IF NOT EXISTS erp JSONB;

COMMENT ON COLUMN wa_config.erp IS
  'Configuracion del ERP. {"bodegas":{"001":"79",...}}. El usuario y la clave del webhook viven en variables de entorno, nunca aqui.';

UPDATE wa_config
SET erp = '{
  "bodegas": {
    "001": "79",         "002": "79",
    "003": "109",        "004": "109",
    "019": "cartagena",  "018": "cartagena",
    "020": "web",
    "013": "outlet",
    "017": "principal"
  }
}'::jsonb,
    updated_at = now()
WHERE company_id IN (
  SELECT id FROM companies WHERE name ILIKE '%casa precis%'
);

-- Verificacion: deben salir dos filas con el mapa puesto.
SELECT c.name, w.erp -> 'bodegas' AS bodegas, w.updated_at
FROM wa_config w
JOIN companies c ON c.id = w.company_id
WHERE c.name ILIKE '%casa precis%';
