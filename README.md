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

Abre la `url` del JSON que devuelve el script. Ingresa el mismo DUI y activa la cámara. Si el indicador marca poca luz, ponte frente a una fuente de luz hasta que el indicador cambie a «Iluminación adecuada». Parpadea y gira la cabeza cuando se indique. Después, mira al frente y mantente quieto: se inicia una cuenta regresiva y luego se toman cuatro fotos. Si se detecta posible suplantación, la pantalla indica cuántos intentos quedan; la tercera detección bloquea ese enlace.

- **Web:** `http://localhost:8080`. Abrir solo la portada no inicia una sesión.
- **API:** `http://localhost:8000/docs` para ver y probar el contrato.
- **PostgreSQL 16 + pgvector:** `db:5432`, accesible solo dentro de Compose; datos y fotos persisten en volúmenes separados.

El SQL de inicialización solo se ejecuta cuando la base es nueva. `docker compose down` detiene la demo sin borrar datos. Para eliminar los datos de prueba, usa `docker compose down -v`; esto borra ambos volúmenes.

Si ya tienes una base del MVP anterior, aplica la migración antes de actualizar la API:

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U faceid -d faceid < db/002-capturas.sql
docker compose up --build -d
```

## Cómo funciona

1. La integración usa `POST /personas` (multipart: `dui`, `nombre`, `foto`) para guardar la referencia JPEG en el volumen y almacenar ruta y embedding Facenet512 en PostgreSQL. La referencia se consulta por DUI; **el embedding no se usa para buscar entre personas**.
2. La integración crea la solicitud vía `POST /solicitudes` (JSON: `dui`, `id_conversacion`). Ambas operaciones requieren `X-Admin-Key`. La API genera un UUID y un token aleatorio; en la base guarda solo su hash. El enlace pone el token en el fragmento, no en la query HTTP, y vence en 30 minutos.
3. La web valida el enlace con `GET /solicitudes/{id_solicitud}`, encabezados `X-DUI` y `Authorization: Bearer …`. La API exige que coincidan solicitud, DUI y token; no devuelve la referencia ni el ID de la conversación.
4. [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) procesa la cámara localmente. El indicador mide la luminosidad media en la zona central del rostro y exige al menos 650 ms de luz adecuada antes de avanzar. Tras el parpadeo y el giro, la captura exige ojos abiertos, nitidez y una pose frontal estable (giro e inclinación lateral por debajo de 10°, e inclinación vertical por debajo de 12°). Espera 1,2 s, toma cuatro fotos a intervalos de al menos 180 ms y reinicia la secuencia si la persona se mueve o baja la calidad.
5. La web envía solo esas cuatro fotos JPEG a `POST /solicitudes/{id_solicitud}/verificar` (multipart: `dui` y un campo repetido `foto` por captura, con el mismo Bearer). La API acepta de una a cinco imágenes por envío. [DeepFace](https://github.com/serengil/deepface) ejecuta FasNet en cada foto: si alguna parece una suplantación, el envío cuenta como **un** intento y no se compara con la referencia. Los tres intentos se cuentan por solicitud, incluso si se recarga la página. Tras el tercero, el estado es `bloqueada_spoof` y nuevos envíos reciben HTTP 409.
6. Si todas las fotos pasan FasNet, DeepFace compara cada una con la referencia del DUI mediante Facenet512 y distancia coseno. Solo verifica una mayoría estricta de coincidencias (p. ej., al menos tres de cuatro); la distancia registrada es la mediana superior. PostgreSQL conserva el resultado, el contador y las rutas de todas las fotos de los envíos evaluados.

## Prueba sin cámara

Descarga las imágenes públicas de prueba de DeepFace y Silent-Face en una carpeta ignorada por Git. La prueba registra la referencia, comprueba el aislamiento por DUI y token, envía ráfagas de coincidencia y no coincidencia, y verifica que una ráfaga mixta consume un intento de suplantación y que el cuarto envío se bloquea.

```sh
mkdir -p demo-data
for n in 1 2 3; do
  curl -fsSL "https://raw.githubusercontent.com/serengil/deepface/v0.0.95/tests/dataset/img$n.jpg" -o "demo-data/img$n.jpg"
done
curl -fsSL https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/images/sample/image_F1.jpg -o demo-data/image_F1.jpg
bash scripts/probar.sh
```

Son fotos estáticas, no evidencia de presencia física. FasNet puede rechazarlas antes de comparar los rostros; el script muestra si esto ocurre. Estas fotos no ejercitan los gestos frente a la cámara.

## Consola de desarrollo y ciclado de modelos

Con `ENABLE_DEV_TOOLS=1` (habilitado por defecto en `compose.yaml`, desactivable en producción poniendo `ENABLE_DEV_TOOLS=0`), se expone `/dev` en la web y `/dev/*` en la API (protegidos con `X-Admin-Key`):

- **Registro y reemplazo de DUIs:** permite subir o actualizar la foto de referencia de cualquier DUI desde el navegador y generar enlaces de cliente al instante.
- **Feed en vivo y telemetría MediaPipe:** muestra los landmarks faciales, recorte de luminancia, pose 3D (`yaw`/`pitch`/`roll`), nitidez, estado de parpadeo y ráfaga en tiempo real.
- **Ciclado de modelos (`Facenet512`, `ArcFace`, `GhostFaceNet`, `SFace`, `Facenet`):** permite cambiar el modelo activo (`FACEID_MODEL` / `POST /dev/modelo-activo`) o comparar todos los modelos sobre la misma ráfaga desde `/dev` o por CLI:

```sh
bash scripts/ciclar-modelos.sh
```

## Límites

- La detección de presencia no está certificada: puede aceptar imágenes de pantalla o rechazar a personas reales. Los gestos del navegador mejoran la captura, pero no constituyen evidencia confiable para la API: el reto no se firma ni se valida en el servidor.
- Las puntuaciones no expresan certeza de identidad. El umbral es el de DeepFace; no se calibró con fotos de documentos reales, cámaras variadas ni poblaciones representativas. La referencia se siembra manualmente: no hay integración con un registro oficial de DUI.
- No usar en producción ni cargar documentos reales. Antes de un piloto hacen falta HTTPS, autenticación de la integración, controles de abuso, cifrado, control de acceso, consentimiento, retención y borrado de biometría. Esta demo conserva datos hasta borrar los volúmenes. No compartas los enlaces de sesión ni las claves.
