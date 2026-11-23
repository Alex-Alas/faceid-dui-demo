import { crearMotorCaptura } from "./motor-captura.js";

const STORAGE_KEY = "faceid_dev_admin_key";
const el = id => document.getElementById(id);

let adminKey = "";
let modelosDisponibles = [];
let ultimaRafaga = [];
let ultimoDui = "";
let previewRefUrl = null;
let serverRefUrl = null;

function avisar(texto, tipo = "") {
  const box = el("aviso-global");
  if (!texto) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = texto;
  box.dataset.tipo = tipo;
}

async function apiDev(ruta, opciones = {}) {
  const headers = new Headers(opciones.headers || {});
  headers.set("X-Admin-Key", adminKey);
  const resp = await fetch(`/api${ruta}`, { ...opciones, headers, cache: "no-store" });
  const datos = await resp.json().catch(() => null);
  if (!resp.ok || !datos) {
    throw new Error(typeof datos?.detail === "string" ? datos.detail : `Error HTTP ${resp.status}`);
  }
  return datos;
}

function habilitarControles(activo) {
  for (const id of [
    "modelo-global", "btn-guardar-modelo", "btn-guardar-persona",
    "btn-solo-enlace", "btn-iniciar-camara", "btn-evaluar-fijas",
    "btn-ciclar-todos", "btn-evaluar-seleccion",
  ]) {
    el(id).disabled = !activo;
  }
}

function mostrarPreviewRef(src) {
  const img = el("preview-ref");
  const vacio = el("preview-ref-vacio");
  if (src) {
    img.src = src;
    img.hidden = false;
    vacio.hidden = true;
  } else {
    img.removeAttribute("src");
    img.hidden = true;
    vacio.hidden = false;
  }
}

async function cargarReferenciaServidor(dui) {
  if (serverRefUrl) URL.revokeObjectURL(serverRefUrl);
  serverRefUrl = null;
  try {
    const resp = await fetch(`/api/dev/personas/${encodeURIComponent(dui)}/referencia`, {
      headers: { "X-Admin-Key": adminKey },
      cache: "no-store",
    });
    if (!resp.ok) {
      mostrarPreviewRef(null);
      return;
    }
    const blob = await resp.blob();
    serverRefUrl = URL.createObjectURL(blob);
    mostrarPreviewRef(serverRefUrl);
  } catch {
    mostrarPreviewRef(null);
  }
}

function renderPersonas(personas) {
  const cont = el("lista-duis");
  cont.replaceChildren();
  if (!personas.length) {
    const p = document.createElement("span");
    p.className = "tenue";
    p.textContent = "No hay DUIs registrados aún. Sube el primero abajo.";
    cont.appendChild(p);
    return;
  }
  for (const persona of personas) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    if (el("dui").value === persona.dui) btn.classList.add("activo");
    btn.textContent = `${persona.dui} · ${persona.nombre}`;
    btn.addEventListener("click", () => {
      el("dui").value = persona.dui;
      el("nombre").value = persona.nombre;
      ultimoDui = persona.dui;
      el("foto-ref").value = "";
      void cargarReferenciaServidor(persona.dui);
      for (const c of cont.querySelectorAll(".chip")) c.classList.remove("activo");
      btn.classList.add("activo");
    });
    cont.appendChild(btn);
  }
  if (!el("dui").value && personas[0]) {
    el("dui").value = personas[0].dui;
    el("nombre").value = personas[0].nombre;
    ultimoDui = personas[0].dui;
    cont.firstChild?.classList.add("activo");
    void cargarReferenciaServidor(personas[0].dui);
  }
}

function renderModelos(disponibles, activo) {
  modelosDisponibles = disponibles;
  const select = el("modelo-global");
  select.replaceChildren();
  for (const m of disponibles) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    opt.selected = m === activo;
    select.appendChild(opt);
  }

  const checks = el("selector-modelos");
  if (!checks.childElementCount) {
    for (const m of disponibles) {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = m;
      input.checked = true;
      label.append(input, ` ${m}`);
      checks.appendChild(label);
    }
  }
}

async function conectar() {
  adminKey = el("admin-key").value.trim();
  if (!adminKey) {
    el("badge-auth").textContent = "Sin conectar";
    el("badge-auth").dataset.estado = "off";
    habilitarControles(false);
    return;
  }
  try {
    const estado = await apiDev("/dev/estado");
    localStorage.setItem(STORAGE_KEY, adminKey);
    el("badge-auth").textContent = `Conectado (${estado.modelo_activo})`;
    el("badge-auth").dataset.estado = "ok";
    habilitarControles(true);
    renderModelos(estado.modelos_disponibles, estado.modelo_activo);
    renderPersonas(estado.personas);
    avisar("");
  } catch (error) {
    el("badge-auth").textContent = "Clave inválida";
    el("badge-auth").dataset.estado = "err";
    habilitarControles(false);
    avisar(error.message, "error");
  }
}

function mostrarEnlace(solicitud) {
  if (!solicitud?.url) return;
  el("caja-enlace").hidden = false;
  el("url-generada").value = solicitud.url;
  el("btn-abrir").href = solicitud.url;
}

el("form-auth").addEventListener("submit", evento => {
  evento.preventDefault();
  void conectar();
});

el("btn-guardar-modelo").addEventListener("click", async () => {
  const modelo = el("modelo-global").value;
  try {
    const res = await apiDev("/dev/modelo-activo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelo }),
    });
    el("badge-auth").textContent = `Conectado (${res.modelo_activo})`;
    avisar(`Modelo global cambiado a ${res.modelo_activo} para los enlaces de cliente.`, "exito");
  } catch (error) {
    avisar(error.message, "error");
  }
});

el("foto-ref").addEventListener("change", () => {
  const archivo = el("foto-ref").files?.[0];
  if (previewRefUrl) URL.revokeObjectURL(previewRefUrl);
  previewRefUrl = null;
  if (archivo) {
    previewRefUrl = URL.createObjectURL(archivo);
    mostrarPreviewRef(previewRefUrl);
  }
});

el("form-persona").addEventListener("submit", async evento => {
  evento.preventDefault();
  const archivo = el("foto-ref").files?.[0];
  if (!archivo) {
    avisar("Adjunta una imagen de referencia JPEG o PNG para guardar el DUI.", "error");
    return;
  }
  const btn = el("btn-guardar-persona");
  btn.disabled = true;
  avisar("Calculando embedding Facenet512 y guardando referencia…");
  try {
    const form = new FormData();
    form.set("dui", el("dui").value.trim());
    form.set("nombre", el("nombre").value.trim());
    form.set("foto", archivo);
    form.set("crear_solicitud", "true");
    const res = await apiDev("/dev/personas", { method: "POST", body: form });
    ultimoDui = res.dui;
    mostrarEnlace(res.solicitud);
    const estado = await apiDev("/dev/estado");
    renderPersonas(estado.personas);
    await cargarReferenciaServidor(res.dui);
    avisar(`DUI ${res.dui} (${res.estado}) listo para pruebas.`, "exito");
  } catch (error) {
    avisar(error.message, "error");
  } finally {
    btn.disabled = false;
  }
});

el("btn-solo-enlace").addEventListener("click", async () => {
  const dui = el("dui").value.trim();
  if (!dui) {
    avisar("Ingresa un DUI primero.", "error");
    return;
  }
  try {
    const res = await apiDev("/solicitudes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dui, id_conversacion: "dev-manual" }),
    });
    mostrarEnlace(res);
    avisar(`Nuevo enlace generado para DUI ${dui}.`, "exito");
  } catch (error) {
    avisar(error.message, "error");
  }
});

el("btn-copiar").addEventListener("click", async () => {
  const url = el("url-generada").value;
  if (!url) return;
  await navigator.clipboard.writeText(url).catch(() => {});
  avisar("Enlace copiado al portapapeles.", "exito");
});

function dibujarOverlay(t) {
  const video = el("video");
  const canvas = el("overlay");
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (t.rostro?.caja) {
    const c = t.rostro.caja;
    ctx.strokeStyle = t.rostro.error ? "#f59e0b" : "#10b981";
    ctx.lineWidth = 3;
    ctx.strokeRect(c.x * canvas.width, c.y * canvas.height, c.w * canvas.width, c.h * canvas.height);
  }
  if (t.recorteLuz) {
    const r = t.recorteLuz;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
    ctx.restore();
  }
  if (t.landmarks?.length) {
    ctx.fillStyle = "rgba(56, 189, 248, 0.85)";
    for (const cara of t.landmarks) {
      for (const p of cara) {
        ctx.fillRect(p.x * canvas.width - 1.5, p.y * canvas.height - 1.5, 3, 3);
      }
    }
  }
}

function actualizarTelemetria(t) {
  const r = t.rostro || {};
  const c = t.calidad || {};
  el("m-fase").textContent = t.fase || "—";
  el("m-rostros").textContent = r.rostros ?? "—";
  el("m-luz").textContent = c.luz !== undefined ? `${c.luz.toFixed(1)} (${c.iluminacion})` : (c.iluminacion || "—");
  el("m-luz-estable").textContent = t.luzEstable || "—";
  el("m-nitidez").textContent = c.nitidez !== undefined ? c.nitidez.toFixed(1) : "—";
  el("m-caja").textContent = r.caja ? `${r.caja.w.toFixed(2)} × ${r.caja.h.toFixed(2)}` : "—";
  el("m-centro").textContent = r.caja
    ? `${(r.caja.x + r.caja.w / 2).toFixed(2)}, ${(r.caja.y + r.caja.h / 2).toFixed(2)}`
    : "—";
  el("m-pose").textContent = r.yaw !== undefined
    ? `${r.yaw.toFixed(1)}° / ${r.pitch.toFixed(1)}° / ${r.roll.toFixed(1)}°`
    : "—";
  el("m-frontal").textContent = r.frontal !== undefined
    ? `${r.frontal ? "Sí" : "No"} / ${r.frontalParaCaptura ? "Sí" : "No"}`
    : "—";
  el("m-ojos").textContent = r.parpadeoIzq !== undefined
    ? `${r.parpadeoIzq.toFixed(2)} / ${r.parpadeoDer.toFixed(2)}`
    : "—";
  el("m-latencia").textContent = t.inferenciaMs !== undefined ? `${t.inferenciaMs.toFixed(1)} ms` : "—";
  el("m-rafaga").textContent = t.rafaga?.cantidad !== undefined ? `${t.rafaga.cantidad} / 4` : "0 / 4";
  el("m-mensaje").textContent = t.mensaje || "Listo";
  el("estado-camara").textContent = `${t.fase} · ${t.mensaje || "Procesando…"}`;
}

function mostrarMiniaturas(lienzos) {
  const strip = el("capturas-preview");
  strip.replaceChildren();
  lienzos.forEach((lienzo, i) => {
    const img = document.createElement("img");
    img.src = lienzo.toDataURL("image/jpeg", .85);
    img.alt = `Captura ${i + 1}`;
    strip.appendChild(img);
  });
}

function renderResultados(datos) {
  const spoof = el("resumen-spoof");
  spoof.hidden = false;
  spoof.dataset.ok = String(datos.liveness_ok);
  const detalleFotos = (datos.fotos || [])
    .map(f => `#${f.indice}: ${f.is_real ? "real" : "spoof"} (${f.antispoof_score})`)
    .join(" · ");
  spoof.textContent = `FasNet liveness: ${datos.liveness_ok ? "REAL" : "POSIBLE SUPLANTACIÓN"} `
    + `(score ${datos.liveness_score})${datos.spoof_ignorado ? " [bloqueo ignorado por modo dev]" : ""}`
    + (detalleFotos ? ` — ${detalleFotos}` : "");

  const tabla = el("tabla-resultados");
  const tbody = tabla.querySelector("tbody");
  tbody.replaceChildren();
  if (datos.resultados?.length) {
    tabla.hidden = false;
    for (const r of datos.resultados) {
      const tr = document.createElement("tr");
      const celdas = [
        r.modelo,
        r.match_verified ? "✓ Coincide" : "✕ Rechazado",
        `${r.match_distance.toFixed(4)} (${r.metrica})`,
        r.umbral.toFixed(4),
        `${r.fotos_coincidentes} / ${r.total_fotos}`,
        r.distancias_fotos.map(d => d.toFixed(3)).join(", "),
        `${r.tiempo_ms} ms`,
      ];
      celdas.forEach((texto, idx) => {
        const td = document.createElement("td");
        td.textContent = texto;
        if (idx === 1) td.className = r.match_verified ? "ok-txt" : "err-txt";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  } else {
    tabla.hidden = true;
  }
  el("raw-wrap").hidden = false;
  el("raw-json").textContent = JSON.stringify(datos, null, 2);
}

async function evaluarBlobs(blobs, modelos) {
  const dui = el("dui").value.trim() || ultimoDui;
  if (!dui) {
    avisar("Selecciona o registra un DUI antes de evaluar.", "error");
    return;
  }
  if (!blobs.length) {
    avisar("No hay imágenes capturadas ni adjuntadas para evaluar.", "error");
    return;
  }
  avisar(`Evaluando ${blobs.length} imagen(es) con ${modelos.join(", ")}… (la primera vez puede tardar mientras descarga pesos)`);
  try {
    const form = new FormData();
    form.set("dui", dui);
    form.set("modelos", modelos.join(","));
    form.set("ignorar_spoof", String(el("ignorar-spoof").checked));
    blobs.forEach((blob, i) => form.append("foto", blob, `muestra-${i + 1}.jpg`));
    const datos = await apiDev("/dev/evaluar", { method: "POST", body: form });
    renderResultados(datos);
    avisar("Evaluación completada.", "exito");
  } catch (error) {
    avisar(error.message, "error");
  }
}

function modelosSeleccionados() {
  return [...el("selector-modelos").querySelectorAll("input:checked")].map(i => i.value);
}

async function evaluarUltimaRafaga(modelos) {
  if (!ultimaRafaga.length) {
    avisar("Primero captura una ráfaga en vivo o usa fotos fijas.", "error");
    return;
  }
  const blobs = await Promise.all(ultimaRafaga.map(l => new Promise(r => l.toBlob(r, "image/jpeg", .9))));
  await evaluarBlobs(blobs.filter(Boolean), modelos);
}

const motor = crearMotorCaptura({
  video: el("video"),
  onFrame(t) {
    dibujarOverlay(t);
    actualizarTelemetria(t);
  },
  onCaptura(lienzos) {
    detenerCamara();
    ultimaRafaga = lienzos;
    el("btn-reevaluar").disabled = false;
    mostrarMiniaturas(lienzos);
    const elegidos = modelosSeleccionados();
    void evaluarUltimaRafaga(elegidos.length ? elegidos : ["todos"]);
  },
  onError() {
    detenerCamara();
    avisar("Error analizando el feed de la cámara.", "error");
  },
});

function detenerCamara() {
  motor.detener();
  el("btn-detener-camara").disabled = true;
  el("btn-iniciar-camara").disabled = !adminKey;
  el("estado-camara").textContent = "Cámara detenida.";
  const canvas = el("overlay");
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

el("btn-iniciar-camara").addEventListener("click", async () => {
  el("btn-iniciar-camara").disabled = true;
  el("estado-camara").textContent = "Cargando MediaPipe y cámara…";
  try {
    await motor.iniciar({ saltarGestos: el("saltar-gestos").checked });
    el("btn-detener-camara").disabled = false;
  } catch (error) {
    detenerCamara();
    avisar(error.message, "error");
  }
});

el("btn-detener-camara").addEventListener("click", detenerCamara);
el("saltar-gestos").addEventListener("change", () => {
  motor.configurar({ saltarGestos: el("saltar-gestos").checked });
});

el("btn-reevaluar").addEventListener("click", () => {
  const elegidos = modelosSeleccionados();
  if (!elegidos.length) {
    avisar("Marca al menos un modelo.", "error");
    return;
  }
  void evaluarUltimaRafaga(elegidos);
});

el("btn-ciclar-todos").addEventListener("click", () => {
  for (const cb of el("selector-modelos").querySelectorAll("input")) cb.checked = true;
  if (ultimaRafaga.length) void evaluarUltimaRafaga(["todos"]);
  else if (el("fotos-fijas").files?.length) void evaluarBlobs([...el("fotos-fijas").files], ["todos"]);
  else avisar("Captura una ráfaga o adjunta fotos fijas para ciclar todos los modelos.", "error");
});

el("btn-evaluar-seleccion").addEventListener("click", () => {
  const elegidos = modelosSeleccionados();
  if (!elegidos.length) {
    avisar("Marca al menos un modelo.", "error");
    return;
  }
  if (ultimaRafaga.length) void evaluarUltimaRafaga(elegidos);
  else if (el("fotos-fijas").files?.length) void evaluarBlobs([...el("fotos-fijas").files], elegidos);
  else avisar("Captura una ráfaga o adjunta fotos fijas primero.", "error");
});

el("btn-evaluar-fijas").addEventListener("click", () => {
  const archivos = [...(el("fotos-fijas").files || [])];
  if (!archivos.length) {
    avisar("Selecciona de 1 a 5 imágenes primero.", "error");
    return;
  }
  const elegidos = modelosSeleccionados();
  void evaluarBlobs(archivos.slice(0, 5), elegidos.length ? elegidos : ["todos"]);
});

window.addEventListener("pagehide", detenerCamara);

const hashParams = new URLSearchParams(location.hash.slice(1));
const keyDesdeHash = hashParams.get("admin_key");
if (keyDesdeHash) {
  el("admin-key").value = keyDesdeHash;
  history.replaceState(null, "", location.pathname + location.search);
  void conectar();
} else {
  const guardada = localStorage.getItem(STORAGE_KEY);
  if (guardada) {
    el("admin-key").value = guardada;
    void conectar();
  }
}
