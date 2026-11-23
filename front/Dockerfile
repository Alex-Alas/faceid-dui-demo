FROM nginx:1.28-alpine
RUN mkdir -p /usr/share/nginx/html/mediapipe \
    && wget -qO /tmp/vision.tgz https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz \
    && tar -xzf /tmp/vision.tgz -C /usr/share/nginx/html/mediapipe --strip-components=1 \
        package/vision_bundle.mjs package/wasm/vision_wasm_internal.js package/wasm/vision_wasm_internal.wasm \
        package/wasm/vision_wasm_nosimd_internal.js package/wasm/vision_wasm_nosimd_internal.wasm \
    && rm /tmp/vision.tgz \
    && wget -qO /usr/share/nginx/html/mediapipe/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html app.js calidad.js styles.css /usr/share/nginx/html/
