import { createClient } from "npm:@supabase/supabase-js@2";
import { BRAND, maskEmail } from "../_shared/yontech-core.ts";

// Désinscription des messages de prospection, sans authentification :
//  - POST « List-Unsubscribe=One-Click » envoyé par Gmail, Outlook... (RFC 8058) ;
//  - POST JSON depuis la page de désinscription ;
//  - GET (lien ouvert dans un navigateur) : redirection vers cette page, qui
//    demande une confirmation. Un GET ne désinscrit jamais, car les antivirus
//    de messagerie ouvrent les liens automatiquement.
// Le jeton est un UUID aléatoire propre à chaque message.

const PAGE = Deno.env.get("YONTECH_UNSUBSCRIBE_PAGE") || BRAND.unsubscribePage;
const allowedOrigins = new Set(["https://prospection.yontech.fr", "https://yontech.fr", "https://www.yontech.fr", "http://localhost:4173", "http://localhost:5173"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://prospection.yontech.fr",
    "Access-Control-Allow-Headers": "content-type, apikey, x-client-info, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin", "Cache-Control": "no-store",
  };
}
function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const url = new URL(req.url);
  let token = url.searchParams.get("t") || "";
  if (req.method === "GET") {
    return new Response(null, { status: 302, headers: { Location: `${PAGE}${UUID.test(token) ? `?t=${encodeURIComponent(token)}` : ""}`, "Cache-Control": "no-store" } });
  }
  if (req.method !== "POST") return json(req, { ok: false, error: "Méthode non autorisée" }, 405);
  if (!token && (req.headers.get("content-type") || "").includes("application/json")) {
    try { token = String((await req.json())?.token || ""); } catch { token = ""; }
  }
  if (!UUID.test(token)) return json(req, { ok: false, error: "Lien de désinscription invalide." }, 400);
  const base = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return json(req, { ok: false, error: "Service momentanément indisponible." }, 503);
  const db = createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.rpc("yontech_prospection_unsubscribe", { target_token: token });
  if (error) return json(req, { ok: false, error: "Service momentanément indisponible." }, 503);
  if (!data?.ok) return json(req, { ok: false, error: "Ce lien de désinscription n'est plus valable." }, 404);
  return json(req, { ok: true, email: maskEmail(String(data.email || "")) });
});
