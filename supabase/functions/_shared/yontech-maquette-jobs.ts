import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildSite, RESERVED_SLUGS, slugify } from "./yontech-maquette.ts";

// Prospection par maquette : chaque jour, l'outil prépare un nombre fixe de
// prospects de la campagne « sites » qui ont déjà un site (20 par défaut) :
// maquette générée, e-mail prêt. Rien ne part sans validation dans l'onglet
// « Prospection maquette ». Un prospect préparé est réservé (statut
// « maquette ») : l'automate classique ne lui écrit pas.

export const MAQUETTE_SUBJECT = "{entreprise}, nous avons refait votre site internet";
export const MAQUETTE_BODY = `{bonjour},

Nous avons pris le temps de refaire le site de {entreprise}, avec vos textes et vos photos actuels. Le voici :

{maquette}

Il s'affiche parfaitement sur téléphone, se charge vite et met en avant votre numéro et votre demande de devis. C'est le même contenu que votre site actuel, présenté autrement.

S'il vous plaît, il est à vous : nous le mettons en ligne sur votre adresse, avec vos corrections, pour 39 € par mois (hébergement, nom de domaine et mises à jour compris), sans engagement.

Répondez simplement « ok » et nous vous appelons pour l'ajuster avec vous.

Bien cordialement,`;

let domainCheck: { ready: boolean; at: number } | null = null;
// *.yontech.fr est branché quand un sous-domaine quelconque répond en DNS
// (enregistrement générique posé avec le Worker Cloudflare).
export async function maquetteDomainReady() {
  if (domainCheck && Date.now() - domainCheck.at < 10 * 60_000) return domainCheck.ready;
  let ready = false;
  try {
    const r = await fetch("https://cloudflare-dns.com/dns-query?name=verif-maquette.yontech.fr&type=AAAA", { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    ready = Array.isArray(j.Answer) && j.Answer.length > 0;
  } catch { /* considéré comme non branché */ }
  domainCheck = { ready, at: Date.now() };
  return ready;
}
export function maquetteUrl(slug: string, ready: boolean) {
  return ready ? `https://${slug}.yontech.fr` : `https://prospection.yontech.fr/maquette.html?s=${slug}`;
}
export async function uniqueSlug(db: SupabaseClient, wanted: string) {
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? wanted : `${wanted.slice(0, 44)}-${i + 1}`;
    if (RESERVED_SLUGS.has(slug)) continue;
    const { data } = await db.from("yontech_maquettes").select("id").eq("slug", slug).maybeSingle();
    if (!data) return slug;
  }
  return `${wanted.slice(0, 40)}-${crypto.randomUUID().slice(0, 6)}`;
}

function parisMidnightIso() {
  const now = new Date();
  const day = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(now);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value || "GMT+1";
  const h = Number((offset.match(/[+-]\d+/) || ["+1"])[0]);
  return new Date(`${day}T00:00:00${h >= 0 ? "+" : "-"}${String(Math.abs(h)).padStart(2, "0")}:00`).toISOString();
}

// Prospects préparés il y a plus de 10 jours et jamais validés : rendus à l'automate classique.
export async function releaseStale(db: SupabaseClient) {
  const limit = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const { data: stale } = await db.from("yontech_maquettes").select("id,message_id").eq("review", "a_valider").lt("prepared_at", limit).limit(50);
  for (const m of stale || []) {
    if (m.message_id) await db.from("yontech_prospection_messages").update({ status: "queued" }).eq("id", m.message_id).eq("status", "maquette");
    await db.from("yontech_maquettes").delete().eq("id", m.id);
  }
  return (stale || []).length;
}

export async function prepareMaquettes(db: SupabaseClient, opts: { max: number; budgetMs: number; force?: boolean }) {
  const started = Date.now();
  const { data: settings } = await db.from("yontech_prospection_settings").select("maquette_enabled,maquette_daily,maquette_subject,maquette_body").eq("id", 1).single();
  if (!settings) return { state: "error", error: "settings" };
  if (!settings.maquette_enabled && !opts.force) return { state: "disabled" };
  const { count: today } = await db.from("yontech_maquettes").select("id", { count: "exact", head: true }).not("review", "is", null).gte("prepared_at", parisMidnightIso());
  let todo = Math.min(opts.max, Math.max(0, Number(settings.maquette_daily || 0) - (today || 0)));
  if (opts.force) todo = Math.max(todo, Math.min(opts.max, 1));
  let prepared = 0, failed = 0;
  const errors: string[] = [];
  while (todo > 0 && Date.now() - started < opts.budgetMs) {
    // Meilleur prospect « avec site » encore en file, jamais essayé.
    const { data: cands } = await db.from("yontech_prospection_messages").select("id,email,company,data")
      .eq("status", "queued").eq("data->>campagne", "site").is("data->>maquette_essai", null)
      .order("score", { ascending: false, nullsFirst: false }).order("created_at").limit(10);
    const cand = (cands || []).find((c) => c.data?.site && String(c.data?.sanssite) !== "true");
    if (!cand) {
      // Les fiches sans site de la sélection sont marquées pour ne pas être relues.
      for (const c of cands || []) await db.from("yontech_prospection_messages").update({ data: { ...(c.data || {}), maquette_essai: "sans site" } }).eq("id", c.id);
      if (!(cands || []).length) break;
      continue;
    }
    const { data: reserved } = await db.from("yontech_prospection_messages").update({ status: "maquette" }).eq("id", cand.id).eq("status", "queued").select("id").maybeSingle();
    if (!reserved) continue;
    const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", cand.email).maybeSingle();
    if (banned) { await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Adresse exclue" }).eq("id", cand.id); continue; }
    const built = await buildSite(String(cand.data.site), { company: cand.company, metier: cand.data?.metier, ville: cand.data?.ville, email: cand.email });
    if ("error" in built) {
      failed++; errors.push(`${cand.company} : ${built.error}`);
      await db.from("yontech_prospection_messages").update({ status: "queued", data: { ...(cand.data || {}), maquette_essai: built.error.slice(0, 120) } }).eq("id", cand.id);
      continue;
    }
    const slug = await uniqueSlug(db, slugify(built.data.name));
    const { error } = await db.from("yontech_maquettes").insert({
      slug, message_id: cand.id, source_url: built.data.source, host: built.data.host, company: built.data.name, data: built.data, html: built.html,
      status: "en_ligne", review: "a_valider", prepared_at: new Date().toISOString(),
      mail_subject: settings.maquette_subject || MAQUETTE_SUBJECT, mail_body: settings.maquette_body || MAQUETTE_BODY,
    });
    if (error) {
      failed++; errors.push(`${cand.company} : ${error.message}`);
      await db.from("yontech_prospection_messages").update({ status: "queued", data: { ...(cand.data || {}), maquette_essai: "erreur d'enregistrement" } }).eq("id", cand.id);
      continue;
    }
    prepared++; todo--;
  }
  return { state: "done", prepared, failed, errors: errors.slice(0, 5), today: (today || 0) + prepared };
}
