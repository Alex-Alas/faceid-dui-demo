#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Uso: bash scripts/sembrar.sh FOTO DUI NOMBRE ID_CONVERSACION" >&2
  exit 2
fi

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_KEY="${ADMIN_KEY:-$(sed -n 's/^ADMIN_KEY=//p' "$raiz/.env")}"
api="${API_URL:-http://localhost:8000}"

curl -fsS "$api/personas" -H "X-Admin-Key: $ADMIN_KEY" \
  --form-string "dui=$2" --form-string "nombre=$3" -F "foto=@$1" >/dev/null

json="$(python3 -c 'import json,sys; print(json.dumps(dict(dui=sys.argv[1], id_conversacion=sys.argv[2])))' "$2" "$4")"
curl -fsS "$api/solicitudes" -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" --data "$json"
printf '\n'
