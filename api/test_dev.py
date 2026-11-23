from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from dev import ModeloActivoNuevo, crear_router_dev


def _requerir_admin_mock(clave):
    if clave != "clave-secreta":
        raise HTTPException(401, "Clave de integración inválida.")


def _normalizar_dui_mock(dui):
    limpio = dui.strip().replace("-", "")
    if len(limpio) != 9 or not limpio.isdigit():
        raise HTTPException(422, "DUI inválido.")
    return limpio


class DevRouterTests(TestCase):
    def setUp(self):
        self.conn = MagicMock()
        self.conn.__enter__ = MagicMock(return_value=self.conn)
        self.conn.__exit__ = MagicMock(return_value=False)
        self.router = crear_router_dev(
            blobs_dir=Path("/tmp/blobs"),
            front_url="https://example.test",
            max_fotos=5,
            conexion_fn=lambda: self.conn,
            requerir_admin_fn=_requerir_admin_mock,
            normalizar_dui_fn=_normalizar_dui_mock,
            leer_foto_fn=lambda f: f,
            persistir_foto_fn=MagicMock(),
            resumir_token_fn=lambda t: b"hash",
        )
        self.endpoints = {route.path: route.endpoint for route in self.router.routes}

    def test_rutas_dev_rechazan_sin_admin_key(self):
        with self.assertRaises(HTTPException) as ctx:
            self.endpoints["/dev/estado"](x_admin_key=None)
        self.assertEqual(ctx.exception.status_code, 401)

        with self.assertRaises(HTTPException) as ctx_mod:
            self.endpoints["/dev/modelo-activo"](ModeloActivoNuevo(modelo="ArcFace"), x_admin_key="incorrecta")
        self.assertEqual(ctx_mod.exception.status_code, 401)

    def test_estado_devuelve_modelos_y_personas_formateadas(self):
        self.conn.execute.return_value.fetchall.return_value = [
            {"dui": "000000000", "nombre": "Demo", "created_at": "2026-11-23T00:00:00Z"}
        ]
        res = self.endpoints["/dev/estado"](x_admin_key="clave-secreta")
        self.assertIn("Facenet512", res["modelos_disponibles"])
        self.assertEqual(res["personas"][0]["dui"], "00000000-0")

    def test_evaluar_dev_valida_modelos_y_delega_evaluacion(self):
        self.conn.execute.return_value.fetchone.return_value = {"foto_ref_blob_path": "referencias/ref.jpg"}
        with patch("dev.cv2.imread", return_value="img-ref"):
            with patch("dev.evaluar_modelos", return_value={"liveness_ok": True, "resultados": []}) as ev:
                res = self.endpoints["/dev/evaluar"](
                    dui="00000000-0",
                    foto=["f1"],
                    modelos="Facenet512, SFace",
                    ignorar_spoof=True,
                    x_admin_key="clave-secreta",
                )
        ev.assert_called_once_with(
            ["f1"], "img-ref", modelos=["Facenet512", "SFace"], saltar_antisuplantacion=True
        )
        self.assertTrue(res["liveness_ok"])

    def test_evaluar_dev_rechaza_lista_modelos_vacia(self):
        with self.assertRaises(HTTPException) as ctx:
            self.endpoints["/dev/evaluar"](
                dui="00000000-0",
                foto=["f1"],
                modelos=" , ",
                ignorar_spoof=False,
                x_admin_key="clave-secreta",
            )
        self.assertEqual(ctx.exception.status_code, 422)
