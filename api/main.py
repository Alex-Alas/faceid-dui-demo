import hashlib
import os
import re
import secrets
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import cv2
import psycopg
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from biometria import FotoInvalida, decodificar, obtener_modelo_activo, representar, verificar
from dev import crear_router_dev

BLOBS = Path(os.getenv("BLOB_DIR", "/blobs"))
FRONT_URL = os.getenv("FRONT_URL", "http://localhost:8080").rstrip("/")
MODO_DEV = os.getenv("ENABLE_DEV_TOOLS", "0").strip().lower() in ("1", "true", "yes")
MAX_BYTES = 5 * 1024 * 1024
MAX_FOTOS = 5
MAX_INTENTOS_SPOOF = 3
app = FastAPI(title="Demo de validación de identidad", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONT_URL],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type", "X-DUI", "X-Admin-Key"],
)


class SolicitudNueva(BaseModel):
    dui: str
    id_conversacion: str = Field(min_length=1, max_length=128)


def conexion():
    return psycopg.connect(connect_timeout=5, row_factory=dict_row)


def resumir_token(token):
    return hashlib.sha256(token.encode()).digest()


def requerir_admin(clave):
    configurada = os.getenv("ADMIN_KEY")
    if not configurada or not secrets.compare_digest(resumir_token(clave or ""), resumir_token(configurada)):
        raise HTTPException(401, "Clave de integración inválida.")


def normalizar_dui(dui):
    dui = dui.strip()
    if not re.fullmatch(r"[0-9]{8}-?[0-9]", dui):
        raise HTTPException(422, "Ingresa un DUI de nueve dígitos.")
    return dui.replace("-", "")


def leer_foto(foto):
    contenido = foto.file.read(MAX_BYTES + 1)
    if len(contenido) > MAX_BYTES:
        raise HTTPException(413, "La foto supera el límite de 5 MB.")
    if not contenido.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n")):
        raise HTTPException(422, "La foto debe ser JPEG o PNG.")
    return decodificar(contenido)


@contextmanager
def persistir_foto(carpeta, imagen):
    relativo = f"{carpeta}/{uuid4()}.jpg"
    ruta = BLOBS / relativo
    ruta.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not cv2.imwrite(str(ruta), imagen):
            raise HTTPException(500, "No se pudo almacenar la foto.")
        yield relativo
    except Exception:
        ruta.unlink(missing_ok=True)
        raise


def buscar_solicitud(conn, id_solicitud, dui, autorizacion, bloquear=False):
    esquema, _, token = (autorizacion or "").partition(" ")
    if esquema.lower() != "bearer" or not token:
        raise HTTPException(401, "Falta el token de la sesión.")
    consulta = """
        SELECT s.id_solicitud, s.estado, s.expires_at,
               s.expires_at <= clock_timestamp() AS vencida,
               s.liveness_ok, s.liveness_score, s.match_distance, s.match_verified, s.intentos_spoof,
               p.foto_ref_blob_path
        FROM solicitudes s JOIN personas p USING (dui)
        WHERE s.id_solicitud = %s AND s.dui = %s AND s.token_hash = %s
    """
    if bloquear:
        consulta += " FOR UPDATE OF s"
    fila = conn.execute(consulta, (id_solicitud, dui, resumir_token(token))).fetchone()
    if fila is None:
        raise HTTPException(404, "No hay una solicitud para estos datos.")
    if fila.pop("vencida"):
        raise HTTPException(410, "La solicitud expiró. Pide un enlace nuevo.")
    return fila


@app.get("/health")
def salud():
    try:
        with conexion() as conn:
            instalado = conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector'").fetchone()
    except psycopg.Error as error:
        raise HTTPException(503, "Base de datos no disponible.") from error
    if not instalado:
        raise HTTPException(503, "No se encontró pgvector.")
    return {"estado": "ok", "modelo_activo": obtener_modelo_activo(), "dev_habilitado": MODO_DEV}


@app.post("/personas", status_code=201)
def registrar_persona(
    dui: str = Form(), nombre: str = Form(min_length=1, max_length=150),
    foto: UploadFile = File(), x_admin_key: str | None = Header(default=None),
):
    requerir_admin(x_admin_key)
    dui = normalizar_dui(dui)
    nombre = nombre.strip()
    if not nombre:
        raise HTTPException(422, "Ingresa un nombre.")
    try:
        imagen = leer_foto(foto)
        embedding = representar(imagen)
        with persistir_foto("referencias", imagen) as ruta, conexion() as conn:
            conn.execute(
                """
                INSERT INTO personas (dui, nombre, foto_ref_blob_path, embedding)
                VALUES (%s, %s, %s, %s::vector)
                """,
                (dui, nombre, ruta, str(embedding)),
            )
    except FotoInvalida as error:
        raise HTTPException(422, str(error)) from error
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(409, "El DUI ya está registrado.") from error
    return {"estado": "registrada"}


@app.post("/solicitudes", status_code=201)
def crear_solicitud(datos: SolicitudNueva, x_admin_key: str | None = Header(default=None)):
    requerir_admin(x_admin_key)
    dui = normalizar_dui(datos.dui)
    conversacion = datos.id_conversacion.strip()
    if not conversacion:
        raise HTTPException(422, "Ingresa el ID de la conversación.")
    token = secrets.token_urlsafe(32)
    try:
        with conexion() as conn:
            nueva = conn.execute(
                """
                INSERT INTO solicitudes (dui, id_conversacion, token_hash)
                VALUES (%s, %s, %s)
                RETURNING id_solicitud, expires_at
                """,
                (dui, conversacion, resumir_token(token)),
            ).fetchone()
    except psycopg.errors.ForeignKeyViolation as error:
        raise HTTPException(404, "El DUI no está registrado.") from error
    nueva["token"] = token
    nueva["url"] = f"{FRONT_URL}/?solicitud={nueva['id_solicitud']}#token={token}"
    return nueva


@app.get("/solicitudes/{id_solicitud}")
def consultar_solicitud(
    id_solicitud: UUID, x_dui: str = Header(), authorization: str | None = Header(default=None),
):
    with conexion() as conn:
        fila = buscar_solicitud(conn, id_solicitud, normalizar_dui(x_dui), authorization)
    fila.pop("foto_ref_blob_path")
    fila["intentos_spoof_restantes"] = MAX_INTENTOS_SPOOF - fila["intentos_spoof"]
    return fila


@app.post("/solicitudes/{id_solicitud}/verificar")
def verificar_solicitud(
    id_solicitud: UUID, dui: str = Form(), foto: list[UploadFile] = File(max_length=MAX_FOTOS),
    authorization: str | None = Header(default=None),
):
    try:
        with conexion() as conn:
            fila = buscar_solicitud(conn, id_solicitud, normalizar_dui(dui), authorization, bloquear=True)
            if fila["estado"] != "pendiente":
                raise HTTPException(409, "La solicitud ya fue completada.")
            imagenes = [leer_foto(archivo) for archivo in foto]
            referencia = cv2.imread(str(BLOBS / fila["foto_ref_blob_path"]))
            if referencia is None:
                raise HTTPException(500, "No se encontró la foto de referencia.")
            liveness, puntaje, distancia, coincide = verificar(imagenes, referencia)
            intentos = fila["intentos_spoof"] + (not liveness)
            if liveness:
                estado = "verificada" if coincide else "rechazada"
            else:
                estado = "bloqueada_spoof" if intentos >= MAX_INTENTOS_SPOOF else "pendiente"
            with ExitStack() as archivos:
                rutas = [archivos.enter_context(persistir_foto("capturas", imagen)) for imagen in imagenes]
                conn.execute(
                    """
                    UPDATE solicitudes
                    SET estado = %s, liveness_ok = %s, liveness_score = %s, match_distance = %s,
                        match_verified = %s, intentos_spoof = %s, foto_capturada_blob_path = %s,
                        fotos_capturadas_blob_paths = fotos_capturadas_blob_paths || %s, updated_at = now()
                    WHERE id_solicitud = %s
                    """,
                    (estado, liveness, puntaje, distancia, coincide, intentos, rutas[0], rutas, id_solicitud),
                )
                conn.commit()
    except FotoInvalida as error:
        raise HTTPException(422, str(error)) from error
    return {
        "id_solicitud": id_solicitud, "estado": estado, "liveness_ok": liveness,
        "liveness_score": puntaje, "match_distance": distancia, "match_verified": coincide,
        "intentos_spoof": intentos, "intentos_spoof_restantes": MAX_INTENTOS_SPOOF - intentos,
    }


if MODO_DEV:
    app.include_router(
        crear_router_dev(
            blobs_dir=BLOBS,
            front_url=FRONT_URL,
            max_fotos=MAX_FOTOS,
            conexion_fn=conexion,
            requerir_admin_fn=requerir_admin,
            normalizar_dui_fn=normalizar_dui,
            leer_foto_fn=leer_foto,
            persistir_foto_fn=persistir_foto,
            resumir_token_fn=resumir_token,
        )
    )
