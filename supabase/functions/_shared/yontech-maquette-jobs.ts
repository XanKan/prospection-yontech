import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildSite, RESERVED_SLUGS, slugify } from "./yontech-maquette.ts";
import { creationData } from "./yontech-maquette-creation.ts";
import { checkAddress } from "./yontech-mail.ts";

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
// Pages intérieures d'une maquette : remplacées en bloc.
export async function savePages(db: SupabaseClient, maquetteId: string, pages: { path: string; html: string }[]) {
  await db.from("yontech_maquette_pages").delete().eq("maquette_id", maquetteId);
  if (pages.length) {
    const { error } = await db.from("yontech_maquette_pages").insert(pages.map((pg) => ({ maquette_id: maquetteId, path: pg.path, html: pg.html })));
    if (error) throw error;
  }
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

export function parisMidnightIso() {
  const now = new Date();
  const day = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(now);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value || "GMT+1";
  const h = Number((offset.match(/[+-]\d+/) || ["+1"])[0]);
  return new Date(`${day}T00:00:00${h >= 0 ? "+" : "-"}${String(Math.abs(h)).padStart(2, "0")}:00`).toISOString();
}

// Prospects préparés il y a plus de 10 jours et jamais validés : rendus à l'automate classique.
// Prospects réservés sans maquette (préparation interrompue) : rendus aussitôt.
export async function releaseStale(db: SupabaseClient) {
  const { data: reserved } = await db.from("yontech_prospection_messages").select("id").eq("status", "maquette").limit(200);
  for (const r of reserved || []) {
    const { data: has } = await db.from("yontech_maquettes").select("id").eq("message_id", r.id).limit(1).maybeSingle();
    if (!has) await db.from("yontech_prospection_messages").update({ status: "queued" }).eq("id", r.id).eq("status", "maquette");
  }
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
  const { data: settings } = await db.from("yontech_prospection_settings").select("maquette_enabled,maquette_daily,maquette_subject,maquette_body,design_ai").eq("id", 1).single();
  if (!settings) return { state: "error", error: "settings" };
  if (!settings.maquette_enabled && !opts.force) return { state: "disabled" };
  const { count: today } = await db.from("yontech_maquettes").select("id", { count: "exact", head: true }).eq("kind", "refonte").not("review", "is", null).gte("prepared_at", parisMidnightIso());
  let todo = Math.min(opts.max, Math.max(0, Number(settings.maquette_daily || 0) - (today || 0)));
  // « Préparer maintenant » : le nombre demandé, même si le quota du jour est atteint.
  if (opts.force) todo = opts.max;
  let prepared = 0, failed = 0;
  const errors: string[] = [];
  // Au plus « max » sites lus par appel, retenus ou écartés : un site occupe
  // presque toute la capacité de calcul d'une exécution.
  let attempts = 0;
  while (todo > 0 && attempts < opts.max && Date.now() - started < opts.budgetMs) {
    // 1. Meilleur prospect « avec site » encore en file, jamais essayé.
    const { data: cands } = await db.from("yontech_prospection_messages").select("id,email,company,data,status,opened_at")
      .eq("status", "queued").eq("data->>campagne", "site").is("data->>maquette_essai", null)
      .order("score", { ascending: false, nullsFirst: false }).order("created_at").limit(10);
    let cand = (cands || []).find((c) => c.data?.site && String(c.data?.sanssite) !== "true");
    if (!cand) for (const c of cands || []) await db.from("yontech_prospection_messages").update({ data: { ...(c.data || {}), maquette_essai: "sans site" } }).eq("id", c.id);
    // 2. À défaut : ceux qui ont ouvert le mail classique (vraie ouverture, pas de
    //    réponse, envoyé depuis 24 h au moins), les plus récents ouvreurs d'abord.
    if (!cand) {
      const { data: openers } = await db.from("yontech_prospection_messages").select("id,email,company,data,status,opened_at")
        .eq("status", "sent").eq("data->>campagne", "site").is("data->>maquette_essai", null)
        .not("opened_at", "is", null).is("scanner_at", null).is("replied_at", null)
        .lt("sent_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .not("data->>site", "is", null).neq("data->>site", "").or("data->>sanssite.is.null,data->>sanssite.neq.true")
        .order("opened_at", { ascending: false }).limit(50);
      const list = (openers || []).filter((c) => c.data?.site && String(c.data?.sanssite) !== "true");
      const { data: taken } = list.length ? await db.from("yontech_maquettes").select("message_id").in("message_id", list.map((c) => c.id)) : { data: [] };
      const has = new Set((taken || []).map((x) => x.message_id));
      cand = list.find((c) => !has.has(c.id));
    }
    // 3. À défaut : ceux qui ont reçu le mail classique il y a plus de 24 h sans
    //    l'ouvrir ni répondre (la maquette remplace leur relance), meilleur score d'abord.
    //    Rien ne part sans validation dans l'onglet Prospection maquette.
    if (!cand) {
      const { data: quiet } = await db.from("yontech_prospection_messages").select("id,email,company,data,status,opened_at")
        .eq("status", "sent").eq("data->>campagne", "site").is("data->>maquette_essai", null)
        .is("opened_at", null).is("replied_at", null)
        .lt("sent_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .not("data->>site", "is", null).neq("data->>site", "").or("data->>sanssite.is.null,data->>sanssite.neq.true")
        .order("score", { ascending: false, nullsFirst: false }).order("sent_at", { ascending: false }).limit(50);
      const list = (quiet || []).filter((c) => c.data?.site && String(c.data?.sanssite) !== "true");
      const { data: taken } = list.length ? await db.from("yontech_maquettes").select("message_id").in("message_id", list.map((c) => c.id)) : { data: [] };
      const has = new Set((taken || []).map((x) => x.message_id));
      cand = list.find((c) => !has.has(c.id));
    }
    if (!cand) break;
    const fromQueue = cand.status === "queued";
    // Prospect de la file : réservé (statut « maquette »). Prospect déjà contacté : statut inchangé.
    if (fromQueue) {
      const { data: reserved } = await db.from("yontech_prospection_messages").update({ status: "maquette" }).eq("id", cand.id).eq("status", "queued").select("id").maybeSingle();
      if (!reserved) continue;
    }
    const release = async (essai: string) => {
      await db.from("yontech_prospection_messages").update({ ...(fromQueue ? { status: "queued" } : {}), data: { ...(cand!.data || {}), maquette_essai: essai.slice(0, 120) } }).eq("id", cand!.id);
    };
    const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", cand.email).maybeSingle();
    if (banned) { if (fromQueue) await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Adresse exclue" }).eq("id", cand.id); else await release("adresse exclue"); continue; }
    // Adresse inutilisable : pas de maquette (ni lecture du site, ni site sur mesure à payer).
    const addr = await checkAddress(cand.email);
    if (!addr.ok) { if (fromQueue) await db.from("yontech_prospection_messages").update({ status: "skipped", error: `Adresse écartée : ${addr.reason}`, data: { ...(cand.data || {}), maquette_essai: "adresse invalide" } }).eq("id", cand.id); else await release("adresse invalide"); continue; }
    attempts++;
    // Marqué « essayé » avant la lecture : un site qui fait échouer l'exécution ne revient jamais en tête de file.
    await db.from("yontech_prospection_messages").update({ data: { ...(cand.data || {}), maquette_essai: "en cours" } }).eq("id", cand.id);
    let built: Awaited<ReturnType<typeof buildSite>>;
    try { built = await buildSite(String(cand.data.site), { company: cand.company, metier: cand.data?.metier, ville: cand.data?.ville, cp: cand.data?.cp, email: cand.email, noAi: settings.design_ai === false }); }
    catch (error) { built = { error: "lecture impossible : " + String((error as Error).message || error).slice(0, 80) }; }
    if (!("error" in built) && built.data.quality && !built.data.quality.ok) {
      failed++; errors.push(`${cand.company} : écartée (${built.data.quality.blocking.join(", ")})`);
      await release("écartée : " + built.data.quality.blocking.join(", "));
      continue;
    }
    if ("error" in built) {
      failed++; errors.push(`${cand.company} : ${built.error}`);
      await release(built.error);
      continue;
    }
    const slug = await uniqueSlug(db, slugify(built.data.name));
    // Mail : un des modèles actifs de type « maquette » (écran Messages), au hasard.
    const { data: tpls } = await db.from("yontech_prospection_templates").select("id,subject,body").eq("kind", "maquette").eq("active", true);
    const tpl = (tpls || []).length ? tpls![Math.floor(Math.random() * tpls!.length)] : null;
    const { data: inserted, error } = await db.from("yontech_maquettes").insert({
      slug, message_id: cand.id, source_url: built.data.source, host: built.data.host, company: built.data.name, data: built.data, html: built.html,
      status: "en_ligne", review: "a_valider", prepared_at: new Date().toISOString(), design_status: "attente",
      template_id: tpl?.id || null, mail_subject: tpl?.subject || settings.maquette_subject || MAQUETTE_SUBJECT, mail_body: tpl?.body || settings.maquette_body || MAQUETTE_BODY,
    }).select("id").single();
    if (!error && inserted) await savePages(db, inserted.id, built.pages);
    if (error) {
      failed++; errors.push(`${cand.company} : ${error.message}`);
      await release("erreur d'enregistrement");
      continue;
    }
    // Relances classiques en attente : annulées, la maquette prend le relais.
    if (!fromQueue) await db.from("yontech_prospection_followups").delete().eq("message_id", cand.id).eq("status", "queued");
    prepared++; todo--;
  }
  return { state: "done", prepared, failed, errors: errors.slice(0, 5), today: (today || 0) + prepared };
}

export const CREATION_SUBJECT = "{entreprise} : nous avons créé votre site internet";
export const CREATION_BODY = `{bonjour},

Quand un client cherche {entreprise} sur internet, il ne trouve aujourd'hui aucun site. Nous avons donc pris les devants et préparé une première ébauche du vôtre :

{maquette}

Ce n'est qu'un point de départ : nous l'adaptons ensuite à votre image. Les couleurs s'accordent à votre identité, et si vous avez un logo, envoyez-le-nous. Même chose pour vos photos de chantiers et vos textes : une simple réponse à ce mail suffit, nous nous occupons du reste.

La création est offerte : vous ne payez que 39 € par mois (hébergement, nom de domaine et mises à jour compris), sans engagement.

Répondez simplement « ok » et nous mettons votre site en ligne avec vos éléments.

Bien cordialement,`;

export const placeholder = (name: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${name.replace(/[<>&"]/g, "")}</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:600 18px system-ui,sans-serif;color:#333">Site en préparation</body></html>`;

// Maquettes « création » : entreprises sans site, données publiques seulement,
// site dessiné par Claude (aucune lecture de site : plusieurs par passage).
export async function prepareCreations(db: SupabaseClient, opts: { max: number }) {
  const { data: settings } = await db.from("yontech_prospection_settings").select("maquette_enabled,maquette_daily_creation").eq("id", 1).single();
  if (!settings?.maquette_enabled) return { state: "disabled" };
  const { count: today } = await db.from("yontech_maquettes").select("id", { count: "exact", head: true }).eq("kind", "creation").not("review", "is", null).gte("prepared_at", parisMidnightIso());
  let todo = Math.min(opts.max, Math.max(0, Number(settings.maquette_daily_creation || 0) - (today || 0)));
  let prepared = 0;
  for (let guard = 0; todo > 0 && guard < opts.max * 3; guard++) {
    // 1. File d'attente, puis 2. prospects déjà contactés sans réponse (ouvreurs d'abord).
    let { data: list } = await db.from("yontech_prospection_messages").select("id,email,company,data,status")
      .eq("status", "queued").eq("data->>campagne", "site").in("data->>sanssite", ["1", "true"]).is("data->>maquette_essai", null)
      .order("score", { ascending: false, nullsFirst: false }).limit(10);
    if (!list?.length) {
      ({ data: list } = await db.from("yontech_prospection_messages").select("id,email,company,data,status")
        .eq("status", "sent").eq("data->>campagne", "site").in("data->>sanssite", ["1", "true"]).or('data->>maquette_essai.is.null,data->>maquette_essai.eq."sans site"')
        .is("replied_at", null).lt("sent_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .order("opened_at", { ascending: false, nullsFirst: false }).order("sent_at", { ascending: false }).limit(50));
    }
    const { data: taken } = list?.length ? await db.from("yontech_maquettes").select("message_id").in("message_id", list.map((c) => c.id)) : { data: [] };
    const has = new Set((taken || []).map((x) => x.message_id));
    const cand = (list || []).find((c) => !has.has(c.id) && c.email);
    if (!cand) break;
    const fromQueue = cand.status === "queued";
    if (fromQueue) {
      const { data: reserved } = await db.from("yontech_prospection_messages").update({ status: "maquette" }).eq("id", cand.id).eq("status", "queued").select("id").maybeSingle();
      if (!reserved) continue;
    }
    await db.from("yontech_prospection_messages").update({ data: { ...(cand.data || {}), maquette_essai: "création" } }).eq("id", cand.id);
    const { data: banned } = await db.from("yontech_prospection_suppressions").select("email").eq("email", cand.email).maybeSingle();
    if (banned) { if (fromQueue) await db.from("yontech_prospection_messages").update({ status: "skipped", error: "Adresse exclue" }).eq("id", cand.id); continue; }
    const addr = await checkAddress(cand.email);
    if (!addr.ok) { await db.from("yontech_prospection_messages").update({ ...(fromQueue ? { status: "skipped", error: `Adresse écartée : ${addr.reason}` } : {}), data: { ...(cand.data || {}), maquette_essai: "adresse invalide" } }).eq("id", cand.id); continue; }
    const data = creationData(cand as { company: string; email: string; data: Record<string, unknown> });
    const slug = await uniqueSlug(db, slugify(data.name));
    const { data: tpls } = await db.from("yontech_prospection_templates").select("id,subject,body").eq("kind", "maquette_creation").eq("active", true);
    const tpl = (tpls || []).length ? tpls![Math.floor(Math.random() * tpls!.length)] : null;
    const { error } = await db.from("yontech_maquettes").insert({
      slug, message_id: cand.id, source_url: "", host: "", company: data.name, data, html: placeholder(data.name), kind: "creation",
      status: "en_ligne", review: "a_valider", prepared_at: new Date().toISOString(), design_status: "attente",
      template_id: tpl?.id || null, mail_subject: tpl?.subject || CREATION_SUBJECT, mail_body: tpl?.body || CREATION_BODY,
    });
    if (error) { if (fromQueue) await db.from("yontech_prospection_messages").update({ status: "queued" }).eq("id", cand.id); continue; }
    if (!fromQueue) await db.from("yontech_prospection_followups").delete().eq("message_id", cand.id).eq("status", "queued");
    prepared++; todo--;
  }
  return { state: "done", prepared, today: (today || 0) + prepared };
}
