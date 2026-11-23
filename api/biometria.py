import os
import struct
import time
from io import BytesIO
from threading import Lock

import cv2
import numpy as np
from deepface import DeepFace
from deepface.modules import modeling
from PIL import Image

MODELOS_DISPONIBLES = ("Facenet512", "ArcFace", "GhostFaceNet", "SFace", "Facenet")
_modelo_env = os.getenv("FACEID_MODEL", "Facenet512")
MODELO = _modelo_env if _modelo_env in MODELOS_DISPONIBLES else "Facenet512"
DETECTOR = "opencv"
LADO_MAXIMO = 4096
cerrojo = Lock()
_modelo_activo = MODELO


def obtener_modelo_activo():
    return _modelo_activo


def cambiar_modelo_activo(modelo):
    global _modelo_activo
    if modelo not in MODELOS_DISPONIBLES:
        raise ValueError(f"Modelo no soportado: {modelo}")
    with cerrojo:
        DeepFace.build_model(modelo)
        _modelo_activo = modelo
        return _modelo_activo


def precalentar():
    DeepFace.build_model(obtener_modelo_activo())
    modeling.build_model(task="spoofing", model_name="Fasnet")


class FotoInvalida(ValueError):
    pass


def decodificar(contenido):
    try:
        with Image.open(BytesIO(contenido), formats=["JPEG", "PNG"]) as cabecera:
            dimensiones = cabecera.size
    except Image.DecompressionBombError as error:
        raise FotoInvalida("La foto supera 4096 píxeles por lado.") from error
    except (OSError, SyntaxError, ValueError, struct.error) as error:
        raise FotoInvalida("La imagen no es válida.") from error
    if max(dimensiones) > LADO_MAXIMO:
        raise FotoInvalida("La foto supera 4096 píxeles por lado.")
    try:
        imagen = cv2.imdecode(np.frombuffer(contenido, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:
        raise FotoInvalida("La imagen no es válida.") from error
    if imagen is None or max(imagen.shape[:2]) > LADO_MAXIMO:
        raise FotoInvalida("La imagen no es válida o supera 4096 píxeles por lado.")
    return imagen


def extraer(imagen, antisuplantacion=False):
    try:
        caras = DeepFace.extract_faces(
            imagen, detector_backend=DETECTOR, anti_spoofing=antisuplantacion,
        )
    except ValueError as error:
        raise FotoInvalida("La foto debe mostrar un solo rostro claro.") from error
    if len(caras) != 1:
        raise FotoInvalida("La foto debe mostrar un solo rostro claro.")
    return caras[0]


def representar(imagen):
    with cerrojo:
        extraer(imagen)
        return DeepFace.represent(
            imagen, model_name=MODELO, detector_backend=DETECTOR,
        )[0]["embedding"]


def verificar(imagenes, referencia, modelo=None):
    elegido = modelo or obtener_modelo_activo()
    if elegido not in MODELOS_DISPONIBLES:
        raise ValueError(f"Modelo no soportado: {elegido}")
    with cerrojo:
        caras = []
        foto_invalida = None
        for imagen in imagenes:
            try:
                caras.append(extraer(imagen, antisuplantacion=True))
            except FotoInvalida as error:
                if foto_invalida is None:
                    foto_invalida = error
        sospechosas = [float(cara["antispoof_score"]) for cara in caras if not cara["is_real"]]
        if sospechosas:
            return False, max(sospechosas), None, None
        if foto_invalida is not None:
            raise foto_invalida
        puntaje = min(float(cara["antispoof_score"]) for cara in caras)
        comparaciones = [
            DeepFace.verify(imagen, referencia, model_name=elegido, detector_backend=DETECTOR)
            for imagen in imagenes
        ]
        distancias = sorted(float(comparacion["distance"]) for comparacion in comparaciones)
        coincide = sum(bool(comparacion["verified"]) for comparacion in comparaciones) > len(imagenes) / 2
        return True, puntaje, distancias[len(distancias) // 2], coincide


def evaluar_modelos(imagenes, referencia, modelos=None, saltar_antisuplantacion=False):
    if not imagenes:
        raise ValueError("Debes enviar al menos una imagen.")
    if modelos is None or list(modelos) == ["todos"]:
        lista_modelos = list(MODELOS_DISPONIBLES)
    else:
        lista_modelos = list(modelos)
    if not lista_modelos:
        raise ValueError("Selecciona al menos un modelo.")
    for modelo in lista_modelos:
        if modelo not in MODELOS_DISPONIBLES:
            raise ValueError(f"Modelo no soportado: {modelo}")

    with cerrojo:
        caras = []
        fotos = []
        foto_invalida = None
        for indice, imagen in enumerate(imagenes, start=1):
            try:
                cara = extraer(imagen, antisuplantacion=True)
                caras.append(cara)
                fotos.append({
                    "indice": indice,
                    "is_real": bool(cara["is_real"]),
                    "antispoof_score": round(float(cara["antispoof_score"]), 6),
                })
            except FotoInvalida as error:
                if foto_invalida is None:
                    foto_invalida = error

        sospechosas = [float(cara["antispoof_score"]) for cara in caras if not cara["is_real"]]
        if sospechosas and not saltar_antisuplantacion:
            return {
                "liveness_ok": False,
                "liveness_score": round(max(sospechosas), 6),
                "spoof_ignorado": False,
                "fotos": fotos,
                "resultados": [],
            }
        if foto_invalida is not None:
            raise foto_invalida

        liveness_ok = not sospechosas
        puntaje = max(sospechosas) if sospechosas else min(float(cara["antispoof_score"]) for cara in caras)
        resultados = []
        for modelo in lista_modelos:
            inicio = time.perf_counter()
            comparaciones = [
                DeepFace.verify(imagen, referencia, model_name=modelo, detector_backend=DETECTOR)
                for imagen in imagenes
            ]
            tiempo_ms = round((time.perf_counter() - inicio) * 1000, 1)
            distancias_fotos = [round(float(comp["distance"]), 6) for comp in comparaciones]
            coincidencias_fotos = [bool(comp["verified"]) for comp in comparaciones]
            distancias_ordenadas = sorted(float(comp["distance"]) for comp in comparaciones)
            coinciden = sum(coincidencias_fotos)
            resultados.append({
                "modelo": modelo,
                "match_verified": coinciden > len(imagenes) / 2,
                "match_distance": round(distancias_ordenadas[len(distancias_ordenadas) // 2], 6),
                "umbral": round(float(comparaciones[0]["threshold"]), 6),
                "metrica": str(comparaciones[0].get("similarity_metric", "cosine")),
                "fotos_coincidentes": coinciden,
                "total_fotos": len(imagenes),
                "distancias_fotos": distancias_fotos,
                "coincidencias_fotos": coincidencias_fotos,
                "tiempo_ms": tiempo_ms,
            })

        return {
            "liveness_ok": liveness_ok,
            "liveness_score": round(puntaje, 6),
            "spoof_ignorado": bool(not liveness_ok and saltar_antisuplantacion),
            "fotos": fotos,
            "resultados": resultados,
        }
