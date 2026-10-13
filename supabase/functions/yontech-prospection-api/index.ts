import { createClient } from "npm:@supabase/supabase-js@2";
import { BRAND, normalizeTarget, targetKey, templateVars, unknownVariables } from "../_shared/yontech-core.ts";
import { deliver, smtpConfigured, smtpHost, smtpPort } from "../_shared/yontech-mail.ts";
import { knownFor, maybeSource } from "../_shared/yontech-jobs.ts";

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
  const SETTINGS_COLUMNS = "id,paused,pause_reason,sender_name,sender_email,reply_to,signature,footer_identity,video_url,daily_cap,warmup_enabled,warmup_start,warmup_step,window_start,window_end,send_days,min_gap_seconds,max_gap_seconds,max_consecutive_errors,require_first_name,followup_enabled,followup1_days,followup2_days,followup_opened_only,followup_since,autopilot,autopilot_target,autopilot_min_score,autopilot_batch,last_sourcing_at,last_sourcing_report,next_send_at,consecutive_errors,last_error,last_error_at,last_run_at,updated_at";

  try {
    if (action === "state") {
      // L'adresse de réveil des fonctions dépend du projet : elle est alignée
      // ici sur l'URL réelle du projet, sans intervention manuelle.
      const senderUrl = `${url}/functions/v1/yontech-prospection-sender`;
      const { data: runtime } = await db.from("yontech_prospection_runtime").select("sender_url").eq("id", 1).single();
      if (runtime && runtime.sender_url !== senderUrl) await db.from("yontech_prospection_runtime").update({ sender_url: senderUrl }).eq("id", 1);

      const [settings, templates, queued, sent, failed, skipped, suppressions, sentToday, cap, recent, history, opened, video, clickedSite, followups, scanned, scanStats] = await Promise.all([
        db.from("yontech_prospection_settings").select(SETTINGS_COLUMNS).eq("id", 1).single(),
        db.from("yontech_prospection_templates").select("id,name,subject,body,active,kind,updated_at").order("created_at"),
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
      ]);
      for (const r of [settings, templates, queued, sent, failed, skipped, suppressions, sentToday, cap, recent, history, opened, video, clickedSite, followups, scanned, scanStats]) if (r.error) throw r.error;
      const s = settings.data, activeTemplates = (templates.data || []).filter((t) => t.active && (t.kind || "initial") === "initial").length;
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
      const recentAll = [
        ...((recent.data || []) as Array<Record<string, unknown>>).map((r) => ({ ...r, kind: "initial" as const })),
        ...((recentFollowups || []) as Array<{ stage: number; sent_at: string; yontech_prospection_messages: Record<string, unknown> | null }>).filter((f) => f.yontech_prospection_messages)
          .map((f) => ({ ...(f.yontech_prospection_messages as Record<string, unknown>), sent_at: f.sent_at, kind: "followup" as const, stage: f.stage })),
      ].sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at))).slice(0, 8);
      return response(req, {
        settings: s, templates: templates.data || [], counts, sentToday: today, capToday, status, missing,
        smtp: { configured: smtpConfigured(), host: smtpHost(), port: smtpPort() },
        search: { configured: !!Deno.env.get("YONTECH_SEARCH_API_KEY") },
        recent: recentAll, perDay, adminEmail: user.email,
        tracking: { opened: opened.count || 0, video: video.count || 0, site: clickedSite.count || 0, scanner: scanned.count || 0 },
        followups: followups.data || { due: 0, sent: 0, sent_today: 0, replied: 0 },
        scanned: scanStats.data || { total: 0, sites: 0, emails: 0, today: 0, emails_today: 0 },
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
      // Nouveau ciblage : les entreprises trouvées pour l'ancien et pas encore
      // contactées sont retirées, la file se recharge avec le nouveau.
      let replaced = 0;
      if (patch.autopilot_target || "autopilot_min_score" in patch) {
        const before = check(await db.from("yontech_prospection_settings").select("autopilot_target,autopilot_min_score").eq("id", 1).single()) as { autopilot_target: unknown; autopilot_min_score: number };
        const changed = (patch.autopilot_target && targetKey(normalizeTarget(before.autopilot_target)) !== targetKey(patch.autopilot_target as ReturnType<typeof normalizeTarget>))
          || ("autopilot_min_score" in patch && patch.autopilot_min_score !== before.autopilot_min_score);
        if (changed) {
          const removed = check(await db.from("yontech_prospection_messages").delete().eq("status", "queued").eq("origin", "autopilote").select("id"));
          replaced = (removed || []).length;
          patch.last_sourcing_at = null;
        }
      }
      const settings = check(await db.from("yontech_prospection_settings").update(patch).eq("id", 1).select(SETTINGS_COLUMNS).single());
      return response(req, { settings, replaced });
    }

    if (action === "templates.save") {
      const kind = ["initial", "relance1", "relance2"].includes(String(payload.kind)) ? String(payload.kind) : "initial";
      const subject = kind === "initial" ? text(payload.subject, 200) : (text(payload.subject, 200) || "Re : (objet du premier message)");
      const row = { name: text(payload.name, 120), subject, body: text(payload.body, 8000), active: payload.active !== false, kind, updated_at: new Date().toISOString() };
      if (!row.name || !row.subject || !row.body) throw fail("Nom, objet et message sont obligatoires.");
      const unknown = unknownVariables(row.subject + "\n" + row.body);
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
      const track = text(payload.track, 20), how = text(payload.how, 20);
      let query = db.from("yontech_prospection_messages").select(`id,siren,email,company,score,origin,status,subject,error,created_at,sent_at,data,opened_at,open_count,video_clicked_at,site_clicked_at,replied_at,scanner_at,scanner_hits,yontech_prospection_followups${status === "sent" && track === "followed" ? "!inner" : ""}(stage,status,sent_at)`, { count: "exact" });
      if (status === "queued") query = query.in("status", ["queued", "sending"]);
      else if (["sent", "failed", "skipped"].includes(status)) query = query.eq("status", status);
      if (q) query = query.or(`company.ilike.%${q}%,email.ilike.%${q}%`);
      // Filtre « Découverte » : site deviné depuis le nom ou trouvé par le moteur de recherche.
      if (how === "guess" || how === "search") query = query.like("data->>how", `${how}:%`);
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
