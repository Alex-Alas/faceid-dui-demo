import base64
import struct
import time
from io import BytesIO
from threading import Lock

import cv2
import numpy as np
from deepface import DeepFace
from deepface.modules import modeling
from PIL import Image

MODELO = "Facenet512"
DETECTOR = "opencv"
METRICA = "cosine"
LADO_MAXIMO = 4096
cerrojo = Lock()


def precalentar():
    DeepFace.build_model(MODELO)
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


def miniatura(imagen, caja=None, lado=240):
    """JPEG en base64 para el panel técnico; recorta la cara con margen si se da la caja."""
    if caja:
        x, y, w, h = (int(caja[k]) for k in ("x", "y", "w", "h"))
        m = int(.25 * max(w, h))
        alto, ancho = imagen.shape[:2]
        imagen = imagen[max(0, y - m):min(alto, y + h + m), max(0, x - m):min(ancho, x + w + m)]
    escala = lado / max(imagen.shape[:2])
    if escala < 1:
        imagen = cv2.resize(imagen, None, fx=escala, fy=escala, interpolation=cv2.INTER_AREA)
    ok, jpeg = cv2.imencode(".jpg", imagen, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode() if ok else None


def caja_simple(area):
    return {k: int(area[k]) for k in ("x", "y", "w", "h")} if area else None


def verificar_pasos(imagen, referencia):
    """Ejecuta la verificación y emite cada paso para el panel técnico.

    El último evento siempre es {"paso": "resultado", ...} con los valores que se guardan.
    """
    alto, ancho = imagen.shape[:2]
    yield {
        "paso": "recibida", "ok": True, "titulo": "Captura recibida por la API",
        "detalle": {"ancho": ancho, "alto": alto},
        "imagenes": {"captura": miniatura(imagen, lado=320)},
    }

    inicio = time.perf_counter()
    with cerrojo:
        cara = extraer(imagen, antisuplantacion=True)
    real = bool(cara["is_real"])
    puntaje = float(cara["antispoof_score"])
    yield {
        "paso": "presencia", "ok": real, "ms": round((time.perf_counter() - inicio) * 1000),
        "titulo": "Detección de presencia (FasNet)",
        "detalle": {
            "es_real": real, "confianza": puntaje, "detector": DETECTOR,
            "caja": caja_simple(cara["facial_area"]),
            "nota": "La confianza es la del veredicto: alta con es_real=false significa suplantación segura.",
        },
        "imagenes": {"rostro": miniatura(imagen, cara["facial_area"])},
    }
    if not real:
        yield {
            "paso": "resultado", "estado": "rechazada", "liveness_ok": False,
            "liveness_score": puntaje, "match_distance": None, "match_threshold": None,
            "match_verified": None,
        }
        return

    inicio = time.perf_counter()
    with cerrojo:
        comparacion = DeepFace.verify(
            imagen, referencia, model_name=MODELO, detector_backend=DETECTOR, distance_metric=METRICA,
        )
    distancia = float(comparacion["distance"])
    umbral = float(comparacion["threshold"])
    coincide = bool(comparacion["verified"])
    areas = comparacion.get("facial_areas", {})
    yield {
        "paso": "comparacion", "ok": coincide, "ms": round((time.perf_counter() - inicio) * 1000),
        "titulo": f"Comparación con la referencia ({MODELO})",
        "detalle": {
            "distancia": distancia, "umbral": umbral, "metrica": METRICA, "modelo": MODELO,
            "detector": DETECTOR, "coincide": coincide,
            "nota": "Coincide si la distancia es menor o igual que el umbral.",
        },
        "imagenes": {
            "captura": miniatura(imagen, areas.get("img1")),
            "referencia": miniatura(referencia, areas.get("img2")),
        },
    }
    yield {
        "paso": "resultado", "estado": "verificada" if coincide else "rechazada",
        "liveness_ok": True, "liveness_score": puntaje, "match_distance": distancia,
        "match_threshold": umbral, "match_verified": coincide,
    }


def verificar(imagen, referencia):
    *_, resultado = verificar_pasos(imagen, referencia)
    return (
        resultado["liveness_ok"], resultado["liveness_score"],
        resultado["match_distance"], resultado["match_verified"],
    )
