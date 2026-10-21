import { createClient } from "npm:@supabase/supabase-js@2";
import { prepareCreations, prepareMaquettes, releaseStale } from "../_shared/yontech-maquette-jobs.ts";
import { sendViewFollowups } from "../_shared/yontech-maquette-followup.ts";
import { autoSendMaquettes } from "../_shared/yontech-maquette-autosend.ts";
import { refreshStale } from "../_shared/yontech-maquette-refresh.ts";
import { collectDesigns, submitDesigns } from "../_shared/yontech-maquette-design.ts";
import { refreshMaison } from "../_shared/yontech-maquette-templates.ts";

// Préparation quotidienne de la prospection par maquette. Réveillée par
// pg_cron toutes les 5 minutes (yontech-maquettes-batch) ; prépare au plus
// deux prospects par passage jusqu'au quota du jour. N'envoie rien.
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
    // Maquettes enregistrées avec un ancien gabarit : redessinées par lots.
    const redrawn = await refreshStale(db, 15).catch((e) => { console.error("[Maquette rendu]", (e as Error).message); return 0; });
    // Maquettes « maison » remplies avec d'anciennes règles : remplies de nouveau (même modèle).
    const remplies = await refreshMaison(db, 30, 40_000).catch((e) => ({ error: (e as Error).message }));
    // Sites sur mesure : récupère les lots terminés, puis soumet les maquettes en attente.
    const designed = await collectDesigns(db).catch((e) => ({ error: (e as Error).message }));
    const designing = await submitDesigns(db, 12).catch((e) => ({ error: (e as Error).message }));
    // Relances automatiques après la première visite d'une maquette.
    const viewFollowups = await sendViewFollowups(db, 3).catch((e) => ({ error: (e as Error).message }));
    // Envoi automatique des maquettes prêtes (réglage « Envoi automatique »).
    const autoSent = await autoSendMaquettes(db, 6).catch((e) => ({ error: (e as Error).message }));
    // Maquettes « création » (sans site) : aucune lecture de site, plusieurs par passage.
    const creations = await prepareCreations(db, { max: 4 }).catch((e) => ({ error: (e as Error).message }));
    // Une maquette par passage (toutes les 5 minutes) : lire jusqu'à neuf pages
    // et quarante images d'un site occupe une exécution entière.
    const result = await prepareMaquettes(db, { max: 1, budgetMs: 100_000 });
    return json({ ...result, released, redrawn, remplies, designed, designing, viewFollowups, autoSent, creations });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Yontech Maquettes] Erreur", message);
    return json({ state: "error", error: message }, 500);
  }
});
