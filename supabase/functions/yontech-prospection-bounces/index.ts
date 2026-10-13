import { createClient } from "npm:@supabase/supabase-js@2";

// Ingestion des rebonds de prospection : lit la boîte d'envoi Yontech via
// l'API mail Hostinger, repère les avis de non-remise (MAILER-DAEMON) et, pour
// chaque refus définitif (code 5xx), passe le message en échec et exclut
// l'adresse (RPC yontech_prospection_bounce). La boîte n'est jamais modifiée :
// un curseur (uid) évite de relire les messages déjà examinés.
//
// Réveillée par pg_cron (yontech-prospection-bounces, toutes les 10 minutes),
// protégée par le secret de yontech_prospection_runtime.
// Secrets : YONTECH_HOSTINGER_MAIL_TOKEN et YONTECH_HOSTINGER_MAILBOX_ID
// (identifiant de la boîte, « AC… », donné par l'API Hostinger). Optionnel :
// YONTECH_HOSTINGER_MAIL_FOLDER (défaut INBOX). Sans ces secrets, la tâche
// répond « unconfigured » sans erreur.

const MAIL_API = "https://api.mail.hostinger.com";

const DAEMON_RE = /mailer-daemon|postmaster/i;
// Réponses automatiques (absence, accusé de réception) : jamais comptées comme une réponse.
const AUTO_RE = /absence|out of office|auto.?reply|réponse automatique|automatic reply|accusé de réception|delivery|undeliver|mailer-daemon|postmaster|noreply|no-reply|ne pas répondre/i;
const SUBJECT_RE = /undeliver|delivery status|delivery fail|returned to sender|non.remise|mail delivery/i;
const RECIPIENT_RE = /<([^<>\s]+@[^<>\s]+)>:\s*host[\s\S]{0,400}?said:\s*(\d{3})([\s\S]{0,300}?)(?:\(in reply|\n\n|$)/gi;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function mailApi(path: string) {
  const token = Deno.env.get("YONTECH_HOSTINGER_MAIL_TOKEN");
  if (!token) return null;
  const response = await fetch(`${MAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`hostinger_mail_${response.status}`);
  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Configuration serveur indisponible" }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  const mailbox = Deno.env.get("YONTECH_HOSTINGER_MAILBOX_ID") || "";
  if (!Deno.env.get("YONTECH_HOSTINGER_MAIL_TOKEN") || !mailbox) return json({ state: "unconfigured", missing: "YONTECH_HOSTINGER_MAIL_TOKEN / YONTECH_HOSTINGER_MAILBOX_ID" });
  const folder = encodeURIComponent(Deno.env.get("YONTECH_HOSTINGER_MAIL_FOLDER") || "INBOX");

  try {
    const { data: runtime, error: runtimeError } = await db.from("yontech_prospection_runtime").select("last_bounce_uid").eq("id", 1).single();
    if (runtimeError) throw runtimeError;
    const lastUid = Number(runtime?.last_bounce_uid) || 0;

    const list = await mailApi(`/api/v1/mailboxes/${mailbox}/folders/${folder}/messages?perPage=100&sort=-uid`);
    const messages: Array<{ uid: number; subject?: string; from?: { address?: string } }> = list?.data || [];
    const fresh = messages.filter((m) => Number(m.uid) > lastUid);
    const maxUid = messages.reduce((max, m) => Math.max(max, Number(m.uid) || 0), lastUid);

    let bounced = 0, softs = 0, replied = 0;
    const details: Array<Record<string, unknown>> = [];
    for (const message of fresh) {
      const fromAddress = String(message.from?.address || "").toLowerCase();
      const subject = String(message.subject || "");
      if (!DAEMON_RE.test(fromAddress) && !SUBJECT_RE.test(subject)) {
        // Réponse d'un prospect : la ligne passe « a répondu », ses relances s'arrêtent.
        if (!fromAddress || AUTO_RE.test(fromAddress + " " + subject)) continue;
        const { data: prospect } = await db.from("yontech_prospection_messages").select("id").eq("email", fromAddress).eq("status", "sent").is("replied_at", null).limit(1).maybeSingle();
        if (prospect?.id) {
          const { error: replyError } = await db.rpc("yontech_prospection_mark_replied", { target_id: prospect.id, replied: true });
          if (!replyError) { replied++; details.push({ email: fromAddress, replied: true }); }
        }
        continue;
      }
      const content = await mailApi(`/api/v1/mailboxes/${mailbox}/folders/${folder}/messages/${message.uid}/text`);
      const text = String(content?.data?.text || "");
      for (const match of text.matchAll(RECIPIENT_RE)) {
        const [, email, code, snippet] = match;
        if (!code.startsWith("5")) { softs++; continue; }
        const reason = `${code} ${snippet.replace(/\s+/g, " ").trim()}`.slice(0, 300);
        const { data: result, error } = await db.rpc("yontech_prospection_bounce", { target_email: email, target_error: reason });
        if (!error && result?.ok) { bounced++; details.push({ email, code }); }
      }
    }

    await db.from("yontech_prospection_runtime").update({ last_bounce_uid: maxUid, last_bounce_scan_at: new Date().toISOString() }).eq("id", 1);
    return json({ state: "scanned", examined: fresh.length, bounced, replied, temporary: softs, details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Yontech Rebonds] Erreur", message);
    return json({ state: "error", error: message }, 502);
  }
});
