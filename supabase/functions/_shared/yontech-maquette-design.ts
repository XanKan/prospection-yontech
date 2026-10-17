import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sourceText } from "./yontech-maquette-ai.ts";
import { px } from "./yontech-maquette-render.ts";
import type { SiteData } from "./yontech-maquette.ts";

// Site sur mesure dessiné par Claude pour chaque maquette.
// Le gabarit (yontech-maquette-pro.ts) sert de première version et de secours ;
// Claude reçoit les textes extraits du site actuel et VOIT les photos, puis écrit
// une page complète. Les demandes passent par l'API d'envoi en lot (pas de limite
// de durée côté Supabase, moitié prix) : la tâche planifiée soumet puis récupère.
// Chaque page rendue est contrôlée : seules les photos fournies, aucun script
// externe, téléphone et e-mail réels, bandeau Yontech ajouté.
//
// Statuts (yontech_maquettes.design_status) : attente → en_cours → ok | echec.

const MODEL = "claude-opus-5-5";
const MAX_IMAGES = 9;
const MAX_ATTEMPTS = 2;

// Directions artistiques nettement différentes ; trois sont proposées au hasard
// à chaque maquette, Claude retient celle qui va le mieux à l'entreprise.
const DIRECTIONS = [
  "Éditorial magazine : grands titres en serif de caractère très contrastée, grille asymétrique, photos en pleine largeur avec légendes, fond blanc pur et noir profond, un seul accent tiré du logo.",
  "Plein cadre immersif : accueil en photo plein écran, sections qui alternent photo pleine largeur et blocs sombres, grotesque large et serrée, légère parallaxe au défilement.",
  "Atelier artisan : typographie humaniste chaleureuse, photos en cadres décalés qui se chevauchent, couleurs terre prélevées dans les photos, détails de savoir-faire mis en avant.",
  "Industriel technique : fond anthracite, grille visible et filets fins, typographie condensée en capitales, chiffres réels mis en valeur, accent vif (couleur du logo ou jaune sécurité).",
  "Minimal suisse : grille stricte, beaucoup d'air, une seule couleur d'accent, néo-grotesque soignée, photos alignées au cordeau, hiérarchie typographique très nette.",
  "Grille en tuiles : mosaïque de blocs de tailles variées mêlant photos, textes et chiffres, rythme visuel fort, palette tirée du logo.",
  "Prestige : fond profond (bleu nuit, vert bouteille ou bordeaux selon le logo), serif élégante, filets dorés discrets, grandes respirations, rythme lent.",
  "Énergie graphique : aplats francs de la couleur de la marque, typographie display très épaisse, formes géométriques, contrastes forts, animations d'entrée nettes.",
  "Récit de chantier : page qui se lit comme un reportage, grandes photos de réalisations commentées, typographie de presse, fil chronologique ou par étapes réelles de l'entreprise.",
];

const SYSTEM = `Tu es directeur artistique et intégrateur dans une agence web française haut de gamme. Tu conçois des sites vitrines qui donnent envie de signer : identité forte, composition soignée, finitions dignes d'un site primé. Tu écris toi-même le HTML/CSS final.

Ce que tu produis : une page d'accueil complète (un seul fichier HTML, CSS dans <style>, JavaScript léger en ligne si utile), en français, responsive (parfaite sur téléphone), qui présente l'entreprise mieux que son site actuel. Elle sera montrée au dirigeant comme proposition de refonte.

Règles absolues sur le contenu :
- Aucun fait inventé : pas de chiffre, d'année, de nombre de clients ou de chantiers, de label, certification, garantie, délai, prix, avis client, témoignage, nom de personne, zone d'intervention ou prestation qui ne figure pas dans la source. Tu peux reformuler, résumer, regrouper, mettre en scène.
- Coordonnées : utilise uniquement le téléphone, l'e-mail et l'adresse fournis, à l'identique. Sans e-mail fourni, pas d'e-mail.
- Images : uniquement les URL fournies, à l'identique (balises <img> ou background-image). Tu les as vues : choisis chacune pour ce qu'elle montre, ne mets jamais une photo à un endroit où elle ne correspond pas au texte, n'utilise pas une photo floue, sombre ou hors sujet, et n'utilise jamais deux fois la même. Le logo va dans l'en-tête, à sa taille lisible, sans monogramme inventé à côté. Moins de photos bien choisies vaut mieux que des photos mal placées.
- Orthographe et accords irréprochables. Pas d'emoji.

Ressources : polices Google Fonts via <link> (pas d'autre ressource externe, aucun script externe, aucune image externe hors liste). Icônes en SVG en ligne si besoin. Une carte Google Maps est permise seulement avec l'adresse fournie, en <iframe src="https://maps.google.com/maps?q=ADRESSE&output=embed">. Un formulaire de contact est permis (il ne sera pas envoyé).

Ce qui fait « site généré par IA » et que tu évites absolument :
- fond crème ou blanc cassé, mots en italique dans les titres, numéros de section « 01 / 02 / 03 », petites étiquettes en police à chasse fixe, boutons en pilule partout ;
- polices Inter, Roboto, Arial, Poppins, Montserrat ou police système ;
- dégradés violets, ombres molles sur toutes les cartes, grilles de trois cartes identiques avec icône + titre + texte ;
- sections passe-partout : « Comment ça se passe » en 4 étapes génériques, « Pourquoi nous choisir » avec des atouts vagues, bandeaux de chiffres inventés, témoignages ;
- formules creuses (« un seul interlocuteur », « des solutions sur mesure adaptées à vos besoins », « votre satisfaction est notre priorité ») ;
- sur-titres en capitales au-dessus de chaque titre.
Chaque section doit exister parce que le contenu de CETTE entreprise la justifie.

Réponds uniquement par le document HTML complet, de <!doctype html> à </html>, sans commentaire avant ni après. Dans le <head>, ajoute <meta name="yt-direction" content="nom court de la direction retenue">.`;

type DesignRow = { id: string; slug: string; data: SiteData; design_attempts: number | null };

function client() {
  const apiKey = Deno.env.get("YONTECH_ANTHROPIC_API_KEY") || "";
  return apiKey ? new Anthropic({ apiKey, maxRetries: 2 }) : null;
}

function pickDirections(seed: string) {
  const pool = [...DIRECTIONS];
  let h = 0;
  for (const ch of seed + Date.now()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const out: string[] = [];
  while (out.length < 3 && pool.length) { h = (h * 1103515245 + 12345) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
  return out;
}

// Vérifie qu'une image est récupérable par l'API (format accepté, moins de 5 Mo) :
// une seule image refusée ferait échouer toute la demande.
async function usableImage(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const type = (r.headers.get("content-type") || "").toLowerCase();
    const len = Number(r.headers.get("content-length") || 0);
    let ok = r.ok && /image\/(jpeg|png|gif|webp)/.test(type) && (!len || len < 4_800_000);
    if (ok && !len && r.body) {
      let size = 0;
      const reader = r.body.getReader();
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value?.byteLength || 0; if (size >= 4_800_000) { ok = false; break; } }
      try { await reader.cancel(); } catch { /* fini */ }
    } else { try { await r.body?.cancel(); } catch { /* rien */ } }
    return ok;
  } catch { return false; }
}

async function buildRequest(row: DesignRow) {
  const d = row.data;
  const photos: string[] = [];
  for (const u of [d.heroImage, d.aboutImage, d.bandImage, ...(d.gallery || []), ...d.services.map((s) => s.image), ...d.images]) {
    const p = px(u || "");
    if (p && !photos.includes(p)) photos.push(p);
  }
  const usable: string[] = [];
  for (const p of photos) { if (usable.length >= MAX_IMAGES) break; if (await usableImage(p)) usable.push(p); }
  const logo = d.logo && (await usableImage(px(d.logo))) ? px(d.logo) : "";
  const content: Anthropic.ContentBlockParam[] = [];
  if (logo) content.push({ type: "text", text: `LOGO — URL à utiliser : ${logo}` }, { type: "image", source: { type: "url", url: logo } });
  usable.forEach((u, i) => content.push({ type: "text", text: `PHOTO ${i + 1} — URL à utiliser : ${u}` }, { type: "image", source: { type: "url", url: u } }));
  const directions = pickDirections(row.id);
  content.push({
    type: "text",
    text: `ENTREPRISE À METTRE EN VALEUR (contenu extrait de son site actuel ${d.source}) :

${sourceText(d, { paragraphs: [], pages: (d.pages || []).map((pg) => ({ label: pg.label, blocks: pg.blocks })), imageNames: [] })}

COORDONNÉES À UTILISER TELLES QUELLES : téléphone ${d.phone || "(aucun)"} · e-mail ${d.email || "(aucun)"} · adresse ${d.address || d.city || "(aucune)"}${d.hours.length ? ` · horaires ${d.hours.join(" ; ")}` : ""}
COULEUR PRINCIPALE RELEVÉE SUR LE SITE : ${d.accent}

DIRECTIONS ARTISTIQUES PROPOSÉES (choisis celle qui convient le mieux au métier et aux photos, et pousse-la loin) :
${directions.map((x, i) => `${i + 1}. ${x}`).join("\n")}

Conçois maintenant la page d'accueil de ${d.name}. Elle doit paraître dessinée spécialement pour cette entreprise, pas tirée d'un modèle.`,
  });
  return {
    custom_id: row.id,
    params: {
      model: MODEL, max_tokens: 64000,
      output_config: { effort: "high" as const },
      system: SYSTEM,
      messages: [{ role: "user" as const, content }],
    },
    allowed: [logo, ...usable].filter(Boolean),
  };
}

// ---------- contrôle de la page rendue ----------
const digits = (s: string) => s.replace(/\D/g, "").replace(/^33/, "0");
const PHONE_RE = /(?:\+33\s?|0)[1-9](?:[\s.\-]?\d{2}){4}/g;
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function finalizeHtml(raw: string, d: SiteData, allowed: string[]): { html: string; direction: string } | { error: string } {
  const start = raw.search(/<!doctype html|<html[\s>]/i), end = raw.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) return { error: "page incomplète" };
  let html = raw.slice(start, end + 7);
  if (html.length < 6000) return { error: "page trop courte" };
  if (html.length > 600_000) return { error: "page trop lourde" };
  const ok = new Set(allowed.map((u) => u.replace(/&amp;/g, "&")));
  const isOk = (u: string) => ok.has(u.replace(/&amp;/g, "&").trim());
  // Scripts externes, cadres (hors carte Google), objets, feuilles de style hors Google Fonts.
  html = html.replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, "");
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (m) => /src="https:\/\/maps\.google\.com\/maps\?[^"]*output=embed/i.test(m) ? m : "");
  html = html.replace(/<(object|embed)\b[\s\S]*?(<\/\1>|\/?>)/gi, "");
  html = html.replace(/<link\b[^>]*>/gi, (m) => /rel=["']?stylesheet/i.test(m) && !/fonts\.googleapis\.com/i.test(m) ? "" : m);
  html = html.replace(/@import\s+url\(\s*['"]?(?!https:\/\/fonts\.googleapis\.com)[^)]*\)\s*;?/gi, "");
  // Images : uniquement celles fournies.
  html = html.replace(/<img\b[^>]*>/gi, (m) => {
    const src = (m.match(/\bsrc\s*=\s*"([^"]*)"/i) || m.match(/\bsrc\s*=\s*'([^']*)'/i) || [])[1] || "";
    if (/^data:image\/svg\+xml/i.test(src)) return m;
    return isOk(src) ? m.replace(/\s(srcset|sizes)\s*=\s*("[^"]*"|'[^']*')/gi, "") : "";
  });
  html = html.replace(/url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/gi, (m, _q, u) => (isOk(u) || /fonts\.(googleapis|gstatic)\.com/i.test(u) ? m : "none"));
  html = html.replace(/<source\b[^>]*>/gi, "");
  // Formulaires : jamais envoyés.
  html = html.replace(/<form\b([^>]*)>/gi, (_m, a) => `<form${String(a).replace(/\s(action|method|target)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, "")} onsubmit="event.preventDefault();alert('Formulaire de démonstration : cette maquette n\\'envoie rien.')">`);
  // Coordonnées : seules les vraies.
  const realPhone = digits(d.phone || "");
  html = html.replace(/href="tel:([^"]*)"/gi, (m, n) => (realPhone && digits(n) === realPhone ? m : realPhone ? `href="tel:${realPhone}"` : 'href="#contact"'));
  html = html.replace(PHONE_RE, (m) => (digits(m) === realPhone ? m : d.phone || ""));
  const realEmail = (d.email || "").toLowerCase();
  html = html.replace(EMAIL_RE, (m) => (m.toLowerCase() === realEmail || /yontech|googleapis|gstatic/i.test(m) ? m : d.email || ""));
  // Bandeau Yontech, non indexation, repère de version.
  const direction = ((html.match(/<meta\s+name="yt-direction"\s+content="([^"]*)"/i) || [])[1] || "").slice(0, 80);
  html = html.replace(/<head([^>]*)>/i, `<head$1><meta name="robots" content="noindex,nofollow"><meta name="yt-design" content="ia">`);
  const bar = `<div style="position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;background:rgba(17,17,17,.88);color:#fff;font:600 12px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:calc(100vw - 24px)"><span>Maquette de refonte proposée par Yontech pour ${esc(d.name)}</span><a href="${esc(d.source)}" target="_blank" rel="noopener nofollow" style="color:#fff;opacity:.75;text-decoration:underline;white-space:nowrap">Site actuel</a></div>`;
  html = /<body[^>]*>/i.test(html) ? html.replace(/<body([^>]*)>/i, `<body$1>${bar}`) : html.replace(/<\/html>/i, `${bar}</html>`);
  return { html, direction };
}

// ---------- soumission et récupération ----------
export async function submitDesigns(db: SupabaseClient, max = 4) {
  const ai = client();
  if (!ai) return { submitted: 0, note: "clé IA absente" };
  const { data: rows } = await db.from("yontech_maquettes").select("id,slug,data,design_attempts").eq("design_status", "attente").eq("status", "en_ligne").not("data", "is", null).order("prepared_at", { ascending: false, nullsFirst: false }).limit(max);
  if (!rows?.length) return { submitted: 0 };
  const built: { row: DesignRow; req: Awaited<ReturnType<typeof buildRequest>> }[] = [];
  for (const row of rows as DesignRow[]) {
    try { built.push({ row, req: await buildRequest(row) }); }
    catch (e) { await db.from("yontech_maquettes").update({ design_status: "echec", design_error: "préparation : " + (e as Error).message.slice(0, 150) }).eq("id", row.id); }
  }
  if (!built.length) return { submitted: 0 };
  const batch = await ai.messages.batches.create({ requests: built.map((b) => ({ custom_id: b.req.custom_id, params: b.req.params })) });
  for (const b of built) {
    await db.from("yontech_maquettes").update({
      design_status: "en_cours", design_batch: batch.id, design_images: b.req.allowed,
      design_attempts: (b.row.design_attempts || 0) + 1, design_error: null,
    }).eq("id", b.row.id);
  }
  return { submitted: built.length, batch: batch.id };
}

export async function collectDesigns(db: SupabaseClient) {
  const ai = client();
  if (!ai) return { collected: 0 };
  const { data: rows } = await db.from("yontech_maquettes").select("design_batch").eq("design_status", "en_cours").not("design_batch", "is", null).limit(50);
  const batches = [...new Set((rows || []).map((r) => r.design_batch as string))];
  let collected = 0, failed = 0;
  for (const id of batches) {
    const b = await ai.messages.batches.retrieve(id);
    if (b.processing_status !== "ended") continue;
    for await (const result of await ai.messages.batches.results(id)) {
      const { data: m } = await db.from("yontech_maquettes").select("id,data,design_images,design_attempts,design_status").eq("id", result.custom_id).maybeSingle();
      if (!m || m.design_status !== "en_cours") continue;
      const retry = async (why: string) => {
        failed++;
        const again = (m.design_attempts || 0) < MAX_ATTEMPTS;
        await db.from("yontech_maquettes").update({ design_status: again ? "attente" : "echec", design_batch: null, design_error: why.slice(0, 200) }).eq("id", m.id);
      };
      if (result.result.type !== "succeeded") { await retry(`demande ${result.result.type}`); continue; }
      const msg = result.result.message;
      if (msg.stop_reason === "refusal") { await retry("refus du modèle"); continue; }
      const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const out = finalizeHtml(text, m.data as SiteData, (m.design_images || []) as string[]);
      if ("error" in out) { await retry(out.error + (msg.stop_reason === "max_tokens" ? " (réponse coupée)" : "")); continue; }
      await db.from("yontech_maquettes").update({ html: out.html, design_status: "ok", design_direction: out.direction, design_at: new Date().toISOString(), design_error: null, updated_at: new Date().toISOString() }).eq("id", m.id);
      // Une seule page sur mesure : les anciennes pages intérieures du gabarit disparaissent.
      await db.from("yontech_maquette_pages").delete().eq("maquette_id", m.id);
      collected++;
    }
  }
  return { collected, failed };
}
