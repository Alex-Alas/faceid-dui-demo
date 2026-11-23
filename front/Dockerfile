FROM node:22-alpine AS test
WORKDIR /src
RUN printf '{"type":"module"}\n' > package.json
COPY calidad.js motor-captura.js app.js dev.js calidad.test.mjs ./
RUN node --check motor-captura.js && node --check app.js && node --check dev.js && node --test calidad.test.mjs

FROM nginx:1.28-alpine
RUN mkdir -p /usr/share/nginx/html/mediapipe \
    && wget -qO /tmp/vision.tgz https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz \
    && tar -xzf /tmp/vision.tgz -C /usr/share/nginx/html/mediapipe --strip-components=1 \
        package/vision_bundle.mjs package/wasm/vision_wasm_internal.js package/wasm/vision_wasm_internal.wasm \
        package/wasm/vision_wasm_nosimd_internal.js package/wasm/vision_wasm_nosimd_internal.wasm \
    && rm /tmp/vision.tgz \
    && wget -qO /usr/share/nginx/html/mediapipe/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
COPY default.conf /etc/nginx/conf.d/default.conf
COPY --from=test /src/calidad.js /usr/share/nginx/html/calidad.js
COPY index.html app.js motor-captura.js styles.css dev.html dev.js dev.css /usr/share/nginx/html/
