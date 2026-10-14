import { createClient } from "npm:@supabase/supabase-js@2";
import { BRAND, composeEmail, normalizeTarget, targetKey, templateVars, unknownVariables } from "../_shared/yontech-core.ts";
import { deliver, smtpConfigured, smtpHost, smtpPort } from "../_shared/yontech-mail.ts";
import { knownFor, maybeSource } from "../_shared/yontech-jobs.ts";
import { buildSite, maquetteMailBlock, renderSite, slugify, type SiteData } from "../_shared/yontech-maquette.ts";
import { MAQUETTE_BODY, MAQUETTE_SUBJECT, maquetteDomainReady, maquetteUrl, prepareMaquettes, uniqueSlug } from "../_shared/yontech-maquette-jobs.ts";

// Point d'entrée unique de l'outil prospection.yontech.fr. Réservé aux
// comptes Supabase Auth dont l'adresse figure dans le secret
// YONTECH_ADMIN_EMAILS (adresses séparées par des virgules) ; toutes les
// écritures passent ensuite par la clé de service, les tables n'ayant aucune
// politique RLS. Projet indépendant de l'outil Piloz.

const allowedOrigins = new Set(["https://prospection.yontech.fr", "http://localhost:4173", "http://localhost:5173", "http://127.0.0.1:4173"]);
function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://prospection.yontech.fr",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Cache-Control": "no-store",
  };
}
function response(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" } });
}
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
function text(value: unknown, max = 200) { return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max); }
function integer(value: unknown, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail("Valeur numérique invalide.");
  return Math.max(min, Math.min(max, Math.round(n)));
}
function email(value: unknown, optional = false) {
  const result = text(value, 254).toLowerCase();
  if (!result && optional) return null;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(result)) throw fail(`Adresse e-mail invalide : ${result || "vide"}`);
  return result;
}
function time(value: unknown) {
  const result = text(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw fail("Heure invalide (format HH:MM).");
  return result;
}
function uuid(value: unknown) {
  const result = text(value, 40);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw fail("Identifiant invalide.");
  return result;
}
function uuids(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw fail("Sélection invalide.");
  return value.map(uuid);
}
function searchTerm(value: unknown) { return text(value, 80).replace(/[,()%*\\"']/g, " ").trim(); }

// État de l'automate tel qu'il serait décidé au prochain réveil.
function parisNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday as string] || 1;
  return { day, hm: `${parts.hour}:${parts.minute}` };
}

const SAMPLE = { entreprise: "DUPONT MECANIQUE", prenom: "Jean", nom: "Dupont", ville: "La Roche-sur-Yon", cp: "85000", metier: "fabrication de produits métalliques", departement: "85", effectif: "20 à 49", site: "dupont-mecanique.fr" };


/* ---------------- Maquettes de refonte ---------------- */
// Modèle du mail « maquette » : un des modèles actifs de ce type, au hasard.
// deno-lint-ignore no-explicit-any
async function maquetteTemplate(db: any) {
  const { data } = await db.from("yontech_prospection_templates").select("id,subject,body").eq("kind", "maquette").eq("active", true);
  const list = (data || []) as { id: string; subject: string; body: string }[];
  return list.length ? list[Math.floor(Math.random() * list.length)] : { id: null, subject: MAQUETTE_SUBJECT, body: MAQUETTE_BODY };
}
// deno-lint-ignore no-explicit-any
type Rec = Record<string, any>;
const MAQUETTE_COLUMNS = "id,slug,message_id,source_url,host,company,status,views,last_view_at,emailed_at,email_to,created_at,updated_at,data,review,prepared_at,sent_at,mail_subject,mail_body,template_id";

function adminAllowed(address: string) {
  const list = (Deno.env.get("YONTECH_ADMIN_EMAILS") || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(address || "").toLowerCase());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return response(req, { error: "Méthode non autorisée" }, 405);
  const origin = req.headers.get("origin") || "";
  if (origin && !allowedOrigins.has(origin)) return response(req, { error: "Origine non autorisée" }, 403);
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return response(req, { error: "Authentification requise" }, 401);
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !serviceKey) return response(req, { error: "Configuration serveur indisponible" }, 503);
  const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await client.auth.getUser();
  if (userError || !user) return response(req, { error: "Session expirée, reconnectez-vous.", code: "session" }, 401);
  if (!Deno.env.get("YONTECH_ADMIN_EMAILS")) {
    return response(req, { error: "Outil non configuré : renseignez le secret YONTECH_ADMIN_EMAILS côté serveur.", code: "forbidden" }, 403);
  }
  if (!adminAllowed(user.email || "")) return response(req, { error: "Outil réservé à l'équipe Yontech.", code: "forbidden" }, 403);

  let body: { action?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return response(req, { error: "Requête invalide" }, 400); }
  const action = text(body.action, 60), payload = body.payload || {};
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const check = <T>(result: { data: T; error: unknown }) => {
    if (result.error) {
      const message = String((result.error as { message?: string })?.message || "");
      if (message.includes("settings_window_order")) throw fail("La fin du créneau doit être après son début.");
      if (message.includes("settings_gap_order")) throw fail("L'intervalle maximum doit être supérieur ou égal au minimum.");
      if (message.includes("check constraint")) throw fail("Une valeur est hors des limites autorisées.");
      throw result.error;
    }
    return result.data;
  };
  const SETTINGS_COLUMNS = "id,paused,pause_reason,sender_name,sender_email,reply_to,signature,footer_identity,video_url,daily_cap,warmup_enabled,warmup_start,warmup_step,window_start,window_end,send_days,min_gap_seconds,max_gap_seconds,max_consecutive_errors,require_first_name,followup_enabled,followup1_days,followup2_days,followup_opened_only,followup_since,autopilot,autopilot_target,autopilot_min_score,autopilot_batch,site_share,last_sourcing_at,last_sourcing_report,next_send_at,consecutive_errors,last_error,last_error_at,last_run_at,updated_at";

  try {
    if (action === "state") {
      // L'adresse de réveil des fonctions dépend du projet : elle est alignée
      // ici sur l'URL réelle du projet, sans intervention manuelle.
      const senderUrl = `${url}/functions/v1/yontech-prospection-sender`;
      const { data: runtime } = await db.from("yontech_prospection_runtime").select("sender_url").eq("id", 1).single();
      if (runtime && runtime.sender_url !== senderUrl) await db.from("yontech_prospection_runtime").update({ sender_url: senderUrl }).eq("id", 1);

      const [settings, templates, queued, sent, failed, skipped, suppressions, sentToday, cap, recent, history, opened, video, clickedSite, followups, scanned, scanStats, campaigns] = await Promise.all([
        db.from("yontech_prospection_settings").select(SETTINGS_COLUMNS).eq("id", 1).single(),
        db.from("yontech_prospection_templates").select("id,name,subject,body,active,kind,audience,campagne,updated_at").order("created_at"),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).in("status", ["queued", "sending"]),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).eq("status", "sent"),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).eq("status", "failed"),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).eq("status", "skipped"),
        db.from("yontech_prospection_suppressions").select("email", { count: "exact", head: true }),
        db.rpc("yontech_prospection_sent_today", {}),
        db.rpc("yontech_prospection_daily_cap", {}),
        db.from("yontech_prospection_messages").select("id,company,email,sent_at,origin,opened_at,video_clicked_at,site_clicked_at,scanner_at").eq("status", "sent").order("sent_at", { ascending: false }).limit(8),
        db.rpc("yontech_prospection_per_day", {}),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).not("opened_at", "is", null),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).not("video_clicked_at", "is", null),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).not("site_clicked_at", "is", null),
        db.rpc("yontech_prospection_followup_stats", {}),
        db.from("yontech_prospection_messages").select("id", { count: "exact", head: true }).not("scanner_at", "is", null),
        db.rpc("yontech_prospection_scanned_stats", {}),
        db.rpc("yontech_prospection_campaign_stats", {}),
      ]);
      for (const r of [settings, templates, queued, sent, failed, skipped, suppressions, sentToday, cap, recent, history, opened, video, clickedSite, followups, scanned, scanStats, campaigns]) if (r.error) throw r.error;
      // deno-lint-ignore no-explicit-any
      const s = settings.data as Record<string, any>, activeTemplates = (templates.data || []).filter((t) => t.active && (t.kind || "initial") === "initial").length;
      const now = parisNow();
      const counts = { queued: queued.count || 0, sent: sent.count || 0, failed: failed.count || 0, skipped: skipped.count || 0, suppressions: suppressions.count || 0 };
      const capToday = Number(cap.data || 0), today = Number(sentToday.data || 0);
      const missing = [!s.sender_email && "sender", !smtpConfigured() && "smtp", !activeTemplates && "template"].filter(Boolean);
      const status = missing.length ? "setup"
        : s.paused ? "paused"
        : !(s.send_days || []).includes(now.day) ? "off_day"
        : now.hm < String(s.window_start).slice(0, 5) || now.hm >= String(s.window_end).slice(0, 5) ? "off_hours"
        : today >= capToday ? "cap_reached"
        : !counts.queued ? "empty" : "running";
      const perDay: Record<string, { p: number; r: number }> = {};
      for (const row of (history.data || []) as Array<{ day: string; premiers: number; relances: number }>) perDay[String(row.day).slice(0, 10)] = { p: Number(row.premiers || 0), r: Number(row.relances || 0) };
      const { data: recentFollowups } = await db.from("yontech_prospection_followups").select("stage,sent_at,yontech_prospection_messages(id,company,email,origin,opened_at,video_clicked_at,site_clicked_at,scanner_at)").eq("status", "sent").order("sent_at", { ascending: false }).limit(8);
      type Recent = Record<string, unknown> & { sent_at?: string };
      const recentAll: Recent[] = [
        ...((recent.data || []) as unknown as Array<Record<string, unknown>>).map((r) => ({ ...r, kind: "initial" }) as Recent),
        ...((recentFollowups || []) as unknown as Array<{ stage: number; sent_at: string; yontech_prospection_messages: Record<string, unknown> | null }>).filter((f) => f.yontech_prospection_messages)
          .map((f) => ({ ...(f.yontech_prospection_messages as Record<string, unknown>), sent_at: f.sent_at, kind: "followup", stage: f.stage }) as Recent),
      ].sort((a: Recent, b: Recent) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 8);
      return response(req, {
        settings: s, templates: templates.data || [], counts, sentToday: today, capToday, status, missing,
        smtp: { configured: smtpConfigured(), host: smtpHost(), port: smtpPort() },
        search: { configured: !!Deno.env.get("YONTECH_SEARCH_API_KEY") },
        recent: recentAll, perDay, adminEmail: user.email,
        tracking: { opened: opened.count || 0, video: video.count || 0, site: clickedSite.count || 0, scanner: scanned.count || 0 },
        followups: followups.data || { due: 0, sent: 0, sent_today: 0, replied: 0 },
        scanned: scanStats.data || { total: 0, sites: 0, emails: 0, today: 0, emails_today: 0 },
        // Compteurs par campagne (logiciel, site) : en file, envoyés, aujourd'hui, ouverts, clics, réponses.
        campaigns: campaigns.data || {},
      });
    }

    if (action === "settings.save") {
      const v = payload, patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("sender_name" in v) patch.sender_name = text(v.sender_name, 80) || BRAND.senderName;
      if ("sender_email" in v) patch.sender_email = email(v.sender_email, true);
      if ("reply_to" in v) patch.reply_to = email(v.reply_to, true);
      if ("signature" in v) patch.signature = text(v.signature, 1000);
      if ("footer_identity" in v) patch.footer_identity = text(v.footer_identity, 300);
      if ("daily_cap" in v) patch.daily_cap = integer(v.daily_cap, 1, 3000);
      if ("warmup_enabled" in v) patch.warmup_enabled = v.warmup_enabled === true;
      if ("warmup_start" in v) patch.warmup_start = integer(v.warmup_start, 1, 3000);
      if ("warmup_step" in v) patch.warmup_step = integer(v.warmup_step, 0, 1000);
      if ("window_start" in v) patch.window_start = time(v.window_start);
      if ("window_end" in v) patch.window_end = time(v.window_end);
      if ("send_days" in v) {
        const days = Array.isArray(v.send_days) ? [...new Set(v.send_days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort() : [];
        if (!days.length) throw fail("Choisissez au moins un jour d'envoi.");
        patch.send_days = days;
      }
      if ("min_gap_seconds" in v) patch.min_gap_seconds = integer(v.min_gap_seconds, 5, 7200);
      if ("max_gap_seconds" in v) patch.max_gap_seconds = integer(v.max_gap_seconds, 5, 7200);
      if ("max_consecutive_errors" in v) patch.max_consecutive_errors = integer(v.max_consecutive_errors, 1, 20);
      if ("video_url" in v) {
        const video = text(v.video_url, 300);
        if (video && !/^https:\/\/\S+$/i.test(video)) throw fail("Le lien de la vidéo doit commencer par https://");
        patch.video_url = video;
      }
      if ("require_first_name" in v) patch.require_first_name = v.require_first_name === true;
      if ("followup_enabled" in v) {
        patch.followup_enabled = v.followup_enabled === true;
        if (patch.followup_enabled) {
          const { data: current } = await db.from("yontech_prospection_settings").select("followup_since").eq("id", 1).single();
          if (!current?.followup_since && !("followup_since" in v)) patch.followup_since = new Date().toISOString();
        }
      }
      if ("followup1_days" in v) patch.followup1_days = integer(v.followup1_days, 1, 90);
      if ("followup2_days" in v) patch.followup2_days = integer(v.followup2_days, 2, 180);
      if ("followup_opened_only" in v) patch.followup_opened_only = v.followup_opened_only !== false;
      if ("followup_since" in v) {
        const since = text(v.followup_since, 10);
        if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw fail("Date de début des relances invalide.");
        patch.followup_since = since ? `${since}T00:00:00+02:00` : null;
      }
      if ("autopilot" in v) patch.autopilot = v.autopilot === true;
      if ("autopilot_target" in v) patch.autopilot_target = normalizeTarget(v.autopilot_target);
      if ("autopilot_min_score" in v) patch.autopilot_min_score = integer(v.autopilot_min_score, 0, 100);
      if ("autopilot_batch" in v) patch.autopilot_batch = integer(v.autopilot_batch, 5, 500);
      // Part du quota quotidien réservée à la campagne « Sites internet » (0 à 100 %).
      if ("site_share" in v) patch.site_share = integer(v.site_share, 0, 100);
      // Nouveau ciblage : les entreprises trouvées pour l'ancien et pas encore
      // contactées sont retirées, la file se recharge avec le nouveau.
      let replaced = 0;
      if (patch.autopilot_target || "autopilot_min_score" in patch) {
        const before = check(await db.from("yontech_prospection_settings").select("autopilot_target,autopilot_min_score").eq("id", 1).single()) as { autopilot_target: unknown; autopilot_min_score: number };
        const changed = (patch.autopilot_target && targetKey(normalizeTarget(before.autopilot_target)) !== targetKey(patch.autopilot_target as ReturnType<typeof normalizeTarget>))
          || ("autopilot_min_score" in patch && patch.autopilot_min_score !== before.autopilot_min_score);
        if (changed) {
          const removed = check(await db.from("yontech_prospection_messages").delete().eq("status", "queued").eq("origin", "autopilote").select("id,siren")) as Array<{ id: string; siren: string | null }>;
          replaced = (removed || []).length;
          // Ces entreprises doivent pouvoir être retrouvées par le nouveau ciblage :
          // elles sont retirées de la mémoire des entreprises déjà examinées.
          const sirens = (removed || []).map((r) => r.siren).filter((s): s is string => !!s);
          for (let i = 0; i < sirens.length; i += 500) check(await db.from("yontech_prospection_scanned").delete().in("siren", sirens.slice(i, i + 500)));
          patch.last_sourcing_at = null;
        }
      }
      const settings = check(await db.from("yontech_prospection_settings").update(patch).eq("id", 1).select(SETTINGS_COLUMNS).single());
      return response(req, { settings, replaced });
    }

    if (action === "templates.save") {
      const kind = ["initial", "relance1", "relance2", "maquette"].includes(String(payload.kind)) ? String(payload.kind) : "initial";
      const subject = kind === "initial" || kind === "maquette" ? text(payload.subject, 200) : (text(payload.subject, 200) || "Re : (objet du premier message)");
      // Public : toutes les entreprises, sans site internet (annuaire RGE) ou avec site.
      const audience = ["tous", "sanssite", "avecsite"].includes(String(payload.audience)) ? String(payload.audience) : "tous";
      // Campagne : « logiciel » (développement, applications) ou « site » (création et refonte de sites internet).
      const campagne = ["logiciel", "site"].includes(String(payload.campagne)) ? String(payload.campagne) : "logiciel";
      const row = { name: text(payload.name, 120), subject, body: text(payload.body, 8000), active: payload.active !== false, kind, audience, campagne, updated_at: new Date().toISOString() };
      if (!row.name || !row.subject || !row.body) throw fail("Nom, objet et message sont obligatoires.");
      // Mail de prospection par maquette : {maquette} (aperçu visuel) et {lien} (adresse) en plus.
      const unknown = unknownVariables(row.subject + "\n" + row.body).filter((v) => !(kind === "maquette" && ["maquette", "lien"].includes(v.toLowerCase())));
      if (kind === "maquette" && !/\{maquette\}|\{lien\}/i.test(row.body)) throw fail("Ce mail doit contenir {maquette} (aperçu de la maquette) ou {lien} (son adresse).");
      if (unknown.length) throw fail(`Variable inconnue : {${unknown.join("}, {")}}.`);
      const template = payload.id
        ? check(await db.from("yontech_prospection_templates").update(row).eq("id", uuid(payload.id)).select("*").single())
        : check(await db.from("yontech_prospection_templates").insert(row).select("*").single());
      return response(req, { template });
    }
    if (action === "templates.delete") {
      check(await db.from("yontech_prospection_templates").delete().eq("id", uuid(payload.id)));
      return response(req, { ok: true });
    }

    if (action === "queue.add") {
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 2000) : [];
      if (!items.length) throw fail("Aucun prospect à ajouter.");
      const result = check(await db.rpc("yontech_prospection_enqueue", { items, target_origin: "manuel" }));
      return response(req, { result });
    }
    if (action === "queue.known") {
      const list = (value: unknown, max: number) => Array.isArray(value) ? value.slice(0, max).map((x) => text(x, 254).toLowerCase()).filter(Boolean) : [];
      const known = await knownFor(db, list(payload.sirens, 3000), list(payload.emails, 3000));
      return response(req, { sirens: [...known.sirens], emails: [...known.emails] });
    }
    if (action === "queue.list") {
      const status = text(payload.status, 20), page = integer(payload.page ?? 1, 1, 100000), size = 50, q = searchTerm(payload.search);
      const track = text(payload.track, 20), how = text(payload.how, 20), campagne = text(payload.campagne, 20);
      let query = db.from("yontech_prospection_messages").select(`id,siren,email,company,score,origin,status,subject,error,created_at,sent_at,data,opened_at,open_count,video_clicked_at,site_clicked_at,replied_at,scanner_at,scanner_hits,yontech_prospection_followups${status === "sent" && track === "followed" ? "!inner" : ""}(stage,status,sent_at)`, { count: "exact" });
      if (status === "queued") query = query.in("status", ["queued", "sending"]);
      else if (["sent", "failed", "skipped"].includes(status)) query = query.eq("status", status);
      if (q) query = query.or(`company.ilike.%${q}%,email.ilike.%${q}%`);
      // Filtre « Découverte » : site deviné depuis le nom, trouvé par le moteur
      // de recherche, ou entreprise sans site internet (annuaire RGE).
      if (how === "guess" || how === "search") query = query.like("data->>how", `${how}:%`);
      else if (how === "sanssite") query = query.eq("data->>sanssite", "1");
      // Filtre « Campagne » : logiciel (campagne absente = logiciel) ou sites internet.
      if (campagne === "site") query = query.eq("data->>campagne", "site");
      else if (campagne === "logiciel") query = query.or("data->>campagne.is.null,data->>campagne.neq.site");
      if (status === "sent" && track) {
        if (track === "opened") query = query.not("opened_at", "is", null);
        else if (track === "unopened") query = query.is("opened_at", null);
        else if (track === "clicked") query = query.or("video_clicked_at.not.is.null,site_clicked_at.not.is.null");
        else if (track === "unclicked") query = query.is("video_clicked_at", null).is("site_clicked_at", null);
        else if (track === "replied") query = query.not("replied_at", "is", null);
        else if (track === "scanner") query = query.not("scanner_at", "is", null).is("site_clicked_at", null).is("video_clicked_at", null);
      }
      query = status === "queued" ? query.order("score", { ascending: false, nullsFirst: false }).order("created_at") : query.order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
      const { data, count, error } = await query.range((page - 1) * size, page * size - 1);
      if (error) throw error;
      const suppressed = new Map<string, string>();
      if (status === "sent" && data?.length) {
        const { data: sup } = await db.from("yontech_prospection_suppressions").select("email,reason").in("email", data.map((m) => m.email));
        for (const row of sup || []) suppressed.set(row.email, row.reason);
      }
      const items = (data || []).map((m) => ({ ...m, prospection_followups: (m as Record<string, unknown>).yontech_prospection_followups, suppressed: suppressed.get(m.email) || null }));
      return response(req, { items, total: count || 0, page, size });
    }
    if (action === "followups.list") {
      const page = integer(payload.page ?? 1, 1, 100000), size = 50, q = searchTerm(payload.search), stage = text(payload.stage, 10);
      let query = db.from("yontech_prospection_followups").select("id,stage,status,subject,sent_at,error,message_id,yontech_prospection_messages!inner(id,company,email,data,origin,opened_at,open_count,video_clicked_at,site_clicked_at,replied_at,scanner_at)", { count: "exact" })
        .in("status", ["sent", "failed"]).order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
      if (q) query = query.or(`company.ilike.%${q}%,email.ilike.%${q}%`, { referencedTable: "yontech_prospection_messages" });
      if (stage === "1" || stage === "2") query = query.eq("stage", Number(stage));
      else if (stage === "replied") query = query.not("yontech_prospection_messages.replied_at", "is", null);
      const { data, count, error } = await query.range((page - 1) * size, page * size - 1);
      if (error) throw error;
      const items = (data || []).map((f) => ({ ...f, message: (f as { yontech_prospection_messages?: unknown }).yontech_prospection_messages }));
      return response(req, { items, total: count || 0, page, size });
    }
    if (action === "queue.get") {
      const message = check(await db.from("yontech_prospection_messages").select("*,yontech_prospection_followups(id,stage,status,subject,body,sent_at,error)").eq("id", uuid(payload.id)).single()) as Record<string, unknown>;
      return response(req, { message: { ...message, prospection_followups: message.yontech_prospection_followups } });
    }
    if (action === "queue.replied") {
      const result = check(await db.rpc("yontech_prospection_mark_replied", { target_id: uuid(payload.id), replied: payload.replied !== false }));
      return response(req, { result });
    }
    if (action === "queue.remove") {
      const ids = uuids(payload.ids);
      const removed = check(await db.from("yontech_prospection_messages").delete().in("id", ids).in("status", ["queued", "failed", "skipped"]).select("id"));
      return response(req, { removed: (removed || []).length });
    }
    if (action === "queue.retry") {
      const ids = uuids(payload.ids);
      const retried = check(await db.from("yontech_prospection_messages").update({ status: "queued", error: null, attempts: 0, claimed_at: null }).in("id", ids).eq("status", "failed").select("id"));
      return response(req, { retried: (retried || []).length });
    }

    if (action === "suppressions.list") {
      const page = integer(payload.page ?? 1, 1, 100000), size = 50, q = searchTerm(payload.search);
      let query = db.from("yontech_prospection_suppressions").select("*", { count: "exact" }).order("created_at", { ascending: false });
      if (q) query = query.ilike("email", `%${q}%`);
      const { data, count, error } = await query.range((page - 1) * size, page * size - 1);
      if (error) throw error;
      return response(req, { items: data || [], total: count || 0, page, size });
    }
    if (action === "suppressions.add") {
      const reason = payload.reason === "deja_contacte" ? "deja_contacte" : "manuel";
      const raw: { email?: unknown; siren?: unknown }[] = Array.isArray(payload.items)
        ? payload.items.slice(0, 20000) as { email?: unknown; siren?: unknown }[]
        : String(payload.emails || "").split(/[\s,;]+/).map((e) => ({ email: e }));
      const rows = new Map<string, { email: string; siren: string | null; reason: string }>();
      let invalid = 0;
      for (const item of raw) {
        const address = text(item.email, 254).toLowerCase();
        if (!address) continue;
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(address)) { invalid++; continue; }
        const siren = text(item.siren, 20).replace(/\D/g, "");
        rows.set(address, { email: address, siren: /^\d{9}$/.test(siren) ? siren : null, reason });
      }
      const list = [...rows.values()];
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        check(await db.from("yontech_prospection_suppressions").upsert(chunk, { onConflict: "email", ignoreDuplicates: true }));
        check(await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Ajouté à la liste d'exclusion" }).in("email", chunk.map((r) => r.email)).eq("status", "queued"));
      }
      if (!list.length && !invalid) throw fail("Aucune adresse.");
      return response(req, { added: list.length, invalid });
    }
    if (action === "suppressions.remove") {
      check(await db.from("yontech_prospection_suppressions").delete().eq("email", email(payload.email)));
      return response(req, { ok: true });
    }

    if (action === "run.pause") {
      const settings = check(await db.from("yontech_prospection_settings").update({ paused: true, pause_reason: "Mis en pause manuellement.", updated_at: new Date().toISOString() }).eq("id", 1).select(SETTINGS_COLUMNS).single());
      return response(req, { settings });
    }
    if (action === "run.resume") {
      const current = check(await db.from("yontech_prospection_settings").select("sender_email").eq("id", 1).single());
      const { count } = await db.from("yontech_prospection_templates").select("id", { count: "exact", head: true }).eq("active", true).eq("kind", "initial");
      if (!current?.sender_email) throw fail("Renseignez d'abord l'adresse d'envoi dans les réglages.");
      if (!smtpConfigured()) throw fail("Le mot de passe de la boîte d'envoi n'est pas encore enregistré côté serveur (YONTECH_SMTP_PASSWORD).");
      if (!count) throw fail("Activez au moins un modèle de premier contact.");
      const settings = check(await db.from("yontech_prospection_settings").update({ paused: false, autopilot: true, pause_reason: null, consecutive_errors: 0, last_sourcing_at: null, updated_at: new Date().toISOString() }).eq("id", 1).select(SETTINGS_COLUMNS).single());
      return response(req, { settings });
    }

    if (action === "test.send") {
      const settings = check(await db.from("yontech_prospection_settings").select("*").eq("id", 1).single());
      if (!settings.sender_email) throw fail("Renseignez d'abord l'adresse d'envoi.");
      const template = payload.template && typeof payload.template === "object"
        ? { id: "test", subject: text((payload.template as Record<string, unknown>).subject, 200), body: text((payload.template as Record<string, unknown>).body, 8000) }
        : check(await db.from("yontech_prospection_templates").select("id,subject,body").eq("active", true).eq("kind", "initial").limit(1).maybeSingle());
      if (!template?.subject || !template?.body) throw fail("Aucun modèle à tester.");
      const sample = payload.sample && typeof payload.sample === "object" ? payload.sample as Record<string, string> : SAMPLE;
      const to = email(payload.to || user.email) as string;
      // « Comme un vrai envoi » : sans la mention [Test], avec pixel, liens suivis et
      // lien piège, pour qu'un test de délivrabilité juge le message réellement envoyé.
      const realistic = payload.realistic === true;
      const result = await deliver({
        settings, template, to, vars: templateVars(sample), token: crypto.randomUUID(),
        subjectPrefix: realistic ? "" : "[Test] ", trackingToken: realistic ? crypto.randomUUID() : undefined,
      });
      if (!result.ok) return response(req, { ok: false, outcome: result.outcome, error: result.error }, 502);
      return response(req, { ok: true, to });
    }

    /* ------------- Prospection par maquette (validation manuelle) ------------- */
    if (action === "mqp.state") {
      const ready = await maquetteDomainReady();
      const [settings, pending, sent] = await Promise.all([
        db.from("yontech_prospection_settings").select("maquette_enabled,maquette_daily,maquette_subject,maquette_body").eq("id", 1).single(),
        db.from("yontech_maquettes").select(MAQUETTE_COLUMNS + ",yontech_prospection_messages(id,email,company,score,data)").eq("review", "a_valider").order("prepared_at").limit(100),
        db.from("yontech_maquettes").select("id,slug,company,views,last_view_at,sent_at,review,data,yontech_prospection_messages(id,email,opened_at,open_count,site_clicked_at,click_count,replied_at,scanner_at,status)").in("review", ["envoye"]).order("sent_at", { ascending: false }).limit(100),
      ]);
      for (const r of [settings, pending, sent]) if (r.error) throw r.error;
      const midnight = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
      midnight.setHours(0, 0, 0, 0);
      const s = settings.data as Rec;
      const slim = (r: Rec) => ({ ...r, url: maquetteUrl(r.slug, ready), data: { accent: r.data?.accent, logo: r.data?.logo, image: r.data?.images?.[0] || "", tagline: r.data?.tagline, theme: r.data?.theme, city: r.data?.city } });
      const sentRows = (sent.data || []) as Rec[];
      const preparedToday = ((pending.data || []) as Rec[]).concat(sentRows).filter((r) => r.prepared_at && new Date(r.prepared_at) >= new Date(Date.now() - (Date.now() - midnight.getTime()))).length;
      return response(req, {
        domainReady: ready,
        settings: { enabled: s.maquette_enabled, daily: s.maquette_daily, ...(await (async () => { const t = await maquetteTemplate(db); return { subject: t.subject, body: t.body, templates: ((await db.from("yontech_prospection_templates").select("id,name,active").eq("kind", "maquette")).data || []) }; })()) },
        pending: ((pending.data || []) as Rec[]).map(slim),
        sent: sentRows.map(slim),
        stats: {
          pending: (pending.data || []).length, sent: sentRows.length, preparedToday,
          opened: sentRows.filter((r) => r.yontech_prospection_messages?.opened_at).length,
          clicked: sentRows.filter((r) => r.yontech_prospection_messages?.site_clicked_at).length,
          viewed: sentRows.filter((r) => (r.views || 0) > 0).length,
          replied: sentRows.filter((r) => r.yontech_prospection_messages?.replied_at).length,
        },
      });
    }
    if (action === "mqp.settings") {
      const patch: Rec = { updated_at: new Date().toISOString() };
      if ("enabled" in payload) patch.maquette_enabled = payload.enabled === true;
      if ("daily" in payload) patch.maquette_daily = integer(payload.daily, 0, 100);
      if ("subject" in payload) patch.maquette_subject = text(payload.subject, 200) || null;
      if ("body" in payload) {
        const body = text(payload.body, 6000);
        if (body && !/\{maquette\}|\{lien\}/.test(body)) throw fail("Le message doit contenir {maquette} (aperçu visuel) ou {lien}.");
        patch.maquette_body = body || null;
      }
      check(await db.from("yontech_prospection_settings").update(patch).eq("id", 1));
      return response(req, { ok: true });
    }
    if (action === "mqp.prepare") {
      const result = await prepareMaquettes(db, { max: integer(payload.n ?? 3, 1, 5), budgetMs: 90_000, force: true });
      return response(req, result);
    }
    // Prépare l'e-mail d'une maquette en attente (objet et texte éventuellement corrigés).
    const mqpMail = async (id: string, subject?: unknown, body?: unknown) => {
      const maq = check(await db.from("yontech_maquettes").select(MAQUETTE_COLUMNS + ",yontech_prospection_messages(id,email,company,status,data,unsubscribe_token,tracking_token,siren)").eq("id", id).single()) as Rec;
      const link = maquetteUrl(maq.slug, await maquetteDomainReady());
      const msg = maq.yontech_prospection_messages as Rec | null;
      const template = { id: "maquette", subject: text(subject ?? maq.mail_subject ?? MAQUETTE_SUBJECT, 200), body: text(body ?? maq.mail_body ?? MAQUETTE_BODY, 6000).replaceAll("{lien}", link) };
      const vars = templateVars({ ...(msg?.data || {}), entreprise: msg?.company || maq.company } as Parameters<typeof templateVars>[0]);
      return { maq, msg, link, template, vars, block: maquetteMailBlock(maq.data as SiteData, link) };
    };
    if (action === "mqp.preview") {
      const m = await mqpMail(uuid(payload.id), payload.subject, payload.body);
      const mail = composeEmail({ subject: m.template.subject, body: m.template.body, signature: (check(await db.from("yontech_prospection_settings").select("signature").eq("id", 1).single()) as Rec).signature, unsubscribeUrl: "https://prospection.yontech.fr/desinscription.html", vars: m.vars, block: m.block, source: String(m.msg?.data?.source || "") });
      return response(req, { subject: mail.subject, html: mail.html, to: m.msg?.email || "" });
    }
    const mqpSend = async (id: string, subject?: unknown, body?: unknown) => {
      const settings = check(await db.from("yontech_prospection_settings").select("*").eq("id", 1).single()) as Rec;
      const m = await mqpMail(id, subject, body);
      if (m.maq.review !== "a_valider") throw fail("Ce mail a déjà été traité.");
      if (!m.msg?.email) throw fail("Prospect introuvable.");
      if (m.maq.status !== "en_ligne") throw fail("La maquette est retirée : remettez-la en ligne avant d'envoyer.");
      const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", m.msg.email).maybeSingle();
      if (banned) {
        await db.from("yontech_maquettes").update({ review: "rejete" }).eq("id", id);
        await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Adresse exclue" }).eq("id", m.msg.id);
        throw fail("Cette adresse est exclue (désinscription ou rebond) : mail annulé.");
      }
      // Mêmes jetons que l'automate : désinscription, suivi des ouvertures et des clics, réponses.
      const result = await deliver({
        settings: settings as Parameters<typeof deliver>[0]["settings"], template: m.template, to: m.msg.email, vars: m.vars, source: String(m.msg.data?.source || ""),
        token: m.msg.unsubscribe_token, trackingToken: m.msg.tracking_token || undefined, block: m.block,
      });
      if (!result.ok) {
        if (result.outcome === "recipient_rejected") {
          await db.rpc("yontech_prospection_finish", { target_id: m.msg.id, outcome: "recipient_rejected", target_subject: result.subject, target_body: result.body, target_error: result.error });
          await db.from("yontech_maquettes").update({ review: "rejete" }).eq("id", id);
        }
        throw fail(`Envoi refusé : ${result.error}`, 502);
      }
      check(await db.rpc("yontech_prospection_finish", { target_id: m.msg.id, outcome: "sent", target_template_id: m.maq.template_id || null, target_subject: result.subject, target_body: result.body, target_message_id: result.messageId }));
      await db.from("yontech_prospection_messages").update({ data: { ...(m.msg.data || {}), maquette: m.maq.slug } }).eq("id", m.msg.id);
      const now = new Date().toISOString();
      check(await db.from("yontech_maquettes").update({ review: "envoye", sent_at: now, emailed_at: now, email_to: m.msg.email, mail_subject: m.template.subject, mail_body: text(body ?? m.maq.mail_body, 6000) || m.maq.mail_body }).eq("id", id));
      return { ok: true, to: m.msg.email };
    };
    if (action === "mqp.validate") {
      return response(req, await mqpSend(uuid(payload.id), payload.subject, payload.body));
    }
    if (action === "mqp.validate_many") {
      const ids = uuids(payload.ids).slice(0, 25);
      const done: string[] = [], errors: string[] = [];
      for (const id of ids) {
        try { done.push((await mqpSend(id)).to); } catch (e) { errors.push((e as Error).message); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      return response(req, { ok: true, sent: done.length, errors });
    }
    if (action === "mqp.save") {
      // Objet et texte corrigés sans envoyer.
      check(await db.from("yontech_maquettes").update({ mail_subject: text(payload.subject, 200), mail_body: text(payload.body, 6000) }).eq("id", uuid(payload.id)).eq("review", "a_valider"));
      return response(req, { ok: true });
    }
    if (action === "mqp.reject") {
      // Supprimée : la maquette disparaît, le prospect repart dans la file de l'automate classique.
      const maq = check(await db.from("yontech_maquettes").select("id,message_id,review").eq("id", uuid(payload.id)).single()) as Rec;
      if (maq.review !== "a_valider") throw fail("Ce mail a déjà été traité.");
      if (maq.message_id) {
        const { data: msg } = await db.from("yontech_prospection_messages").select("data").eq("id", maq.message_id).maybeSingle();
        await db.from("yontech_prospection_messages").update({ status: "queued", data: { ...((msg?.data as Rec) || {}), maquette_essai: "supprimée" } }).eq("id", maq.message_id).eq("status", "maquette");
      }
      check(await db.from("yontech_maquettes").delete().eq("id", maq.id));
      return response(req, { ok: true });
    }

    /* ------------- Maquettes de refonte (mode test) ------------- */
    if (action === "maquette.list") {
      const [rows, candidates, ready] = await Promise.all([
        db.from("yontech_maquettes").select(MAQUETTE_COLUMNS).order("created_at", { ascending: false }).limit(100),
        db.from("yontech_prospection_messages").select("id,company,email,status,data,created_at").eq("data->>campagne", "site").order("created_at", { ascending: false }).limit(300),
        maquetteDomainReady(),
      ]);
      if (rows.error) throw rows.error;
      if (candidates.error) throw candidates.error;
      const done = new Set((rows.data || []).map((r) => r.message_id).filter(Boolean));
      const list = (candidates.data || []).filter((m) => m.data?.site && String(m.data?.sanssite) !== "true" && !done.has(m.id)).slice(0, 80)
        .map((m) => ({ id: m.id, company: m.company, email: m.email, status: m.status, site: m.data.site, ville: m.data.ville || "", metier: m.data.metier || "", constat: m.data.constat || "" }));
      return response(req, {
        domainReady: ready, adminEmail: user.email,
        maquettes: (rows.data || []).map((r) => ({ ...r, data: { accent: r.data?.accent, logo: r.data?.logo, images: (r.data?.images || []).slice(0, 1) }, url: maquetteUrl(r.slug, ready) })),
        candidates: list,
      });
    }
    if (action === "maquette.generate") {
      let url = text(payload.url, 300), messageId: string | null = null;
      let hints: { company?: string; metier?: string; ville?: string; email?: string } = {};
      if (payload.message_id) {
        const m = check(await db.from("yontech_prospection_messages").select("id,company,email,data").eq("id", uuid(payload.message_id)).single()) as Rec;
        messageId = m.id;
        url = url || String(m.data?.site || "");
        hints = { company: m.company, metier: m.data?.metier, ville: m.data?.ville, email: m.email };
      }
      if (!url) throw fail("Indiquez l'adresse du site à refaire.");
      const built = await buildSite(url, hints);
      if ("error" in built) throw fail(built.error, 422);
      const existing = messageId
        ? (await db.from("yontech_maquettes").select("id,slug").eq("message_id", messageId).limit(1).maybeSingle()).data
        : (await db.from("yontech_maquettes").select("id,slug").eq("host", built.data.host).is("message_id", null).limit(1).maybeSingle()).data;
      const slug = existing?.slug || await uniqueSlug(db, slugify(built.data.name));
      const row = { slug, message_id: messageId, source_url: built.data.source, host: built.data.host, company: built.data.name, data: built.data, html: built.html, status: "en_ligne", updated_at: new Date().toISOString() };
      const saved = (existing
        ? check(await db.from("yontech_maquettes").update(row).eq("id", existing.id).select(MAQUETTE_COLUMNS).single())
        : check(await db.from("yontech_maquettes").insert(row).select(MAQUETTE_COLUMNS).single())) as Rec;
      const ready = await maquetteDomainReady();
      return response(req, { maquette: { ...saved, url: maquetteUrl(saved.slug, ready) }, html: built.html });
    }
    if (action === "maquette.get") {
      const row = check(await db.from("yontech_maquettes").select(MAQUETTE_COLUMNS + ",html").eq("id", uuid(payload.id)).single()) as Rec;
      return response(req, { maquette: { ...row, url: maquetteUrl(row.slug, await maquetteDomainReady()) } });
    }
    if (action === "maquette.update") {
      // Corrections à la main (nom, accroche, couleur…) : la page est redessinée sans relire le site.
      const row = check(await db.from("yontech_maquettes").select("id,data").eq("id", uuid(payload.id)).single()) as Rec;
      const v = (payload.patch && typeof payload.patch === "object" ? payload.patch : {}) as Record<string, unknown>;
      const data = { ...(row.data as SiteData) };
      for (const k of ["name", "tagline", "eyebrow", "intro", "phone", "email", "address", "city"] as const) if (k in v) data[k] = text(v[k], k === "intro" ? 400 : 160);
      if ("accent" in v && /^#[0-9a-f]{6}$/i.test(String(v.accent))) data.accent = String(v.accent).toLowerCase();
      if ("theme" in v && ["atelier", "chantier", "moderne"].includes(String(v.theme))) data.theme = String(v.theme) as SiteData["theme"];
      if ("about" in v) data.about = text(v.about, 1600).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 3);
      if ("services" in v) data.services = text(v.services, 2000).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).map((l) => { const [t, ...rest] = l.split(/\s*:\s*/); return { title: text(t, 70), text: text(rest.join(" : "), 240) }; });
      const saved = check(await db.from("yontech_maquettes").update({ data, company: data.name, html: renderSite(data), updated_at: new Date().toISOString() }).eq("id", row.id).select(MAQUETTE_COLUMNS + ",html").single()) as Rec;
      return response(req, { maquette: { ...saved, url: maquetteUrl(saved.slug, await maquetteDomainReady()) } });
    }
    if (action === "maquette.status") {
      const status = payload.status === "retire" ? "retire" : "en_ligne";
      check(await db.from("yontech_maquettes").update({ status, updated_at: new Date().toISOString() }).eq("id", uuid(payload.id)));
      return response(req, { ok: true, status });
    }
    if (action === "maquette.delete") {
      check(await db.from("yontech_maquettes").delete().eq("id", uuid(payload.id)));
      return response(req, { ok: true });
    }
    if (action === "maquette.send") {
      // MODE TEST : l'e-mail ne part que vers les adresses de l'équipe, jamais vers le prospect.
      const settings = check(await db.from("yontech_prospection_settings").select("*").eq("id", 1).single());
      if (!settings.sender_email) throw fail("Renseignez d'abord l'adresse d'envoi.");
      // Sans maquette désignée (test depuis l'écran Messages) : la dernière maquette en ligne.
      const maq = (payload.id
        ? check(await db.from("yontech_maquettes").select("id,slug,company,host,message_id,status").eq("id", uuid(payload.id)).single())
        : check(await db.from("yontech_maquettes").select("id,slug,company,host,message_id,status").eq("status", "en_ligne").order("updated_at", { ascending: false }).limit(1).single())) as Rec;
      if (maq.status !== "en_ligne") throw fail("Remettez d'abord la maquette en ligne.");
      const to = String(email(payload.to || user.email)).toLowerCase();
      const admins = (Deno.env.get("YONTECH_ADMIN_EMAILS") || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
      const allowed = admins.includes(to) || to === String(settings.sender_email).toLowerCase() || /@yontech\.fr$/.test(to);
      if (!allowed) throw fail("Mode test : l'e-mail ne peut partir que vers vos propres adresses (comptes de l'outil ou adresses @yontech.fr), jamais vers le prospect.", 403);
      const link = maquetteUrl(maq.slug, await maquetteDomainReady());
      const full = check(await db.from("yontech_maquettes").select("data").eq("id", maq.id).single()) as Rec;
      let prospect: Record<string, unknown> = { entreprise: maq.company, site: maq.host };
      if (maq.message_id) {
        const { data: m } = await db.from("yontech_prospection_messages").select("company,data").eq("id", maq.message_id).maybeSingle();
        if (m) prospect = { ...(m.data || {}), entreprise: maq.company || m.company, site: maq.host };
      }
      const chosen = payload.template && typeof payload.template === "object"
        ? { subject: text((payload.template as Rec).subject, 200), body: text((payload.template as Rec).body, 8000) }
        : await maquetteTemplate(db);
      const template = { id: "maquette", subject: chosen.subject, body: String(chosen.body).replaceAll("{lien}", link) };
      const result = await deliver({ settings, template, to, vars: templateVars(prospect as Parameters<typeof templateVars>[0]), token: crypto.randomUUID(), subjectPrefix: "[Test] ", block: maquetteMailBlock(full.data as SiteData, link) });
      if (!result.ok) return response(req, { ok: false, outcome: result.outcome, error: result.error }, 502);
      check(await db.from("yontech_maquettes").update({ emailed_at: new Date().toISOString(), email_to: to }).eq("id", maq.id));
      return response(req, { ok: true, to, link, company: maq.company });
    }

    if (action === "autopilot.run") {
      // Lancé depuis le navigateur : passage court, le reste suit par la tâche planifiée.
      const result = await maybeSource(db, true, 45_000);
      return response(req, { result });
    }

    return response(req, { error: "Action inconnue" }, 400);
  } catch (error) {
    const e = error as { status?: number; message?: string };
    const status = Number(e.status) || 500;
    console.error("yontech-prospection-api", action, e.message || error);
    return response(req, { error: status < 500 ? e.message : "Erreur serveur, réessayez dans un instant." }, status);
  }
});
