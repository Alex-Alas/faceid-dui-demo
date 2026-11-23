#!/usr/bin/env bash
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
carpeta="${1:-$raiz/demo-data}"
api="${API_URL:-http://localhost:8000}"
clave="${ADMIN_KEY:-$(sed -n 's/^ADMIN_KEY=//p' "$raiz/.env")}"
dui="00000001-0"

leer_campo() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

nueva_solicitud() {
  local respuesta
  respuesta="$(curl -fsS "$api/solicitudes" -H "X-Admin-Key: $clave" \
    -H "Content-Type: application/json" --data "{\"dui\":\"$dui\",\"id_conversacion\":\"prueba-api\"}")"
  ruta="$api/solicitudes/$(leer_campo id_solicitud <<< "$respuesta")"
  token="$(leer_campo token <<< "$respuesta")"
}

esperar_codigo() {
  local esperado="$1" codigo
  shift
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' "$@")"
  if [[ "$codigo" != "$esperado" ]]; then
    echo "Falló: se esperaba HTTP $esperado, se recibió HTTP $codigo." >&2
    exit 1
  fi
}

registrada="$(curl -sS -o /dev/null -w '%{http_code}' "$api/personas" -H "X-Admin-Key: $clave" \
  --form-string "dui=$dui" --form-string "nombre=Persona de prueba" -F "foto=@$carpeta/img1.jpg")"
[[ "$registrada" == 201 || "$registrada" == 409 ]] || { echo "Registro falló: HTTP $registrada"; exit 1; }

for n in 2 3; do
  nueva_solicitud
  esperar_codigo 404 "$ruta" -H "Authorization: Bearer $token" -H "X-DUI: 00000009-0"
  esperar_codigo 404 "$ruta" -H "Authorization: Bearer incorrecto" -H "X-DUI: $dui"
  esperar_codigo 404 "$ruta/verificar" -H "Authorization: Bearer $token" \
    --form-string "dui=00000009-0" -F "foto=@$carpeta/img$n.jpg"
  echo "Acceso con DUI o token incorrecto: HTTP 404"
  [[ "$(curl -fsS "$ruta" -H "Authorization: Bearer $token" -H "X-DUI: $dui" | leer_campo estado)" == pendiente ]]
  resultado="$(curl -fsS "$ruta/verificar" -H "Authorization: Bearer $token" \
    --form-string "dui=$dui" -F "foto=@$carpeta/img$n.jpg")"
  python3 -c '
import json, sys
r = json.load(sys.stdin)
mismo = sys.argv[1] == "2"
if r["liveness_ok"]:
    assert r["match_verified"] is mismo and r["match_distance"] is not None, r
    assert r["estado"] == ("verificada" if mismo else "rechazada"), r
    print("img{}: liveness aceptado; match={}; distancia={:.6f}".format(sys.argv[1], r["match_verified"], r["match_distance"]))
else:
    assert r["estado"] == "rechazada" and r["match_verified"] is None, r
    print(f"img{sys.argv[1]}: liveness rechazado; no hubo comparación.")
' "$n" <<< "$resultado"
  esperar_codigo 409 "$ruta/verificar" -H "Authorization: Bearer $token" \
    --form-string "dui=$dui" -F "foto=@$carpeta/img$n.jpg"
  echo "Reutilización rechazada: HTTP 409"
done
