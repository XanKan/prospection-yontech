import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { finalizeHtml } from "./yontech-maquette-design.ts";
import { photoSelectors, polishHtml } from "./yontech-maquette-polish.ts";
import { METIERS, metierOf } from "./yontech-maquette-creation.ts";
import { px } from "./yontech-maquette-render.ts";
import type { SiteData } from "./yontech-maquette.ts";

// Bibliothèque de modèles : des sites sur mesure déjà dessinés par Claude sont
// transformés UNE FOIS en modèles à trous (passe unique, envoi en lot), puis
// chaque nouvelle maquette est remplie par le code, sans aucun appel à l'IA.
//
// Vocabulaire des trous (moustaches) :
//   variables : {{nom}} {{metier}} {{ville}} {{kicker}} {{adresse}} {{adresse_url}} {{telephone}} {{tel}}
//               {{email}} {{accroche}} {{intro}} {{apropos_titre}} {{apropos}} {{cta}} {{logo_url}}
//               {{photo1}}…{{photoN}} {{legende1}}…{{legendeN}}
//   sections  : {{#services}}…{{titre}}…{{texte}}…{{/services}}   (répétée)
//               {{#atouts}}…{{titre}}…{{texte}}…{{/atouts}}       (répétée, facultative)
//               {{#chiffres}}…{{valeur}}…{{label}}…{{/chiffres}}  (répétée, facultative)
//               {{#horaires}}…{{ligne}}…{{/horaires}}            (répétée, facultative)
//               {{#x}}…{{/x}} affiché si x existe ; {{^x}}…{{/x}} si x est vide

const MODEL = "claude-sonnet-5-5";

// Familles de métiers : un modèle garde les illustrations de son métier d'origine,
// il est donc choisi en priorité pour une entreprise de la même famille.
export function groupeOf(naf: string) {
  const n = String(naf || "").toUpperCase();
  if (/^43\.32/.test(n)) return "menuiserie";
  if (/^43\.21|^42\.22/.test(n)) return "electricite";
  if (/^43\.22|^42\.21/.test(n)) return "plomberie";
  if (/^43\.91|^43\.99A/.test(n)) return "toiture";
  if (/^41\.|^42\.|^43\.1|^43\.99[BCDE]/.test(n)) return "gros_oeuvre";
  if (/^43\.3|^43\.29/.test(n)) return "finitions";
  return "autre";
}

// Blocs photo facultatifs : une figure ou une image dont la photo manque disparaît.
export function optionalPhotos(tpl: string) {
  const figures: string[] = [];
  let out = tpl.replace(/<figure\b[\s\S]*?<\/figure>/g, (f) => { const m = f.match(/\{\{photo(\d+)\}\}/); figures.push(m ? `{{#photo${m[1]}}}${f}{{/photo${m[1]}}}` : f); return `\u0000F${figures.length - 1}\u0000`; });
  out = out.replace(/<img\b[^>]*\{\{photo(\d+)\}\}[^>]*>/g, (img, n) => `{{#photo${n}}}${img}{{/photo${n}}}`);
  out = out.replace(/\u0000F(\d+)\u0000/g, (_m, i) => figures[Number(i)]);
  // Section qui n'est qu'une galerie : elle disparaît si sa première photo manque.
  return out.replace(/<section\b[\s\S]*?<\/section>/g, (sec) => {
    if (/\{\{(accroche|intro|apropos|telephone|tel|email|#services|#atouts|#chiffres)\}\}/.test(sec)) return sec;
    const nums = [...sec.matchAll(/\{\{photo(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? `{{#photo${Math.min(...nums)}}}${sec.replace(/\{\{#photo\d+\}\}|\{\{\/photo\d+\}\}/g, "")}{{/photo${Math.min(...nums)}}}` : sec;
  });
}

/* ---------------- Moustaches ---------------- */
type Ctx = Record<string, unknown>;
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Les blocs d'un même nom peuvent s'imbriquer : {{#chiffres}}<section>…{{#chiffres}}élément{{/chiffres}}…</section>{{/chiffres}}.
// Le bloc extérieur est alors une simple condition (section affichée une fois) et le
// bloc intérieur la liste répétée. Une balise sans sa fermeture est ignorée.
const vars = (s: string, ctx: Ctx) => s.replace(/\{\{\s*\/\s*\w+\s*\}\}/g, "").replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, k: string) => esc(ctx[k]));
export function renderTemplate(tpl: string, ctx: Ctx): string {
  const open = /\{\{([#^])\s*(\w+)\s*\}\}/g;
  let out = "", i = 0;
  for (let m = open.exec(tpl); m; m = open.exec(tpl)) {
    out += vars(tpl.slice(i, m.index), ctx);
    const [kind, key] = [m[1], m[2]];
    const tags = new RegExp(`\\{\\{\\s*([#^/])\\s*${key}\\s*\\}\\}`, "g");
    tags.lastIndex = m.index + m[0].length;
    let depth = 1, close: RegExpExecArray | null = null;
    for (let t = tags.exec(tpl); t; t = tags.exec(tpl)) { if (t[1] === "/" && --depth === 0) { close = t; break; } if (t[1] !== "/") depth++; }
    if (!close) { i = m.index + m[0].length; open.lastIndex = i; continue; }
    const inner = tpl.slice(m.index + m[0].length, close.index);
    const v = ctx[key];
    const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
    if (kind === "^") out += truthy ? "" : renderTemplate(inner, ctx);
    else if (truthy) {
      const wrapper = new RegExp(`\\{\\{\\s*#\\s*${key}\\s*\\}\\}`).test(inner);
      out += Array.isArray(v) && !wrapper ? v.map((item, n) => renderTemplate(inner, { ...ctx, ...(item as Ctx), index: n + 1 })).join("") : renderTemplate(inner, ctx);
    }
    i = close.index + close[0].length;
    open.lastIndex = i;
  }
  return out + vars(tpl.slice(i), ctx);
}

// Contrôle de construction d'un modèle : une liste (prestations, atouts) dont la
// boucle entoure une section entière répéterait toute la section, titre compris.
// Listes annexes (chiffres, horaires) dont la boucle entoure une section entière : non affichées
// (sinon une section par chiffre). La section des listes bien construites reste.
export function loopsWrappingSection(html: string) {
  const out: string[] = [];
  for (const key of ["chiffres", "horaires"]) {
    const m = String(html).match(new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`));
    if (m && /<section\b/i.test(m[1]) && !new RegExp(`\\{\\{#${key}\\}\\}`).test(m[1])) out.push(key);
  }
  return out;
}

export function templateUsable(html: string) {
  for (const key of ["services", "atouts"]) {
    const m = String(html).match(new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`));
    if (m && /<section\b/i.test(m[1]) && !new RegExp(`\\{\\{#${key}\\}\\}`).test(m[1])) return false;
  }
  return true;
}

/* ---------------- Transformation (une seule fois) ---------------- */
const CONVERT_SYSTEM = `Tu transformes une page web HTML complète, conçue pour UNE entreprise, en MODÈLE réutilisable pour n'importe quelle entreprise du même type, en gardant EXACTEMENT le design (structure, CSS, typographie, couleurs, animations, illustrations SVG).

Remplace tout ce qui est propre à l'entreprise par des trous au format moustache :
- Variables : {{nom}} (nom de l'entreprise, partout y compris logotype typographique et <title>), {{metier}}, {{ville}}, {{kicker}} (petite ligne « métier · ville »), {{adresse}}, {{adresse_url}} (adresse encodée, à utiliser dans l'URL d'une carte Google : https://maps.google.com/maps?q={{adresse_url}}&output=embed), {{telephone}} (affiché), {{tel}} (dans href="tel:{{tel}}"), {{email}} (affiché et dans mailto:), {{accroche}} (grand titre d'accueil), {{intro}} (texte d'introduction), {{apropos_titre}}, {{apropos}} (paragraphe de présentation), {{cta}} (texte du bouton principal).
- Logo : {{#logo_url}}<img src="{{logo_url}}" …>{{/logo_url}}{{^logo_url}}(logotype typographique avec {{nom}}){{/logo_url}}.
- Photos : chaque photo devient {{photo1}}, {{photo2}}… (numérotées dans l'ordre d'apparition, même dans background-image), et chaque légende de photo {{legende1}}, {{legende2}}… ; garde au plus 8 photos, supprime les blocs photo en trop.
- Liste de prestations : garde UN SEUL élément représentatif entouré de {{#services}} … {{/services}}, avec {{titre}} et {{texte}} à l'intérieur (il sera répété 3 à 6 fois : la mise en page doit fonctionner pour 3 à 6 éléments).
- Atouts ou points forts : {{#atouts}} … {{titre}} … {{texte}} … {{/atouts}} (un seul élément). Chiffres clés : {{#chiffres}} … {{valeur}} … {{label}} … {{/chiffres}} (un seul élément) ; entoure toute la section des chiffres de {{#chiffres}}…{{/chiffres}} si elle n'a de sens qu'avec des chiffres. Horaires : {{#horaires}}{{ligne}}{{/horaires}}.
- Tout autre texte propre à cette entreprise (projets précis, noms de chantiers, citations, détails uniques) : remplace-le par un texte générique et vrai pour toute entreprise de ce métier, ou supprime le bloc. Aucun texte ne doit rester propre à l'ancienne entreprise.
- Couleurs : définis dans :root la variable --yt-accent avec la couleur d'accent principale actuelle et utilise var(--yt-accent) partout où elle apparaît (texte, fonds, bordures, soulignements).
- Ne modifie pas les balises <script> sauf pour y remplacer des textes propres à l'entreprise. Pas de nouvelle ressource externe.

Réponds UNIQUEMENT par le modèle HTML complet, de <!doctype html> à </html>.`;

type Source = { id: string; kind: string; famille: string; html: string; data: SiteData; images: string[] };

function stripYontech(html: string) {
  return html.replace(/<div id="yt-badge"[\s\S]*?<\/div>/, "").replace(/<style id="yt-safe">[\s\S]*?<\/style>/, "")
    .replace(/<script id="yt-safe-js">[\s\S]*?<\/script>/, "").replace(/<meta name="(robots|yt-design)"[^>]*>/g, "");
}

function convertRequest(s: Source) {
  const d = s.data;
  const facts = [`Entreprise : ${d.name}`, `Téléphone : ${d.phone}`, `E-mail : ${d.email}`, `Adresse : ${d.address}`, `Ville : ${d.city}`, `Logo : ${d.logo ? px(d.logo) : "(aucun)"}`,
    `Photos (URL) : ${s.images.length ? s.images.join(" | ") : "(aucune)"}`].join("\n");
  return {
    custom_id: `tpl-${s.id}`,
    params: {
      model: MODEL, max_tokens: 32000, output_config: { effort: "medium" as const }, system: CONVERT_SYSTEM,
      messages: [{ role: "user" as const, content: `DONNÉES PROPRES À L'ENTREPRISE ACTUELLE (à remplacer par des trous) :\n${facts}\n\nPAGE À TRANSFORMER :\n${stripYontech(s.html)}` }],
    },
  };
}

const PACK_PROMPT = (metiers: string[]) => `Pour chacun des métiers du bâtiment ci-dessous, rédige des textes de site vitrine sobres, crédibles et sans aucun fait inventé (ni année, ni chiffre, ni avis, ni label, ni garantie, ni prix), utilisables pour n'importe quelle petite entreprise de ce métier. Tu peux utiliser {{nom}} et {{ville}} dans les textes. Orthographe irréprochable, pas d'emoji.

Réponds UNIQUEMENT par un objet JSON : { "<métier>": { "accroches": [3 titres de 4 à 8 mots], "intros": [2 phrases de 25 à 40 mots], "apropos_titres": [2 titres courts], "apropos": [2 paragraphes de 40 à 60 mots], "services": [6 objets {"titre": "2 à 4 mots", "texte": "1 phrase de 15 à 25 mots"}], "atouts": [3 objets {"titre": "2 à 4 mots", "texte": "1 phrase"}], "cta": "texte de bouton" }, … }

Métiers : ${metiers.join(" ; ")}`;

function client() {
  const apiKey = Deno.env.get("YONTECH_ANTHROPIC_API_KEY") || "";
  if (!apiKey) throw new Error("clé IA absente");
  return new Anthropic({ apiKey, maxRetries: 2 });
}

// Choix des sources : répartition par famille de style, de préférence les pages riches en photos.
const QUOTAS: Record<string, Record<string, number>> = {
  refonte: { "Éditorial": 5, "Industriel": 4, "Énergie": 4, "Plein": 4, "Minimal": 3, "Grille": 3, "Récit": 2, "Prestige": 1, "Atelier": 1 },
  creation: { "Éditorial": 4, "Minimal": 3, "Énergie": 3, "Grille": 2, "Industriel": 2, "Atelier": 1, "Prestige": 1 },
};

// Complément : modèles de création pour les familles de métiers qui en manquent (2 par famille au moins).
export async function submitGroupTemplates(db: SupabaseClient, perGroup = 3) {
  const { data: have } = await db.from("yontech_maquette_templates").select("source_id,groupe,kind,status").neq("status", "echec");
  const used = new Set((have || []).map((r) => r.source_id));
  const count: Record<string, number> = {};
  for (const r of have || []) if (r.kind === "creation") count[r.groupe || "autre"] = (count[r.groupe || "autre"] || 0) + 1;
  const { data: rows } = await db.from("yontech_maquettes").select("id,kind,design_direction,html,data,design_images,yontech_prospection_messages(data)").eq("design_status", "ok").eq("kind", "creation").limit(300);
  const picked: (Source & { groupe: string })[] = [];
  for (const r of rows || []) {
    if (used.has(r.id)) continue;
    const g = groupeOf(String(((r as Record<string, any>).yontech_prospection_messages?.data || {}).naf || ""));
    if ((count[g] || 0) >= perGroup) continue;
    count[g] = (count[g] || 0) + 1;
    picked.push({ id: r.id, kind: "creation", famille: String(r.design_direction || "").split(/[\s—–,]/)[0] || "Création", html: r.html, data: r.data as SiteData, images: [], groupe: g });
  }
  if (!picked.length) return { submitted: 0 };
  const batch = await client().messages.batches.create({ requests: picked.map(convertRequest) as never });
  for (const s of picked) await db.from("yontech_maquette_templates").insert({ source_id: s.id, kind: "creation", famille: s.famille, groupe: s.groupe, status: "en_cours", batch: batch.id });
  return { submitted: picked.length, batch: batch.id, groupes: count };
}

export async function submitTemplateLibrary(db: SupabaseClient) {
  const { data: done } = await db.from("yontech_maquette_templates").select("source_id");
  const used = new Set((done || []).map((r) => r.source_id));
  const { data: rows, error } = await db.from("yontech_maquettes").select("id,kind,design_direction,html,data,design_images").eq("design_status", "ok").not("html", "is", null).limit(400);
  if (error) throw error;
  const picked: Source[] = [];
  for (const kind of ["refonte", "creation"]) {
    for (const [fam, n] of Object.entries(QUOTAS[kind])) {
      const pool = (rows || []).filter((r) => r.kind === kind && !used.has(r.id) && String(r.design_direction || "").startsWith(fam))
        .sort((a, b) => ((b.design_images || []).length - (a.design_images || []).length) || (Math.random() - 0.5));
      for (const r of pool.slice(0, n)) picked.push({ id: r.id, kind, famille: fam, html: r.html, data: r.data as SiteData, images: ((r.design_images || []) as string[]).filter((u) => !(r.data as SiteData).logo || u !== px((r.data as SiteData).logo)) });
    }
  }
  const { data: packs } = await db.from("yontech_metier_textes").select("metier");
  const needPacks = !(packs || []).length;
  if (!picked.length && !needPacks) return { submitted: 0 };
  const requests: { custom_id: string; params: Record<string, unknown> }[] = picked.map(convertRequest);
  if (needPacks) requests.push({ custom_id: "packs", params: { model: MODEL, max_tokens: 64000, output_config: { effort: "low" }, messages: [{ role: "user", content: PACK_PROMPT([...METIERS, "bâtiment"]) }] } });
  const batch = await client().messages.batches.create({ requests: requests as never });
  for (const s of picked) await db.from("yontech_maquette_templates").insert({ source_id: s.id, kind: s.kind, famille: s.famille, status: "en_cours", batch: batch.id });
  return { submitted: requests.length, batch: batch.id };
}

// Contrôle d'un modèle : trous attendus présents, plus aucune trace de l'entreprise d'origine.
function checkTemplate(tpl: string, src: SiteData, images: string[]) {
  const start = tpl.search(/<!doctype html|<html[\s>]/i), end = tpl.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) return { error: "modèle incomplet" };
  const html = tpl.slice(start, end + 7);
  for (const need of ["{{nom}}", "{{#services}}", "{{accroche}}"]) if (!html.includes(need)) return { error: `trou manquant ${need}` };
  if (!/\{\{tel\}\}|\{\{telephone\}\}/.test(html)) return { error: "trou téléphone manquant" };
  const low = html.toLowerCase();
  const leftovers = [src.name, src.email, src.phone].filter((x) => x && x.length > 3 && low.includes(x.toLowerCase()));
  for (const u of images) if (u && html.includes(u)) leftovers.push("photo d'origine");
  if (leftovers.length) return { error: `restes de l'entreprise d'origine : ${leftovers.slice(0, 2).join(", ")}` };
  const photos = new Set([...html.matchAll(/\{\{photo(\d+)\}\}/g)].map((m) => Number(m[1])));
  return { html, photos: photos.size ? Math.max(...photos) : 0 };
}

export async function collectTemplateLibrary(db: SupabaseClient) {
  const { data: pending } = await db.from("yontech_maquette_templates").select("id,source_id,batch").eq("status", "en_cours");
  const batches = [...new Set((pending || []).map((p) => p.batch).filter(Boolean))] as string[];
  if (!batches.length) return { state: "rien en cours" };
  const ai = client();
  let ok = 0, ko = 0, packs = 0;
  for (const id of batches) {
    const b = await ai.messages.batches.retrieve(id);
    if (b.processing_status !== "ended") continue;
    for await (const r of await ai.messages.batches.results(id)) {
      const text = r.result.type === "succeeded" ? r.result.message.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
      if (r.custom_id === "packs") {
        try {
          const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
          for (const [metier, data] of Object.entries(json)) { await db.from("yontech_metier_textes").upsert({ metier, data }); packs++; }
        } catch (e) { console.error("[Modèles] textes métiers", (e as Error).message); }
        continue;
      }
      const sourceId = r.custom_id.replace(/^tpl-/, "");
      const row = (pending || []).find((p) => p.source_id === sourceId);
      if (!row) continue;
      if (!text) { await db.from("yontech_maquette_templates").update({ status: "echec", error: `demande ${r.result.type}` }).eq("id", row.id); ko++; continue; }
      const { data: src } = await db.from("yontech_maquettes").select("data,design_images").eq("id", sourceId).maybeSingle();
      const check = checkTemplate(text, (src?.data || {}) as SiteData, (src?.design_images || []) as string[]);
      if ("error" in check) { await db.from("yontech_maquette_templates").update({ status: "echec", error: check.error }).eq("id", row.id); ko++; continue; }
      await db.from("yontech_maquette_templates").update({ status: "ok", html: check.html, photos: check.photos, error: null }).eq("id", row.id);
      ok++;
    }
  }
  return { ok, echecs: ko, metiers: packs };
}

/* ---------------- Remplissage (sans IA) ---------------- */
// Version des règles de remplissage : une maquette « maison » plus ancienne est
// remplie de nouveau, avec le même modèle, par refreshMaison (cron des maquettes).
export const MAISON_VERSION = 2;

const pick = <T>(arr: T[] | undefined, seed: number) => (arr && arr.length ? arr[seed % arr.length] : undefined);
const firstSentence = (t: string, n: number) => { const m = String(t || "").match(/^.{25,}?[.!?](\s|$)/); const s = (m ? m[0] : String(t || "")).trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s; };
const clean = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Couleur d'accent de l'entreprise, seulement si elle reste lisible comme l'originale.
function lum(hex: string) { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function accentOverride(tpl: string, brand: string) {
  const orig = (tpl.match(/--yt-accent\s*:\s*(#[0-9a-f]{6})/i) || [])[1];
  if (!orig || !/^#[0-9a-f]{6}$/i.test(brand) || brand.toLowerCase() === "#1e5aa8") return "";
  return Math.abs(lum(orig) - lum(brand)) <= 0.12 ? `<style>:root{--yt-accent:${brand}}</style>` : "";
}

// Métier affiché : court, juste, et jamais « Bâtiment » pour une entreprise qui n'en est pas.
const SHORT_METIERS: Record<string, string> = {
  "41.10A": "Promotion immobilière", "41.10B": "Promotion immobilière", "41.10C": "Promotion immobilière", "41.10D": "Promotion immobilière",
  "41.20A": "Construction de maisons", "41.20B": "Construction", "42.11Z": "Travaux routiers", "42.12Z": "Voies ferrées", "42.13A": "Ouvrages d'art",
  "42.13B": "Travaux souterrains", "42.21Z": "Réseaux et canalisations", "42.22Z": "Réseaux électriques", "42.91Z": "Travaux maritimes", "42.99Z": "Génie civil",
  "43.11Z": "Démolition", "43.12A": "Terrassement", "43.12B": "Terrassement", "43.13Z": "Forage", "43.21A": "Électricité", "43.21B": "Éclairage public",
  "43.22A": "Plomberie, chauffage", "43.22B": "Chauffage, climatisation", "43.29A": "Isolation", "43.29B": "Équipements du bâtiment", "43.31Z": "Plâtrerie",
  "43.32A": "Menuiserie", "43.32B": "Serrurerie, métallerie", "43.32C": "Agencement", "43.33Z": "Sols et revêtements", "43.34Z": "Peinture, vitrerie",
  "43.39Z": "Finitions", "43.91A": "Charpente", "43.91B": "Couverture", "43.99A": "Étanchéité", "43.99B": "Structures métalliques", "43.99C": "Maçonnerie",
  "43.99D": "Travaux spécialisés", "43.99E": "Location d'engins", "71.12B": "Bureau d'études", "81.30Z": "Paysagiste",
};
const DIVISIONS: Record<string, string> = {
  "01": "Agriculture", "02": "Sylviculture", "03": "Pêche", "08": "Carrière", "10": "Agroalimentaire", "11": "Boissons", "13": "Textile", "14": "Habillement",
  "15": "Maroquinerie", "16": "Travail du bois", "17": "Papier et carton", "18": "Imprimerie", "20": "Chimie", "22": "Plasturgie", "23": "Matériaux",
  "24": "Métallurgie", "25": "Mécanique", "26": "Électronique", "27": "Équipements électriques", "28": "Machines", "29": "Automobile", "31": "Ameublement",
  "32": "Fabrication", "33": "Maintenance industrielle", "35": "Énergie", "36": "Eau", "37": "Assainissement", "38": "Recyclage", "39": "Dépollution",
  "41": "Construction", "42": "Génie civil", "43": "Bâtiment", "45": "Automobile", "46": "Commerce de gros", "47": "Commerce", "49": "Transport",
  "50": "Transport fluvial", "52": "Logistique", "53": "Livraison", "55": "Hébergement", "56": "Restauration", "58": "Édition", "59": "Audiovisuel",
  "60": "Radio", "61": "Télécommunications", "62": "Informatique", "63": "Services numériques", "64": "Finance", "65": "Assurance", "66": "Services financiers",
  "68": "Immobilier", "69": "Conseil juridique et comptable", "70": "Conseil", "71": "Architecture et ingénierie", "72": "Recherche", "73": "Communication",
  "74": "Services", "75": "Vétérinaire", "77": "Location", "78": "Recrutement", "79": "Voyages", "80": "Sécurité", "81": "Entretien", "82": "Services aux entreprises",
  "85": "Formation", "86": "Santé", "87": "Accueil médico-social", "88": "Action sociale", "90": "Spectacle", "91": "Culture", "93": "Sport et loisirs",
  "94": "Association", "95": "Réparation", "96": "Services à la personne",
};
export const isBtp = (naf: string) => /^4[123]\./.test(String(naf || "")) || Boolean(SHORT_METIERS[String(naf || "").toUpperCase()]);
export function displayMetier(naf: string, fromCopy = "") {
  const c = clean(fromCopy).replace(/[.;:]+$/, "");
  if (c && c.length <= 32 && !/^(bâtiment|entreprise|société)$/i.test(c)) return cap(c);
  const code = String(naf || "").toUpperCase();
  return SHORT_METIERS[code] || DIVISIONS[code.slice(0, 2)] || "";
}

export type Pack = { accroches?: string[]; intros?: string[]; apropos_titres?: string[]; apropos?: string[]; services?: { titre: string; texte: string }[]; atouts?: { titre: string; texte: string }[]; cta?: string };

export type CopyLite = { metier?: string; accroche?: string; intro?: string; apropos_titre?: string; apropos?: string; services?: { titre: string; texte: string }[]; atouts?: { titre: string; texte: string }[]; cta?: string };

// Rédaction des textes d'une refonte par Claude Haiku (≈ 0,1 centime par maquette) :
// longueurs bornées pour tenir dans n'importe quel modèle, aucun fait inventé.
export let lastCopyError = "";
export async function haikuCopy(d: SiteData, metier: string): Promise<CopyLite | null> {
  const apiKey = Deno.env.get("YONTECH_ANTHROPIC_API_KEY") || "";
  if (!apiKey) return null;
  const src = [`Entreprise : ${d.name}`, `Activité déclarée : ${metier || "(inconnue)"}`, `Ville : ${d.city}`, `Titre du site : ${d.tagline}`, `Introduction : ${d.intro}`,
    `Présentation : ${d.about.join(" ").slice(0, 1200)}`, `Pages et prestations du site : ${d.services.map((s) => `${s.title} — ${s.text}`).join(" | ").slice(0, 2500)}`,
    `Faits : ${(d.facts || []).map((f) => f.value + " " + f.label).join(" ; ")}`].join("\n");
  const prompt = `À partir du contenu du site d'une entreprise, rédige les textes de sa nouvelle page d'accueil, en français, ton professionnel et concret. Aucun fait inventé (ni chiffre, année, label, garantie, prix, avis). Les prestations sont de vrais travaux, produits ou services de l'entreprise (pas des pages comme « Historique », « Notre équipe », « Contact », ni des noms de villes). Le métier est l'activité réelle lue sur le site, en 1 à 3 mots (ex. « Serrurerie », « Animalerie », « Audioprothésiste », « Bureau d'études thermiques »), jamais un mot vague comme « Bâtiment » ou « Entreprise ». Orthographe irréprochable, pas d'emoji.
Réponds UNIQUEMENT par un JSON : {"metier":"1 à 3 mots","accroche":"4 à 7 mots, sans le nom","intro":"25 à 35 mots","apropos_titre":"2 à 5 mots","apropos":"40 à 60 mots","services":[3 à 6 {"titre":"2 à 4 mots","texte":"12 à 20 mots"}],"atouts":[3 {"titre":"2 à 4 mots","texte":"8 à 15 mots"}],"cta":"2 à 4 mots"}

${src}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 8000, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!r.ok) { lastCopyError = `${r.status} ${(await r.text()).slice(0, 300)}`; console.error("[Haiku]", lastCopyError); return null; }
    const out = await r.json();
    const text = String((out?.content || []).filter((b: { type?: string }) => b.type === "text").map((b: { text?: string }) => b.text || "").join(""));
    if (!text.includes("{")) { lastCopyError = `réponse vide (${out?.stop_reason}, ${(out?.content || []).map((b: { type?: string }) => b.type).join("+")})`; return null; }
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const cut = (v: unknown, n: number) => clean(v).slice(0, n);
    return {
      metier: cut(j.metier, 32), accroche: cut(j.accroche, 70), intro: cut(j.intro, 280), apropos_titre: cut(j.apropos_titre, 50), apropos: cut(j.apropos, 480), cta: cut(j.cta, 30),
      services: (Array.isArray(j.services) ? j.services : []).slice(0, 6).map((x: Record<string, unknown>) => ({ titre: cut(x.titre, 40), texte: cut(x.texte, 160) })).filter((x: { titre: string }) => x.titre),
      atouts: (Array.isArray(j.atouts) ? j.atouts : []).slice(0, 3).map((x: Record<string, unknown>) => ({ titre: cut(x.titre, 40), texte: cut(x.texte, 120) })).filter((x: { titre: string }) => x.titre),
    };
  } catch (e) { lastCopyError = (e as Error).message; console.error("[Haiku]", lastCopyError); return null; }
}

// Contexte de remplissage. Les textes types du bâtiment (pack) ne servent qu'aux
// entreprises du bâtiment ; ailleurs, seuls les textes du site ou de la rédaction.
export function buildContext(d: SiteData, kind: string, pack: Pack | null, metier: string, copy: CopyLite | null = null, btp = true) {
  const seed = hash(d.name + d.city);
  const p = btp ? pack : null;
  const sub = (t: string) => clean(t).replaceAll("{{nom}}", d.name).replaceAll("{{ville}}", d.city || "votre secteur");
  const photos: string[] = [];
  for (const u of [d.heroImage, ...(d.gallery || []), d.aboutImage, d.bandImage, ...d.services.map((s) => s.image), ...d.images]) { const x = px(u || ""); if (x && !photos.includes(x) && x !== px(d.logo)) photos.push(x); }
  const tagline = clean(d.tagline);
  // Prestations lues sur le site : de vrais intitulés (pas une année, un nombre ou une adresse de page).
  const servicesSite = d.services.filter((s) => /[A-Za-zÀ-ÿ]{3,}/.test(clean(s.title)) && !/^\W*\d[\d\s.,/-]*\W*$/.test(clean(s.title)) && !/https?:|www\./i.test(s.title)).slice(0, 6).map((s, i) => ({ titre: clean(s.title), texte: clean(s.text) ? firstSentence(s.text, 170) : sub(p?.services?.[i % (p?.services?.length || 1)]?.texte || "") })).filter((s) => s.texte);
  const services = copy?.services && copy.services.length >= 3 ? copy.services
    : kind === "refonte" && servicesSite.length >= 3 ? servicesSite
    : (p?.services || []).slice(0, 6).map((s) => ({ titre: sub(s.titre), texte: sub(s.texte) }));
  const ville = d.city || "";
  const ctx: Ctx = {
    nom: d.name, metier, ville, kicker: [metier, ville].filter(Boolean).join(" · "),
    adresse: d.address || ville, adresse_url: encodeURIComponent([d.address || "", ville, "France"].filter(Boolean).join(", ")),
    telephone: d.phone, tel: (d.phone || "").replace(/[^\d+]/g, ""), email: d.email, logo_url: d.logo ? px(d.logo) : "",
    accroche: copy?.accroche || (kind === "refonte" && tagline.length >= 12 && tagline.length <= 90 ? tagline : sub(pick(p?.accroches, seed) || [metier, ville && `à ${ville}`].filter(Boolean).join(" ") || d.name)),
    intro: copy?.intro || (kind === "refonte" && clean(d.intro).length >= 40 ? firstSentence(d.intro, 260) : sub(pick(p?.intros, seed) || "")),
    apropos_titre: copy?.apropos_titre || sub(pick(p?.apropos_titres, seed) || "L'entreprise"),
    apropos: copy?.apropos || (kind === "refonte" && clean(d.about[0]).length >= 60 ? firstSentence(d.about.join(" "), 420) : sub(pick(p?.apropos, seed) || d.about[0] || "")),
    cta: copy?.cta || p?.cta || "Prendre contact",
    services,
    atouts: copy?.atouts && copy.atouts.length ? copy.atouts : (p?.atouts || []).map((a) => ({ titre: sub(a.titre), texte: sub(a.texte) })),
    // Chiffres clés : seulement de vrais nombres, et au moins deux (un chiffre seul fait une section vide).
    chiffres: (() => { const f = (d.facts || []).filter((x) => /\d/.test(String(x.value)) && clean(x.label)).slice(0, 4); return f.length >= 2 ? f.map((x) => ({ valeur: x.value, label: x.label })) : []; })(),
    horaires: d.hours.map((h) => ({ ligne: h })),
  };
  // Pas de légende tirée des noms de fichiers (« Slide home », « FB serrurerie… ») : les légendes vides disparaissent.
  photos.slice(0, 12).forEach((u, i) => { ctx[`photo${i + 1}`] = u; ctx[`legende${i + 1}`] = ""; });
  return { ctx, photos };
}

export type MaisonTemplate = { id: string; famille?: string; groupe?: string; html: string; photos: number; uses?: number };

// Remplit un modèle (sans base de données) : utilisé par la préparation, le rafraîchissement et le banc d'essai.
export function renderMaison(tpl: MaisonTemplate, d: SiteData, kind: string, metier: string, pack: Pack | null, copy: CopyLite | null, btp: boolean) {
  const { ctx, photos } = buildContext(d, kind, pack, metier, copy, btp);
  if ((ctx.services as unknown[]).length < 3) return { error: "pas assez de prestations réelles" } as const;
  for (const key of loopsWrappingSection(String(tpl.html))) ctx[key] = [];
  for (let i = photos.length + 1; i <= 12; i++) { ctx[`photo${i}`] = ""; ctx[`legende${i}`] = ""; }
  const missing: string[] = [];
  for (const [n, sels] of photoSelectors(String(tpl.html))) if (n > Math.min(photos.length, tpl.photos)) missing.push(...sels);
  let html = renderTemplate(optionalPhotos(String(tpl.html)), ctx);
  html = html.replace(/<\/head>/i, accentOverride(String(tpl.html), d.accent) + "</head>");
  html = polishHtml(html, { name: d.name, missingPhotoSelectors: missing });
  const allowed = [ctx.logo_url as string, ...photos.slice(0, tpl.photos)].filter(Boolean);
  const out = finalizeHtml(html, d, allowed);
  if ("error" in out) return { error: out.error } as const;
  return { html: out.html, images: allowed, direction: `Modèle ${tpl.famille}${tpl.groupe ? " · " + tpl.groupe : ""}` };
}

// Modèle d'une maquette déjà faite : retrouvé par sa feuille de style (même modèle, même style).
const styleKey = (html: string) => ((String(html).match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || "")
  .replace(/url\([^)]*\)/g, "").replace(/\{\{[^}]*\}\}/g, "").replace(/--yt-accent\s*:\s*#[0-9a-f]{3,8}/gi, "").replace(/\s+/g, "").slice(0, 4000);
export function matchTemplate(html: string, templates: MaisonTemplate[]) {
  const k = styleKey(html);
  if (k.length < 200) return null;
  return templates.find((t) => styleKey(t.html) === k) || null;
}

type MaisonInfo = { v: number; modele: string; copie?: CopyLite | null; metier?: string };

// Choisit un modèle compatible (type, nombre de photos), le moins utilisé, et remplit la page.
// options.modele : garder le modèle d'une maquette existante (rafraîchissement).
export async function fillFromLibrary(db: SupabaseClient, d: SiteData & { maison?: MaisonInfo }, kind: "refonte" | "creation", naf = "", options: { modele?: string } = {}) {
  const btp = kind === "creation" || isBtp(naf);
  const groupe = groupeOf(naf);
  const nafMetier = metierOf(naf, "");
  const { data: packRow } = btp ? await db.from("yontech_metier_textes").select("metier,data").in("metier", [nafMetier || "bâtiment", "bâtiment"]).limit(2) : { data: [] };
  const pack = ((packRow || []).find((r) => r.metier === nafMetier) || (packRow || [])[0])?.data as Pack | null || null;
  // Refonte : textes rédigés par Claude Haiku si le réglage le permet (gardés pour les rafraîchissements).
  let copy: CopyLite | null = d.maison?.copie || null;
  if (kind === "refonte" && !copy) {
    const { data: st } = await db.from("yontech_prospection_settings").select("copy_ai").eq("id", 1).single();
    if (st?.copy_ai !== false) copy = await haikuCopy(d, nafMetier || displayMetier(naf));
  }
  // Hors bâtiment, les textes types ne conviennent pas : sans rédaction réussie, pas de maquette.
  if (kind === "refonte" && !btp && !copy) return null;
  const metier = displayMetier(naf, copy?.metier || "");
  let q = db.from("yontech_maquette_templates").select("id,famille,groupe,html,photos,uses").eq("status", "ok").eq("kind", kind);
  if (kind === "creation") q = q.eq("photos", 0);
  const { data: rows } = await q.limit(200);
  const all = (rows || []).filter((t) => templateUsable(String(t.html)));
  if (!all.length) return null;
  const nbPhotos = buildContext(d, kind, pack, metier, copy, btp).photos.length;
  let tpl = options.modele ? (all.find((t) => t.id === options.modele) || null) : null;
  if (!tpl) {
    const score = (t: { groupe?: string; photos: number; uses: number }) => (t.groupe === groupe ? 0 : 1000) + (t.photos <= nbPhotos ? 0 : 100) + (t.uses || 0);
    const ranked = [...all].sort((a, b) => score(a) - score(b));
    const best = ranked.filter((t) => score(t) < score(ranked[0]) + 3);
    tpl = best[Math.floor(Math.random() * best.length)];
  }
  const out = renderMaison(tpl as MaisonTemplate, d, kind, metier, pack, copy, btp);
  if ("error" in out) return null;
  if (!options.modele) await db.from("yontech_maquette_templates").update({ uses: (tpl.uses || 0) + 1 }).eq("id", tpl.id);
  d.maison = { v: MAISON_VERSION, modele: tpl.id, copie: copy, metier };
  return { html: out.html, direction: out.direction, images: out.images, modele: tpl.id };
}

// Rafraîchissement : les maquettes « maison » faites avec d'anciennes règles sont
// remplies de nouveau (même modèle, mêmes textes rédigés), quelques-unes par passage.
// Les maquettes à valider passent d'abord (« a_valider » avant « envoye »), dans un budget de temps.
export async function refreshMaison(db: SupabaseClient, limit = 8, budgetMs = 45_000) {
  const started = Date.now();
  const { data: rows } = await db.from("yontech_maquettes").select("id,kind,html,data,message_id,yontech_prospection_messages(data)")
    .eq("maison", true).eq("status", "en_ligne").or(`data->maison->v.is.null,data->maison->>v.lt.${MAISON_VERSION}`)
    .order("review", { ascending: true }).order("prepared_at", { ascending: false }).limit(limit);
  if (!rows?.length) return { refreshed: 0 };
  const { data: templates } = await db.from("yontech_maquette_templates").select("id,famille,groupe,html,photos").eq("status", "ok");
  let refreshed = 0, kept = 0;
  for (const r of rows as Record<string, any>[]) {
    if (Date.now() - started > budgetMs) break;
    const d = r.data as SiteData & { maison?: MaisonInfo };
    const kind = (r.kind || "refonte") as "refonte" | "creation";
    const naf = String(r.yontech_prospection_messages?.data?.naf || "");
    const modele = d.maison?.modele || matchTemplate(String(r.html || ""), (templates || []) as MaisonTemplate[])?.id;
    const lib = await fillFromLibrary(db, d, kind, naf, { modele });
    if (!lib) {
      // Pas de version corrigée possible (trop peu de prestations réelles) : la maquette garde sa page, marquée à jour.
      await db.from("yontech_maquettes").update({ data: { ...d, maison: { v: MAISON_VERSION, modele: modele || "", copie: d.maison?.copie || null } } }).eq("id", r.id);
      kept++; continue;
    }
    await db.from("yontech_maquettes").update({ html: lib.html, data: d, design_direction: lib.direction, design_images: lib.images, updated_at: new Date().toISOString() }).eq("id", r.id);
    refreshed++;
  }
  return { refreshed, kept };
}
