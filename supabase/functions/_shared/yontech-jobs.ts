import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { pickTemplates, templateVars } from "./yontech-core.ts";
import { alertAdmin, deliver, type MailTemplate, type SenderSettings } from "./yontech-mail.ts";
import { runSourcing } from "./yontech-sourcing.ts";

// Tâches de l'automate Yontech, partagées entre yontech-prospection-sender
// (envois, réveillé par pg_cron chaque minute quand un envoi est dû),
// yontech-prospection-sourcer (recherche d'entreprises, toutes les deux
// minutes quand la file baisse) et yontech-prospection-api (boutons de l'outil).

export async function sendNext(db: SupabaseClient) {
  const { data: claim, error } = await db.rpc("yontech_prospection_claim_next", {});
  if (error) throw error;
  if (claim?.state !== "claimed") return claim;
  const message = claim.message, settings = claim.settings as SenderSettings;
  if (claim.kind === "followup") return sendFollowup(db, claim);
  const { data: templates, error: templateError } = await db.from("yontech_prospection_templates").select("id,subject,body,audience").eq("active", true).eq("kind", "initial");
  if (templateError) throw templateError;
  // Public du modèle : un prospect sans site internet reçoit les modèles
  // « Sans site internet » s'il en existe, les autres « Avec site » ou « Toutes ».
  const pool = pickTemplates(templates || [], message.data || {});
  if (!pool.length) {
    await db.rpc("yontech_prospection_finish", { target_id: message.id, outcome: "fatal", target_error: "Aucun modèle de message actif pour ce public." });
    await alertAdmin(settings, "Aucun modèle de message actif", "Activez au moins un modèle de premier contact pour « Toutes les entreprises » dans l'écran Messages.");
    return { state: "paused", reason: "no_template" };
  }
  const template = pool[Math.floor(Math.random() * pool.length)] as MailTemplate;
  const result = await deliver({
    settings, template, to: message.email, vars: templateVars(message.data || {}), source: String((message.data || {}).source || ""),
    token: message.unsubscribe_token, trackingToken: message.tracking_token || undefined,
  });
  const { data: finished, error: finishError } = await db.rpc("yontech_prospection_finish", result.ok
    ? { target_id: message.id, outcome: "sent", target_template_id: template.id, target_subject: result.subject, target_body: result.body, target_message_id: result.messageId }
    : { target_id: message.id, outcome: result.outcome, target_template_id: template.id, target_subject: result.subject, target_body: result.body, target_error: result.error, target_retry_seconds: result.retrySeconds ?? null });
  if (finishError) throw finishError;
  if (!result.ok && finished?.paused) {
    await alertAdmin(settings, "La boîte d'envoi refuse les messages", `${result.error} Vérifiez l'adresse d'envoi et le mot de passe enregistré côté serveur (YONTECH_SMTP_PASSWORD).`);
  }
  return result.ok ? { state: "sent", to: message.email } : { state: "error", outcome: result.outcome, error: result.error };
}

// Relance : même destinataire, même fil (Re : objet d'origine, In-Reply-To),
// modèle du type relance1/relance2 tiré au sort parmi les actifs.
async function sendFollowup(db: SupabaseClient, claim: { followup: { id: string; stage: number }; message: Record<string, unknown>; settings: Record<string, unknown> }) {
  const f = claim.followup, message = claim.message, settings = claim.settings as SenderSettings;
  const kind = f.stage === 2 ? "relance2" : "relance1";
  const { data: templates, error: templateError } = await db.from("yontech_prospection_templates").select("id,subject,body,audience").eq("active", true).eq("kind", kind);
  if (templateError) throw templateError;
  const pool = pickTemplates(templates || [], (message.data as Record<string, unknown>) || {});
  if (!pool.length) {
    await db.rpc("yontech_prospection_followup_finish", { target_id: f.id, outcome: "transient", target_error: `Aucun modèle actif de type ${kind} pour ce public.` });
    return { state: "error", outcome: "transient", error: "no_followup_template" };
  }
  const picked = pool[Math.floor(Math.random() * pool.length)] as MailTemplate;
  const original = String(message.subject || "").replace(/^\s*(re|tr|fwd?)\s*:\s*/i, "");
  const template: MailTemplate = { id: picked.id, subject: original ? `Re: ${original}` : picked.subject, body: picked.body };
  const result = await deliver({
    settings, template, to: String(message.email), vars: templateVars((message.data as Record<string, unknown>) || {}),
    source: String(((message.data as Record<string, unknown>) || {}).source || ""),
    token: String(message.unsubscribe_token), trackingToken: message.tracking_token ? String(message.tracking_token) : undefined,
    inReplyTo: message.message_id ? String(message.message_id) : undefined,
  });
  const { data: finished, error: finishError } = await db.rpc("yontech_prospection_followup_finish", result.ok
    ? { target_id: f.id, outcome: "sent", target_template_id: picked.id, target_subject: result.subject, target_body: result.body, target_message_id: result.messageId }
    : { target_id: f.id, outcome: result.outcome, target_template_id: picked.id, target_subject: result.subject, target_body: result.body, target_error: result.error, target_retry_seconds: result.retrySeconds ?? null });
  if (finishError) throw finishError;
  if (!result.ok && finished?.paused) {
    await alertAdmin(settings, "La boîte d'envoi refuse les messages", `${result.error} Vérifiez l'adresse d'envoi et le mot de passe enregistré côté serveur (YONTECH_SMTP_PASSWORD).`);
  }
  return result.ok ? { state: "sent", kind: "followup", stage: f.stage, to: message.email } : { state: "error", outcome: result.outcome, error: result.error };
}

export async function knownFor(db: SupabaseClient, sirens: string[], emails: string[]) {
  const { data, error } = await db.rpc("yontech_prospection_known", { target_sirens: sirens, target_emails: emails });
  if (error) throw error;
  return { sirens: new Set<string>(data?.sirens || []), emails: new Set<string>(data?.emails || []) };
}

// Recherche d'entreprises : un passage dure jusqu'à `budgetMs` et s'arrête
// dès que `autopilot_batch` entreprises ont été ajoutées. Sans `force`, il ne
// part que si le pilote est actif, l'automate n'est pas en pause, la file est
// sous deux jours d'envoi et le dernier passage date de plus de 90 secondes.
export async function maybeSource(db: SupabaseClient, force = false, budgetMs = 100_000) {
  const { data: s, error } = await db.from("yontech_prospection_settings")
    .select("paused,autopilot,autopilot_target,autopilot_min_score,autopilot_batch,daily_cap,sourcing_cursor,last_sourcing_at,require_first_name").eq("id", 1).single();
  if (error) throw error;
  if (!force) {
    if (s.paused || !s.autopilot) return { state: "off" };
    if (s.last_sourcing_at && Date.now() - new Date(s.last_sourcing_at).getTime() < 90_000) return { state: "recent" };
    const { count } = await db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).eq("status", "queued");
    if ((count || 0) >= Math.max(s.daily_cap * 2, s.autopilot_batch)) return { state: "full", queued: count };
  }
  // Horodatage posé avant le balayage : deux réveils rapprochés ne lancent
  // pas deux balayages en parallèle.
  await db.from("yontech_prospection_settings").update({ last_sourcing_at: new Date().toISOString() }).eq("id", 1);
  const { cursor, report, total, done } = await runSourcing({
    target: s.autopilot_target, cursor: s.sourcing_cursor, batch: s.autopilot_batch, minScore: s.autopilot_min_score,
    requireFirstName: s.require_first_name === true, deadline: Date.now() + budgetMs,
    searchApiKey: Deno.env.get("YONTECH_SEARCH_API_KEY") || undefined,
    known: (sirens, emails) => knownFor(db, sirens, emails),
    enqueue: async (items) => {
      const { data, error: enqueueError } = await db.rpc("yontech_prospection_enqueue", { items, target_origin: "autopilote" });
      if (enqueueError) throw enqueueError;
      return Number(data?.added || 0);
    },
    scanned: async (items) => {
      const { error: scanError } = await db.rpc("yontech_prospection_mark_scanned", { items });
      if (scanError) throw scanError;
    },
  });
  const finishedAt = new Date().toISOString();
  await db.from("yontech_prospection_settings").update({
    sourcing_cursor: cursor, last_sourcing_at: finishedAt, last_sourcing_report: { ...report, at: finishedAt, total, done },
  }).eq("id", 1);
  return { state: "sourced", report };
}
