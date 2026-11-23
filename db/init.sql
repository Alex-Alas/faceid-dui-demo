CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE personas (
    dui text PRIMARY KEY CHECK (dui ~ '^[0-9]{9}$'),
    nombre text NOT NULL,
    foto_ref_blob_path text NOT NULL,
    embedding vector(512),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE solicitudes (
    id_solicitud uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dui text NOT NULL REFERENCES personas(dui),
    id_conversacion text NOT NULL,
    token_hash bytea NOT NULL,
    estado text NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'verificada', 'rechazada')),
    liveness_ok boolean,
    liveness_score double precision,
    match_distance double precision,
    match_verified boolean,
    foto_capturada_blob_path text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
    updated_at timestamptz NOT NULL DEFAULT now()
);
