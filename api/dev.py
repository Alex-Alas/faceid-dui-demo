import secrets

import cv2
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from biometria import (
    MODELOS_DISPONIBLES,
    FotoInvalida,
    cambiar_modelo_activo,
    evaluar_modelos,
    obtener_modelo_activo,
    representar,
)


class ModeloActivoNuevo(BaseModel):
    modelo: str


def _formatear_dui(dui):
    if len(dui) == 9:
        return f"{dui[:8]}-{dui[8:]}"
    return dui


def crear_router_dev(
    *,
    blobs_dir,
    front_url,
    max_fotos,
    conexion_fn,
    requerir_admin_fn,
    normalizar_dui_fn,
    leer_foto_fn,
    persistir_foto_fn,
    resumir_token_fn,
):
    router = APIRouter(prefix="/dev", tags=["dev"])

    @router.get("/estado")
    def dev_estado(x_admin_key: str | None = Header(default=None)):
        requerir_admin_fn(x_admin_key)
        with conexion_fn() as conn:
            filas = conn.execute(
                "SELECT dui, nombre, created_at FROM personas ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
        personas = [
            {"dui": _formatear_dui(fila["dui"]), "nombre": fila["nombre"], "created_at": fila["created_at"]}
            for fila in filas
        ]
        return {
            "modelo_activo": obtener_modelo_activo(),
            "modelos_disponibles": list(MODELOS_DISPONIBLES),
            "personas": personas,
        }

    @router.post("/modelo-activo")
    def dev_cambiar_modelo(datos: ModeloActivoNuevo, x_admin_key: str | None = Header(default=None)):
        requerir_admin_fn(x_admin_key)
        try:
            nuevo = cambiar_modelo_activo(datos.modelo.strip())
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return {"modelo_activo": nuevo}

    @router.post("/personas")
    def dev_guardar_persona(
        dui: str = Form(),
        nombre: str = Form(min_length=1, max_length=150),
        foto: UploadFile = File(),
        crear_solicitud: bool = Form(default=True),
        x_admin_key: str | None = Header(default=None),
    ):
        requerir_admin_fn(x_admin_key)
        dui_norm = normalizar_dui_fn(dui)
        nombre_limpio = nombre.strip()
        if not nombre_limpio:
            raise HTTPException(422, "Ingresa un nombre.")
        anterior_ruta = None
        nueva_solicitud = None
        try:
            imagen = leer_foto_fn(foto)
            embedding = representar(imagen)
            with persistir_foto_fn("referencias", imagen) as ruta, conexion_fn() as conn:
                anterior = conn.execute(
                    "SELECT foto_ref_blob_path FROM personas WHERE dui = %s",
                    (dui_norm,),
                ).fetchone()
                if anterior:
                    anterior_ruta = anterior["foto_ref_blob_path"]
                conn.execute(
                    """
                    INSERT INTO personas (dui, nombre, foto_ref_blob_path, embedding)
                    VALUES (%s, %s, %s, %s::vector)
                    ON CONFLICT (dui) DO UPDATE
                    SET nombre = EXCLUDED.nombre,
                        foto_ref_blob_path = EXCLUDED.foto_ref_blob_path,
                        embedding = EXCLUDED.embedding
                    """,
                    (dui_norm, nombre_limpio, ruta, str(embedding)),
                )
                if crear_solicitud:
                    token = secrets.token_urlsafe(32)
                    nueva_solicitud = conn.execute(
                        """
                        INSERT INTO solicitudes (dui, id_conversacion, token_hash)
                        VALUES (%s, %s, %s)
                        RETURNING id_solicitud, expires_at
                        """,
                        (dui_norm, "dev-web", resumir_token_fn(token)),
                    ).fetchone()
                    nueva_solicitud["token"] = token
                    nueva_solicitud["url"] = f"{front_url}/?solicitud={nueva_solicitud['id_solicitud']}#token={token}"
                conn.commit()
        except FotoInvalida as error:
            raise HTTPException(422, str(error)) from error
        if anterior_ruta and anterior_ruta != ruta:
            (blobs_dir / anterior_ruta).unlink(missing_ok=True)
        respuesta = {
            "estado": "actualizada" if anterior_ruta else "registrada",
            "dui": _formatear_dui(dui_norm),
            "nombre": nombre_limpio,
        }
        if nueva_solicitud is not None:
            respuesta["solicitud"] = nueva_solicitud
        return respuesta

    @router.get("/personas/{dui}/referencia")
    def dev_referencia(dui: str, x_admin_key: str | None = Header(default=None)):
        requerir_admin_fn(x_admin_key)
        dui_norm = normalizar_dui_fn(dui)
        with conexion_fn() as conn:
            fila = conn.execute(
                "SELECT foto_ref_blob_path FROM personas WHERE dui = %s",
                (dui_norm,),
            ).fetchone()
        if fila is None:
            raise HTTPException(404, "No hay foto de referencia para ese DUI.")
        ruta_completa = blobs_dir / fila["foto_ref_blob_path"]
        if not ruta_completa.is_file():
            raise HTTPException(404, "No se encontró el archivo de referencia.")
        return FileResponse(ruta_completa, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @router.post("/evaluar")
    def dev_evaluar(
        dui: str = Form(),
        foto: list[UploadFile] = File(max_length=max_fotos),
        modelos: str = Form(default="todos"),
        ignorar_spoof: bool = Form(default=False),
        x_admin_key: str | None = Header(default=None),
    ):
        requerir_admin_fn(x_admin_key)
        dui_norm = normalizar_dui_fn(dui)
        texto_modelos = modelos.strip()
        if texto_modelos.lower() in ("todos", "*"):
            lista_modelos = None
        else:
            lista_modelos = [m.strip() for m in texto_modelos.split(",") if m.strip()]
            if not lista_modelos:
                raise HTTPException(422, "Selecciona al menos un modelo.")
        try:
            imagenes = [leer_foto_fn(archivo) for archivo in foto]
            if not imagenes:
                raise HTTPException(422, "Envía al menos una imagen.")
            with conexion_fn() as conn:
                fila = conn.execute(
                    "SELECT foto_ref_blob_path FROM personas WHERE dui = %s",
                    (dui_norm,),
                ).fetchone()
            if fila is None:
                raise HTTPException(404, "El DUI no está registrado.")
            referencia = cv2.imread(str(blobs_dir / fila["foto_ref_blob_path"]))
            if referencia is None:
                raise HTTPException(500, "No se encontró la foto de referencia.")
            return evaluar_modelos(
                imagenes,
                referencia,
                modelos=lista_modelos,
                saltar_antisuplantacion=ignorar_spoof,
            )
        except (FotoInvalida, ValueError) as error:
            raise HTTPException(422, str(error)) from error

    return router
