import nodemailer from "npm:nodemailer@6.10.1";
import { BRAND, classifySmtpError, composeEmail, type ComposeInput, htmlEscape, retryDelaySeconds, youtubeThumb, type SmtpOutcome, type Vars } from "./yontech-core.ts";
type ComposeBlock = NonNullable<ComposeInput["block"]>;

// Envoi SMTP depuis la boîte Hostinger de Yontech. Les fonctions Supabase
// bloquent les ports 25 et 587 : seul le port 465 (TLS implicite) est utilisable.
// Secrets : YONTECH_SMTP_PASSWORD (obligatoire), YONTECH_SMTP_HOST (défaut
// smtp.hostinger.com), YONTECH_SMTP_PORT (défaut 465), YONTECH_SMTP_USER
// (défaut : l'adresse d'envoi).
export type SenderSettings = {
  sender_name: string; sender_email: string | null; reply_to: string | null;
  signature: string; footer_identity: string; video_url?: string | null;
  // Boîtes supplémentaires (même nom d'expéditeur) ; mot de passe dans
  // YONTECH_SMTP_PASSWORD_2 … _5. Une boîte sans mot de passe est ignorée.
  sender_email_2?: string | null; sender_email_3?: string | null; sender_email_4?: string | null; sender_email_5?: string | null;
};

type Box = { address: string; user: string; pass: string };

// Boîtes d'envoi utilisables : la principale, puis les supplémentaires configurées.
export function senderBoxes(settings: SenderSettings): Box[] {
  const s = settings as Record<string, unknown>;
  const out: Box[] = [];
  for (let i = 1; i <= 5; i++) {
    const address = String((i === 1 ? s.sender_email : s[`sender_email_${i}`]) || "").trim();
    const pass = Deno.env.get(`YONTECH_SMTP_PASSWORD${i === 1 ? "" : `_${i}`}`) || "";
    if (address && pass) out.push({ address, pass, user: i === 1 ? Deno.env.get("YONTECH_SMTP_USER") || address : address });
  }
  return out;
}

// Un destinataire est toujours servi par la même boîte : ses relances restent
// dans le même fil et l'envoi se répartit à parts égales entre les boîtes.
function boxFor(settings: SenderSettings, recipient: string): Box {
  const boxes = senderBoxes(settings);
  if (!boxes.length) return { address: settings.sender_email || "", user: "", pass: "" };
  let h = 0;
  for (const ch of recipient.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return boxes[h % boxes.length];
}
const primaryBox = (settings: SenderSettings): Box => senderBoxes(settings)[0] || { address: settings.sender_email || "", user: "", pass: "" };
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

function transport(box: Box) {
  const pass = box.pass;
  if (!pass || !box.address) {
    throw Object.assign(new Error("Boîte d'envoi non configurée : adresse ou mot de passe SMTP manquant."), { code: "EAUTH" });
  }
  return nodemailer.createTransport({
    host: smtpHost(), port: smtpPort(), secure: true,
    auth: { user: box.user || box.address, pass },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 45_000,
  });
}

export type DeliveryResult =
  | { ok: true; subject: string; body: string; messageId: string }
  | { ok: false; outcome: SmtpOutcome; error: string; subject: string; body: string; retrySeconds?: number };

// Miniature YouTube en 16:9 si elle existe (miniature personnalisée) ; vérifiée
// une fois par heure, sinon repli sur la version 4:3.
const thumbCache = new Map<string, { url: string; at: number }>();
export async function resolveVideoThumb(videoUrl: string): Promise<string> {
  if (!videoUrl) return "";
  const hit = thumbCache.get(videoUrl);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.url;
  let url = youtubeThumb(videoUrl);
  const maxres = youtubeThumb(videoUrl, "maxresdefault");
  if (maxres) {
    try {
      const response = await fetch(maxres, { method: "HEAD", signal: AbortSignal.timeout(4000) });
      if (response.ok && Number(response.headers.get("content-length") || 0) > 5000) url = maxres;
    } catch { /* repli silencieux sur hqdefault */ }
  }
  thumbCache.set(videoUrl, { url, at: Date.now() });
  return url;
}

// Vérification de l'adresse avant l'envoi (et avant la mise en file ou la
// préparation d'une maquette) : syntaxe, adresses techniques (noreply…),
// domaines jetables, fautes de frappe courantes, puis domaine qui reçoit du
// courrier (MX, ou à défaut une adresse IP). En cas de doute DNS, on accepte.
// La boîte elle-même ne peut pas être testée d'ici (port 25 fermé chez Supabase).
const COMMON_DOMAINS = new Set(["gmail.com", "hotmail.fr", "hotmail.com", "outlook.fr", "outlook.com", "live.fr", "live.com", "yahoo.fr", "yahoo.com",
  "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "neuf.fr", "laposte.net", "icloud.com", "me.com", "bbox.fr", "aol.com", "gmx.fr", "numericable.fr"]);
const ROLE_RE = /^(no-?reply|do-?not-?reply|ne-?pas-?repondre|nepasrepondre|postmaster|abuse|mailer-daemon|bounce[s]?|hostmaster|root|nobody|devnull|null|test|example)([.+_-].*)?@/i;
const DISPOSABLE = new Set(["yopmail.com", "yopmail.fr", "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "trashmail.com", "jetable.org", "getnada.com", "sharklasers.com", "maildrop.cc", "dispostable.com", "throwawaymail.com"]);
const TYPO_DOMAINS = new Set(["gmial.com", "gmai.com", "gmail.fr", "gmal.com", "gamil.com", "gmail.co", "gnail.com", "hotmial.com", "hotmail.f", "hotmal.fr", "hotamil.fr", "outlok.fr", "outloo.fr",
  "orange.fe", "orage.fr", "oragne.fr", "ornage.fr", "wanado.fr", "wanadoo.com", "wandoo.fr", "free.f", "fre.fr", "sfr.f", "laposte.fr", "lapost.net", "yaho.fr", "yahou.fr", "yahoo.f"]);
const domainCache = new Map<string, boolean>();
async function dnsJson(name: string, type: string) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
  return await r.json() as { Status?: number; Answer?: { type: number; data: string }[] };
}
export async function checkAddress(email: string): Promise<{ ok: boolean; reason?: string }> {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || e.includes("..")) return { ok: false, reason: "adresse mal formée" };
  if (ROLE_RE.test(e)) return { ok: false, reason: "adresse technique (noreply, postmaster…)" };
  const domain = e.split("@")[1];
  if (DISPOSABLE.has(domain)) return { ok: false, reason: "adresse jetable" };
  if (TYPO_DOMAINS.has(domain)) return { ok: false, reason: "faute de frappe dans le domaine" };
  if (COMMON_DOMAINS.has(domain)) return { ok: true };
  if (!domainCache.has(domain)) {
    let ok = true;
    try {
      const mx = await dnsJson(domain, "MX");
      const records = (mx.Answer || []).filter((a) => a.type === 15);
      if (mx.Status === 3) ok = false; // le domaine n'existe pas
      else if (records.length) ok = !records.every((a) => /^0\s+\.?$/.test(String(a.data).trim())); // « MX nul » : refuse tout courrier
      else if (mx.Status === 0) { const a = await dnsJson(domain, "A"); ok = (a.Answer || []).some((x) => x.type === 1); }
    } catch { ok = true; }
    domainCache.set(domain, ok);
  }
  return domainCache.get(domain) ? { ok: true } : { ok: false, reason: "domaine sans messagerie" };
}
export async function mailDomainOk(email: string) { return (await checkAddress(email)).ok; }

export async function deliver(input: {
  settings: SenderSettings; template: MailTemplate; to: string; vars: Vars; token: string;
  trackingToken?: string; subjectPrefix?: string; inReplyTo?: string; source?: string;
  block?: ComposeBlock; plain?: boolean;
}): Promise<DeliveryResult> {
  const check = await checkAddress(input.to);
  if (!check.ok) {
    return { ok: false, outcome: "recipient_rejected", error: `Adresse écartée avant l'envoi : ${check.reason}.`, subject: input.template.subject, body: "" };
  }
  const links = unsubscribeLinks(input.token);
  const videoThumb = input.block || input.plain ? "" : await resolveVideoThumb(input.settings.video_url || "");
  const mail = composeEmail({
    subject: input.template.subject, body: input.template.body, signature: input.settings.signature,
    footerIdentity: input.settings.footer_identity, unsubscribeUrl: links.page, vars: input.vars,
    videoUrl: input.block ? "" : input.settings.video_url || "", videoThumb, source: input.source, block: input.block,
    tracking: input.trackingToken ? { base: trackingBase(), token: input.trackingToken } : undefined,
    logoUrl: Deno.env.get("YONTECH_LOGO_URL") ?? BRAND.logo, plain: input.plain,
  });
  const subject = (input.subjectPrefix || "") + mail.subject;
  const box = boxFor(input.settings, input.to);
  const sender = box.address;
  // Réponses et désinscriptions par e-mail : toujours vers la boîte principale (lue par l'outil).
  const primary = input.settings.reply_to || input.settings.sender_email || sender;
  const domain = sender.split("@")[1] || "yontech.fr";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  try {
    const info = await transport(box).sendMail({
      from: { name: input.settings.sender_name || BRAND.senderName, address: sender },
      to: input.to,
      replyTo: primary !== sender ? primary : input.settings.reply_to || undefined,
      subject, text: mail.text, html: mail.html, messageId,
      headers: {
        "List-Unsubscribe": `<${links.oneClick}>, <mailto:${primary}?subject=${encodeURIComponent("Désinscription")}>`,
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
      ok: false, outcome, error: ((senderBoxes(input.settings).length > 1 ? `[${sender}] ` : "") + String(e.response || e.message || error)).slice(0, 500), subject, body: mail.text,
      retrySeconds: outcome === "throttled" ? retryDelaySeconds(error) : undefined,
    };
  }
}

// Message interne à l'équipe (récapitulatif) : envoyé depuis la boîte
// principale vers l'adresse de réponse (ou la boîte principale).
export async function mailTeam(settings: SenderSettings, subject: string, html: string, text: string) {
  const to = settings.reply_to || settings.sender_email;
  if (!to) throw new Error("Aucune adresse d'équipe configurée.");
  await transport(primaryBox(settings)).sendMail({ from: { name: BRAND.name, address: settings.sender_email as string }, to, subject, text, html });
  return to;
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
    await transport(primaryBox(settings)).sendMail({
      from: { name: BRAND.name, address: settings.sender_email as string }, to, subject: `Prospection ${BRAND.name} : ${subject}`,
      text: `${subject}\n\n${reason}\n\n${BRAND.tool}`, html,
    });
  } catch { /* la boîte est probablement la cause de la pause */ }
}
