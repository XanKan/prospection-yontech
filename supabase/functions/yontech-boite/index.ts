import { createClient } from "npm:@supabase/supabase-js@2";

// Accès à la boîte contact@yontech.fr par l'API mail Hostinger (clé
// YONTECH_HOSTINGER_MAIL_TOKEN, déjà utilisée pour les rebonds) : dossiers,
// liste, recherche, lecture, tri vers la corbeille ou la boîte de réception,
// et envoi d'une réponse dans le fil d'un message. Protégée par le secret de
// yontech_prospection_runtime ; aucune suppression définitive.
const MAIL_API = "https://api.mail.hostinger.com";
const DEFAULT_MAILBOX = "AC04b7ae4272e39c67c5970dbe5487"; // contact@yontech.fr

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
async function mailApi(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("YONTECH_HOSTINGER_MAIL_TOKEN") || "";
  const response = await fetch(`${MAIL_API}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`hostinger_mail_${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
type Message = { uid: number; date?: string; subject?: string; flags?: string[]; from?: { address?: string; name?: string }; to?: Array<{ address?: string }> };
const compact = (m: Message) => ({ uid: m.uid, date: m.date, from: m.from?.address, name: m.from?.name, to: (m.to || []).map((t) => t.address).join(", "), subject: m.subject, seen: (m.flags || []).includes("\\Seen") });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  if (!Deno.env.get("YONTECH_HOSTINGER_MAIL_TOKEN")) return json({ error: "Clé YONTECH_HOSTINGER_MAIL_TOKEN absente" }, 400);
  const box = `/api/v1/mailboxes/${Deno.env.get("YONTECH_HOSTINGER_MAILBOX_ID") || DEFAULT_MAILBOX}`;
  const body = await req.json().catch(() => ({}));
  const folder = encodeURIComponent(String(body.folder || "INBOX"));
  try {
    const folders = async () => ((await mailApi(`${box}/folders?perPage=100`))?.data || []) as Array<{ path: string; specialUse?: string; messageCount?: number; unreadCount?: number }>;
    switch (body.action) {
      case "folders":
        return json((await folders()).map((f) => ({ path: f.path, use: f.specialUse, count: f.messageCount, unread: f.unreadCount })));
      case "list": {
        const r = await mailApi(`${box}/folders/${folder}/messages?perPage=${Math.min(100, Number(body.perPage) || 50)}&page=${Math.max(1, Number(body.page) || 1)}&sort=-uid`);
        return json({ total: r?.pagination?.total, messages: (r?.data || []).map(compact) });
      }
      case "search": {
        const r = await mailApi(`${box}/folders/${folder}/messages/search?perPage=${Math.min(100, Number(body.perPage) || 50)}&sort=-uid`, { method: "POST", body: JSON.stringify(body.filters || {}) });
        return json({ total: r?.pagination?.total, messages: (r?.data || []).map(compact) });
      }
      case "text": {
        const r = await mailApi(`${box}/folders/${folder}/messages/${Number(body.uid)}/text`);
        return json({ text: String(r?.data?.text || "").slice(0, 8000) });
      }
      case "move": {
        // Seulement vers la corbeille (récupérable 30 jours) ou la boîte de réception.
        const all = await folders();
        const target = body.target === "inbox" ? "INBOX" : all.find((f) => f.specialUse === "\\Trash")?.path;
        const uids = (Array.isArray(body.uids) ? body.uids : []).map(Number).filter((n: number) => n > 0).slice(0, 100);
        if (!target || !uids.length) return json({ error: "Dossier cible ou messages manquants" }, 400);
        await mailApi(`${box}/folders/${folder}/messages/move`, { method: "POST", body: JSON.stringify({ uids, targetFolder: target }) });
        return json({ moved: uids.length, target });
      }
      case "send": {
        const to = (Array.isArray(body.to) ? body.to : []).map(String).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 5);
        if (!to.length || !body.subject || !body.text) return json({ error: "Destinataire, objet et texte requis" }, 400);
        const payload: Record<string, unknown> = { to, subject: String(body.subject).slice(0, 200), text: String(body.text).slice(0, 10000), displayName: String(body.displayName || "Équipe Yontech") };
        if (body.html) payload.html = String(body.html).slice(0, 50000);
        if (body.inReplyTo?.uid) payload.inReplyTo = { uid: Number(body.inReplyTo.uid), folder: String(body.inReplyTo.folder || "INBOX") };
        const r = await mailApi(`${box}/send`, { method: "POST", body: JSON.stringify(payload) });
        return json({ sent: true, result: r?.data || r });
      }
      default:
        return json({ error: "action inconnue" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
