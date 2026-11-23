from unittest import TestCase
from unittest.mock import call, patch

from biometria import FotoInvalida, verificar


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
