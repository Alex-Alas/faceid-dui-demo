#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Uso: bash scripts/sembrar.sh FOTO DUI NOMBRE ID_CONVERSACION" >&2
  exit 2
fi

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_KEY="${ADMIN_KEY:-$(sed -n 's/^ADMIN_KEY=//p' "$raiz/.env")}"
api="${API_URL:-http://localhost:8000}"

codigo="$(curl -sS -o /dev/null -w '%{http_code}' "$api/personas" -H "X-Admin-Key: $ADMIN_KEY" \
  --form-string "dui=$2" --form-string "nombre=$3" -F "foto=@$1")"
case "$codigo" in
  201) ;;
  409) echo "El DUI ya está registrado. Se conserva su foto de referencia." >&2 ;;
  *) echo "No se pudo registrar la persona (HTTP $codigo)." >&2; exit 1 ;;
esac

json="$(python3 -c 'import json,sys; print(json.dumps(dict(dui=sys.argv[1], id_conversacion=sys.argv[2])))' "$2" "$4")"
curl -fsS "$api/solicitudes" -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" --data "$json"
printf '\n'
