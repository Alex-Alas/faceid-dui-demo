import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluarRostro } from "./calidad.js";

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
