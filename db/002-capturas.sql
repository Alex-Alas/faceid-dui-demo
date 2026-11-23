BEGIN;

ALTER TABLE solicitudes
    ADD COLUMN IF NOT EXISTS intentos_spoof smallint NOT NULL DEFAULT 0
        CHECK (intentos_spoof BETWEEN 0 AND 3),
    ADD COLUMN IF NOT EXISTS fotos_capturadas_blob_paths text[] NOT NULL DEFAULT '{}';

ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS solicitudes_estado_check;
ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_estado_check
    CHECK (estado IN ('pendiente', 'verificada', 'rechazada', 'bloqueada_spoof'));

UPDATE solicitudes
SET fotos_capturadas_blob_paths = ARRAY[foto_capturada_blob_path]
WHERE foto_capturada_blob_path IS NOT NULL AND cardinality(fotos_capturadas_blob_paths) = 0;

COMMIT;
