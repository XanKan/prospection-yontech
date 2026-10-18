import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { templateVars } from "./yontech-core.ts";
import { deliver, type SenderSettings } from "./yontech-mail.ts";
import { inSendingHours } from "./yontech-maquette-followup.ts";
import { CREATION_BODY, CREATION_SUBJECT, MAQUETTE_BODY, MAQUETTE_SUBJECT, maquetteDomainReady, maquetteUrl, parisMidnightIso } from "./yontech-maquette-jobs.ts";
import { maquetteMailBlock, type SiteData } from "./yontech-maquette.ts";

// Envoi automatique des maquettes (réglage « Envoi automatique ») : une maquette
// dont le site sur mesure est prêt part deux heures après, pendant les créneaux
// et les jours d'envoi, dans la limite du quota du jour de son type. Pendant ces
// deux heures, elle reste visible dans l'onglet et peut être supprimée.
// Mêmes contrôles que la validation à la main.

const DELAY_MS = 2 * 3_600_000;

export async function autoSendMaquettes(db: SupabaseClient, max = 3) {
  const { data: settings } = await db.from("yontech_prospection_settings").select("*").eq("id", 1).single();
  // Indépendant de la préparation : les maquettes déjà prêtes partent même si la préparation est suspendue.
  if (!settings?.maquette_auto || settings.paused) return { state: "off" };
  if (!inSendingHours(settings)) return { state: "off_hours" };
  const since = parisMidnightIso();
  const quota: Record<string, number> = { refonte: Number(settings.maquette_daily || 0), creation: Number(settings.maquette_daily_creation || 0) };
  const left: Record<string, number> = {};
  for (const kind of ["refonte", "creation"]) {
    const { count } = await db.from("yontech_maquettes").select("id", { count: "exact", head: true }).eq("kind", kind).eq("review", "envoye").gte("sent_at", since);
    left[kind] = Math.max(0, quota[kind] - (count || 0));
  }
  if (!left.refonte && !left.creation) return { state: "quota" };
  const { data: rows } = await db.from("yontech_maquettes")
    .select("id,slug,company,kind,data,mail_subject,mail_body,template_id,status,yontech_prospection_messages(id,email,company,status,data,unsubscribe_token,tracking_token)")
    .eq("review", "a_valider").eq("status", "en_ligne").eq("design_status", "ok")
    .lt("design_at", new Date(Date.now() - DELAY_MS).toISOString()).order("prepared_at").limit(20);
  const ready = await maquetteDomainReady();
  let sent = 0;
  const errors: string[] = [];
  for (const m of rows || []) {
    if (sent >= max) break;
    const kind = m.kind || "refonte";
    if (!left[kind]) continue;
    const msg = (m as Record<string, unknown>).yontech_prospection_messages as Record<string, any> | null;
    if (!msg?.email) continue;
    // Réservé avant l'envoi : jamais deux envois de la même maquette.
    const { data: claimed } = await db.from("yontech_maquettes").update({ review: "envoi" }).eq("id", m.id).eq("review", "a_valider").select("id").maybeSingle();
    if (!claimed) continue;
    const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", msg.email).maybeSingle();
    if (banned) {
      await db.from("yontech_maquettes").update({ review: "rejete" }).eq("id", m.id);
      await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Adresse exclue" }).eq("id", msg.id);
      continue;
    }
    const link = maquetteUrl(m.slug, ready);
    const creation = kind === "creation";
    const template = {
      id: "maquette",
      subject: String(m.mail_subject || (creation ? CREATION_SUBJECT : MAQUETTE_SUBJECT)).slice(0, 200),
      body: String(m.mail_body || (creation ? CREATION_BODY : MAQUETTE_BODY)).slice(0, 6000).replaceAll("{lien}", link),
    };
    const vars = templateVars({ ...(msg.data || {}), entreprise: msg.company || m.company } as Parameters<typeof templateVars>[0]);
    const result = await deliver({
      settings: settings as SenderSettings, template, to: msg.email, vars, source: String(msg.data?.source || ""),
      token: msg.unsubscribe_token, trackingToken: msg.tracking_token || undefined, block: maquetteMailBlock(m.data as SiteData, link),
    });
    if (!result.ok) {
      if (result.outcome === "recipient_rejected") {
        await db.rpc("yontech_prospection_finish", { target_id: msg.id, outcome: "recipient_rejected", target_subject: result.subject, target_body: result.body, target_error: result.error });
        await db.from("yontech_maquettes").update({ review: "rejete" }).eq("id", m.id);
      } else {
        await db.from("yontech_maquettes").update({ review: "a_valider" }).eq("id", m.id);
      }
      errors.push(`${m.company} : ${result.error}`.slice(0, 160));
      if (result.outcome === "fatal" || result.outcome === "throttled") break;
      continue;
    }
    if (msg.status !== "sent") await db.rpc("yontech_prospection_finish", { target_id: msg.id, outcome: "sent", target_template_id: m.template_id || null, target_subject: result.subject, target_body: result.body, target_message_id: result.messageId });
    await db.from("yontech_prospection_messages").update({ data: { ...(msg.data || {}), maquette: m.slug } }).eq("id", msg.id);
    const now = new Date().toISOString();
    await db.from("yontech_maquettes").update({ review: "envoye", sent_at: now, emailed_at: now, mail_message_id: result.messageId, email_to: msg.email, mail_subject: template.subject }).eq("id", m.id);
    left[kind]--; sent++;
  }
  return { state: "done", sent, errors };
}
