import { createClient } from "npm:@supabase/supabase-js@2";
import { collectTemplateLibrary, fillFromLibrary, lastCopyError, submitGroupTemplates, submitTemplateLibrary } from "../_shared/yontech-maquette-templates.ts";
import { buildSite } from "../_shared/yontech-maquette.ts";

// Bibliothèque de modèles de maquettes : transformation unique des sites sur
// mesure en modèles à trous (« submit »), puis récupération (« collect »).
// Protégée par le secret de yontech_prospection_runtime.
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    // Aperçu : remplit une maquette de refonte pour une adresse, sans rien enregistrer ni envoyer.
    if (action === "preview") {
      const built = await buildSite(String(body.url || ""), { company: String(body.company || ""), noAi: true });
      if ("error" in built) return json({ error: built.error });
      const lib = await fillFromLibrary(db, built.data, "refonte", String(body.naf || ""));
      return json(lib ? { direction: lib.direction, html: lib.html, copyError: lastCopyError } : { error: "aucun modèle" });
    }
    if (action === "submit") return json(await submitTemplateLibrary(db));
    if (action === "groups") return json(await submitGroupTemplates(db));
    if (action === "collect") return json(await collectTemplateLibrary(db));
    return json({ error: "action inconnue" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
