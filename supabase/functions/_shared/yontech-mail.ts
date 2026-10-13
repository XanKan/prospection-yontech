import nodemailer from "npm:nodemailer@6.10.1";
import { BRAND, classifySmtpError, composeEmail, htmlEscape, retryDelaySeconds, type SmtpOutcome, type Vars } from "./yontech-core.ts";

// Envoi SMTP depuis la boîte Hostinger de Yontech. Les fonctions Supabase
// bloquent les ports 25 et 587 : seul le port 465 (TLS implicite) est utilisable.
// Secrets : YONTECH_SMTP_PASSWORD (obligatoire), YONTECH_SMTP_HOST (défaut
// smtp.hostinger.com), YONTECH_SMTP_PORT (défaut 465), YONTECH_SMTP_USER
// (défaut : l'adresse d'envoi).
export type SenderSettings = {
  sender_name: string; sender_email: string | null; reply_to: string | null;
  signature: string; footer_identity: string; video_url?: string | null;
};
export type MailTemplate = { id: string; subject: string; body: string };

export function smtpConfigured() {
  return !!Deno.env.get("YONTECH_SMTP_PASSWORD");
}

export function smtpHost() { return Deno.env.get("YONTECH_SMTP_HOST") || "smtp.hostinger.com"; }
export function smtpPort() { return Number(Deno.env.get("YONTECH_SMTP_PORT") || 465); }

export function functionsBase() {
  return (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1";
}

export function unsubscribeLinks(token: string) {
  const page = Deno.env.get("YONTECH_UNSUBSCRIBE_PAGE") || BRAND.unsubscribePage;
  return {
    page: `${page}?t=${encodeURIComponent(token)}`,
    oneClick: `${functionsBase()}/yontech-prospection-unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

// Les liens suivis passent par la fonction publique de suivi. Si un jour
// yontech.fr redirige un chemin (ex. yontech.fr/t) vers cette fonction, il
// suffit de renseigner YONTECH_TRACKING_BASE pour garder les liens sur le domaine.
export function trackingBase() {
  return Deno.env.get("YONTECH_TRACKING_BASE") || `${functionsBase()}/yontech-prospection-track`;
}

function transport(settings: SenderSettings) {
  const pass = Deno.env.get("YONTECH_SMTP_PASSWORD");
  if (!pass || !settings.sender_email) {
    throw Object.assign(new Error("Boîte d'envoi non configurée : adresse ou mot de passe SMTP manquant."), { code: "EAUTH" });
  }
  return nodemailer.createTransport({
    host: smtpHost(), port: smtpPort(), secure: true,
    auth: { user: Deno.env.get("YONTECH_SMTP_USER") || settings.sender_email, pass },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 45_000,
  });
}

export type DeliveryResult =
  | { ok: true; subject: string; body: string; messageId: string }
  | { ok: false; outcome: SmtpOutcome; error: string; subject: string; body: string; retrySeconds?: number };

export async function deliver(input: {
  settings: SenderSettings; template: MailTemplate; to: string; vars: Vars; token: string;
  trackingToken?: string; subjectPrefix?: string; inReplyTo?: string; source?: string;
}): Promise<DeliveryResult> {
  const links = unsubscribeLinks(input.token);
  const mail = composeEmail({
    subject: input.template.subject, body: input.template.body, signature: input.settings.signature,
    footerIdentity: input.settings.footer_identity, unsubscribeUrl: links.page, vars: input.vars,
    videoUrl: input.settings.video_url || "", source: input.source,
    tracking: input.trackingToken ? { base: trackingBase(), token: input.trackingToken } : undefined,
    logoUrl: Deno.env.get("YONTECH_LOGO_URL") ?? BRAND.logo,
  });
  const subject = (input.subjectPrefix || "") + mail.subject;
  const sender = input.settings.sender_email || "";
  const domain = sender.split("@")[1] || "yontech.fr";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  try {
    const info = await transport(input.settings).sendMail({
      from: { name: input.settings.sender_name || BRAND.senderName, address: sender },
      to: input.to,
      replyTo: input.settings.reply_to || undefined,
      subject, text: mail.text, html: mail.html, messageId,
      headers: {
        "List-Unsubscribe": `<${links.oneClick}>, <mailto:${sender}?subject=${encodeURIComponent("Désinscription")}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        // Une relance s'affiche dans le fil du premier message chez le destinataire.
        ...(input.inReplyTo ? { "In-Reply-To": input.inReplyTo, "References": input.inReplyTo } : {}),
      },
    });
    const rejected = (info.rejected || []).map(String);
    if (rejected.length) return { ok: false, outcome: "recipient_rejected", error: "Adresse refusée par le serveur de destination.", subject, body: mail.text };
    return { ok: true, subject, body: mail.text, messageId: String(info.messageId || messageId) };
  } catch (error) {
    const e = error as { message?: string; response?: string };
    const outcome = classifySmtpError(error);
    return {
      ok: false, outcome, error: String(e.response || e.message || error).slice(0, 500), subject, body: mail.text,
      retrySeconds: outcome === "throttled" ? retryDelaySeconds(error) : undefined,
    };
  }
}

// Alerte à l'administrateur (automate en pause) : envoyée depuis la même
// boîte, sans dépendance à un autre service. Silencieuse si la boîte elle-même
// est en cause (le tableau de bord affiche alors la raison).
export async function alertAdmin(settings: SenderSettings, subject: string, reason: string) {
  const to = settings.reply_to || settings.sender_email;
  if (!to || !smtpConfigured()) return;
  const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#1f2030;max-width:600px"><p style="margin:0 0 6px;font:700 12px Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#e0473f">Automate en pause</p>` +
    `<h1 style="margin:0 0 14px;font:800 22px Arial,sans-serif;color:#15161f">${htmlEscape(subject)}</h1><p style="margin:0 0 18px;color:#5b5d72">${htmlEscape(reason)}</p>` +
    `<p><a href="${BRAND.tool}" style="display:inline-block;background:${BRAND.accent};color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:9px">Ouvrir l'outil de prospection</a></p>` +
    `<p style="margin:22px 0 0;font-size:13px;color:#8a8ca0">Corrigez le réglage en cause puis cliquez sur « Démarrer l'automate ».</p></div>`;
  try {
    await transport(settings).sendMail({
      from: { name: BRAND.name, address: settings.sender_email as string }, to, subject: `Prospection ${BRAND.name} : ${subject}`,
      text: `${subject}\n\n${reason}\n\n${BRAND.tool}`, html,
    });
  } catch { /* la boîte est probablement la cause de la pause */ }
}
