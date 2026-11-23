import { FaceLandmarker, FilesetResolver } from "/mediapipe/vision_bundle.mjs";
import { crearControlLuz, crearControlRafaga, evaluarImagen, evaluarRostro } from "./calidad.js";

const elemento = id => document.getElementById(id);
const solicitud = new URLSearchParams(location.search).get("solicitud");
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const ruta = `/api/solicitudes/${encodeURIComponent(solicitud)}`;
const autorizacion = { Authorization: `Bearer ${token}` };
const video = elemento("video");
const muestra = document.createElement("canvas");
muestra.width = muestra.height = 80;
const contexto = muestra.getContext("2d", { willReadFrequently: true });
const controlarLuz = crearControlLuz();
const controlarRafaga = crearControlRafaga();
const mensajesLuz = {
  buscando: "Iluminación: coloca tu rostro en la guía para medirla.",
  baja: "Poca luz: acércate a una fuente de luz frente a ti.",
  alta: "Demasiada luz: evita que ilumine tu rostro directamente.",
  ajustando: "Iluminación: mantén la luz estable un momento.",
  adecuada: "Iluminación adecuada.",
};
let dui;
let camara;
let modelo;
let fase;
let ultimaMuestra;
let ultimoTiempoVideo;
let fotogramas = [];
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
  else if (datos.estado === "bloqueada_spoof") {
    anunciar("Verificación bloqueada tras tres detecciones de posible suplantación. Solicita un nuevo enlace.", "error");
  }
  else if (!datos.liveness_ok) anunciar("No pudimos confirmar la presencia real. Solicita un nuevo enlace.", "error");
  else anunciar("El rostro no coincide con la foto de referencia. Solicita un nuevo enlace.", "error");
}

function anunciarReintento(restantes) {
  const aviso = restantes === 1 ? "Te queda 1 intento." : `Te quedan ${restantes} intentos.`;
  tituloCaptura("2. Repite la captura");
  elemento("iniciar").textContent = "Volver a activar la cámara";
  elemento("iniciar").hidden = false;
  anunciar(`Detectamos una posible suplantación. ${aviso} Usa tu rostro directamente frente a la cámara.`, "error");
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
    if (datos.intentos_spoof) anunciarReintento(datos.intentos_spoof_restantes);
    else anunciar("");
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
  elemento("luz").hidden = true;
  controlarLuz("buscando");
}

function medirCalidad(caja) {
  const x = Math.max(0, caja.x + caja.w * .14);
  const y = Math.max(0, caja.y + caja.h * .12);
  const ancho = Math.min(1, caja.x + caja.w * .86) - x;
  const alto = Math.min(1, caja.y + caja.h * .88) - y;
  if (ancho <= 0 || alto <= 0) return { iluminacion: "buscando" };
  contexto.drawImage(
    video, x * video.videoWidth, y * video.videoHeight,
    ancho * video.videoWidth, alto * video.videoHeight, 0, 0, muestra.width, muestra.height,
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

function mostrarLuz(luz) {
  const indicador = elemento("luz");
  indicador.hidden = false;
  if (indicador.dataset.luz !== luz) {
    indicador.dataset.luz = luz;
    indicador.textContent = mensajesLuz[luz];
  }
}

async function enviarCaptura(lienzos) {
  detenerCamara();
  tituloCaptura("3. Verificando");
  anunciar("Comparando el rostro con la foto de referencia…");
  try {
    const fotos = await Promise.all(lienzos.map(lienzo => new Promise(resolve => lienzo.toBlob(resolve, "image/jpeg", .9))));
    if (fotos.some(foto => !foto)) throw new Error("No se pudo guardar la ráfaga.");
    const contenido = new FormData();
    contenido.set("dui", dui);
    fotos.forEach((foto, i) => contenido.append("foto", foto, `captura-${i + 1}.jpg`));
    const datos = await solicitar(`${ruta}/verificar`, {
      method: "POST", headers: autorizacion, body: contenido,
    });
    if (datos.estado === "pendiente") anunciarReintento(datos.intentos_spoof_restantes);
    else mostrarResultado(datos);
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
  controlarRafaga(null);
  fotogramas = [];
}

function procesarRostro(rostro, ahora) {
  const calidad = rostro.caja ? medirCalidad(rostro.caja) : { iluminacion: "buscando" };
  const luz = controlarLuz(calidad.iluminacion, ahora);
  mostrarLuz(luz);
  if (rostro.error) {
    fase = "preparar";
    limpiarCandidatos();
    anunciar(rostro.error);
    return;
  }
  if (luz !== "adecuada") {
    limpiarCandidatos();
    anunciar("Espera a que la iluminación sea adecuada para continuar.");
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
  if (!(fase === "capturar" ? rostro.frontalParaCaptura : rostro.frontal)) {
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
  const rafaga = controlarRafaga(rostro, ahora);
  if (rafaga.reinicio) fotogramas = [];
  if (rafaga.segundos) {
    anunciar(`Mantén la mirada al frente. Captura en ${rafaga.segundos}…`);
    return;
  }
  if (rafaga.tomar) guardarFotograma();
  anunciar(`Tomando fotos: ${rafaga.cantidad} de 4. Mantente quieto.`);
  if (rafaga.completa) void enviarCaptura(fotogramas);
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
    mostrarLuz("buscando");
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
