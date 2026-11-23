import { crearMotorCaptura } from "./motor-captura.js";

const elemento = id => document.getElementById(id);
const solicitud = new URLSearchParams(location.search).get("solicitud");
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const ruta = `/api/solicitudes/${encodeURIComponent(solicitud)}`;
const autorizacion = { Authorization: `Bearer ${token}` };
const mensajesLuz = {
  buscando: "Iluminación: coloca tu rostro en la guía para medirla.",
  baja: "Poca luz: acércate a una fuente de luz frente a ti.",
  alta: "Demasiada luz: evita que ilumine tu rostro directamente.",
  ajustando: "Iluminación: mantén la luz estable un momento.",
  adecuada: "Iluminación adecuada.",
};
let dui;

function anunciar(mensaje, tipo = "") {
  const estado = elemento("estado");
  if (estado.textContent !== mensaje) estado.textContent = mensaje;
  estado.dataset.tipo = tipo;
}

function tituloCaptura(titulo) {
  elemento("titulo-paso").textContent = titulo;
}

function mostrarLuz(luz) {
  const indicador = elemento("luz");
  indicador.hidden = false;
  if (indicador.dataset.luz !== luz) {
    indicador.dataset.luz = luz;
    indicador.textContent = mensajesLuz[luz];
  }
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

function detenerVisor() {
  motor.detener();
  elemento("visor").hidden = true;
  elemento("luz").hidden = true;
}

async function enviarCaptura(lienzos) {
  detenerVisor();
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

const motor = crearMotorCaptura({
  video: elemento("video"),
  onFrame(t) {
    mostrarLuz(t.luzEstable);
    if (t.mensaje) anunciar(t.mensaje);
  },
  onCaptura(lienzos) {
    void enviarCaptura(lienzos);
  },
  onError() {
    detenerVisor();
    elemento("iniciar").hidden = false;
    anunciar("No se pudo analizar la imagen de la cámara. Inténtalo de nuevo.", "error");
  },
});

if (!solicitud || !token) {
  elemento("continuar").disabled = true;
  anunciar("Abre el enlace completo que recibiste para iniciar la verificación.", "error");
  fetch("/api/health", { cache: "no-store" })
    .then(r => (r.ok ? r.json() : null))
    .then(datos => {
      if (datos?.dev_habilitado) elemento("acceso-dev").hidden = false;
    })
    .catch(() => {});
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

elemento("iniciar").addEventListener("click", async () => {
  const boton = elemento("iniciar");
  boton.disabled = true;
  anunciar("Cargando MediaPipe y preparando la cámara…");
  try {
    elemento("visor").hidden = false;
    await motor.iniciar();
    boton.hidden = true;
    mostrarLuz("buscando");
    anunciar("Sitúa tu rostro en la guía.");
  } catch (error) {
    detenerVisor();
    anunciar(error.name === "NotAllowedError" ? "Permite el acceso a la cámara e inténtalo de nuevo." : error.message, "error");
  } finally {
    boton.disabled = false;
  }
});

window.addEventListener("pagehide", detenerVisor);
