import { createClient } from "npm:@supabase/supabase-js@2";
import { sendNext } from "../_shared/yontech-jobs.ts";

// Réveillée par pg_cron (tâche yontech-prospection-sender) uniquement
// lorsqu'un envoi est dû. Le réveil a lieu au plus une fois par minute : pour
// tenir les gros quotas, chaque réveil ENCHAÎNE les envois pendant ~50
// secondes, en respectant l'espacement, le créneau et le quota décidés
// atomiquement par yontech_prospection_claim_next() à chaque message.
// La recherche d'entreprises est une tâche à part (yontech-prospection-sourcer).

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendLoop(db: Parameters<typeof sendNext>[0]) {
  const deadline = Date.now() + 50_000;
  let sent = 0, last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = (await sendNext(db)) as Record<string, unknown>;
    if (last?.state === "sent") { sent++; continue; }
    if (last?.state === "error") continue;
    if (last?.state === "waiting" && last.next_send_at) {
      const wait = new Date(String(last.next_send_at)).getTime() - Date.now();
      if (wait <= 0) continue;
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
      continue;
    }
    break; // paused, off_hours, cap_reached, empty…
  }
  return { ...last, sent_this_wake: sent };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Configuration serveur indisponible" }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  try { return json({ send: await sendLoop(db) }); } catch (error) { return json({ send: { state: "crash", error: String((error as Error)?.message || error) } }); }
});
