import struct
from io import BytesIO
from threading import Lock

import cv2
import numpy as np
from deepface import DeepFace
from deepface.modules import modeling
from PIL import Image

MODELO = "Facenet512"
DETECTOR = "opencv"
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


def verificar(imagenes, referencia):
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
            DeepFace.verify(imagen, referencia, model_name=MODELO, detector_backend=DETECTOR)
            for imagen in imagenes
        ]
        distancias = sorted(float(comparacion["distance"]) for comparacion in comparaciones)
        coincide = sum(bool(comparacion["verified"]) for comparacion in comparaciones) > len(imagenes) / 2
        return True, puntaje, distancias[len(distancias) // 2], coincide
