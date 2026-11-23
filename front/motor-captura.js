import { FaceLandmarker, FilesetResolver } from "/mediapipe/vision_bundle.mjs";
import { crearControlLuz, crearControlRafaga, evaluarImagen, evaluarRostro } from "./calidad.js";

export function crearMotorCaptura({ video, onFrame, onCaptura, onError }) {
  const muestra = document.createElement("canvas");
  muestra.width = muestra.height = 80;
  const contexto = muestra.getContext("2d", { willReadFrequently: true });
  const controlarLuz = crearControlLuz();
  const controlarRafaga = crearControlRafaga();

  let camara = null;
  let modelo = null;
  let fase = "preparar";
  let ultimaMuestra = 0;
  let ultimoTiempoVideo = -1;
  let fotogramas = [];
  let inicioParpadeo = 0;
  let saltarGestos = false;
  let capturaCompletada = false;

  function limpiarCandidatos() {
    controlarRafaga(null);
    fotogramas = [];
  }

  function calcularRecorte(caja) {
    const x = Math.max(0, caja.x + caja.w * .14);
    const y = Math.max(0, caja.y + caja.h * .12);
    const w = Math.min(1, caja.x + caja.w * .86) - x;
    const h = Math.min(1, caja.y + caja.h * .88) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  function medirCalidad(recorte) {
    if (!recorte) return { iluminacion: "buscando" };
    contexto.drawImage(
      video,
      recorte.x * video.videoWidth, recorte.y * video.videoHeight,
      recorte.w * video.videoWidth, recorte.h * video.videoHeight,
      0, 0, muestra.width, muestra.height,
    );
    const { data } = contexto.getImageData(0, 0, muestra.width, muestra.height);
    return evaluarImagen(data, muestra.width, muestra.height);
  }

  function guardarFotograma() {
    const lienzo = document.createElement("canvas");
    const escala = Math.min(1, 1280 / video.videoWidth);
    lienzo.width = Math.round(video.videoWidth * escala);
    lienzo.height = Math.round(video.videoHeight * escala);
    lienzo.getContext("2d").drawImage(video, 0, 0, lienzo.width, lienzo.height);
    fotogramas.push(lienzo);
  }

  function procesarResultado(deteccion, ahora, inferenciaMs) {
    const rostro = evaluarRostro(deteccion);
    const recorteLuz = rostro.caja ? calcularRecorte(rostro.caja) : null;
    const calidad = medirCalidad(recorteLuz);
    const luzEstable = controlarLuz(calidad.iluminacion, ahora);
    let mensaje = "";
    let rafaga = null;

    const emitir = () => onFrame?.({
      landmarks: deteccion.faceLandmarks,
      rostro,
      calidad,
      recorteLuz,
      luzEstable,
      fase,
      rafaga,
      mensaje,
      inferenciaMs,
    });

    if (rostro.error) {
      fase = "preparar";
      limpiarCandidatos();
      mensaje = rostro.error;
      emitir();
      return;
    }
    if (luzEstable !== "adecuada") {
      limpiarCandidatos();
      mensaje = "Espera a que la iluminación sea adecuada para continuar.";
      emitir();
      return;
    }
    if (fase === "girar") {
      mensaje = "Gira un poco la cabeza hacia un lado.";
      if (Math.abs(rostro.yaw) >= 18 && Math.abs(rostro.yaw) <= 40) {
        fase = "capturar";
        mensaje = "Vuelve a mirar de frente y mantén el rostro quieto.";
      }
      emitir();
      return;
    }
    const requiereCaptura = fase === "capturar" || (saltarGestos && fase === "preparar");
    if (!(requiereCaptura ? rostro.frontalParaCaptura : rostro.frontal)) {
      if (fase === "capturar") limpiarCandidatos();
      if (fase === "abrir") fase = "parpadear";
      mensaje = "Mira de frente a la cámara.";
      emitir();
      return;
    }
    if (fase === "parpadear") {
      mensaje = "Parpadea una vez y vuelve a abrir los ojos.";
      if (rostro.cerrados) {
        inicioParpadeo = ahora;
        fase = "abrir";
      }
      emitir();
      return;
    }
    if (fase === "abrir") {
      if (ahora - inicioParpadeo > 1000) fase = "parpadear";
      else if (rostro.abiertos) fase = "girar";
      emitir();
      return;
    }
    if (!rostro.abiertos) {
      limpiarCandidatos();
      mensaje = "Abre los ojos y mira a la cámara.";
      emitir();
      return;
    }
    if (calidad.error) {
      limpiarCandidatos();
      mensaje = calidad.error;
      emitir();
      return;
    }
    if (fase === "preparar") {
      if (saltarGestos) {
        fase = "capturar";
      } else {
        fase = "parpadear";
        mensaje = "Parpadea una vez y vuelve a abrir los ojos.";
        emitir();
        return;
      }
    }

    rafaga = controlarRafaga(rostro, ahora);
    if (rafaga.reinicio) fotogramas = [];
    if (rafaga.segundos) {
      mensaje = `Mantén la mirada al frente. Captura en ${rafaga.segundos}…`;
      emitir();
      return;
    }
    if (rafaga.tomar) guardarFotograma();
    mensaje = `Tomando fotos: ${rafaga.cantidad} de 4. Mantente quieto.`;
    emitir();
    if (rafaga.completa && !capturaCompletada) {
      capturaCompletada = true;
      onCaptura?.([...fotogramas]);
    }
  }

  function bucle(ahora) {
    if (!camara) return;
    try {
      if (video.readyState >= 2 && video.currentTime !== ultimoTiempoVideo && ahora - ultimaMuestra >= 50) {
        ultimoTiempoVideo = video.currentTime;
        ultimaMuestra = ahora;
        const inicio = performance.now();
        const deteccion = modelo.detectForVideo(video, ahora);
        procesarResultado(deteccion, ahora, performance.now() - inicio);
      }
    } catch (error) {
      detener();
      onError?.(error);
      return;
    }
    if (camara) requestAnimationFrame(bucle);
  }

  function detener() {
    camara?.getTracks().forEach(pista => pista.stop());
    camara = null;
    video.srcObject = null;
    controlarLuz("buscando");
    limpiarCandidatos();
  }

  async function iniciar(opciones = {}) {
    saltarGestos = Boolean(opciones.saltarGestos);
    capturaCompletada = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("La cámara requiere localhost o HTTPS.");
    }
    if (!modelo) {
      const archivos = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      modelo = await FaceLandmarker.createFromOptions(archivos, {
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    }
    camara = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = camara;
    await video.play();
    fase = "preparar";
    ultimaMuestra = 0;
    ultimoTiempoVideo = -1;
    limpiarCandidatos();
    requestAnimationFrame(bucle);
  }

  return {
    iniciar,
    detener,
    configurar(opciones = {}) {
      if ("saltarGestos" in opciones) saltarGestos = Boolean(opciones.saltarGestos);
    },
    estaActivo() {
      return Boolean(camara);
    },
  };
}
