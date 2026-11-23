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
  if (caja.w < .22 || caja.h < .32) return { rostros, caja, error: "Acerca un poco el rostro." };
  if (caja.w > .72 || caja.h > .85) return { rostros, caja, error: "Aléjate un poco de la cámara." };
  if (Math.abs(caja.x + caja.w / 2 - .5) > .16 || Math.abs(caja.y + caja.h / 2 - .5) > .16) {
    return { rostros, caja, error: "Centra tu rostro en la guía." };
  }
  const matriz = resultado.facialTransformationMatrixes[0]?.data;
  const expresiones = resultado.faceBlendshapes[0]?.categories;
  if (matriz?.length !== 16 || !expresiones) return { rostros, caja, error: "Mira hacia la cámara." };
  const columnas = [0, 4, 8].map(inicio => {
    const columna = matriz.slice(inicio, inicio + 3);
    const escala = Math.hypot(...columna);
    return escala > 0 && Number.isFinite(escala) ? columna.map(valor => valor / escala) : null;
  });
  if (columnas.some(columna => !columna)) return { rostros, caja, error: "Mira hacia la cámara." };
  const [ejeX, ejeY, ejeZ] = columnas;
  const grados = 180 / Math.PI;
  const yaw = Math.asin(Math.min(1, Math.max(-1, ejeZ[0]))) * grados;
  const pitch = Math.atan2(-ejeZ[1], ejeZ[2]) * grados;
  const roll = Math.atan2(-ejeY[0], ejeX[0]) * grados;
  const parpadeo = lado => expresiones.find(e => e.categoryName === `eyeBlink${lado}`)?.score ?? 1;
  const izquierda = parpadeo("Left");
  const derecha = parpadeo("Right");
  return {
    rostros, caja, yaw, pitch, roll,
    parpadeoIzq: izquierda,
    parpadeoDer: derecha,
    frontal: Math.abs(yaw) < 12 && Math.abs(pitch) < 18 && Math.abs(roll) < 15,
    frontalParaCaptura: Math.abs(yaw) < 10 && Math.abs(pitch) < 12 && Math.abs(roll) < 10,
    abiertos: Math.max(izquierda, derecha) < .4,
    cerrados: Math.min(izquierda, derecha) > .48,
  };
}

export function evaluarImagen(rgba, ancho, alto) {
  const luminancias = [];
  for (let i = 0; i < rgba.length; i += 4) {
    luminancias.push(.2126 * rgba[i] + .7152 * rgba[i + 1] + .0722 * rgba[i + 2]);
  }
  const luz = luminancias.reduce((suma, valor) => suma + valor, 0) / luminancias.length;
  if (luz < 65) return { iluminacion: "baja", luz };
  if (luz > 225) return { iluminacion: "alta", luz };
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
  return {
    iluminacion: "adecuada",
    luz,
    nitidez,
    error: nitidez < 45 ? "La imagen está borrosa. Mantén la cámara quieta." : null,
  };
}

export function crearControlLuz() {
  let inicio;
  let anterior;
  return (iluminacion, ahora) => {
    if (iluminacion !== "adecuada") {
      inicio = anterior = undefined;
      return iluminacion;
    }
    if (inicio === undefined || ahora - anterior > 300) inicio = ahora;
    anterior = ahora;
    return ahora - inicio >= 650 ? "adecuada" : "ajustando";
  };
}

export function crearControlRafaga() {
  let ancla;
  let inicio;
  let anterior;
  let ultimaFoto;
  let cantidad;
  return (rostro, ahora) => {
    if (!rostro) {
      ancla = null;
      return { reinicio: true };
    }
    const reinicio = !ancla || ahora - anterior > 300 ||
      ["x", "y", "w", "h"].some(eje => Math.abs(rostro.caja[eje] - ancla.caja[eje]) > .035) ||
      ["yaw", "pitch", "roll"].some(eje => Math.abs(rostro[eje] - ancla[eje]) > 5);
    if (reinicio) {
      ancla = rostro;
      inicio = ahora;
      ultimaFoto = -Infinity;
      cantidad = 0;
    }
    anterior = ahora;
    const restante = 1200 - (ahora - inicio);
    if (restante > 0) return { reinicio, segundos: Math.ceil(restante / 1000) };
    const tomar = cantidad < 4 && ahora - ultimaFoto >= 180;
    if (tomar) {
      cantidad++;
      ultimaFoto = ahora;
    }
    return { reinicio, tomar, cantidad, completa: cantidad === 4 };
  };
}
