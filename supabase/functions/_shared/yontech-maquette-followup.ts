import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { templateVars } from "./yontech-core.ts";
import { deliver, type MailTemplate, type SenderSettings } from "./yontech-mail.ts";
import { maquetteDomainReady, maquetteUrl } from "./yontech-maquette-jobs.ts";

// Relance automatique après visite : une heure après la première vraie visite
// d'une maquette envoyée (équipe et robots exclus), un court message part dans
// le fil du mail de la maquette, une seule fois, si le prospect n'a pas répondu.
// Modèle « Relance après visite » (écran Messages), envoyé pendant les créneaux
// et les jours d'envoi de l'automate.

const DEFAULT_BODY = `{bonjour},

Je me permets de revenir vers vous au sujet du site que nous avons préparé pour {entreprise} : {lien}

Qu'en avez-vous pensé ? S'il vous convient, nous le mettons en ligne cette semaine sur votre adresse, avec vos corrections, pour 39 € par mois tout compris, sans engagement.

Un simple « ok » en réponse suffit : nous vous appelons pour l'ajuster avec vous.

Bien cordialement,`;

export function inSendingHours(s: Record<string, unknown>) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  const hm = `${get("hour")}:${get("minute")}`;
  const days = Array.isArray(s.send_days) ? (s.send_days as number[]) : [1, 2, 3, 4, 5];
  if (!days.includes(dow)) return false;
  const within = (a: unknown, b: unknown) => a && b && hm >= String(a).slice(0, 5) && hm < String(b).slice(0, 5);
  return Boolean(within(s.window_start, s.window_end) || within(s.window2_start, s.window2_end));
}

export async function sendViewFollowups(db: SupabaseClient, max = 3) {
  const { data: settings } = await db.from("yontech_prospection_settings").select("*").eq("id", 1).single();
  if (!settings || settings.paused || !settings.maquette_enabled) return { state: "off" };
  if (!inSendingHours(settings)) return { state: "off_hours" };
  const { data: rows } = await db.from("yontech_maquettes")
    .select("id,slug,company,mail_subject,mail_message_id,yontech_prospection_messages(id,email,company,data,status,replied_at,unsubscribe_token,tracking_token)")
    .eq("review", "envoye").eq("status", "en_ligne").is("view_followup_at", null).not("first_view_at", "is", null)
    .lt("first_view_at", new Date(Date.now() - 3_600_000).toISOString()).order("first_view_at").limit(max * 3);
  const { data: tpls } = await db.from("yontech_prospection_templates").select("id,subject,body").eq("kind", "relance_vue").eq("active", true);
  if (!tpls?.length) return { state: "no_template" };
  const ready = await maquetteDomainReady();
  let sent = 0;
  for (const r of rows || []) {
    if (sent >= max) break;
    const msg = (r as Record<string, unknown>).yontech_prospection_messages as Record<string, unknown> | null;
    // Marqué avant l'envoi : jamais deux relances, même si l'exécution est coupée.
    await db.from("yontech_maquettes").update({ view_followup_at: new Date().toISOString() }).eq("id", r.id).is("view_followup_at", null);
    if (!msg?.email || msg.replied_at || !["sent", "maquette"].includes(String(msg.status))) continue;
    const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", String(msg.email)).maybeSingle();
    if (banned) continue;
    const picked = tpls[Math.floor(Math.random() * tpls.length)];
    const link = maquetteUrl(r.slug, ready);
    const original = String(r.mail_subject || "").replace(/^\s*(re|tr|fwd?)\s*:\s*/i, "");
    const template: MailTemplate = { id: picked.id, subject: original ? `Re: ${original}` : picked.subject, body: String(picked.body || DEFAULT_BODY).replaceAll("{lien}", link) };
    const result = await deliver({
      settings: settings as SenderSettings, template, to: String(msg.email),
      vars: templateVars({ ...((msg.data as Record<string, unknown>) || {}), entreprise: String(msg.company || r.company) } as Parameters<typeof templateVars>[0]),
      source: String(((msg.data as Record<string, unknown>) || {}).source || ""),
      token: String(msg.unsubscribe_token), trackingToken: msg.tracking_token ? String(msg.tracking_token) : undefined,
      inReplyTo: r.mail_message_id || undefined,
    });
    if (result.ok) sent++;
    else await db.from("yontech_maquettes").update({ view_followup_error: result.error.slice(0, 200) }).eq("id", r.id);
  }
  return { state: "done", sent };
}
