#!/usr/bin/env bash
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
carpeta="${1:-$raiz/demo-data}"
api="${API_URL:-http://localhost:8000}"
clave="${ADMIN_KEY:-$(sed -n 's/^ADMIN_KEY=//p' "$raiz/.env" | tr -d '\r')}"
dui="00000002-0"

curl -fsS "$api/dev/personas" -H "X-Admin-Key: $clave" \
  --form-string "dui=$dui" --form-string "nombre=Prueba Modelos" \
  --form-string "crear_solicitud=false" -F "foto=@$carpeta/img1.jpg" > /dev/null

evaluar_archivo() {
  local archivo="$1" etiqueta="$2" esperado="$3"
  local respuesta
  respuesta="$(curl -fsS "$api/dev/evaluar" -H "X-Admin-Key: $clave" \
    --form-string "dui=$dui" --form-string "modelos=todos" --form-string "ignorar_spoof=true" \
    -F "foto=@$archivo" -F "foto=@$archivo" -F "foto=@$archivo" -F "foto=@$archivo")"

  python3 - "$etiqueta" "$esperado" <<< "$respuesta" <<'PY'
import json
import sys

etiqueta, esperado_str = sys.argv[1], sys.argv[2]
esperado = esperado_str == "true"
datos = json.load(sys.stdin)
print(f"\n=== {etiqueta} (liveness_ok={datos['liveness_ok']}, score={datos['liveness_score']}, spoof_ignorado={datos['spoof_ignorado']}) ===")
print(f"{'Modelo':<14} {'Match':<7} {'Distancia':<10} {'Umbral':<8} {'Fotos':<7} {'Tiempo'}")
por_modelo = {}
for r in datos["resultados"]:
    por_modelo[r["modelo"]] = r
    print(
        f"{r['modelo']:<14} {str(r['match_verified']):<7} "
        f"{r['match_distance']:<10.4f} {r['umbral']:<8.4f} "
        f"{r['fotos_coincidentes']}/{r['total_fotos']:<4} {r['tiempo_ms']:.1f} ms"
    )
assert len(por_modelo) >= 5, f"Se esperaban >= 5 modelos, llegaron {len(por_modelo)}"
assert por_modelo["Facenet512"]["match_verified"] is esperado, por_modelo["Facenet512"]
if not esperado:
    for modelo, res in por_modelo.items():
        assert res["match_verified"] is False, f"{modelo} dio falso positivo en {etiqueta}: {res}"
PY
}

evaluar_archivo "$carpeta/img2.jpg" "Mismo rostro (img2 vs img1)" "true"
evaluar_archivo "$carpeta/img3.jpg" "Rostro distinto (img3 vs img1)" "false"
echo -e "\nCiclado de modelos completado correctamente."
