import assert from "node:assert/strict";
import { test } from "node:test";
import { crearControlLuz, crearControlRafaga, evaluarImagen, evaluarRostro } from "./calidad.js";

function evaluar(matriz) {
  return evaluarRostro({
    faceLandmarks: [[{ x: .3, y: .3 }, { x: .7, y: .7 }]],
    facialTransformationMatrixes: [{ data: matriz }],
    faceBlendshapes: [{ categories: [] }],
  });
}

test("La escala no cambia el ángulo de giro ni la clasificación frontal", () => {
  for (const grados of [8, 24]) {
    const angulo = grados * Math.PI / 180;
    for (const escala of [.5, 1, 2]) {
      const coseno = Math.cos(angulo) * escala;
      const seno = Math.sin(angulo) * escala;
      const rostro = evaluar([
        coseno, 0, -seno, 0,
        0, escala, 0, 0,
        seno, 0, coseno, 0,
        0, 0, 0, 1,
      ]);
      assert.ok(Math.abs(rostro.yaw - grados) < 1e-10);
      assert.equal(rostro.frontal, grados < 12);
    }
  }
});

test("Una matriz sin escala válida no permite evaluar la pose", () => {
  assert.ok(evaluar(Array(16).fill(0)).error);
});

test("La poca luz bloquea el avance hasta que la luz adecuada se mantiene", () => {
  const controlar = crearControlLuz();
  const oscuridad = evaluarImagen(new Uint8ClampedArray(4 * 4 * 4).fill(45), 4, 4);
  const luz = evaluarImagen(new Uint8ClampedArray(4 * 4 * 4).fill(130), 4, 4);
  assert.equal(controlar(oscuridad.iluminacion, 0), "baja");
  for (const ahora of [100, 300, 500, 700]) assert.equal(controlar(luz.iluminacion, ahora), "ajustando");
  assert.equal(controlar(luz.iluminacion, 750), "adecuada");
  assert.equal(controlar(oscuridad.iluminacion, 800), "baja");
  assert.equal(controlar(luz.iluminacion, 850), "ajustando");
  assert.equal(controlar(luz.iluminacion, 1500), "ajustando");
});

test("La ráfaga espera 1200 ms de estabilidad y toma cuatro fotos espaciadas", () => {
  const controlar = crearControlRafaga();
  const rostro = { caja: { x: .3, y: .3, w: .4, h: .4 }, yaw: 0, pitch: 0, roll: 0 };
  const movido = { ...rostro, yaw: 6 };
  for (const ahora of [0, 250, 500, 750, 1000]) assert.ok(controlar(rostro, ahora).segundos);
  assert.equal(controlar(movido, 1100).reinicio, true);
  for (const ahora of [1300, 1500, 1700, 1900, 2100, 2299]) assert.ok(controlar(movido, ahora).segundos);
  assert.deepEqual(controlar(movido, 2300), { reinicio: false, tomar: true, cantidad: 1, completa: false });
  assert.equal(controlar(movido, 2400).tomar, false);
  assert.equal(controlar(movido, 2480).cantidad, 2);
  assert.equal(controlar(movido, 2660).cantidad, 3);
  assert.equal(controlar(movido, 2840).completa, true);
  assert.equal(controlar(null).reinicio, true);
  assert.ok(controlar(rostro, 2890).segundos);
});
