import { createClient } from "npm:@supabase/supabase-js@2";
import { BRAND, htmlEscape } from "../_shared/yontech-core.ts";
import { mailTeam, type SenderSettings } from "../_shared/yontech-mail.ts";

// Récapitulatif du lundi matin (pg_cron yontech-prospection-recap) : chiffres
// des 7 derniers jours, réponses reçues, prospects à rappeler, meilleurs modèles.
// Protégée par le secret de yontech_prospection_runtime.

type Rec = Record<string, any>;
const e = (v: unknown) => htmlEscape(String(v ?? ""));
const n = (v: unknown) => Number(v || 0).toLocaleString("fr-FR");
const pct = (a: number, b: number) => (b ? `${(a * 100 / b).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %` : "—");
const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Paris" });

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await db.rpc("yontech_prospection_check_cron_secret", { candidate: req.headers.get("x-prospection-cron") || "" });
  if (allowed !== true) return json({ error: "Accès refusé" }, 403);
  try {
    const { data: settings } = await db.from("yontech_prospection_settings").select("*").eq("id", 1).single();
    const { data: r, error } = await db.rpc("yontech_weekly_recap");
    if (error) throw error;
    const d = r as Rec;
    const kpis: [string, string, string][] = [
      ["Premiers mails", n(d.premiers), ""],
      ["Relances", n(d.relances), ""],
      ["Réponses", n(d.nb_reponses), pct(d.nb_reponses, d.premiers + d.relances) + " des envois"],
      ["Clics", n(d.clics), ""],
      ["Maquettes envoyées", n(d.maquettes_refonte + d.maquettes_creation), `${n(d.maquettes_refonte)} refontes · ${n(d.maquettes_creation)} créations`],
      ["Maquettes ouvertes", n(d.maquettes_vues), `${n(d.relances_vue)} relance(s) après visite`],
      ["Adresses écartées", n(d.ecartes), "rebonds et domaines morts"],
      ["Désinscriptions", n(d.desinscriptions), ""],
    ];
    const cell = (k: [string, string, string]) => `<td style="width:50%;padding:12px 14px;border:1px solid #e3e4ec;vertical-align:top"><div style="font-size:12px;color:#6d7086">${e(k[0])}</div><div style="font:bold 24px Arial,sans-serif;color:#15161f">${e(k[1])}</div>${k[2] ? `<div style="font-size:12px;color:#6d7086">${e(k[2])}</div>` : ""}</td>`;
    const rows: string[] = [];
    for (let i = 0; i < kpis.length; i += 2) rows.push(`<tr>${cell(kpis[i])}${cell(kpis[i + 1])}</tr>`);
    const list = (items: Rec[], line: (x: Rec) => string, empty: string) => items.length ? `<ul style="margin:0;padding-left:18px">${items.map((x) => `<li style="margin:0 0 6px">${line(x)}</li>`).join("")}</ul>` : `<p style="margin:0;color:#6d7086">${e(empty)}</p>`;
    const section = (title: string, body: string) => `<h2 style="margin:26px 0 10px;font:bold 17px Arial,sans-serif;color:#15161f">${e(title)}</h2>${body}`;
    const html = `<div style="font:15px/1.55 Arial,Helvetica,sans-serif;color:#1f2030;max-width:620px">
<p style="margin:0 0 4px;font:bold 12px Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#3a7de0">Prospection ${e(BRAND.name)} · 7 derniers jours</p>
<h1 style="margin:0 0 18px;font:bold 24px Arial,sans-serif;color:#15161f">${n(d.nb_reponses)} réponse(s) et ${n((d.a_rappeler || []).length)} prospect(s) à rappeler</h1>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows.join("")}</table>
${section("Réponses reçues", list(d.reponses || [], (x) => `<b>${e(x.company)}</b> · ${e(x.email)}${x.tel ? ` · ${e(x.tel)}` : ""} <span style="color:#6d7086">(${e(day(x.at))})</span>`, "Aucune réponse cette semaine."))}
${section("À rappeler : maquette ouverte plusieurs fois, sans réponse", list(d.a_rappeler || [], (x) => `<b>${e(x.company)}</b> · ${e(x.views)} visites${x.tel ? ` · ${e(x.tel)}` : ""} · <a href="https://${e(x.slug)}.yontech.fr/?apercu" style="color:#2563c9">maquette</a>`, "Personne pour l'instant."))}
${section("Modèles qui font le plus répondre (depuis le début)", list(d.modeles || [], (x) => `${e(x.name)} : ${n(x.replied)} réponse(s) sur ${n(x.sent)} envois (${e(pct(x.replied, x.sent))})`, "Pas encore assez d'envois."))}
<p style="margin:26px 0 0"><a href="${BRAND.tool}" style="display:inline-block;background:#15161f;color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:9px">Ouvrir l'outil de prospection</a></p>
</div>`;
    const text = [`Prospection ${BRAND.name} · 7 derniers jours`, ...kpis.map((k) => `${k[0]} : ${k[1]}${k[2] ? ` (${k[2]})` : ""}`),
      "", "Réponses :", ...(d.reponses || []).map((x: Rec) => `- ${x.company} ${x.email} ${x.tel || ""}`),
      "", "À rappeler :", ...(d.a_rappeler || []).map((x: Rec) => `- ${x.company} (${x.views} visites) ${x.tel || ""}`), "", BRAND.tool].join("\n");
    const to = await mailTeam(settings as SenderSettings, `Prospection ${BRAND.name} : ${n(d.nb_reponses)} réponse(s) cette semaine`, html, text);
    return json({ ok: true, to });
  } catch (error) {
    return json({ ok: false, error: (error as Error).message }, 500);
  }
});
