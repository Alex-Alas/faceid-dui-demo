import { FaceLandmarker, FilesetResolver } from "/mediapipe/vision_bundle.mjs";
import { evaluarImagen, evaluarRostro } from "./calidad.js";

const elemento = id => document.getElementById(id);
const solicitud = new URLSearchParams(location.search).get("solicitud");
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const ruta = `/api/solicitudes/${encodeURIComponent(solicitud)}`;
const autorizacion = { Authorization: `Bearer ${token}` };
const video = elemento("video");
const muestra = document.createElement("canvas");
muestra.width = muestra.height = 80;
const contexto = muestra.getContext("2d", { willReadFrequently: true });
let dui;
let camara;
let modelo;
let fase;
let ultimaMuestra;
let ultimoTiempoVideo;
let fotogramas;
let mejor;
let inicioParpadeo;

function anunciar(mensaje, tipo = "") {
  const estado = elemento("estado");
  if (estado.textContent !== mensaje) estado.textContent = mensaje;
  estado.dataset.tipo = tipo;
}

async function solicitar(url, opciones) {
  const respuesta = await fetch(url, { ...opciones, cache: "no-store" });
  const datos = await respuesta.json().catch(() => null);
  if (!respuesta.ok || !datos) {
    throw new Error(typeof datos?.detail === "string" ? datos.detail : "No se pudo completar la solicitud.");
  }
  return datos;
}

function mostrarResultado(datos) {
  elemento("formulario").hidden = true;
  elemento("captura").hidden = true;
  elemento("titulo-paso").textContent = "Resultado";
  if (datos.estado === "verificada") anunciar("Identidad verificada.", "exito");
  else if (!datos.liveness_ok) anunciar("No pudimos confirmar la presencia real. Solicita un nuevo enlace.", "error");
  else anunciar("El rostro no coincide con la foto de referencia. Solicita un nuevo enlace.", "error");
}

if (!solicitud || !token) {
  elemento("continuar").disabled = true;
  anunciar("Abre el enlace completo que recibiste para iniciar la verificación.", "error");
}

elemento("formulario").addEventListener("submit", async evento => {
  evento.preventDefault();
  if (!solicitud || !token) return;
  dui = elemento("dui").value;
  elemento("continuar").disabled = true;
  anunciar("Validando el enlace…");
  try {
    const datos = await solicitar(ruta, { headers: { ...autorizacion, "X-DUI": dui } });
    if (datos.estado !== "pendiente") {
      mostrarResultado(datos);
      return;
    }
    elemento("formulario").hidden = true;
    elemento("captura").hidden = false;
    elemento("titulo-paso").textContent = "2. Prepara la cámara";
    anunciar("");
  } catch (error) {
    anunciar(error.message, "error");
  } finally {
    elemento("continuar").disabled = false;
  }
});

function detenerCamara() {
  camara?.getTracks().forEach(pista => pista.stop());
  camara = null;
  video.srcObject = null;
  elemento("visor").hidden = true;
}

function medirCalidad(caja) {
  contexto.drawImage(
    video, caja.x * video.videoWidth, caja.y * video.videoHeight,
    caja.w * video.videoWidth, caja.h * video.videoHeight, 0, 0, muestra.width, muestra.height,
  );
  const { data } = contexto.getImageData(0, 0, muestra.width, muestra.height);
  return evaluarImagen(data, muestra.width, muestra.height);
}

function guardarCandidato(puntaje) {
  if (mejor && puntaje <= mejor.puntaje) return;
  const lienzo = document.createElement("canvas");
  const escala = Math.min(1, 1280 / video.videoWidth);
  lienzo.width = Math.round(video.videoWidth * escala);
  lienzo.height = Math.round(video.videoHeight * escala);
  lienzo.getContext("2d").drawImage(video, 0, 0, lienzo.width, lienzo.height);
  mejor = { lienzo, puntaje };
}

async function enviarCaptura(lienzo) {
  detenerCamara();
  tituloCaptura("3. Verificando");
  anunciar("Comparando el rostro con la foto de referencia…");
  try {
    const foto = await new Promise(resolve => lienzo.toBlob(resolve, "image/jpeg", .9));
    if (!foto) throw new Error("No se pudo guardar la captura.");
    const contenido = new FormData();
    contenido.set("dui", dui);
    contenido.set("foto", foto, "captura.jpg");
    mostrarResultado(await solicitar(`${ruta}/verificar`, {
      method: "POST", headers: autorizacion, body: contenido,
    }));
  } catch (error) {
    tituloCaptura("2. Vuelve a intentar la captura");
    anunciar(error.message, "error");
    elemento("iniciar").hidden = false;
  }
}

function tituloCaptura(titulo) {
  elemento("titulo-paso").textContent = titulo;
}

function limpiarCandidatos() {
  fotogramas = 0;
  mejor = null;
}

function procesarRostro(rostro, ahora) {
  if (rostro.error) {
    fase = "preparar";
    limpiarCandidatos();
    anunciar(rostro.error);
    return;
  }

  if (fase === "girar") {
    anunciar("Gira un poco la cabeza hacia un lado.");
    if (Math.abs(rostro.yaw) >= 18 && Math.abs(rostro.yaw) <= 40) {
      fase = "capturar";
      anunciar("Vuelve a mirar de frente y mantén el rostro quieto.");
    }
    return;
  }
  if (!rostro.frontal) {
    if (fase === "capturar") limpiarCandidatos();
    if (fase === "abrir") fase = "parpadear";
    anunciar("Mira de frente a la cámara.");
    return;
  }
  if (fase === "parpadear") {
    anunciar("Parpadea una vez y vuelve a abrir los ojos.");
    if (rostro.cerrados) {
      inicioParpadeo = ahora;
      fase = "abrir";
    }
    return;
  }
  if (fase === "abrir") {
    if (ahora - inicioParpadeo > 1000) fase = "parpadear";
    else if (rostro.abiertos) fase = "girar";
    return;
  }
  if (!rostro.abiertos) {
    limpiarCandidatos();
    anunciar("Abre los ojos y mira a la cámara.");
    return;
  }
  const calidad = medirCalidad(rostro.caja);
  if (calidad.error) {
    limpiarCandidatos();
    anunciar(calidad.error);
    return;
  }
  if (fase === "preparar") {
    fase = "parpadear";
    anunciar("Parpadea una vez y vuelve a abrir los ojos.");
    return;
  }
  anunciar("Mantén el rostro quieto mientras se toma la foto.");
  fotogramas++;
  guardarCandidato(calidad.puntaje);
  if (fotogramas === 5) void enviarCaptura(mejor.lienzo);
}

function capturar(ahora) {
  if (!camara) return;
  try {
    if (video.readyState >= 2 && video.currentTime !== ultimoTiempoVideo && ahora - ultimaMuestra >= 50) {
      ultimoTiempoVideo = video.currentTime;
      ultimaMuestra = ahora;
      procesarRostro(evaluarRostro(modelo.detectForVideo(video, ahora)), ahora);
    }
  } catch {
    detenerCamara();
    elemento("iniciar").hidden = false;
    anunciar("No se pudo analizar la imagen de la cámara. Inténtalo de nuevo.", "error");
  }
  if (camara) requestAnimationFrame(capturar);
}

elemento("iniciar").addEventListener("click", async () => {
  const boton = elemento("iniciar");
  boton.disabled = true;
  anunciar("Cargando MediaPipe y preparando la cámara…");
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("La cámara requiere localhost o HTTPS.");
    if (!modelo) {
      const archivos = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      modelo = await FaceLandmarker.createFromOptions(archivos, {
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 2,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
    }
    camara = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = camara;
    elemento("visor").hidden = false;
    await video.play();
    boton.hidden = true;
    fase = "preparar";
    ultimaMuestra = 0;
    ultimoTiempoVideo = -1;
    limpiarCandidatos();
    anunciar("Sitúa tu rostro en la guía.");
    requestAnimationFrame(capturar);
  } catch (error) {
    detenerCamara();
    anunciar(error.name === "NotAllowedError" ? "Permite el acceso a la cámara e inténtalo de nuevo." : error.message, "error");
  } finally {
    boton.disabled = false;
  }
});

window.addEventListener("pagehide", detenerCamara);
