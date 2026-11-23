from unittest import TestCase
from unittest.mock import call, patch

import biometria
from biometria import FotoInvalida, cambiar_modelo_activo, evaluar_modelos, obtener_modelo_activo, verificar


class VerificarRafaga(TestCase):
    def test_suplantacion_tiene_prioridad_sobre_foto_sin_rostro_en_cualquier_orden(self):
        sospechosa = [{"is_real": False, "antispoof_score": .8}]
        invalida = ValueError("No se encontró un rostro.")
        for resultados in ([invalida, sospechosa], [sospechosa, invalida]):
            with self.subTest(resultados=resultados):
                with patch("biometria.DeepFace.extract_faces", side_effect=resultados) as extraer:
                    with patch("biometria.DeepFace.verify") as comparar:
                        self.assertEqual(verificar(["primera", "segunda"], "referencia"), (False, .8, None, None))
                self.assertEqual(extraer.call_args_list, [
                    call("primera", detector_backend="opencv", anti_spoofing=True),
                    call("segunda", detector_backend="opencv", anti_spoofing=True),
                ])
                comparar.assert_not_called()

    def test_foto_sin_rostro_es_invalida_si_no_hay_suplantacion(self):
        resultados = [ValueError("No se encontró un rostro."), [{"is_real": True, "antispoof_score": .9}]]
        with patch("biometria.DeepFace.extract_faces", side_effect=resultados) as extraer:
            with patch("biometria.DeepFace.verify") as comparar:
                with self.assertRaises(FotoInvalida):
                    verificar(["primera", "segunda"], "referencia")
        self.assertEqual(extraer.call_count, 2)
        comparar.assert_not_called()


class EvaluarModelos(TestCase):
    def setUp(self):
        self.modelo_previo = biometria._modelo_activo

    def tearDown(self):
        biometria._modelo_activo = self.modelo_previo

    def test_cicla_multiples_modelos_y_extrae_caras_una_sola_vez(self):
        caras = [
            [{"is_real": True, "antispoof_score": .92}],
            [{"is_real": True, "antispoof_score": .88}],
        ]
        comparaciones = [
            {"distance": .21, "verified": True, "threshold": .30, "similarity_metric": "cosine"},
            {"distance": .25, "verified": True, "threshold": .30, "similarity_metric": "cosine"},
            {"distance": .48, "verified": False, "threshold": .40, "similarity_metric": "cosine"},
            {"distance": .35, "verified": True, "threshold": .40, "similarity_metric": "cosine"},
        ]
        with patch("biometria.DeepFace.extract_faces", side_effect=caras) as extraer:
            with patch("biometria.DeepFace.verify", side_effect=comparaciones) as comparar:
                res = evaluar_modelos(["f1", "f2"], "ref", modelos=["Facenet512", "GhostFaceNet"])
        self.assertEqual(extraer.call_count, 2)
        self.assertEqual(comparar.call_args_list, [
            call("f1", "ref", model_name="Facenet512", detector_backend="opencv"),
            call("f2", "ref", model_name="Facenet512", detector_backend="opencv"),
            call("f1", "ref", model_name="GhostFaceNet", detector_backend="opencv"),
            call("f2", "ref", model_name="GhostFaceNet", detector_backend="opencv"),
        ])
        self.assertTrue(res["liveness_ok"])
        self.assertAlmostEqual(res["liveness_score"], .88)
        self.assertFalse(res["spoof_ignorado"])
        self.assertEqual([r["modelo"] for r in res["resultados"]], ["Facenet512", "GhostFaceNet"])
        self.assertTrue(res["resultados"][0]["match_verified"])
        self.assertFalse(res["resultados"][1]["match_verified"])
        self.assertEqual(res["resultados"][1]["fotos_coincidentes"], 1)

    def test_spoof_bloquea_modelos_si_no_se_ignora(self):
        caras = [[{"is_real": False, "antispoof_score": .84}], [{"is_real": True, "antispoof_score": .95}]]
        with patch("biometria.DeepFace.extract_faces", side_effect=caras):
            with patch("biometria.DeepFace.verify") as comparar:
                res = evaluar_modelos(["f1", "f2"], "ref", modelos=["Facenet512"], saltar_antisuplantacion=False)
        comparar.assert_not_called()
        self.assertFalse(res["liveness_ok"])
        self.assertFalse(res["spoof_ignorado"])
        self.assertEqual(res["resultados"], [])

    def test_spoof_ignorado_permite_comparar_modelos_reportando_bandera(self):
        caras = [[{"is_real": False, "antispoof_score": .71}]]
        comp = [{"distance": .18, "verified": True, "threshold": .30, "similarity_metric": "cosine"}]
        with patch("biometria.DeepFace.extract_faces", side_effect=caras):
            with patch("biometria.DeepFace.verify", side_effect=comp) as comparar:
                res = evaluar_modelos(["f1"], "ref", modelos=["SFace"], saltar_antisuplantacion=True)
        comparar.assert_called_once()
        self.assertFalse(res["liveness_ok"])
        self.assertTrue(res["spoof_ignorado"])
        self.assertEqual(len(res["resultados"]), 1)
        self.assertEqual(res["resultados"][0]["modelo"], "SFace")

    def test_modelo_no_soportado_lanza_error(self):
        with self.assertRaises(ValueError):
            evaluar_modelos(["f1"], "ref", modelos=["ModeloInexistente"])
        with self.assertRaises(ValueError):
            cambiar_modelo_activo("ModeloInexistente")

    def test_cambiar_modelo_activo_precalienta_y_actualiza(self):
        with patch("biometria.DeepFace.build_model") as build:
            nuevo = cambiar_modelo_activo("ArcFace")
        build.assert_called_once_with("ArcFace")
        self.assertEqual(nuevo, "ArcFace")
        self.assertEqual(obtener_modelo_activo(), "ArcFace")
