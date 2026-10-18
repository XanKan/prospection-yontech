/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { parseHTML } from "npm:linkedom@0.18.5";
import { extractEmails, htmlEscape, niceCompany, type Tracking, trackedUrl } from "./yontech-core.ts";
import { inkOf as renderInk, pickVariant, px, renderAll, type Variant } from "./yontech-maquette-render.ts";
import { type Copy, rewriteCopy } from "./yontech-maquette-ai.ts";

// Générateur de maquettes de refonte (campagne « sites », prospects qui ont
// déjà un site). Il lit le site actuel de l'entreprise (accueil, puis une page
// services et une page à propos au plus), en extrait le nom, le logo, la
// couleur principale, les textes, les services, les photos et les coordonnées,
// puis produit une page unique moderne, rapide et lisible sur téléphone.
//
// Règles : aucun fait n'est inventé (seuls les textes et photos du site actuel
// sont repris) ; la page porte un bandeau « proposition de Yontech, ce n'est
// pas le site officiel » et n'est jamais indexée (noindex).

const USER_AGENT = "Mozilla/5.0 (compatible; YontechBot/1.0; +https://yontech.fr) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const MAX_BYTES = 600_000;
const FALLBACK_ACCENT = "#1e5aa8";

export type Service = { title: string; text: string; link?: string; image?: string };
export type Block = { t: "h" | "p" | "li" | "img"; v: string };
// Une page du site refait (une entrée du menu du site actuel).
export type PageModel = { path: string; label: string; title: string; intro: string; image: string; kind: "service" | "about" | "gallery" | "page"; blocks: Block[] };
export type SiteData = {
  source: string; host: string; name: string; logo: string; eyebrow: string; tagline: string; intro: string;
  about: string[]; services: Service[]; images: string[]; phone: string; email: string; address: string;
  city: string; hours: string[]; accent: string; socials: { label: string; url: string }[];
  // Style graphique (« atelier », « chantier », « moderne ») et faits marquants relevés sur le site.
  theme?: Theme; facts?: { value: string; label: string }[];
  quality?: { ok: boolean; blocking: string[]; warnings: string[] };
  pages?: PageModel[];
  // Images réparties une seule fois chacune, code postal (carte), variante de mise en page.
  heroImage?: string; aboutImage?: string; gallery?: string[]; bandImage?: string; cp?: string; variant?: Variant;
  // Textes rédigés par l'IA à partir du site (facultatif).
  copy?: Copy | null;
  // Année de création estimée du site actuel (refonte seulement pour les sites d'avant 2024).
  siteYear?: number | null; siteYearHow?: string;
};
export type Theme = "atelier" | "chantier" | "moderne";
export const THEMES: Record<Theme, string> = { atelier: "Atelier (artisanat, bois, chaleureux)", chantier: "Chantier (BTP, énergique)", moderne: "Moderne (sobre, polyvalent)" };
export type Hints = { company?: string; metier?: string; ville?: string; email?: string; cp?: string; noAi?: boolean };
type Raw = { url: string; host: string; html: string; css: string };

/* ---------------- Téléchargement ---------------- */

async function fetchRaw(url: string, timeoutMs = 8000, maxBytes = MAX_BYTES): Promise<Raw | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    if (!response.ok || !response.body) { try { await response.body?.cancel(); } catch { /* rien */ } return null; }
    const type = response.headers.get("content-type") || "";
    if (type && !/html|xml/i.test(type)) { try { await response.body.cancel(); } catch { /* rien */ } return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); size += value.byteLength; }
    }
    try { await reader.cancel(); } catch { /* terminé */ }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    const source = new TextDecoder("utf-8", { fatal: false }).decode(all.slice(0, maxBytes));
    // Les styles servent à trouver la couleur de marque, puis sont retirés avec
    // les scripts (sauf données structurées), les SVG et les commentaires.
    const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").slice(0, 200_000) +
      "\n" + [...source.matchAll(/style=["']([^"']{0,400})["']/gi)].map((m) => m[1]).join(";\n");
    // Un espace après chaque balise de texte fermante et à la place des <br> :
    // « Le spécialiste</span><span>de la fermeture » ne doit pas donner « spécialistede ».
    const html = source.replace(/<script\b(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->|<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ").replace(/<\/(span|strong|b|em|i|a|div|p|li|h[1-6]|small|font|mark|label|td|th)>/gi, "$& ");
    const final = new URL(response.url || url);
    return { url: final.toString(), host: final.hostname.toLowerCase(), html, css };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, max = 250_000, timeoutMs = 5000) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); return ""; }
    return (await response.text()).slice(0, max);
  } catch { return ""; }
}

// Taille d'une image distante (en-tête Content-Length), sans la télécharger.
async function imageSize(url: string): Promise<number> {
  try {
    let response = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(4000) });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Range: "bytes=0-0" }, signal: AbortSignal.timeout(4000) });
      await response.body?.cancel();
      const range = response.headers.get("content-range") || "";
      const total = Number(range.split("/")[1] || 0);
      if (total) return /^image\//i.test(response.headers.get("content-type") || "image/") ? total : 0;
    }
    if (!response.ok) return 0;
    if (!/^image\//i.test(response.headers.get("content-type") || "")) return 0;
    return Number(response.headers.get("content-length") || 0) || 1;
  } catch { return 0; }
}

// Dimensions réelles d'une image : seuls les premiers octets sont lus
// (en-têtes PNG, JPEG, WebP), avec le poids total.
export async function imageInfo(url: string): Promise<{ size: number; w: number; h: number; alpha?: boolean }> {
  const none = { size: 0, w: 0, h: 0, alpha: false };
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Range: "bytes=0-65535" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); return none; }
    if (!/^image\//i.test(response.headers.get("content-type") || "")) { await response.body.cancel(); return none; }
    const range = response.headers.get("content-range") || "";
    const size = Number(range.split("/")[1] || 0) || Number(response.headers.get("content-length") || 0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < 65536) { const { done, value } = await reader.read(); if (done) break; if (value) { chunks.push(value); got += value.byteLength; } }
    try { await reader.cancel(); } catch { /* terminé */ }
    const b = new Uint8Array(Math.min(got, 65536));
    let o = 0;
    for (const c of chunks) { const part = c.subarray(0, Math.max(0, b.length - o)); b.set(part, o); o += part.length; if (o >= b.length) break; }
    let w = 0, h = 0;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      w = (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0; h = (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0;
      // Type de couleur : palette (3) ou transparence (4, 6) = pictogramme, schéma, logo — pas une photo.
      if (b[25] === 3 || b[25] === 4 || b[25] === 6) return { size, w, h, alpha: true };
    } else if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = b[i + 5] << 8 | b[i + 6]; w = b[i + 7] << 8 | b[i + 8]; break; }
        i += 2 + (b[i + 2] << 8 | b[i + 3]);
      }
    } else if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === "VP8 ") { w = (b[26] | b[27] << 8) & 0x3fff; h = (b[28] | b[29] << 8) & 0x3fff; }
      else if (kind === "VP8L") { w = 1 + (((b[22] & 0x3f) << 8) | b[21]); h = 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)); }
      else if (kind === "VP8X") { w = 1 + (b[24] | b[25] << 8 | b[26] << 16); h = 1 + (b[27] | b[28] << 8 | b[29] << 16); }
    }
    return { size, w, h, alpha: false };
  } catch { return none; }
}

// Clé d'une image indépendante de sa taille publiée : « photo-300x200.jpg »,
// « photo-scaled.jpg » et « photo.jpg?ver=2 » sont la même photo.
export function imgKey(url: string) {
  let u = String(url || "").toLowerCase().replace(/[#?].*$/, "");
  const jimdo = u.match(/\/image\/(i[0-9a-f]+)\//); if (jimdo) return "jimdo:" + jimdo[1];
  const wix = u.match(/wixstatic\.com\/media\/([^/]+)/); if (wix) return "wix:" + wix[1];
  u = u.replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]+$)/, "").replace(/-(scaled|large|medium|thumb|thumbnail|small)(?=\.[a-z]+$)/, "").replace(/@\dx(?=\.[a-z]+$)/, "").replace(/\.(jpe?g|png|webp|avif)$/, "");
  return u.replace(/^https?:\/\/(www\.)?/, "");
}

// Images à ignorer selon leur emplacement : partenaires, logos clients, avis,
// réseaux sociaux, cartes, bandeaux… ou lien vers un autre site.
const IMG_ZONE = /^(.*[_-])?(partenaires?|partners?|clients?|logos?|brands?|marques?|certif[a-z]*|labels?|avis|reviews?|testimonials?|t[ée]moignages?|social|instagram|insta|feed|widget|maps?|carte|newsletter|cookies?|popup|modal|sponsors?|awards?|troph[ée]es?|footer|sidebar|menu|nav|navbar|payment|paiement|badges?|icons?|picto[a-z]*)([_-].*)?$/i;
function inImageZone(el: Element, host: string) {
  for (let p: Element | null = el; p; p = p.parentElement) {
    const tag = p.tagName?.toLowerCase();
    if (tag === "body" || tag === "html") return false;
    if (tag === "footer" || tag === "nav" || tag === "aside") return true;
    if (tag === "a") {
      try { const h = new URL(p.getAttribute("href") || "", "https://" + host).hostname.replace(/^www\./, ""); if (h && h !== host.replace(/^www\./, "")) return true; } catch { /* lien invalide */ }
    }
    const tokens = ((p.getAttribute?.("id") || "") + " " + (p.getAttribute?.("class") || "")).split(/\s+/).filter(Boolean);
    if (tokens.some((t) => IMG_ZONE.test(t))) return true;
  }
  return false;
}

// Analyse HTML protégée : une page illisible (vide, binaire, mal formée) est
// ignorée au lieu d'interrompre toute la maquette.
function safeDoc(html: string): Doc | null {
  try {
    const doc = parseHTML(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`).document;
    return doc && doc.documentElement && doc.body ? doc : null;
  } catch { return null; }
}

// Avis clients (Google, Trustpilot…) : jamais repris comme texte de l'entreprise.
const REVIEW_RE = /publi[ée] sur google|avis google|google review|trustpilot|pages ?jaunes|\b[1-5](?:[.,]\d)?\s?\/\s?5\b|★|☆|\b\d+ (?:[ée]toiles|avis)\b|il y a \d+ (?:jours?|semaines?|mois|ans?)|\b(?:client|cliente) (?:satisfait|ravie?)|je recommande|nous recommandons vivement|merci (?:à|a) toute l'[ée]quipe/i;

/* ---------------- Outils texte ---------------- */

const clean = (value: unknown, max = 600) => String(value ?? "").replace(/\s+/g, " ").replace(/ /g, " ").trim().slice(0, max);
// Libellé sans flèches, puces ni symboles décoratifs autour (« Créer mon compte → »).
const labelOf = (value: unknown, max = 60) => clean(value, max * 2).replace(/^[\s→←↗›»>‹«<·•|+*\-–—:]+|[\s→←↗›»>‹«<·•|+*\-–—:]+$/g, "").trim().slice(0, max);
const BOILER_RE = /cookie|mentions l[ée]gales|tous droits|copyright|confidentialit|rgpd|newsletter|javascript|navigateur|cliquez|accepter|consentement|lorem ipsum|wordpress|elementor|site r[ée]alis[ée]|webmaster|plan du site|404|page introuvable/i;
const GENERIC_HEADING_RE = /^(accueil|home|menu|contact(ez[- ]nous)?|nous contacter|nos coordonn[ée]es|coordonn[ée]es|suivez[- ]nous|newsletter|horaires?|plan d'acc[eè]s|acc[eè]s|recherche|rechercher|actualit[ée]s?|blog|news|avis( clients)?|t[ée]moignages?|liens? utiles|navigation|informations?|infos? pratiques|mentions l[ée]gales|partenaires|nos partenaires|d[ée]couvrir|en savoir plus|bienvenue.*|qui sommes[- ]nous\s*\??|[àa] propos|demande de devis|devis gratuit|footer|r[ée]seaux sociaux|panier|mon compte|connexion)$/i;
const SECTION_RE = /^((nos |les )?(services|prestations|activit[ée]s|solutions|produits|offres|expertises|domaines|m[ée]tiers|savoir-faire)( \+)?|tous nos services|toutes nos prestations|voir (tous|toutes).*|retour.*|revenir.*|.*page d'accueil.*|(me|nous) contacter.*|contactez[- ]moi.*|savoir[- ]faire|professionnalisme|accompagnement|local|proximit[ée]|r[ée]activit[ée]|qualit[ée]|exp[ée]rience|expertise|confiance|engagement|garanties?|s[ée]rieux|transparence|[ée]coute|conseils?|disponibilit[ée]|efficacit[ée]|passion|valeurs|suivant|pr[ée]c[ée]dent|retour|lire la suite|voir plus|voir tout|en savoir plus|carri[eè]res?|nos m[ée]tiers|recrutement|emplois?|rejoignez[- ]nous.*|nous rejoindre|(notre|nos|l'|la|le|les)\s*(histoire|[ée]quipe|valeurs?|engagements?|entreprise|soci[ée]t[ée]|atelier|philosophie|mission|vision|chiffres?|clients?|partenaires|r[ée]f[ée]rences|r[ée]alisations|actualit[ée]s|avis)|venez nous.*|envoyez[- ]nous.*|appelez[- ]nous.*|[ée]crivez[- ]nous.*|contactez.*|trouvez[- ]nous.*|nous trouver|o[uù] nous trouver.*|demander? (un|votre) devis.*|obtenez.*devis.*|page\s?\d*|pourquoi nous choisir.*|pourquoi choisir.*|ils nous font confiance.*|faq|questions fr[ée]quentes)$/i;
// Réseaux sociaux, y compris les textes cachés des icônes (« Linkedin-in », « Facebook-f », « X-twitter »).
const SOCIAL_RE = /^(fa[bsr]?[- ])?(insta(gram)?|facebook|fb|linkedin|youtube|tiktok|twitter|x|pinterest|whatsapp|google|avis google|viadeo|snapchat|threads)([- ][a-z]{1,10})?$/i;
// Compte, recherche, langue, pages techniques : jamais des services.
const ACCOUNT_RE = /^(se connecter|connexion|login|log in|sign in|s'identifier|mon compte|mon espace|espace (client|membre|adh[ée]rent|pro|priv[ée]|abonn[ée])s?|s'inscrire|inscription|d[ée]connexion|cr[ée]er (un|mon) compte|adh[ée]rer|adh[ée]sion|panier|commander|boutique|rechercher?|search|fr|en|de|es|it|english|fran[çc]ais|menu|fermer|ouvrir|close|t[ée]l[ée]charger.*|plan du site|cgv|cgu|politique.*|cookies?|newsletter|presse|espace presse|faq|aide|support|annuaire|trouver un.*|actualit[ée]s?|agenda|[ée]v[ée]nements?|offres? d'emploi|nous rejoindre)$/i;
const NAV_SKIP_RE = /^(accueil|home|contact|nous contacter|[àa] propos|qui sommes[- ]nous|l'entreprise|entreprise|mentions|blog|actualit|news|r[ée]alisations|galerie|portfolio|photos|devis|demande de devis|plan|recrutement|emploi|espace client|faq|avis|t[ée]moignages|partenaires|tarifs?|boutique|panier|mon compte|connexion|fr|en|menu)/i;

function absolute(value: string | null | undefined, base: string) {
  const v = String(value || "").trim();
  if (!v || /^(data|javascript|mailto|tel):/i.test(v)) return "";
  try { const u = new URL(v, base); return /^https?:$/.test(u.protocol) ? u.toString() : ""; } catch { return ""; }
}

// Adresse d'image d'un élément, quel que soit le chargement différé utilisé
// (srcset, data-src, data-lazyload, data-lazyloadSrc, data-bg…).
const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
function imageAttr(el: Element) {
  const srcset = largestFromSrcset(el.getAttribute("srcset") || el.getAttribute("data-srcset"));
  if (srcset) return srcset;
  for (const a of Array.from(el.attributes || [])) {
    if (/^data-/i.test(a.name) && IMG_EXT.test(a.value) && !/\s/.test(a.value.trim())) return a.value.trim();
  }
  return el.getAttribute("src") || "";
}

function largestFromSrcset(srcset: string | null | undefined) {
  let best = "", bestW = -1;
  for (const part of String(srcset || "").split(",")) {
    const [u, d] = part.trim().split(/\s+/);
    const w = parseFloat(d || "1") * (/(x)$/.test(d || "") ? 1000 : 1);
    if (u && w > bestW) { best = u; bestW = w; }
  }
  return best;
}

function frenchPhone(raw: string) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+33")) d = "0" + d.slice(3);
  if (d.startsWith("0033")) d = "0" + d.slice(4);
  d = d.replace(/^0+(?=0)/, "");
  if (!/^0[1-9]\d{8}$/.test(d)) return "";
  return d.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

function sentence(text: string, max = 220) {
  // Puces et tirets collés des listes mises à plat : « terrasse:-Étanchéité•Toitures » → « terrasse : Étanchéité, Toitures ».
  const t = clean(String(text ?? "").replace(/\s*:\s*-\s*/g, " : ").replace(/\s*[•▪►✓✔·]\s*/g, ", ").replace(/(^|[.:!?]\s*),\s*/g, "$1").replace(/,\s*,/g, ","), 2000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" ! "), cut.lastIndexOf(" ? "));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

// « TOITURE ACCESSIBLE » → « Toiture accessible » (titres saisis en capitales).
function sentenceCase(text: string) {
  const t = clean(text, 200);
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, ""), upper = t.replace(/[^A-ZÀ-Ý]/g, "");
  // Tout en capitales, ou presque (« ACTIOn FACADE ») : remis en casse de phrase.
  if (!t || !letters || upper.length / letters.length < 0.6 || letters.length < 4) return t;
  const lower = t.toLowerCase();
  return lower[0].toUpperCase() + lower.slice(1);
}

function titleCase(text: string) {
  const t = clean(text, 120);
  if (/^[A-Z0-9&]{2,5}$/.test(t)) return t;
  if (!t || t !== t.toUpperCase()) return t;
  return niceCompany(t) || t;
}

/* ---------------- Couleur de marque ---------------- */

function hexToRgb(hex: string) {
  let h = hex.replace("#", "").toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (rgb: number[]) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function hsl([r, g, b]: number[]) {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}
function luminance([r, g, b]: number[]) {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
// Palette par défaut de WordPress et de son administration : présente sur tous
// les sites WordPress, elle ne dit rien de la marque.
const DEFAULT_PALETTE = new Set(["#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#00d084", "#8ed1fc", "#0693e3", "#9b51e0", "#f78da7", "#abb8c3", "#0073aa", "#00a0d2", "#2271b1", "#135e96", "#72aee6", "#d63638", "#00a32a", "#dba617", "#3858e9", "#007cba", "#006ba1", "#1e73be", "#e2401c", "#f0821e",
  // Thèmes (Divi, Elementor, Avada) et couleurs des réseaux sociaux (icônes).
  "#2ea3f2", "#6ec1e4", "#61ce70", "#54595f", "#65bc7b", "#3b5998", "#1877f2", "#4267b2", "#00f2ea", "#ff0050", "#e1306c", "#c13584", "#833ab4", "#fd1d1d", "#f56040", "#fcaf45", "#0077b5", "#0a66c2", "#ff0000", "#1da1f2", "#25d366", "#128c7e", "#bd081c", "#ea4335", "#4285f4", "#34a853", "#fbbc05", "#00b67a", "#00aced", "#cb2027", "#dd4b39", "#e4405f", "#ff4500", "#7289da", "#5865f2", "#00acee"]);
const usable = (rgb: number[] | null) => { if (!rgb) return false; if (DEFAULT_PALETTE.has(toHex(rgb))) return false; const { s, l } = hsl(rgb); return s >= 0.3 && l >= 0.18 && l <= 0.72; };

export function pickAccent(css: string, themeColor = "") {
  const theme = hexToRgb(themeColor.trim());
  if (usable(theme)) return toHex(theme!);
  // Variables de marque déclarées par le thème (Elementor, WordPress, Divi…).
  for (const m of css.matchAll(/--(?:e-global-color-(?:primary|accent|secondary)|wp--preset--color--(?:primary|accent|secondary)|(?:color-)?(?:primary|accent|brand|main|theme)(?:-color)?)\s*:\s*(#[0-9a-f]{3,6})\b/gi)) {
    const rgb = hexToRgb(m[1]);
    if (usable(rgb)) return toHex(rgb!);
  }
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const rgb = hexToRgb(m[1]);
    if (!usable(rgb)) continue;
    const k = toHex(rgb!);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!usable(rgb)) continue;
    const k = toHex(rgb);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : FALLBACK_ACCENT;
}

// Version de la couleur assez foncée pour porter un texte blanc (boutons).
function inkOf(accent: string) {
  let rgb = hexToRgb(accent) || hexToRgb(FALLBACK_ACCENT)!;
  for (let i = 0; i < 12 && (1.05) / (luminance(rgb) + 0.05) < 4.2; i++) rgb = rgb.map((v) => v * 0.86);
  return toHex(rgb);
}

/* ---------------- Extraction ---------------- */

type Doc = ReturnType<typeof parseHTML>["document"];
// Conteneurs de navigation, pied de page, bandeaux : leurs textes ne sont pas
// du contenu. Le test porte sur chaque classe et identifiant, du titre jusqu'au
// <body> exclu (les classes du <body>, du type « et_no_sidebar », ne comptent pas).
const SKIP_TOKEN = /^(.*[_-])?(header|footer|nav|navbar|navigation|menu|sidebar|cookies?|cmplz|widgets?|breadcrumbs?|modal|popup|newsletter|copyright|topbar)([_-].*)?$/i;

function inChrome(el: Element) {
  for (let p: Element | null = el; p; p = p.parentElement) {
    const tag = p.tagName?.toLowerCase();
    if (tag === "body" || tag === "html") return false;
    if (tag === "nav" || tag === "footer" || tag === "header" || tag === "aside" || tag === "form") return true;
    const tokens = ((p.getAttribute?.("id") || "") + " " + (p.getAttribute?.("class") || "")).split(/\s+/).filter(Boolean);
    if (tokens.some((t) => SKIP_TOKEN.test(t))) return true;
  }
  return false;
}

function ldItems(doc: Doc) {
  const out: Record<string, unknown>[] = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const v = JSON.parse(s.textContent || "");
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") { out.push(x as Record<string, unknown>); if ((x as Record<string, unknown>)["@graph"]) walk((x as Record<string, unknown>)["@graph"]); }
      };
      walk(v);
    } catch { /* JSON invalide */ }
  }
  return out;
}

function sectionText(heading: Element) {
  const parts: string[] = [];
  let el = heading.nextElementSibling, steps = 0;
  while (el && steps < 6 && !/^H[1-3]$/.test(el.tagName)) {
    const t = clean(el.textContent, 600);
    if (t && !BOILER_RE.test(t)) parts.push(t);
    el = el.nextElementSibling; steps++;
    if (parts.join(" ").length > 260) break;
  }
  if (!parts.length && heading.parentElement) {
    const t = clean(heading.parentElement.textContent, 700).replace(clean(heading.textContent), "").trim();
    if (t.length > 30 && !BOILER_RE.test(t)) parts.push(t);
  }
  return sentence(parts.join(" "), 230);
}

function collect(doc: Doc, raw: Raw) {
  const base = raw.url;
  const meta = (sel: string) => clean(doc.querySelector(sel)?.getAttribute("content"), 400);
  const ld = ldItems(doc);
  const org = ld.find((x) => /Organization|LocalBusiness|Store|Contractor|Service|Company|HomeAndConstruction|Electrician|Plumber|Roofing|Restaurant|Shop/i.test(String(x["@type"] || ""))) || {};

  const headings: { level: number; title: string; text: string }[] = [];
  for (const h of [...doc.querySelectorAll("h1,h2,h3")].slice(0, 120)) {
    if (inChrome(h)) continue;
    const title = clean(h.textContent, 120);
    if (title.length < 3 || BOILER_RE.test(title)) continue;
    headings.push({ level: Number(h.tagName[1]), title, text: sectionText(h) });
  }
  const paragraphs: string[] = [];
  for (const p of [...doc.querySelectorAll("p, .elementor-text-editor, .et_pb_text_inner")].slice(0, 250)) {
    if (inChrome(p)) continue;
    const t = clean(p.textContent, 900);
    if (t.length >= 70 && !BOILER_RE.test(t) && !REVIEW_RE.test(t) && !paragraphs.includes(t)) paragraphs.push(t);
  }
  const navItems: string[] = [];
  for (const a of doc.querySelectorAll("nav a, header a, .menu a")) {
    const t = labelOf(a.textContent, 60);
    if (t.length >= 3 && t.length <= 40 && !NAV_SKIP_RE.test(t) && !SOCIAL_RE.test(t) && !SECTION_RE.test(t) && !ACCOUNT_RE.test(t) && !navItems.includes(t)) navItems.push(t);
  }

  const images: { url: string; w: number; logo: boolean; header: boolean }[] = [];
  const pushImg = (u: string, w: number, logo: boolean, header: boolean) => {
    const url = absolute(u, base);
    if (!url || images.some((i) => i.url === url)) return;
    images.push({ url, w, logo, header });
  };
  const lazyEls = [...doc.querySelectorAll("[data-lazyload],[data-bg],[data-background],[data-background-image],[data-image],[data-img],[data-lazy],[data-src],[data-original]")].filter((el) => el.tagName !== "IMG" && el.tagName !== "SOURCE");
  for (const img of [...doc.querySelectorAll("img, source"), ...lazyEls].slice(0, 180)) {
    const src = imageAttr(img);
    const hint = [src, img.getAttribute("alt"), img.getAttribute("class"), img.getAttribute("id"), img.parentElement?.getAttribute("class")].join(" ");
    const w = Number(img.getAttribute("width") || 0);
    const isLogo = /logo/i.test(hint), inHeader = !!img.closest?.("header, .header, #header, .site-header, .elementor-location-header");
    if (!isLogo && inImageZone(img, raw.host)) continue;
    pushImg(src, w, isLogo, inHeader);
  }
  for (const m of raw.html.matchAll(/background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) pushImg(m[1], 0, false, false);
  const og = absolute(meta('meta[property="og:image"]'), base);
  // Image préchargée par le site (rel=preload as=image) : sa photo d'accroche.
  const preload = [...doc.querySelectorAll('link[rel="preload"][as="image"]')].map((l) => absolute(l.getAttribute("href"), base)).filter((u) => u && IMG_EXT.test(u));

  const tels = [...doc.querySelectorAll('a[href^="tel:"]')].map((a) => frenchPhone(a.getAttribute("href") || "")).filter(Boolean);
  const bodyText = clean(doc.body?.textContent, 60_000);
  const socials: { label: string; url: string }[] = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/https?:\/\/(?:[a-z]+\.)?(facebook|instagram|linkedin|youtube|tiktok)\.com\/[^\s"']+/i);
    if (!m || /sharer|share\?|intent|plugins/i.test(href)) continue;
    const label = ({ facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok" } as Record<string, string>)[m[1].toLowerCase()];
    if (label && !socials.some((s) => s.label === label)) socials.push({ label, url: href });
  }
  const stylesheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => absolute(l.getAttribute("href"), base))
    .filter((u) => u && new URL(u).hostname.replace(/^www\./, "") === raw.host.replace(/^www\./, "") && !/bootstrap|font-?awesome|fontawesome|wp-block-library|dashicons|jquery|slick|swiper|animate|icons?\.css|fonts?\.googleapis/i.test(u));
  const links = [...doc.querySelectorAll("a[href]")].map((a) => ({ url: absolute(a.getAttribute("href"), base), text: clean(a.textContent, 60) }))
    .filter((l) => l.url && new URL(l.url).hostname.replace(/^www\./, "") === raw.host.replace(/^www\./, ""));

  return {
    title: clean(doc.querySelector("title")?.textContent, 200),
    siteName: meta('meta[property="og:site_name"]'),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    themeColor: meta('meta[name="theme-color"]'),
    org, headings, paragraphs, navItems, images, og, preload, tels, bodyText, socials, stylesheets, links,
    mailtos: [...doc.querySelectorAll('a[href^="mailto:"]')].map((a) => clean((a.getAttribute("href") || "").slice(7).split("?")[0], 120).toLowerCase()),
  };
}

function ldAddress(org: Record<string, unknown>) {
  const a = (Array.isArray(org.address) ? org.address[0] : org.address) as Record<string, unknown> | string | undefined;
  if (!a) return { address: "", city: "" };
  if (typeof a === "string") return { address: clean(a, 200), city: "" };
  const street = clean(a.streetAddress, 120), cp = clean(a.postalCode, 10), city = clean(a.addressLocality, 60);
  return { address: [street, [cp, city].filter(Boolean).join(" ")].filter(Boolean).join(", "), city };
}

function ldHours(org: Record<string, unknown>) {
  const days: Record<string, string> = { Mo: "Lundi", Tu: "Mardi", We: "Mercredi", Th: "Jeudi", Fr: "Vendredi", Sa: "Samedi", Su: "Dimanche" };
  const out: string[] = [];
  const oh = org.openingHours;
  for (const h of (Array.isArray(oh) ? oh : oh ? [oh] : []) as string[]) {
    out.push(clean(String(h).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, (d) => days[d] || d).replace(/-/g, " – "), 80));
  }
  return out.slice(0, 4);
}

const compact = (v: string) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function pickName(c: ReturnType<typeof collect>, hints: Hints, host: string) {
  const hostLabel = compact(host.replace(/^www\./, "").split(".")[0]);
  const hintWords = clean(hints.company, 80).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(sarl|sas|sasu|eurl|ets|societe|entreprise)$/.test(w));
  const titleParts = c.title.split(/\s+[|\-–—·:»]\s+/).map((p) => clean(p, 80));
  const candidates = [clean((c.org as Record<string, unknown>).name, 80), c.siteName, ...titleParts]
    .filter((p) => p && p.length <= 60 && !/^(accueil|home|bienvenue|page d'accueil)/i.test(p));
  // Le bon nom ressemble au nom de domaine ou à la raison sociale.
  const score = (p: string) => {
    const k = compact(p);
    let sc = 0;
    if (hostLabel && (k === hostLabel || k.includes(hostLabel) || (k.length >= 4 && hostLabel.includes(k)))) sc += 30;
    sc += hintWords.filter((w) => k.includes(w)).length * 12;
    return sc - p.length / 30;
  };
  const best = candidates.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s)[0];
  if (best && best.s > 0) return titleCase(best.p);
  if (hints.company) return titleCase(hints.company);
  if (candidates[0] && candidates[0].split(/\s+/).length <= 3) return titleCase(candidates[0]);
  return host.replace(/^www\./, "").split(".")[0].replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

function pickAddress(text: string) {
  const m = text.match(/\b(\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|chemin|route|place|all[ée]e|impasse|quai|cours|zone|za|zi|zac|lieu[- ]dit|parc|rond[- ]point|voie|chauss[ée]e)\b[^\d]{2,70}?\b\d{5}\s+[A-ZÀ-Ýa-zà-ÿ'][A-ZÀ-Ýa-zà-ÿ' -]{1,38})/i);
  if (!m) return { address: "", city: "" };
  const address = clean(m[1], 160).replace(/\s+(T[ée]l|Tel|Phone|Email|Mail|Horaires?|Du lundi|Lundi|Ouvert)\b.*$/i, "");
  // Ville : mots en majuscule initiale (et liaisons « sur », « en », « de »…) après le code postal.
  const cm = address.match(/\b(\d{5})\s+((?:[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]*)(?:[\s-]+(?:(?:sur|sous|en|de|du|des|la|le|les|lès|lez|aux|au|et|d'|l')[\s-]+)*[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]*)*)/);
  // La ville s'arrête avant les mots d'interface collés à l'adresse (« Appelez-nous », « Tél »…).
  const city = cm ? cm[2].split(/\s+(?=(?:Appelez|Appeler|T[ée]l|Tel|Phone|Contact|Contactez|Horaires?|Ouvert|Du|Lundi|E-?mail|Mail|Nous|Suivez|Devis|Accueil|France|Fax|Mob|Port|SIRET|Siret|RCS|Facebook|Linked[Ii]n|Instagram|Insta|Twitter|X|Youtube|YouTube|TikTok|Pinterest|Google|Plan|Itin[ée]raire|Voir|Mentions|Copyright|Tous|©)\b)/)[0] : "";
  const trimmed = cm ? address.slice(0, address.indexOf(cm[0])) + cm[1] + " " + city : address;
  return { address: trimmed, city: titleCase(city) };
}

function pickHours(text: string) {
  const out: string[] = [];
  for (const m of text.matchAll(/((?:du\s+)?(?:lundi|mardi|mercredi|jeudi|vendredi|samedi)[^.;|]{0,40}?\d{1,2}\s?[h:]\s?\d{0,2}[^.;|]{0,40}?\d{1,2}\s?[h:]\s?\d{0,2})/gi)) {
    const t = clean(m[1], 90);
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t[0].toUpperCase() + t.slice(1));
    if (out.length >= 3) break;
  }
  return out;
}

// Faits marquants, uniquement s'ils sont écrits sur le site : ancienneté,
// années d'expérience, effectif, qualifications.
export function pickFacts(text: string) {
  const out: { value: string; label: string }[] = [];
  const t = String(text || "");
  const since = t.match(/\b(?:depuis|cr[ée]{1,2}e?\s+en|fond[ée]e?\s+en)\s+((?:19[2-9]|20[0-2])\d)\b/i);
  if (since) out.push({ value: since[1], label: "Année de création" });
  const years = t.match(/\b(plus de\s+)?(\d{1,3})\s+ans\s+d['’]\s?exp[ée]rience/i);
  if (years && Number(years[2]) >= 3 && Number(years[2]) <= 60) out.push({ value: (years[1] ? "+" : "") + years[2] + " ans", label: "d'expérience" });
  const team = t.match(/\b(\d{1,4})\s+(salari[ée]s|collaborateurs|compagnons|techniciens|artisans|personnes)\b/i);
  if (team && !/^0/.test(team[1]) && Number(team[1]) >= 2 && Number(team[1]) < 5000) out.push({ value: team[1], label: team[2].toLowerCase() });
  const done = t.match(/\b(plus de\s+)?(\d{2,5}|\d{1,3}(?:[\s.]\d{3}))\s+(chantiers|r[ée]alisations|projets|clients|interventions)\b/i);
  // Compteurs animés laissés à leur valeur d'exemple (99, 999) : ignorés.
  if (done && !/^9+$|^0/.test(done[2].replace(/[\s.]/g, ""))) out.push({ value: (done[1] ? "+" : "") + done[2].replace(/[\s.]/g, " "), label: done[3].toLowerCase() });
  const labels = [...new Set([...t.matchAll(/\b(RGE|Qualibat|QualiPAC|QualiPV|QualiSol|QualiBois|Qualifelec|Handibat|Meilleur Ouvrier de France|Garantie d[ée]cennale|Artisan d['’]art|Entreprise du Patrimoine Vivant)\b/gi)].map((m) => m[1]))];
  for (const l of labels.slice(0, 2)) out.push({ value: l.replace(/^garantie d[ée]cennale$/i, "Décennale").replace(/^rge$/i, "RGE"), label: /garantie/i.test(l) ? "garantie" : "qualification" });
  return out.slice(0, 4);
}

export function pickTheme(text: string): Theme {
  // Le style qui compte le plus de mots du métier l'emporte (à égalité : chantier).
  const t = String(text || "").toLowerCase();
  const count = (re: RegExp) => (t.match(re) || []).length;
  const atelier = count(/menuis|[ée]b[ée]nist|\bbois\b|atelier|charpent|parquet|escalier|boulang|p[âa]tiss|fleur|tapiss|cuisine|agencement|ferronn|forge|vitrail|c[ée]ramique|poterie|restaurat|artisan d'art/g);
  const chantier = count(/ma[çc]on|gros[- ]?[œo]e?uvre|terrassement|btp|construction|toiture|\btoit|[ée]tanch|couverture|couvreur|fa[çc]ade|bardage|ravalement|d[ée]molition|vrd|travaux|[ée]lectric|plomb|chauff|clim|solaire|photovolta|pompe [àa] chaleur|serrur|fermeture|isolation|carrel|pl[âa]tr|peintur|b[ée]ton|enrob|assainiss|piscine|maintenance immobili/g);
  if (!atelier && !chantier) return "moderne";
  return atelier > chantier ? "atelier" : "chantier";
}

/* ---------------- Pages du site ---------------- */

const SKIP_PAGE_RE = /g[ée]rer|cookie|consent|tarteaucitron|axeptio|mention|legal|l[ée]gales|cgv|cgu|conditions|politique|confidentialit|cookie|rgpd|plan-du-site|sitemap|login|connexion|compte|panier|cart|checkout|wp-admin|wp-login|feed|\/tag\/|\/category\/|\/categorie\/|\/author\/|\/page\/\d|\/20\d\d\/\d\d\/|\?(p|page_id|s)=|\/(en|de|es|it|nl)\/|\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)(\?|$)/i;

// Entrées du menu qui mènent à une page du même site, dans l'ordre du menu.
function menuLinks(doc: Doc, raw: Raw) {
  const host = raw.host.replace(/^www\./, "");
  const home = raw.url.replace(/[#?].*$/, "").replace(/\/$/, "");
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>([home]);
  const anchors = [...doc.querySelectorAll("header nav a, nav a, header a, .menu a, #menu a, .navbar a, [class*=menu] a")];
  for (const a of anchors) {
    const url = absolute(a.getAttribute("href"), raw.url).replace(/#.*$/, "");
    if (!url) continue;
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    if (u.hostname.replace(/^www\./, "") !== host || SKIP_PAGE_RE.test(u.pathname + u.search)) continue;
    const norm = (u.origin + u.pathname).replace(/\/$/, "");
    if (seen.has(norm) || norm === home) continue;
    const label = labelOf(a.textContent, 60);
    if (!label || label.length < 2 || !/[a-zà-ÿ]{3}/i.test(label) || SOCIAL_RE.test(label) || ACCOUNT_RE.test(label) || /^(accueil|home)$/i.test(label) || /g[ée]rer|cookie|consentement|param[eè]tres/i.test(label)) continue;
    seen.add(norm);
    out.push({ url: norm, label });
  }
  return out;
}

const IMG_SKIP = /logo|icon|favicon|sprite|pixel|avatar|gravatar|emoji|flag|drapeau|badge|payment|paiement|visa|mastercard|loader|spinner|placeholder|blank|arrow|fleche|picto|qualibat|label|certif|partenaire|\.svg|\.gif|google|facebook|instagram|linkedin|youtube|tripadvisor|pagesjaunes|laur[ée]at|troph[ée]e|award|r[ée]seau[-_]entreprendre|prix[-_]|medaille|m[ée]daille|banner-ad|pub[-_]/i;

// Contenu d'une page dans l'ordre de lecture : titres, paragraphes, listes,
// images (hors menu, en-tête, pied de page et bandeaux).
function contentBlocks(doc: Doc, base: string) {
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const el of [...doc.querySelectorAll("h1,h2,h3,h4,p,li,img")].slice(0, 400)) {
    if (blocks.length >= 60 || chars > 7000) break;
    if (inChrome(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      if (inImageZone(el, new URL(base).hostname)) continue;
      const src = absolute(imageAttr(el), base);
      const w = Number(el.getAttribute("width") || 0);
      if (!src || seen.has(src) || IMG_SKIP.test(src + " " + (el.getAttribute("alt") || "") + " " + (el.getAttribute("class") || "")) || (w && w < 300)) continue;
      seen.add(src); blocks.push({ t: "img", v: src });
      continue;
    }
    if (tag === "li" && el.querySelector("p,li")) continue;
    const text = clean(el.textContent, 900);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || BOILER_RE.test(text) || REVIEW_RE.test(text)) continue;
    if (tag[0] === "h") {
      if (text.length < 3 || text.length > 110 || SOCIAL_RE.test(text) || ACCOUNT_RE.test(text)) continue;
      seen.add(key); blocks.push({ t: "h", v: sentenceCase(text) }); chars += text.length;
    } else if (tag === "li") {
      if (text.length < 4 || text.length > 260 || SOCIAL_RE.test(text) || ACCOUNT_RE.test(text)) continue;
      seen.add(key); blocks.push({ t: "li", v: text }); chars += text.length;
    } else {
      if (text.length < 25) continue;
      seen.add(key); blocks.push({ t: "p", v: sentence(text, 900) }); chars += text.length;
    }
  }
  // Pas de titre orphelin en fin de page.
  while (blocks.length && blocks[blocks.length - 1].t === "h") blocks.pop();
  return blocks;
}

// Nettoyage du contenu d'une page : fils d'Ariane, slogans en capitales,
// titres de blocs non repris (sommaire, avis, labels, marques…), titres vides,
// et introduction déjà affichée en tête de page.
const JUNK_HEADING_RE = /^(sommaire|table des mati[eè]res|(nos |vos |les )?(t[ée]moignages?|avis( clients)?)|(nos )?labels?( et certifications)?|(nos )?certifications?|nos marques.*|(nos )?partenaires|newsletter|suivez[- ]nous.*|r[ée]seaux sociaux|ils nous font confiance.*|faq|questions fr[ée]quentes|en savoir plus|lire la suite|articles? (r[ée]cents?|similaires)|partager.*)$/i;
function tidyBlocks(blocks: Block[], intro: string) {
  let out = blocks.filter((b) => {
    if (b.t === "p" && (/^(accueil|home)\s*[|»>›\/]/i.test(b.v) || (b.v.match(/\s[|»›]\s/g) || []).length >= 2)) return false;
    if (b.t === "p" && b.v.length < 70 && b.v === b.v.toUpperCase() && /[A-Z]/.test(b.v)) return false;
    if (b.t === "h" && JUNK_HEADING_RE.test(b.v.replace(/[.:!]+$/, ""))) return false;
    return true;
  });
  if (intro) {
    const i = out.findIndex((b) => b.t === "p");
    if (i >= 0 && compact(out[i].v).startsWith(compact(intro).slice(0, 60))) out.splice(i, 1);
  }
  // Un titre suivi d'un autre titre (ou de rien) n'a pas de contenu : retiré.
  out = out.filter((b, i) => b.t !== "h" || (out[i + 1] && out[i + 1].t !== "h"));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/* ---------------- Assemblage ---------------- */

export async function buildSite(url: string, hints: Hints = {}): Promise<{ data: SiteData; html: string; pages: { path: string; html: string }[] } | { error: string }> {
  let start = String(url || "").trim();
  if (!/^https?:\/\//i.test(start)) start = "https://" + start.replace(/^\/+/, "");
  const home = await fetchRaw(start) || (start.startsWith("https://") ? await fetchRaw(start.replace("https://", "http://")) : null);
  if (!home) return { error: "Le site ne répond pas ou n'est pas une page HTML." };
  const doc = safeDoc(home.html);
  if (!doc) return { error: "La page d'accueil du site actuel est illisible." };
  const c = collect(doc, home);

  // Toutes les pages du menu du site actuel (huit au plus), plus une page
  // services et une page à propos si le menu ne les contient pas.
  const SERVICES_RE = /prestation|services?|savoir-faire|activit|nos-metiers|expertise|competence/i, ABOUT_RE = /propos|qui-sommes|about|entreprise|histoire|presentation|soci[ée]t[ée]/i;
  const GALLERY_RE = /r[ée]alisation|galerie|gallery|portfolio|photos|chantiers|projets|r[ée]f[ée]rences/i, CONTACT_RE = /contact|devis|nous-trouver|acc[eè]s|nous-joindre|rendez-vous/i;
  const menu = menuLinks(doc, home);
  const pick = (re: RegExp) => c.links.find((l) => re.test(l.url + " " + l.text) && l.url.replace(/\/$/, "") !== home.url.replace(/\/$/, "") && !SKIP_PAGE_RE.test(l.url));
  for (const re of [SERVICES_RE, ABOUT_RE]) {
    const l = pick(re);
    const label = labelOf(l?.text, 60);
    if (!l || !label || /g[ée]rer|cookie|consent|param[eè]tres/i.test(label) || SOCIAL_RE.test(label) || ACCOUNT_RE.test(label)) continue;
    const norm = l.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (norm !== home.url.replace(/[#?].*$/, "").replace(/\/$/, "") && !menu.some((m) => m.url === norm)) menu.push({ url: norm, label });
  }
  // Six pages au plus : au-delà, la lecture dépasse la capacité de calcul d'une exécution.
  const crawl = menu.slice(0, 6);
  const fetched = await mapLimit(crawl, 4, (l) => fetchRaw(l.url, 6000, 350_000));
  const subs = crawl.map((link, i) => ({ link, raw: fetched[i] })).filter((x) => x.raw).flatMap((x) => {
    const sdoc = safeDoc(x.raw!.html);
    if (!sdoc) return [];
    try { return [{ link: x.link, raw: x.raw!, c: collect(sdoc, x.raw!), blocks: contentBlocks(sdoc, x.raw!.url) }]; } catch { return []; }
  });
  const extras = subs.map((x) => x.raw);
  const extraCollected = subs.map((x) => x.c);
  const svcC = subs.find((x) => SERVICES_RE.test(x.link.url + " " + x.link.label))?.c;
  const aboutC = subs.find((x) => ABOUT_RE.test(x.link.url + " " + x.link.label))?.c;

  if (/coming soon|en construction|under construction|bient[oô]t (en ligne|disponible)|site en maintenance|maintenance mode|domain (is )?for sale|nom de domaine.{0,30}(vente|disponible)|parked/i.test(c.title + " " + c.headings.slice(0, 3).map((h) => h.title).join(" ")) ||
    (c.headings.length + c.paragraphs.length < 2 && c.bodyText.length < 400)) {
    return { error: "Le site actuel est une page d'attente ou presque vide : rien à reprendre pour une refonte." };
  }
  const name = pickName(c, hints, home.host);
  const lowerName = name.toLowerCase();

  // Services : titres de sections (accueil puis page services), sinon entrées du menu.
  const services: Service[] = [];
  const seen = new Set<string>();
  const addService = (title: string, text: string) => {
    const key = title.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, "");
    // Un service est un intitulé court (« Volets roulants »), pas une phrase, une
    // question, un bout de phrase ni un titre qui répète le nom de l'entreprise.
    const words = title.split(/\s+/).length;
    // Actions et rubriques du menu (devis, contact, recrutement, documents…) : jamais des prestations.
    if (/carri[eè]re|recrut|emploi|candidat|espace (client|pro|membre|partenaire)|\bstage\b|alternance|devis|contact|rendez-vous|rdv|t[ée]l[ée]charg|brochure|catalogue|documentation|plan d'acc[eè]s|mentions|actualit|blog|galerie|r[ée]alisations|photos|vid[ée]os?|avis|t[ée]moignage|faq|tarifs?|prix/i.test(title)) return;
    if (words > 7 || /\?/.test(title) || /,/.test(title) || /^[a-zà-ÿ]/.test(title) || /^(je|nous|vous|on|notre|nos|votre|vos|un|une|des|besoin|pourquoi|comment|quand|d[ée]couvrez|contactez|appelez|demandez|profitez|bienvenue|rencontrons|parlons|faites|confiez|offrez|donnez|imaginons|construisons|r[ée]alisons|cr[ée]ons)\b/i.test(title) ||
      (compact(lowerName).length >= 4 && compact(title).includes(compact(lowerName)))) return;
    if (!key || seen.has(key) || GENERIC_HEADING_RE.test(title) || SECTION_RE.test(title) || SOCIAL_RE.test(title) || ACCOUNT_RE.test(title) || /^[\d\s.+()-]{6,}$/.test(title) || /@|https?:|www\./i.test(title) || title.toLowerCase() === lowerName || title.length > 70 || /[?!]$/.test(title) && title.length > 50) return;
    seen.add(key);
    services.push({ title: sentenceCase(title.replace(/[.:]+$/, "")), text: sentenceCase(text) });
  };
  for (const h of [...(svcC?.headings || []), ...c.headings].filter((h) => h.level >= 2)) {
    if (services.length >= 6) break;
    if (h.text.length >= 25) addService(h.title, h.text);
  }
  // Entrées du menu en dernier recours, seulement s'il y en a au moins trois de crédibles.
  if (services.length < 3) {
    const fromMenu = c.navItems.filter((t) => t.split(/\s+/).length <= 5);
    if (services.length + fromMenu.length >= 3) for (const t of fromMenu) { if (services.length >= 6) break; addService(t, ""); }
  }

  // Suffixe commun répété pour le référencement (« … Charleville-Mézières ») : retiré.
  if (services.length >= 2) {
    const tails = services.map((x) => x.title.split(/\s+/));
    for (let n = 3; n >= 1; n--) {
      const tail = (w: string[]) => w.length > n ? w.slice(-n).join(" ").toLowerCase() : "";
      const counts = new Map<string, number>();
      tails.forEach((w) => { const t = tail(w); if (t) counts.set(t, (counts.get(t) || 0) + 1); });
      const common = [...counts.entries()].find(([t, k]) => k >= 2 && !/^(de|des|du|et|la|le|les)$/.test(t));
      if (common) {
        services.forEach((x, i) => { if (tail(tails[i]) === common[0]) x.title = tails[i].slice(0, -n).join(" ").replace(/\s+(à|a|sur|en|dans|de|du|-|–)$/i, ""); });
        break;
      }
    }
  }

  // Textes : présentation et à propos, sans répéter ceux des services.
  const used = new Set(services.map((s) => s.text));
  const allParagraphs = [...(aboutC?.paragraphs || []), ...c.paragraphs, ...(svcC?.paragraphs || [])].filter((p) => !used.has(sentence(p, 230)));
  const scoreAbout = (p: string) => (/\b(nous|notre|nos|depuis|cr[ée]{1,2}e?|fond[ée]e?|entreprise|[ée]quipe|exp[ée]rience|ann[ée]es|famil|savoir-faire|passion|qualit)/i.test(p) ? 10 : 0) + Math.min(p.length, 400) / 100;
  const isContactLine = (t: string) => /@|(\+33|0)[1-9]([ .-]?\d{2}){4}/.test(t) && t.length < 200;
  const about = [...new Set(allParagraphs)].filter((p) => !isContactLine(p)).sort((a, b) => scoreAbout(b) - scoreAbout(a)).slice(0, 2).map((p) => sentence(p, 420));

  const h1 = c.headings.find((h) => h.level === 1 && h.title.length >= 8 && h.title.length <= 90 && h.title.toLowerCase() !== lowerName && !/^bienvenue/i.test(h.title) && /^[A-ZÀ-Ý0-9«"]/.test(h.title) && h.title.split(/\s+/).length >= 2)?.title || "";
  const titleRest = c.title.split(/\s+[|\-–—·:»]\s+/).map((p) => clean(p, 90)).find((p) => p.length >= 12 && !p.toLowerCase().includes(lowerName) && !/^(accueil|home|bienvenue)/i.test(p) && /^[A-ZÀ-Ý0-9«"]/.test(p) && !/en cours de|en construction|maintenance|bient[oô]t/i.test(p)) || "";
  // Une description qui n'est qu'une adresse ou des coordonnées ne sert pas d'introduction.
  const contactLike = (t: string) => /@|\b\d{5}\b.*\b\d{2}[ .]?\d{2}[ .]?\d{2}|(\+33|0)[1-9]([ .-]?\d{2}){4}/.test(t);
  const intro = sentence(c.description && c.description.length >= 40 && !contactLike(c.description) ? c.description : (about[0] || allParagraphs.find((x) => !contactLike(x)) || ""), 220);

  const ldAddr = ldAddress(c.org as Record<string, unknown>);
  const textAll = [c.bodyText, ...extraCollected.map((x) => x.bodyText)].join(" ");
  const found = ldAddr.address ? ldAddr : pickAddress(textAll);
  const city = titleCase(found.city || ldAddr.city || hints.ville || "");
  if (found.address && found.city === "" && hints.ville) found.address = found.address;
  const welcome = (t: string) => clean(t, 400).replace(/^bienvenue\s+(chez|sur le site d[eu']|à|au|aux|dans)\s*[^,.!:–—-]{2,60}[,.!:–—-]\s*/i, "");
  const clause = (t: string) => { const first = welcome(t).split(/(?<=[.!?;])\s|\s[–—]\s/)[0].replace(/[.;]$/, "").trim(); return first.length >= 15 && first.length <= 85 ? first[0].toUpperCase() + first.slice(1) : ""; };
  // « Maçonnerie générale à Charleville | SARL Decq » : la partie qui répète le nom est retirée.
  const dropName = (t: string) => t.split(/\s+[|–—·-]\s+/).filter((p) => p && !(compact(p).includes(compact(name)) && p.length <= name.length + 12)).join(" – ") || t;
  const tagline = sentenceCase(dropName(h1 || (titleRest && titleRest.length <= 80 ? titleRest : "") || clause(c.description) || clause(intro) || name));
  // Le libellé SIRENE (« travaux de construction spécialisés ») n'est jamais affiché : trop administratif.
  let activity = titleRest && titleRest.length <= 60 ? titleRest : "";
  if (compact(activity) === compact(tagline)) activity = "";
  const eyebrow = [activity ? activity[0].toUpperCase() + activity.slice(1) : "", city && !compact(activity).includes(compact(city)) ? city : ""].filter(Boolean).join(" · ");

  const phone = c.tels[0] || frenchPhone(clean((c.org as Record<string, unknown>).telephone, 40)) ||
    frenchPhone((textAll.match(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/) || [""])[0]);
  const ownDomain = home.host.replace(/^www\./, "");
  const emails = extractEmails([home.html, ...extras.map((x) => x.html)].join(" "), ownDomain);
  const email = clean((c.org as Record<string, unknown>).email, 120).replace(/^mailto:/i, "").toLowerCase() || c.mailtos.find((m) => /@/.test(m)) || emails[0]?.email || clean(hints.email, 120);
  const hours = ldHours(c.org as Record<string, unknown>).length ? ldHours(c.org as Record<string, unknown>) : pickHours(textAll);

  // Couleur : variables et styles de la page, puis feuilles de style du site.
  let css = home.css;
  // Feuilles de style propres au site (Elementor en premier) : couleur de marque
  // et images de fond des sections, souvent les plus belles photos du site.
  const sheets = [...c.stylesheets].sort((x, y) => Number(/elementor\/css\/post-\d+/.test(y)) - Number(/elementor\/css\/post-\d+/.test(x))).slice(0, 3);
  const sheetTexts = await Promise.all(sheets.map((u) => fetchText(u)));
  for (const t of sheetTexts) css += "\n" + t;
  const cssImages: string[] = [];
  sheetTexts.forEach((t, i) => { for (const m of t.matchAll(/background(?:-image)?\s*:[^;}]*?url\(\s*['"]?([^'")]+\.(?:jpe?g|png|webp|avif)[^'")]*)['"]?\s*\)/gi)) { const u = absolute(m[1], sheets[i]); if (u && !cssImages.includes(u)) cssImages.push(u); } });
  const accent = pickAccent(css, c.themeColor);

  // Logo et photos (photos vérifiées : vraies images, assez lourdes).
  const ldLogo = (c.org as Record<string, unknown>).logo;
  const logoLd = absolute(typeof ldLogo === "string" ? ldLogo : (ldLogo as Record<string, unknown> | undefined)?.url as string, home.url);
  // Pas de favicon ni d'icône d'application : trop petits, souvent blancs.
  const LOGO_SKIP = /favicon|apple-touch|site-icon|\/icon[-_.]|[-_]icon\.|cropped-[^/]*-(32|150|180|192|270|512)x/i;
  let logo = [logoLd, c.images.find((i) => i.logo && i.header)?.url, c.images.find((i) => i.logo)?.url].find((u) => u && !LOGO_SKIP.test(u)) || "";
  // Photos de toutes les pages : dimensions réelles lues, doublons écartés.
  const isPng = (u: string) => /\.png(\?|$)|format=png/i.test(u);
  const homeImgs = c.images.filter((i) => !i.logo && (!i.w || i.w >= 300)).map((i) => i.url);
  const pageImgs = subs.flatMap((x) => x.blocks.filter((b) => b.t === "img").map((b) => b.v));
  let candidates = [...c.preload, ...(c.og ? [c.og] : []), ...homeImgs, ...cssImages.slice(0, 12), ...pageImgs].filter((u) => u && !IMG_SKIP.test(u) && u !== logo);
  { const seenK = new Set<string>(); candidates = candidates.filter((u) => { const k = imgKey(u); if (seenK.has(k)) return false; seenK.add(k); return true; }).slice(0, 40); }
  const infos = await mapLimit(candidates, 8, (u) => imageInfo(u));
  const measured = candidates.map((u, i) => ({ u, ...infos[i] }));
  // Sans logo déclaré, un petit PNG en tête de page sert de logo.
  if (!logo) {
    const first = measured.slice(0, 4).find((x) => isPng(x.u) && x.size > 0 && x.size < 150_000 && (!x.w || x.w <= 700));
    if (first) logo = first.u;
  }
  // Une photo : assez grande, ni bandeau ni bande verticale, assez lourde ; un PNG léger est un visuel graphique.
  const isPhoto = (x: { u: string; size: number; w: number; h: number; alpha?: boolean }) => x.u !== logo && !x.alpha && (x.w
    ? x.w >= 480 && x.h >= 300 && x.w / x.h >= 0.65 && x.w / x.h <= 2.4 && (!x.size || x.size >= 15_000) && !(isPng(x.u) && x.size > 0 && x.size < 120_000)
    : x.size >= 60_000 && !isPng(x.u));
  const sig = new Set<string>();
  const photos = measured.filter(isPhoto).filter((x) => { if (!x.w || !x.size) return true; const k = `${x.w}x${x.h}:${x.size}`; if (sig.has(k)) return false; sig.add(k); return true; });
  const accepted = new Set(photos.map((x) => x.u));
  // Chaque photo ne sert qu'une fois sur tout le site.
  const usedImg = new Set<string>();
  const take = (u?: string) => { if (u) usedImg.add(u); return u || ""; };
  const free = (u: string) => accepted.has(u) && !usedImg.has(u);
  const heroScore = (x: { u: string; size: number; w: number; h: number }) => (x.w ? Math.min(x.w, 2200) * Math.min(x.h, 1400) : x.size * 4) * (x.w && x.w / x.h >= 1.2 ? 1.6 : 1) * (c.preload.includes(x.u) ? 2 : homeImgs.includes(x.u) || x.u === c.og ? 1.3 : 1) * (isPng(x.u) ? 0.5 : 1);
  const heroImage = take([...photos].sort((a, b) => heroScore(b) - heroScore(a))[0]?.u);
  const serviceImage = new Map<string, string>();

  // Paragraphes répétés d'une page à l'autre (bandeau commun du site) : jamais
  // utilisés comme description propre d'une page ou d'une prestation.
  const pCount = new Map<string, number>();
  for (const p of [...c.paragraphs, ...subs.flatMap((x) => x.blocks.filter((b) => b.t === "p").map((b) => b.v))]) pCount.set(compact(p).slice(0, 120), (pCount.get(compact(p).slice(0, 120)) || 0) + 1);
  const ownParagraph = (blocks: Block[]) => blocks.find((b) => b.t === "p" && b.v.length >= 60 && (pCount.get(compact(b.v).slice(0, 120)) || 0) <= 1)?.v || "";

  // Une page par entrée du menu qui a du contenu (sauf contact, repris partout).
  const pages: PageModel[] = [];
  const usedPaths = new Set<string>(["contact"]);
  for (const x of subs) {
    const where = x.link.url + " " + x.link.label;
    if (CONTACT_RE.test(where) && !GALLERY_RE.test(where)) continue;
    const isGallery = GALLERY_RE.test(where);
    // Photos de la page elle-même, pas encore utilisées : la première en tête,
    // deux au plus dans le texte (toutes pour une page réalisations).
    const own = x.blocks.filter((b) => b.t === "img" && free(b.v)).map((b) => b.v);
    const bodyImgs = new Set(isGallery ? own.slice(0, 12) : own.slice(1, 3));
    const blocks = x.blocks.filter((b) => b.t !== "img" || bodyImgs.has(b.v));
    const textLen = blocks.filter((b) => b.t !== "img").reduce((n, b) => n + b.v.length, 0);
    const imgs = isGallery ? [...bodyImgs] : own.slice(0, 1);
    // Recrutement, avis, qualité, actualités, page d'ensemble des prestations : des pages, pas des services.
    const notService = /recrut|emploi|carri[eè]re|rejoindre|avis|t[ée]moignage|qse|qualit[ée]|s[ée]curit[ée]-environnement|actualit|blog|news|partenaire|faq|presse|^(les |nos )?(prestations|services|activit[ée]s|m[ée]tiers|savoir-faire)$/i.test(clean(x.link.label, 60)) || /recrut|emploi|avis|temoignage|actualit|blog|faq/i.test(x.link.url);
    const kind: PageModel["kind"] = GALLERY_RE.test(where) ? "gallery" : ABOUT_RE.test(where) ? "about" : !notService && x.link.label.split(/\s+/).length <= 5 ? "service" : "page";
    if (kind === "gallery" ? imgs.length < 2 : textLen < 220) continue;
    // Libellé du menu, sauf s'il est tronqué (« Notre », « Nos ») : alors le titre de la page.
    const rawLabel = labelOf(x.link.label, 40);
    const h1Short = clean(x.c.headings.find((h) => h.level === 1)?.title || x.c.headings[0]?.title || "", 40);
    const label = sentenceCase(/^(notre|nos|nous|le|la|les|l'|mon|ma|mes|plus|autres?)$/i.test(rawLabel) || rawLabel.length < 3 ? h1Short : rawLabel);
    if (!label || !/[a-zà-ÿ]{3}/i.test(label)) continue;
    // Adresse lisible tirée du libellé (« La société » → /la-societe).
    let path = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " et ").replace(/['’]/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "page";
    for (let k = 2; usedPaths.has(path); k++) path = `${path.replace(/-\d+$/, "")}-${k}`;
    usedPaths.add(path);
    const h1 = x.c.headings.find((h) => h.level === 1)?.title || "";
    const title = sentenceCase(dropName(h1 && h1.length <= 90 && compact(h1) !== compact(name) ? h1 : label));
    const intro = sentence(ownParagraph(blocks), 220);
    const pageHero = isGallery ? "" : own[0] || "";
    take(pageHero); bodyImgs.forEach((u) => take(u));
    // Carte du service sur l'accueil : une autre photo de la page si possible.
    if (own[3] && free(own[3])) serviceImage.set("/" + path, take(own[3])); else if (pageHero) serviceImage.set("/" + path, pageHero);
    pages.push({ path: "/" + path, label, title, intro, image: pageHero, kind, blocks: tidyBlocks(blocks.filter((b) => !(b.t === "h" && compact(b.v) === compact(title))), intro).slice(0, 50) });
    if (pages.length >= 7) break;
  }
  // Les pages de prestations deviennent les services de l'accueil, avec un lien.
  const servicePages = pages.filter((x) => x.kind === "service");
  if (servicePages.length >= 2) {
    services.splice(0, services.length, ...servicePages.slice(0, 6).map((x) => ({ title: x.label, text: x.intro, link: x.path, image: serviceImage.get(x.path) || "" })));
  }
  // Entreprise, galerie, bandeau : photos restantes, jamais déjà utilisées.
  const aboutSub = subs.find((x) => ABOUT_RE.test(x.link.url + " " + x.link.label));
  const aboutImage = take([...(aboutSub ? aboutSub.blocks.filter((b) => b.t === "img").map((b) => b.v) : []), ...homeImgs, ...photos.map((p) => p.u)].find(free));
  const gallery: string[] = [];
  for (const u of photos.map((p) => p.u)) { if (gallery.length >= 6) break; if (free(u)) gallery.push(take(u)); }
  const bandImage = take(photos.map((p) => p.u).find(free));
  const images = photos.map((p) => p.u).slice(0, 24);
  const cp = (found.address.match(/\b\d{5}\b/) || [])[0] || clean(hints.cp, 5);

  const data: SiteData = {
    source: home.url, host: ownDomain, name, logo, eyebrow, tagline, intro, about, services: services.slice(0, 6), images,
    phone, email, address: found.address, city, hours, accent, socials: c.socials.slice(0, 4),
    facts: pickFacts(textAll), theme: pickTheme([name, tagline, intro, ...services.map((x) => x.title), hints.metier || ""].join(" ")),
    pages, heroImage, aboutImage, gallery: gallery.length >= 3 ? gallery : [], bandImage, cp, variant: pickVariant(ownDomain + name),
  };
  const created = siteCreationYear([home.html, ...extras.map((x) => x.html)], images);
  data.siteYear = created?.year ?? null; data.siteYearHow = created?.how || "";
  data.quality = assessQuality(data, hints.company || "");
  // Rédaction par IA (si la clé est configurée et la maquette retenue) : textes courts et structurés.
  const aiKey = hints.noAi ? "" : Deno.env.get("YONTECH_ANTHROPIC_API_KEY") || "";
  if (aiKey && data.quality.ok) {
    const fileName = (u: string) => decodeURIComponent(u.split("?")[0].split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").slice(0, 80);
    data.copy = await rewriteCopy(aiKey, data, {
      paragraphs: allParagraphs,
      pages: pages.map((pg) => ({ label: pg.label, blocks: pg.blocks })),
      imageNames: (data.gallery || []).map(fileName),
    });
  }
  const all = renderAll(data);
  return { data, html: all.home, pages: all.pages };
}

/* ---------------- Rendu ---------------- */

const SLUG_STOP = /\b(sarl|sas|sasu|eurl|sa|snc|sci|scop|ei|eirl|selarl|ets|etablissements?|entreprise|societe|soci[ée]t[ée]|groupe|the|le|la|les|l|et|de|du|des)\b/g;
export const RESERVED_SLUGS = new Set(["www", "prospection", "mail", "webmail", "smtp", "imap", "pop", "ftp", "autodiscover", "autoconfig", "api", "app", "admin", "go", "cdn", "static", "dev", "test", "staging", "blog", "shop", "support", "aide", "contact", "yontech", "piloz", "netozia", "querax", "verif-maquette", "maquette", "maquettes", "sebalyo", "img"]);
export function slugify(name: string) {
  const base = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " et ").replace(/['’]/g, " ")
    .replace(SLUG_STOP, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return base.length >= 2 ? base : "site-" + crypto.randomUUID().slice(0, 6);
}

// Trois styles : polices, fonds, arrondis. La couleur vient toujours de la marque.
// Rendu : voir yontech-maquette-render.ts (variantes de mise en page).
export { IMG_PROXY, pickVariant, px, renderAll, renderSite, type Variant } from "./yontech-maquette-render.ts";

// Aperçu de la maquette dans l'e-mail : barre de navigateur avec l'adresse,
// photo d'accroche, bandeau à la couleur de l'entreprise avec son logo et un
// bouton. Tableaux et styles en ligne (Outlook, Gmail, Apple Mail).
export function maquetteMailBlock(d: SiteData, url: string) {
  return (tracking?: Tracking) => {
    const e = htmlEscape;
    const href = e(trackedUrl(url, tracking));
    const accent = /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : FALLBACK_ACCENT;
    const ink = inkOf(accent);
    const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const hero = px(d.heroImage || d.images[0] || "");
    const logo = px(d.logo || "");
    const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:6px 0 20px;border:1px solid #e3e4ec;border-radius:14px;border-collapse:separate;overflow:hidden">` +
      `<tr><td style="background:#f1f2f6;padding:9px 14px;border-bottom:1px solid #e3e4ec;font:12px Arial,Helvetica,sans-serif;color:#8a8ca0"><span style="color:#ff5f57">&#9679;</span> <span style="color:#febc2e">&#9679;</span> <span style="color:#28c840">&#9679;</span>&nbsp;&nbsp;<a href="${href}" style="color:#5b5d72;text-decoration:none">${e(host)}</a></td></tr>` +
      (hero ? `<tr><td style="padding:0;line-height:0"><a href="${href}"><img src="${e(hero)}" width="560" alt="Aperçu du nouveau site de ${e(d.name)}" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : "") +
      `<tr><td style="background:${ink};padding:22px 24px">` +
      (logo ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr><td style="background:#ffffff;border-radius:8px;padding:6px 10px"><img src="${e(logo)}" height="30" alt="${e(d.name)}" style="display:block;height:30px;width:auto;max-width:180px;border:0"></td></tr></table>` : "") +
      `<div style="font:bold 21px/1.25 Arial,Helvetica,sans-serif;color:#ffffff">${e(d.tagline)}</div>` +
      `<div style="font:14px/1.5 Arial,Helvetica,sans-serif;color:#e8e9f0;margin-top:6px">${e([d.name, d.city].filter(Boolean).join(" · "))}</div>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr><td style="background:#ffffff;border-radius:999px"><a href="${href}" style="display:inline-block;padding:12px 22px;font:bold 15px Arial,Helvetica,sans-serif;color:${ink};text-decoration:none">Voir votre nouveau site &rarr;</a></td></tr></table>` +
      `</td></tr></table>`;
    return { html, text: `Votre nouveau site : ${url}` };
  };
}

// Contrôle qualité d'une maquette avant de la proposer : les défauts
// bloquants l'écartent d'office, les autres sont signalés à la validation.
const NOT_A_COMPANY_RE = /\b(ordre (des|national)|chambre (de|des|r[ée]gionale|d[ée]partementale)|syndicat|f[ée]d[ée]ration|conf[ée]d[ée]ration|union (nationale|r[ée]gionale|d[ée]partementale)|conseil (national|r[ée]gional|d[ée]partemental)|association|fondation|minist[eè]re|mairie|commune de|communaut[ée] (de communes|d'agglom)|d[ée]partement d[eu]|r[ée]gion |pr[ée]fecture|universit[ée]|lyc[ée]e|coll[eè]ge|[ée]cole|ccas|cci|cma|urssaf|p[ôo]le emploi|france travail|non-diffusible)\b/i;
// Année de création estimée d'un site : la plus ancienne date des dossiers
// d'images (/uploads/AAAA/MM/, WordPress et autres), sinon l'année de départ
// du copyright (« © 2019 – 2026 »), ou une année seule si elle n'est pas
// l'année en cours (souvent affichée automatiquement, donc pas une preuve).
export const RECENT_SITE_YEAR = 2024;
export function siteCreationYear(htmls: string[], urls: string[], now = new Date()): { year: number; how: string } | null {
  const cur = now.getFullYear();
  const blob = htmls.join(" ") + " " + urls.join(" ");
  const uploads = [...blob.matchAll(/\/uploads\/((?:19|20)\d{2})\/(?:0[1-9]|1[0-2])\//g)].map((m) => Number(m[1])).filter((y) => y >= 2005 && y <= cur);
  if (uploads.length >= 2) return { year: Math.min(...uploads), how: "dates des images" };
  for (const m of blob.matchAll(/(?:©|&copy;|&#169;|copyright)\s*((?:19|20)\d{2})\s*(?:[-–]\s*((?:19|20)\d{2}))?/gi)) {
    const start = Number(m[1]);
    if (start < 1995 || start > cur) continue;
    if (m[2] || start < cur) return { year: start, how: "copyright" };
  }
  return null;
}

export function assessQuality(d: SiteData, company = "") {
  const blocking: string[] = [], warnings: string[] = [];
  // Site créé récemment : pas de refonte proposée (l'entreprise vient d'investir).
  if (d.siteYear && d.siteYear >= RECENT_SITE_YEAR) blocking.push(`site récent (créé en ${d.siteYear}, d'après les ${d.siteYearHow || "indices du site"})`);
  if (NOT_A_COMPANY_RE.test(`${company} ${d.name}`)) blocking.push("organisme, pas une entreprise à démarcher");
  if (!d.images.length) blocking.push("aucune photo exploitable");
  if (!d.phone && !d.email) blocking.push("ni téléphone ni e-mail sur le site");
  if (d.services.length < 2 && !d.about.length) blocking.push("trop peu de contenu à reprendre");
  if (!d.tagline || d.tagline.length < 8) blocking.push("pas de titre exploitable");
  if (!d.logo) warnings.push("pas de logo (initiales affichées)");
  if (d.images.length < 3) warnings.push("peu de photos");
  if (d.services.length && !d.services.some((x) => x.text)) warnings.push("services sans description");
  if (!d.about.length) warnings.push("pas de texte de présentation");
  if (!d.phone) warnings.push("pas de téléphone");
  if (!d.address && !d.city) warnings.push("pas d'adresse");
  if (d.tagline.length > 90) warnings.push("titre long");
  return { ok: blocking.length === 0, blocking, warnings };
}
