import hashlib
import json
import os
import re
import secrets
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import cv2
import psycopg
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from biometria import FotoInvalida, decodificar, representar, verificar_pasos

BLOBS = Path(os.getenv("BLOB_DIR", "/blobs"))
FRONT_URL = os.getenv("FRONT_URL", "http://localhost:8080").rstrip("/")
MAX_BYTES = 5 * 1024 * 1024
# Solo para desarrollo local: enlaces reutilizables (30 días, intentos ilimitados) y panel técnico.
MODO_DESARROLLO = os.getenv("MODO_DESARROLLO", "0") == "1"
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
               s.liveness_ok, s.liveness_score, s.match_distance, s.match_verified,
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
    return {"estado": "ok"}


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
                INSERT INTO solicitudes (dui, id_conversacion, token_hash, expires_at)
                VALUES (%s, %s, %s, now() + %s::interval)
                RETURNING id_solicitud, expires_at
                """,
                (dui, conversacion, resumir_token(token), "30 days" if MODO_DESARROLLO else "30 minutes"),
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
    fila["modo_desarrollo"] = MODO_DESARROLLO
    return fila


def preparar_verificacion(conn, id_solicitud, dui, foto, authorization):
    fila = buscar_solicitud(conn, id_solicitud, normalizar_dui(dui), authorization, bloquear=True)
    if fila["estado"] != "pendiente" and not MODO_DESARROLLO:
        raise HTTPException(409, "La solicitud ya fue completada.")
    try:
        imagen = leer_foto(foto)
    except FotoInvalida as error:
        raise HTTPException(422, str(error)) from error
    referencia = cv2.imread(str(BLOBS / fila["foto_ref_blob_path"]))
    if referencia is None:
        raise HTTPException(500, "No se encontró la foto de referencia.")
    return imagen, referencia


def guardar_resultado(conn, id_solicitud, imagen, resultado, traza):
    """Actualiza la solicitud con el último resultado y registra el intento en el historial."""
    with persistir_foto("capturas", imagen) as ruta:
        conn.execute(
            """
            UPDATE solicitudes
            SET estado = %(estado)s, liveness_ok = %(liveness_ok)s, liveness_score = %(liveness_score)s,
                match_distance = %(match_distance)s, match_verified = %(match_verified)s,
                foto_capturada_blob_path = %(ruta)s, updated_at = now()
            WHERE id_solicitud = %(id)s
            """,
            {**resultado, "ruta": ruta, "id": id_solicitud},
        )
        intento = conn.execute(
            """
            INSERT INTO intentos (id_solicitud, estado, liveness_ok, liveness_score, match_distance,
                                  match_threshold, match_verified, foto_capturada_blob_path, traza)
            VALUES (%(id)s, %(estado)s, %(liveness_ok)s, %(liveness_score)s, %(match_distance)s,
                    %(match_threshold)s, %(match_verified)s, %(ruta)s, %(traza)s)
            RETURNING id_intento
            """,
            {**resultado, "ruta": ruta, "id": id_solicitud, "traza": Jsonb(traza)},
        ).fetchone()
        conn.commit()
    return intento["id_intento"]


def sin_imagenes(evento):
    return {k: v for k, v in evento.items() if k != "imagenes"}


def respuesta_final(id_solicitud, resultado, id_intento):
    return {
        "id_solicitud": str(id_solicitud), "id_intento": str(id_intento),
        **{k: resultado[k] for k in (
            "estado", "liveness_ok", "liveness_score", "match_distance", "match_threshold", "match_verified",
        )},
    }


@app.post("/solicitudes/{id_solicitud}/verificar")
def verificar_solicitud(
    id_solicitud: UUID, dui: str = Form(), foto: UploadFile = File(),
    authorization: str | None = Header(default=None),
):
    with conexion() as conn:
        imagen, referencia = preparar_verificacion(conn, id_solicitud, dui, foto, authorization)
        try:
            eventos = list(verificar_pasos(imagen, referencia))
        except FotoInvalida as error:
            raise HTTPException(422, str(error)) from error
        resultado = eventos[-1]
        id_intento = guardar_resultado(conn, id_solicitud, imagen, resultado, [sin_imagenes(e) for e in eventos])
    return respuesta_final(id_solicitud, resultado, id_intento)


@app.post("/solicitudes/{id_solicitud}/verificar/traza")
def verificar_con_traza(
    id_solicitud: UUID, dui: str = Form(), foto: UploadFile = File(),
    authorization: str | None = Header(default=None),
):
    """Igual que /verificar, pero emite cada paso como una línea JSON (NDJSON) a medida que ocurre."""
    if not MODO_DESARROLLO:
        raise HTTPException(404, "Disponible solo en modo desarrollo.")
    with conexion() as conn:
        imagen, referencia = preparar_verificacion(conn, id_solicitud, dui, foto, authorization)

    def emitir():
        traza = []
        try:
            for evento in verificar_pasos(imagen, referencia):
                traza.append(sin_imagenes(evento))
                if evento["paso"] == "resultado":
                    with conexion() as conn:
                        id_intento = guardar_resultado(conn, id_solicitud, imagen, evento, traza)
                    yield json.dumps({"paso": "fin", **respuesta_final(id_solicitud, evento, id_intento)}) + "\n"
                else:
                    yield json.dumps(evento) + "\n"
        except FotoInvalida as error:
            yield json.dumps({"paso": "error", "mensaje": str(error)}) + "\n"
        except Exception as error:  # el estado HTTP ya se envió; se informa en el flujo
            yield json.dumps({"paso": "error", "mensaje": f"Error interno: {type(error).__name__}"}) + "\n"

    return StreamingResponse(
        emitir(), media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/solicitudes/{id_solicitud}/intentos")
def listar_intentos(
    id_solicitud: UUID, x_dui: str = Header(), authorization: str | None = Header(default=None),
):
    if not MODO_DESARROLLO:
        raise HTTPException(404, "Disponible solo en modo desarrollo.")
    with conexion() as conn:
        buscar_solicitud(conn, id_solicitud, normalizar_dui(x_dui), authorization)
        return conn.execute(
            """
            SELECT id_intento, estado, liveness_ok, liveness_score, match_distance, match_threshold,
                   match_verified, created_at
            FROM intentos WHERE id_solicitud = %s ORDER BY created_at DESC LIMIT 20
            """,
            (id_solicitud,),
        ).fetchall()
