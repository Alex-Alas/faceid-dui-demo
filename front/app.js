import { FaceLandmarker, FilesetResolver } from "/mediapipe/vision_bundle.mjs";
import { areaUtil, evaluarImagen, evaluarRostro } from "./calidad.js";

const elemento = id => document.getElementById(id);
const solicitud = new URLSearchParams(location.search).get("solicitud");
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const ruta = `/api/solicitudes/${encodeURIComponent(solicitud)}`;
const autorizacion = { Authorization: `Bearer ${token}` };
const video = elemento("video");
const superposicion = elemento("superposicion");
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
let modoDesarrollo = false;
let ultimoPanel = 0;
let cuadrosProcesados = 0;
let inicioCuadros = 0;

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

/* ---------- Panel técnico (solo modo desarrollo) ---------- */

const numero = (valor, decimales = 2) => (typeof valor === "number" ? valor.toFixed(decimales) : "—");

function registrar(mensaje) {
  if (!modoDesarrollo) return;
  const lista = elemento("bitacora");
  const item = document.createElement("li");
  const hora = document.createElement("time");
  hora.textContent = new Date().toLocaleTimeString();
  item.append(hora, mensaje);
  lista.prepend(item);
  while (lista.children.length > 80) lista.lastChild.remove();
}

function cambiarFase(nueva, motivo) {
  if (fase !== nueva) registrar(`Fase: ${fase ?? "—"} → ${nueva}${motivo ? ` (${motivo})` : ""}`);
  fase = nueva;
}

function mostrarMetricas(rostro, calidad) {
  const ahora = performance.now();
  if (!modoDesarrollo || ahora - ultimoPanel < 120) return;
  ultimoPanel = ahora;
  const fps = cuadrosProcesados / Math.max(.001, (ahora - inicioCuadros) / 1000);
  const filas = [
    ["Fase", fase, true],
    ["Rostros", rostro.rostros ?? 0, rostro.rostros === 1],
    ["Ancho cara", numero(rostro.caja?.w), rostro.caja && rostro.caja.w >= .22 && rostro.caja.w <= .72],
    ["Alto cara", numero(rostro.caja?.h), rostro.caja && rostro.caja.h >= .32 && rostro.caja.h <= .85],
    ["Yaw (giro)", `${numero(rostro.yaw, 1)}°`, Math.abs(rostro.yaw ?? 99) < 12],
    ["Pitch", `${numero(rostro.pitch, 1)}°`, Math.abs(rostro.pitch ?? 99) < 18],
    ["Roll", `${numero(rostro.roll, 1)}°`, Math.abs(rostro.roll ?? 99) < 15],
    ["Parpadeo izq", numero(rostro.parpadeoIzq), (rostro.parpadeoIzq ?? 1) < .4],
    ["Parpadeo der", numero(rostro.parpadeoDer), (rostro.parpadeoDer ?? 1) < .4],
    ["Luz (55–225)", numero(calidad?.luz, 0), calidad?.luz >= 55 && calidad?.luz <= 225],
    ["Nitidez (≥45)", numero(calidad?.nitidez, 0), calidad?.nitidez >= 45],
    ["Puntaje", numero(calidad?.puntaje, 0), calidad?.puntaje !== undefined],
    ["Candidatos", `${fotogramas ?? 0}/5`, true],
    ["Cuadros/s", numero(fps, 1), true],
    ["Video", `${video.videoWidth}×${video.videoHeight}`, true],
    ["Veredicto", rostro.error ?? calidad?.error ?? "apto", !(rostro.error ?? calidad?.error)],
  ];
  elemento("metricas").replaceChildren(...filas.map(([nombre, valor, ok]) => {
    const div = document.createElement("div");
    div.className = ok ? "ok" : "mal";
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = nombre;
    dd.textContent = valor;
    div.append(dt, dd);
    return div;
  }));
}

function dibujar(resultado, rostro) {
  if (!modoDesarrollo) return;
  if (superposicion.width !== video.videoWidth) superposicion.width = video.videoWidth;
  if (superposicion.height !== video.videoHeight) superposicion.height = video.videoHeight;
  const ctx = superposicion.getContext("2d");
  ctx.clearRect(0, 0, superposicion.width, superposicion.height);
  const color = rostro.error ? "#ff6b81" : "#4ade80";
  for (const puntos of resultado.faceLandmarks) {
    ctx.fillStyle = color;
    for (const p of puntos) ctx.fillRect(p.x * superposicion.width - 1, p.y * superposicion.height - 1, 2, 2);
  }
  if (rostro.caja) {
    const { x, y, w, h } = rostro.caja;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x * superposicion.width, y * superposicion.height, w * superposicion.width, h * superposicion.height);
  }
}

const NOMBRES_IMAGEN = { captura: "Captura", rostro: "Rostro detectado", referencia: "Referencia (DUI)" };
const SIGUIENTE = {
  front: "Subiendo la captura a la API…",
  recibida: "Ejecutando FasNet (detección de presencia)…",
  presencia: "Comparando con la referencia (Facenet512)…",
};

function limpiarPasos() {
  elemento("pasos").replaceChildren();
}

function quitarPendiente() {
  elemento("pasos").querySelector(".corriendo")?.remove();
}

function pasoPendiente(texto) {
  quitarPendiente();
  const item = document.createElement("li");
  item.className = "corriendo";
  item.textContent = texto;
  elemento("pasos").append(item);
}

function barraDistancia(distancia, umbral) {
  const maximo = Math.max(umbral * 2, distancia * 1.1);
  const barra = document.createElement("div");
  barra.className = "barra";
  const relleno = document.createElement("span");
  relleno.style.width = `${Math.min(100, (distancia / maximo) * 100)}%`;
  relleno.style.background = distancia <= umbral ? "#3ccf7f" : "#f0566c";
  const marca = document.createElement("i");
  marca.style.left = `${(umbral / maximo) * 100}%`;
  marca.title = `Umbral ${umbral}`;
  barra.append(relleno, marca);
  return barra;
}

function pintarPaso(evento) {
  quitarPendiente();
  const item = document.createElement("li");
  item.className = evento.ok ? "ok" : "mal";
  const titulo = document.createElement("div");
  titulo.className = "titulo";
  titulo.append(`${evento.ok ? "✔" : "✘"} ${evento.titulo}`);
  if (evento.ms !== undefined) {
    const tiempo = document.createElement("span");
    tiempo.textContent = `${evento.ms} ms`;
    titulo.append(tiempo);
  }
  item.append(titulo);
  const { nota, ...detalle } = evento.detalle ?? {};
  const datos = document.createElement("div");
  datos.className = "datos";
  datos.textContent = Object.entries(detalle)
    .map(([clave, valor]) => `${clave}: ${typeof valor === "object" && valor ? JSON.stringify(valor) : typeof valor === "number" && !Number.isInteger(valor) ? valor.toFixed(4) : valor}`)
    .join("\n");
  item.append(datos);
  if (evento.paso === "comparacion") item.append(barraDistancia(detalle.distancia, detalle.umbral));
  if (nota) {
    const parrafo = document.createElement("div");
    parrafo.className = "nota";
    parrafo.textContent = nota;
    item.append(parrafo);
  }
  const imagenes = Object.entries(evento.imagenes ?? {}).filter(([, src]) => src);
  if (imagenes.length) {
    const contenedor = document.createElement("div");
    contenedor.className = "imagenes";
    for (const [clave, src] of imagenes) {
      const figura = document.createElement("figure");
      const imagen = document.createElement("img");
      imagen.src = src;
      imagen.alt = NOMBRES_IMAGEN[clave] ?? clave;
      const leyenda = document.createElement("figcaption");
      leyenda.textContent = NOMBRES_IMAGEN[clave] ?? clave;
      figura.append(imagen, leyenda);
      contenedor.append(figura);
    }
    item.append(contenedor);
  }
  elemento("pasos").append(item);
  registrar(`Backend: ${evento.titulo} → ${evento.ok ? "ok" : "falla"}${evento.ms !== undefined ? ` en ${evento.ms} ms` : ""}`);
  if (SIGUIENTE[evento.paso] && evento.ok) pasoPendiente(SIGUIENTE[evento.paso]);
}

async function cargarHistorial() {
  if (!modoDesarrollo) return;
  try {
    const intentos = await solicitar(`${ruta}/intentos`, { headers: { ...autorizacion, "X-DUI": dui } });
    elemento("historial").replaceChildren(...intentos.map(intento => {
      const fila = document.createElement("tr");
      const celdas = [
        new Date(intento.created_at).toLocaleTimeString(),
        intento.estado,
        intento.liveness_ok ? `real (${numero(intento.liveness_score, 3)})` : `falso (${numero(intento.liveness_score, 3)})`,
        intento.match_distance === null ? "—" : `${numero(intento.match_distance, 3)} / ${numero(intento.match_threshold, 2)}`,
      ];
      fila.append(...celdas.map(texto => {
        const celda = document.createElement("td");
        celda.textContent = texto;
        return celda;
      }));
      return fila;
    }));
  } catch (error) {
    registrar(`No se pudo cargar el historial: ${error.message}`);
  }
}

/* ---------- Flujo principal ---------- */

function mostrarResultado(datos) {
  elemento("formulario").hidden = true;
  elemento("captura").hidden = true;
  elemento("titulo-paso").textContent = "Resultado";
  const otraVez = modoDesarrollo ? "Puedes volver a intentarlo con este mismo enlace." : "Solicita un nuevo enlace.";
  if (datos.estado === "verificada") anunciar("Identidad verificada.", "exito");
  else if (!datos.liveness_ok) anunciar(`No pudimos confirmar la presencia real. ${otraVez}`, "error");
  else anunciar(`El rostro no coincide con la foto de referencia. ${otraVez}`, "error");
  elemento("reintentar").hidden = !modoDesarrollo;
}

function prepararCaptura() {
  elemento("formulario").hidden = true;
  elemento("captura").hidden = false;
  elemento("iniciar").hidden = false;
  elemento("reintentar").hidden = true;
  elemento("titulo-paso").textContent = "2. Prepara la cámara";
  anunciar("");
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
    modoDesarrollo = Boolean(datos.modo_desarrollo);
    if (modoDesarrollo) {
      document.body.classList.add("desarrollo");
      elemento("panel").hidden = false;
      registrar(`Enlace válido. Estado actual: ${datos.estado}. Vence: ${new Date(datos.expires_at).toLocaleString()}`);
      void cargarHistorial();
    }
    if (datos.estado !== "pendiente" && !modoDesarrollo) {
      mostrarResultado(datos);
      return;
    }
    prepararCaptura();
  } catch (error) {
    anunciar(error.message, "error");
  } finally {
    elemento("continuar").disabled = false;
  }
});

elemento("reintentar").addEventListener("click", () => {
  registrar("Nuevo intento con el mismo enlace.");
  prepararCaptura();
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
  const area = detectarAreaUtil();
  const sx = Math.round(area.x * video.videoWidth);
  const sy = Math.round(area.y * video.videoHeight);
  const sw = Math.round(area.w * video.videoWidth);
  const sh = Math.round(area.h * video.videoHeight);
  const lienzo = document.createElement("canvas");
  const escala = Math.min(1, 1280 / sw);
  lienzo.width = Math.round(sw * escala);
  lienzo.height = Math.round(sh * escala);
  lienzo.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, lienzo.width, lienzo.height);
  mejor = { lienzo, puntaje, area, video: `${video.videoWidth}×${video.videoHeight}` };
}

function detectarAreaUtil() {
  const ancho = 160;
  const alto = Math.max(1, Math.round(ancho * video.videoHeight / video.videoWidth));
  const lienzo = document.createElement("canvas");
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, ancho, alto);
  return areaUtil(ctx.getImageData(0, 0, ancho, alto).data, ancho, alto);
}

async function verificarConTraza(contenido, candidato) {
  limpiarPasos();
  const recortada = candidato.area.w < 1 || candidato.area.h < 1;
  pintarPaso({
    paso: "front", ok: true, titulo: "Captura elegida por el front (MediaPipe)",
    detalle: {
      video: candidato.video,
      enviada: `${candidato.lienzo.width}×${candidato.lienzo.height}`,
      barras_negras: recortada ? "recortadas" : "no había",
      puntaje_calidad: candidato.puntaje,
    },
    imagenes: { captura: candidato.lienzo.toDataURL("image/jpeg", .7) },
  });
  const respuesta = await fetch(`${ruta}/verificar/traza`, {
    method: "POST", headers: autorizacion, body: contenido, cache: "no-store",
  });
  if (!respuesta.ok) {
    const datos = await respuesta.json().catch(() => null);
    throw new Error(typeof datos?.detail === "string" ? datos.detail : "No se pudo completar la solicitud.");
  }
  const lector = respuesta.body.pipeThrough(new TextDecoderStream()).getReader();
  let resto = "";
  let final;
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    resto += value;
    let corte;
    while ((corte = resto.indexOf("\n")) >= 0) {
      const linea = resto.slice(0, corte).trim();
      resto = resto.slice(corte + 1);
      if (!linea) continue;
      const evento = JSON.parse(linea);
      if (evento.paso === "fin") final = evento;
      else if (evento.paso === "error") throw new Error(evento.mensaje);
      else pintarPaso(evento);
    }
  }
  quitarPendiente();
  if (!final) throw new Error("La API cerró la conexión sin resultado.");
  registrar(`Resultado: ${final.estado} (intento ${final.id_intento.slice(0, 8)})`);
  return final;
}

async function enviarCaptura(candidato) {
  detenerCamara();
  tituloCaptura("3. Verificando");
  anunciar("Comparando el rostro con la foto de referencia…");
  registrar("Cinco candidatos válidos: se envía el de mejor puntaje.");
  try {
    const foto = await new Promise(resolve => candidato.lienzo.toBlob(resolve, "image/jpeg", .9));
    if (!foto) throw new Error("No se pudo guardar la captura.");
    const contenido = new FormData();
    contenido.set("dui", dui);
    contenido.set("foto", foto, "captura.jpg");
    const datos = modoDesarrollo
      ? await verificarConTraza(contenido, candidato)
      : await solicitar(`${ruta}/verificar`, { method: "POST", headers: autorizacion, body: contenido });
    mostrarResultado(datos);
  } catch (error) {
    quitarPendiente();
    registrar(`Error: ${error.message}`);
    tituloCaptura("2. Vuelve a intentar la captura");
    anunciar(error.message, "error");
    elemento("iniciar").hidden = false;
  } finally {
    void cargarHistorial();
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
    cambiarFase("preparar", rostro.error);
    limpiarCandidatos();
    anunciar(rostro.error);
    mostrarMetricas(rostro, modoDesarrollo && rostro.caja ? medirCalidad(rostro.caja) : null);
    return;
  }
  const calidadPanel = modoDesarrollo ? medirCalidad(rostro.caja) : null;
  mostrarMetricas(rostro, calidadPanel);

  if (fase === "girar") {
    anunciar("Gira un poco la cabeza hacia un lado.");
    if (Math.abs(rostro.yaw) >= 18 && Math.abs(rostro.yaw) <= 40) {
      cambiarFase("capturar", `giro detectado, yaw ${rostro.yaw.toFixed(1)}°`);
      anunciar("Vuelve a mirar de frente y mantén el rostro quieto.");
    }
    return;
  }
  if (!rostro.frontal) {
    if (fase === "capturar") limpiarCandidatos();
    if (fase === "abrir") cambiarFase("parpadear", "dejó de mirar de frente");
    anunciar("Mira de frente a la cámara.");
    return;
  }
  if (fase === "parpadear") {
    anunciar("Parpadea una vez y vuelve a abrir los ojos.");
    if (rostro.cerrados) {
      inicioParpadeo = ahora;
      cambiarFase("abrir", "ojos cerrados");
    }
    return;
  }
  if (fase === "abrir") {
    if (ahora - inicioParpadeo > 1000) cambiarFase("parpadear", "parpadeo demasiado largo");
    else if (rostro.abiertos) cambiarFase("girar", "parpadeo completo");
    return;
  }
  if (!rostro.abiertos) {
    limpiarCandidatos();
    anunciar("Abre los ojos y mira a la cámara.");
    return;
  }
  const calidad = calidadPanel ?? medirCalidad(rostro.caja);
  if (calidad.error) {
    limpiarCandidatos();
    anunciar(calidad.error);
    return;
  }
  if (fase === "preparar") {
    cambiarFase("parpadear", "rostro apto");
    anunciar("Parpadea una vez y vuelve a abrir los ojos.");
    return;
  }
  anunciar("Mantén el rostro quieto mientras se toma la foto.");
  fotogramas++;
  guardarCandidato(calidad.puntaje);
  registrar(`Candidato ${fotogramas}/5 · puntaje ${calidad.puntaje.toFixed(0)} · luz ${calidad.luz.toFixed(0)} · nitidez ${calidad.nitidez.toFixed(0)}`);
  if (fotogramas === 5) void enviarCaptura(mejor);
}

function capturar(ahora) {
  if (!camara) return;
  try {
    if (video.readyState >= 2 && video.currentTime !== ultimoTiempoVideo && ahora - ultimaMuestra >= 50) {
      ultimoTiempoVideo = video.currentTime;
      ultimaMuestra = ahora;
      const resultado = modelo.detectForVideo(video, ahora);
      const rostro = evaluarRostro(resultado);
      cuadrosProcesados++;
      dibujar(resultado, rostro);
      procesarRostro(rostro, ahora);
    }
  } catch (error) {
    detenerCamara();
    elemento("iniciar").hidden = false;
    registrar(`Error al analizar la cámara: ${error.message}`);
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
      registrar("Cargando MediaPipe Face Landmarker (WASM, CPU)…");
      const archivos = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      modelo = await FaceLandmarker.createFromOptions(archivos, {
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 2,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      registrar("MediaPipe listo.");
    }
    camara = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = camara;
    elemento("visor").hidden = false;
    await video.play();
    registrar(`Cámara activa: ${video.videoWidth}×${video.videoHeight}`);
    boton.hidden = true;
    fase = undefined;
    cambiarFase("preparar");
    ultimaMuestra = 0;
    ultimoTiempoVideo = -1;
    cuadrosProcesados = 0;
    inicioCuadros = performance.now();
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
