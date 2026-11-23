# Face ID DUI · Demo de validación de identidad

El cliente abre un enlace de un solo uso, confirma su DUI, sigue un reto de cámara y recibe el resultado de la comparación con su foto de referencia. La solicitud conserva el `id_conversacion` asociado al cliente; la demo no envía mensajes ni reanuda la conversación automáticamente.

## Ejecutar la demo

Requiere Docker con Compose, Bash, curl, Python 3, OpenSSL y un navegador con cámara. Usa un DUI ficticio y fotos propias o autorizadas. La primera compilación descarga MediaPipe, DeepFace, los modelos y sus dependencias; puede tardar varios minutos. La inferencia usa CPU.

```sh
umask 077
(set -C; printf 'POSTGRES_PASSWORD=%s\nADMIN_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env)
docker compose up --build -d
curl --retry 20 --retry-connrefused --retry-delay 2 -fsS http://localhost:8000/health
```

En el mismo equipo, registra la foto de referencia y crea una solicitud:

```sh
bash scripts/sembrar.sh /ruta/a/referencia.jpg 00000000-0 'Persona de prueba' demo-conversacion
```

Abre la `url` del JSON que devuelve el script. Ingresa el mismo DUI, activa la cámara, parpadea una vez y gira la cabeza. Luego vuelve al centro y mantente quieto: la página envía automáticamente la mejor de cinco capturas válidas. Si la solicitud queda verificada o rechazada, hay que crear otra para repetir.

- **Web:** `http://localhost:8080`. Abrir solo la portada no inicia una sesión.
- **API:** `http://localhost:8000/docs` para ver y probar el contrato.
- **PostgreSQL 16 + pgvector:** `db:5432`, accesible solo dentro de Compose; datos y fotos persisten en volúmenes separados.

El SQL de inicialización solo se ejecuta cuando la base es nueva. `docker compose down` detiene la demo sin borrar datos. Para eliminar los datos de prueba, usa `docker compose down -v`; esto borra ambos volúmenes.

## Cómo funciona

1. La integración usa `POST /personas` (multipart: `dui`, `nombre`, `foto`) para guardar la referencia JPEG en el volumen y almacenar ruta y embedding Facenet512 en PostgreSQL. La referencia se consulta por DUI; **el embedding no se usa para buscar entre personas**.
2. La integración crea la solicitud vía `POST /solicitudes` (JSON: `dui`, `id_conversacion`). Ambas operaciones requieren `X-Admin-Key`. La API genera un UUID y un token aleatorio; en la base guarda solo su hash. El enlace pone el token en el fragmento, no en la query HTTP, y vence en 30 minutos.
3. La web valida el enlace con `GET /solicitudes/{id_solicitud}`, encabezados `X-DUI` y `Authorization: Bearer …`. La API exige que coincidan solicitud, DUI y token; no devuelve la referencia ni el ID de la conversación.
4. [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) procesa la cámara localmente. Filtra por cantidad, tamaño y posición del rostro, pose, ojos, iluminación y nitidez. Detecta un parpadeo y un giro mediante blendshapes y la matriz facial. Solo sube el JPEG final a `POST /solicitudes/{id_solicitud}/verificar` (multipart: `dui`, `foto`; el mismo Bearer).
5. [DeepFace](https://github.com/serengil/deepface) evalúa la captura con `extract_faces(anti_spoofing=True)` (FasNet). Si pasa, `verify` compara esa captura con la referencia del DUI mediante Facenet512 y distancia coseno. La API guarda los resultados, la ruta del blob de captura y el estado final. Si falla la detección de presencia, los campos de coincidencia quedan nulos.

## Prueba sin cámara

Descarga las imágenes públicas del conjunto de pruebas de DeepFace en una carpeta ignorada por Git. La prueba registra la referencia, comprueba el aislamiento por DUI y token, verifica una foto del mismo rostro y otra de otro rostro, y comprueba que la sesión completada no se puede reutilizar.

```sh
mkdir -p demo-data
for n in 1 2 3; do
  curl -fsSL "https://raw.githubusercontent.com/serengil/deepface/v0.0.95/tests/dataset/img$n.jpg" -o "demo-data/img$n.jpg"
done
bash scripts/probar.sh
```

Son fotos estáticas, no evidencia de presencia física. FasNet puede rechazarlas antes de comparar los rostros; el script muestra si esto ocurre. Estas fotos no ejercitan los gestos frente a la cámara.

## Modo desarrollo (panel técnico)

Para iterar rápido en local, agrega `MODO_DESARROLLO=1` al `.env` y reinicia la API. Con el modo activo:

- Cada enlace vale 30 días y admite intentos ilimitados; cada intento queda en la tabla `intentos`.
- La web muestra un panel técnico: puntos de MediaPipe sobre el video, métricas en vivo (pose, parpadeo, luz, nitidez), los pasos del backend en tiempo real (FasNet, Facenet512, distancia contra umbral, imágenes) y el historial de intentos.
- El panel usa `POST /solicitudes/{id}/verificar/traza` (NDJSON) y `GET /solicitudes/{id}/intentos`, que solo existen en este modo.

No lo actives en un despliegue público. Si la base se creó antes de esta versión, crea la tabla con el bloque `intentos` de `db/init.sql`.

## Límites

- La detección de presencia no está certificada: puede aceptar imágenes de pantalla o rechazar a personas reales. Los gestos del navegador mejoran la captura, pero no constituyen evidencia confiable para la API: el reto no se firma ni se valida en el servidor.
- Las puntuaciones no expresan certeza de identidad. El umbral es el de DeepFace; no se calibró con fotos de documentos reales, cámaras variadas ni poblaciones representativas. La referencia se siembra manualmente: no hay integración con un registro oficial de DUI.
- No usar en producción ni cargar documentos reales. Antes de un piloto hacen falta HTTPS, autenticación de la integración, controles de abuso, cifrado, control de acceso, consentimiento, retención y borrado de biometría. Esta demo conserva datos hasta borrar los volúmenes. No compartas los enlaces de sesión ni las claves.
