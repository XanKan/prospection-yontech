#!/usr/bin/env bash
# Branche les maquettes de refonte sur <slug>.yontech.fr (une seule fois).
#
# Prérequis (jamais dans le dépôt) : CLOUDFLARE_API_TOKEN, jeton Cloudflare
# limité à la zone yontech.fr avec les permissions :
#   Compte  → Workers Scripts : Modifier
#   Zone    → Workers Routes  : Modifier
#   Zone    → DNS             : Modifier
#   Zone    → Zone            : Lire
#
# Ce que fait le script (idempotent, sans rien supprimer) :
#   1. publie le Worker « yontech-maquettes » (cloudflare/maquettes-worker.js) ;
#   2. ajoute l'enregistrement DNS générique « * » (AAAA 100::, proxifié) s'il
#      n'existe pas : les enregistrements existants (www, prospection, mail…)
#      restent prioritaires et ne sont pas touchés ;
#   3. relie la route *.yontech.fr/* au Worker.
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN manquant}"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
SCRIPT="yontech-maquettes"
ZONE_NAME="yontech.fr"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }

echo "→ Zone ${ZONE_NAME}"
ZONE=$(curl -sS "${AUTH[@]}" "$API/zones?name=${ZONE_NAME}" | json 'r=d.get("result") or [];print(r[0]["id"]+" "+r[0]["account"]["id"] if r else "")')
[ -n "$ZONE" ] || { echo "Zone introuvable : vérifiez les permissions du jeton."; exit 1; }
ZONE_ID=${ZONE% *}; ACCOUNT_ID=${ZONE#* }

echo "→ Worker ${SCRIPT}"
curl -sS -X PUT "${AUTH[@]}" "$API/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}" \
  -F 'metadata={"main_module":"maquettes-worker.js","compatibility_date":"2026-09-01"};type=application/json' \
  -F "maquettes-worker.js=@maquettes-worker.js;type=application/javascript+module" | json 'print("   ok" if d.get("success") else "   ERREUR "+json.dumps(d.get("errors")))'

echo "→ DNS générique *.${ZONE_NAME}"
EXISTS=$(curl -sS "${AUTH[@]}" "$API/zones/${ZONE_ID}/dns_records?name=*.${ZONE_NAME}" | json 'print(len(d.get("result") or []))')
if [ "$EXISTS" = "0" ]; then
  curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" "$API/zones/${ZONE_ID}/dns_records" \
    --data '{"type":"AAAA","name":"*","content":"100::","proxied":true,"ttl":1,"comment":"Maquettes Yontech (Worker yontech-maquettes)"}' | json 'print("   créé" if d.get("success") else "   ERREUR "+json.dumps(d.get("errors")))'
else
  echo "   déjà présent, inchangé"
fi

echo "→ Route *.${ZONE_NAME}/*"
ROUTES=$(curl -sS "${AUTH[@]}" "$API/zones/${ZONE_ID}/workers/routes" | json 'print(sum(1 for r in d.get("result") or [] if r.get("pattern")=="*.'"${ZONE_NAME}"'/*"))')
if [ "$ROUTES" = "0" ]; then
  curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" "$API/zones/${ZONE_ID}/workers/routes" \
    --data "{\"pattern\":\"*.${ZONE_NAME}/*\",\"script\":\"${SCRIPT}\"}" | json 'print("   créée" if d.get("success") else "   ERREUR "+json.dumps(d.get("errors")))'
else
  echo "   déjà présente, inchangée"
fi
echo "Terminé. Test : https://verif-maquette.${ZONE_NAME} doit afficher « Page introuvable »."
