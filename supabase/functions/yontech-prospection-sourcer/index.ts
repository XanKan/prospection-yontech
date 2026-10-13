import { createClient } from "npm:@supabase/supabase-js@2";
import { maybeSource } from "../_shared/yontech-jobs.ts";

// Recherche d'entreprises (pilote automatique) : réveillée par pg_cron
// (tâche yontech-prospection-sourcer) toutes les deux minutes, seulement
// quand le pilote est actif et que la file descend sous deux jours d'envoi.
// Chaque passage balaie une ou plusieurs pages SIRENE, cherche le site et
// l'adresse de chaque entreprise sur le web, et met les adresses trouvées en
// file. Tourne jour et nuit : la découverte web est lente, l'envoi ne l'est pas.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Configuration serveur indisponible" }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  try { return json({ sourcing: await maybeSource(db, false, 100_000) }); } catch (error) { return json({ sourcing: { state: "crash", error: String((error as Error)?.message || error) } }); }
});
