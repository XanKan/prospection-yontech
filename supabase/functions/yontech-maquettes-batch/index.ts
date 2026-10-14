import { createClient } from "npm:@supabase/supabase-js@2";
import { prepareMaquettes, releaseStale } from "../_shared/yontech-maquette-jobs.ts";

// Préparation quotidienne de la prospection par maquette. Réveillée par
// pg_cron toutes les 10 minutes (yontech-maquettes-batch) ; prépare au plus
// quatre prospects par passage jusqu'au quota du jour. N'envoie rien.
// Protégée par le secret de yontech_prospection_runtime.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  try {
    const released = await releaseStale(db);
    const result = await prepareMaquettes(db, { max: 4, budgetMs: 100_000 });
    return json({ ...result, released });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Yontech Maquettes] Erreur", message);
    return json({ state: "error", error: message }, 500);
  }
});
