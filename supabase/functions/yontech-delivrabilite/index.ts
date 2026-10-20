import { createClient } from "npm:@supabase/supabase-js@2";
import { templateVars } from "../_shared/yontech-core.ts";
import { deliver, type MailTemplate } from "../_shared/yontech-mail.ts";

// Test de délivrabilité (MailReach, mail-tester…) : envoie un vrai premier mail de
// prospection (modèle actif, pixel, liens suivis, vidéo) aux adresses du test, avec
// le code du test en fin de message. Protégé par le secret de yontech_prospection_runtime.
const SAMPLE = { entreprise: "MARTIN ELECTRICITE", prenom: "Pierre", nom: "Martin", ville: "Lyon", cp: "69003", metier: "électricité", departement: "69", effectif: "3 à 5", site: "martin-electricite.fr" };
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  const body = await req.json().catch(() => ({}));
  const to = (Array.isArray(body.to) ? body.to : []).map(String).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 60);
  const code = String(body.code || "").replace(/[^\w-]/g, "").slice(0, 60);
  if (!to.length || !code) return json({ error: "Adresses et code du test requis." }, 400);
  const { data: settings } = await db.from("yontech_prospection_settings").select("*").eq("id", 1).single();
  const { data: tpls } = await db.from("yontech_prospection_templates").select("id,subject,body").eq("active", true).eq("kind", "initial");
  if (!settings || !tpls?.length) return json({ error: "Réglages ou modèle actif manquant." }, 400);
  const tpl = tpls[Math.floor(Math.random() * tpls.length)];
  const template: MailTemplate = { id: tpl.id, subject: tpl.subject, body: `${tpl.body}\n\n${code}` };
  const results: { to: string; ok: boolean; error?: string }[] = [];
  for (const address of to) {
    const r = await deliver({ settings, template, to: address, vars: templateVars(SAMPLE), token: crypto.randomUUID(), trackingToken: crypto.randomUUID() });
    results.push({ to: address, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  return json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), subject: tpl.subject });
});
