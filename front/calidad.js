// Devuelve las métricas del rostro (para el panel técnico) y, si no sirve, el motivo en `error`.
export function evaluarRostro(resultado) {
  const rostros = resultado.faceLandmarks.length;
  if (rostros !== 1) {
    return { rostros, error: rostros ? "Debe verse solo una persona." : "Sitúa tu rostro en la guía." };
  }
  const puntos = resultado.faceLandmarks[0];
  const x = puntos.map(p => p.x);
  const y = puntos.map(p => p.y);
  const caja = { x: Math.min(...x), y: Math.min(...y) };
  caja.w = Math.max(...x) - caja.x;
  caja.h = Math.max(...y) - caja.y;
  const metricas = { rostros, caja };
  const matriz = resultado.facialTransformationMatrixes[0]?.data;
  const expresiones = resultado.faceBlendshapes[0]?.categories;
  if (matriz?.length === 16 && expresiones) {
    // Columnas de rotación normalizadas: la matriz de MediaPipe incluye escala.
    const columnas = [0, 4, 8].map(inicio => {
      const columna = matriz.slice(inicio, inicio + 3);
      const escala = Math.hypot(...columna);
      return escala > 0 && Number.isFinite(escala) ? columna.map(valor => valor / escala) : null;
    });
    if (columnas.every(Boolean)) {
      const [ejeX, ejeY, ejeZ] = columnas;
      const grados = 180 / Math.PI;
      metricas.yaw = Math.asin(Math.min(1, Math.max(-1, ejeZ[0]))) * grados;
      metricas.pitch = Math.atan2(-ejeZ[1], ejeZ[2]) * grados;
      metricas.roll = Math.atan2(-ejeY[0], ejeX[0]) * grados;
      const parpadeo = lado => expresiones.find(e => e.categoryName === `eyeBlink${lado}`)?.score ?? 1;
      metricas.parpadeoIzq = parpadeo("Left");
      metricas.parpadeoDer = parpadeo("Right");
    }
  }
  if (caja.w < .22 || caja.h < .32) return { ...metricas, error: "Acerca un poco el rostro." };
  if (caja.w > .72 || caja.h > .85) return { ...metricas, error: "Aléjate un poco de la cámara." };
  if (Math.abs(caja.x + caja.w / 2 - .5) > .16 || Math.abs(caja.y + caja.h / 2 - .5) > .16) {
    return { ...metricas, error: "Centra tu rostro en la guía." };
  }
  if (metricas.yaw === undefined) return { ...metricas, error: "Mira hacia la cámara." };
  const { yaw, pitch, roll, parpadeoIzq, parpadeoDer } = metricas;
  return {
    ...metricas,
    frontal: Math.abs(yaw) < 12 && Math.abs(pitch) < 18 && Math.abs(roll) < 15,
    abiertos: Math.max(parpadeoIzq, parpadeoDer) < .4,
    cerrados: Math.min(parpadeoIzq, parpadeoDer) > .48,
  };
}

// Devuelve el rectángulo (en fracciones) sin las barras negras que agregan algunas cámaras,
// por ejemplo un celular vertical usado como webcam. FasNet confunde esas barras con el borde
// de una foto o pantalla y marca la captura como suplantación.
export function areaUtil(rgba, ancho, alto, umbral = 24) {
  const brillo = i => .2126 * rgba[i] + .7152 * rgba[i + 1] + .0722 * rgba[i + 2];
  const columnaOscura = x => {
    for (let y = 0; y < alto; y++) if (brillo((y * ancho + x) * 4) > umbral) return false;
    return true;
  };
  const filaOscura = y => {
    for (let x = 0; x < ancho; x++) if (brillo((y * ancho + x) * 4) > umbral) return false;
    return true;
  };
  let izquierda = 0;
  let derecha = ancho - 1;
  let arriba = 0;
  let abajo = alto - 1;
  while (izquierda < derecha && columnaOscura(izquierda)) izquierda++;
  while (derecha > izquierda && columnaOscura(derecha)) derecha--;
  while (arriba < abajo && filaOscura(arriba)) arriba++;
  while (abajo > arriba && filaOscura(abajo)) abajo--;
  // La columna/fila del borde mezcla barra y contenido: se descarta para no dejar una franja negra.
  if (izquierda > 0) izquierda++;
  if (derecha < ancho - 1) derecha--;
  if (arriba > 0) arriba++;
  if (abajo < alto - 1) abajo--;
  const area = {
    x: izquierda / ancho, y: arriba / alto,
    w: (derecha - izquierda + 1) / ancho, h: (abajo - arriba + 1) / alto,
  };
  // Si casi todo es oscuro, no recortar: es una escena oscura, no barras.
  return area.w < .3 || area.h < .3 ? { x: 0, y: 0, w: 1, h: 1 } : area;
}

export function evaluarImagen(rgba, ancho, alto) {
  const luminancias = [];
  for (let i = 0; i < rgba.length; i += 4) {
    luminancias.push(.2126 * rgba[i] + .7152 * rgba[i + 1] + .0722 * rgba[i + 2]);
  }
  const luz = luminancias.reduce((suma, valor) => suma + valor, 0) / luminancias.length;
  if (luz < 55) return { luz, error: "Necesitas más luz frente a ti." };
  if (luz > 225) return { luz, error: "Evita la luz directa sobre tu rostro." };
  let detalle = 0;
  for (let y = 1; y < alto - 1; y++) {
    for (let x = 1; x < ancho - 1; x++) {
      const i = y * ancho + x;
      const laplaciano = luminancias[i - 1] + luminancias[i + 1] + luminancias[i - ancho]
        + luminancias[i + ancho] - 4 * luminancias[i];
      detalle += laplaciano ** 2;
    }
  }
  const nitidez = detalle / ((ancho - 2) * (alto - 2));
  if (nitidez < 45) return { luz, nitidez, error: "La imagen está borrosa. Mantén la cámara quieta." };
  return { luz, nitidez, puntaje: Math.min(nitidez, 400) - Math.abs(luz - 145) };
}
