#!/usr/bin/env bash
# Déploiement côté serveur (Supabase) de l'automate de prospection Yontech.
#
# Prérequis (jamais dans le dépôt) :
#   SUPABASE_ACCESS_TOKEN  jeton d'accès personnel Supabase (sbp_…, Account → Access Tokens)
#   PROJECT_REF            identifiant du projet Supabase qui héberge l'automate
#                          (projet dédié recommandé ; aucune collision avec un autre projet)
#
# Usage :
#   SUPABASE_ACCESS_TOKEN=sbp_xxx PROJECT_REF=abcdefghijklmnop ./deploy.sh migrate     # tables, fonctions SQL, tâches pg_cron
#   SUPABASE_ACCESS_TOKEN=sbp_xxx PROJECT_REF=abcdefghijklmnop ./deploy.sh functions   # les six fonctions
#   SUPABASE_ACCESS_TOKEN=sbp_xxx PROJECT_REF=abcdefghijklmnop ./deploy.sh secrets     # lit les secrets depuis l'environnement
#   SUPABASE_ACCESS_TOKEN=sbp_xxx PROJECT_REF=abcdefghijklmnop ./deploy.sh all
#
# Secrets attendus par `secrets` (variables d'environnement, les vides sont ignorées) :
#   YONTECH_ADMIN_EMAILS        adresses autorisées à ouvrir l'outil, séparées par des virgules (obligatoire)
#   YONTECH_SMTP_PASSWORD       mot de passe de la boîte Hostinger d'envoi (obligatoire pour envoyer)
#   YONTECH_SMTP_USER           identifiant SMTP si différent de l'adresse d'envoi (facultatif)
#   YONTECH_SEARCH_API_KEY      clé API Brave Search pour trouver plus de sites (facultatif)
#   YONTECH_HOSTINGER_MAIL_TOKEN / YONTECH_HOSTINGER_MAILBOX_ID   lecture des rebonds (facultatif)
#   YONTECH_TRACKING_BASE, YONTECH_UNSUBSCRIBE_PAGE, YONTECH_LOGO_URL           surcharges (facultatif)
set -euo pipefail
cd "$(dirname "$0")"

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN manquant}"
: "${PROJECT_REF:?PROJECT_REF manquant}"
CLI="npx --yes supabase@2.120.0"
MIGRATION="supabase/migrations/202610130100_yontech_prospection.sql"

migrate() {
  echo "→ Migration ${MIGRATION} sur ${PROJECT_REF}"
  # La migration est une transaction : une erreur annule tout.
  python3 - "$MIGRATION" <<'PY' | curl -sS -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary @-
import json, sys
print(json.dumps({"query": open(sys.argv[1], encoding="utf-8").read()}))
PY
  echo
  echo "   (réponse attendue : [] ou un numéro de tâche cron)"
  # L'adresse de réveil des fonctions dépend du projet : posée tout de suite,
  # sans attendre le premier chargement de l'outil.
  echo "→ Adresse de réveil des fonctions"
  python3 -c 'import json,sys;print(json.dumps({"query":"update public.yontech_prospection_runtime set sender_url=%s where id=1" % repr("https://"+sys.argv[1]+".supabase.co/functions/v1/yontech-prospection-sender")}))' "$PROJECT_REF" \
    | curl -sS -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary @-
  echo
}

functions() {
  for name in yontech-prospection-api yontech-prospection-sender yontech-prospection-sourcer yontech-prospection-track yontech-prospection-unsubscribe yontech-prospection-bounces yontech-maquette yontech-maquettes-batch; do
    echo "→ Fonction ${name}"
    $CLI --yes functions deploy "$name" --project-ref "$PROJECT_REF"
  done
}

secrets() {
  local args=()
  for name in YONTECH_ADMIN_EMAILS YONTECH_SMTP_PASSWORD YONTECH_SMTP_USER YONTECH_SMTP_HOST YONTECH_SMTP_PORT YONTECH_SEARCH_API_KEY \
              YONTECH_HOSTINGER_MAIL_TOKEN YONTECH_HOSTINGER_MAILBOX_ID YONTECH_HOSTINGER_MAIL_FOLDER \
              YONTECH_TRACKING_BASE YONTECH_UNSUBSCRIBE_PAGE YONTECH_LOGO_URL; do
    if [ -n "${!name:-}" ]; then args+=("${name}=${!name}"); fi
  done
  if [ "${#args[@]}" -eq 0 ]; then echo "Aucun secret dans l'environnement."; return; fi
  echo "→ Secrets : ${args[*]%%=*}"
  $CLI --yes secrets set "${args[@]}" --project-ref "$PROJECT_REF"
}

# Relie la page (index.html, desinscription.html) au projet : URL du projet et
# clé publique « anon », lues par l'API de gestion. À relancer si le projet change.
configure() {
  local anon
  anon=$(curl -sS "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=false" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" | python3 -c 'import json,sys
keys=json.load(sys.stdin)
print(next((k.get("api_key") for k in keys if k.get("name")=="anon" and k.get("api_key")), ""))')
  if [ -z "$anon" ]; then echo "Clé anon introuvable pour ${PROJECT_REF}"; exit 1; fi
  local url="https://${PROJECT_REF}.supabase.co"
  for f in index.html desinscription.html; do
    python3 - "$f" "$url" "$anon" <<'PY'
import re, sys
path, url, anon = sys.argv[1:]
s = open(path, encoding="utf-8").read()
s = re.sub(r'const SUPABASE_URL = "[^"]*";', f'const SUPABASE_URL = "{url}";', s)
s = re.sub(r'const SUPABASE_ANON = "[^"]*";', f'const SUPABASE_ANON = "{anon}";', s)
s = re.sub(r'var ENDPOINT = "[^"]*/functions/v1/yontech-prospection-unsubscribe";', f'var ENDPOINT = "{url}/functions/v1/yontech-prospection-unsubscribe";', s)
open(path, "w", encoding="utf-8").write(s)
PY
    echo "→ ${f} relié à ${url}"
  done
  echo "   Validez puis poussez sur GitHub : git commit -am 'Projet Supabase' && git push"
}

case "${1:-}" in
  configure) configure ;;
  migrate) migrate ;;
  functions) functions ;;
  secrets) secrets ;;
  all) configure; migrate; functions; secrets ;;
  *) echo "Usage : $0 configure|migrate|functions|secrets|all"; exit 1 ;;
esac
