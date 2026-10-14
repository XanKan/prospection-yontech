/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { parseHTML } from "npm:linkedom@0.18.5";
import { extractEmails, htmlEscape, niceCompany, type Tracking, trackedUrl } from "./yontech-core.ts";

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

export type Service = { title: string; text: string; link?: string };
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
};
export type Theme = "atelier" | "chantier" | "moderne";
export const THEMES: Record<Theme, string> = { atelier: "Atelier (artisanat, bois, chaleureux)", chantier: "Chantier (BTP, énergique)", moderne: "Moderne (sobre, polyvalent)" };
export type Hints = { company?: string; metier?: string; ville?: string; email?: string };
type Raw = { url: string; host: string; html: string; css: string };

/* ---------------- Téléchargement ---------------- */

async function fetchRaw(url: string, timeoutMs = 8000): Promise<Raw | null> {
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
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); size += value.byteLength; }
    }
    try { await reader.cancel(); } catch { /* terminé */ }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    const source = new TextDecoder("utf-8", { fatal: false }).decode(all.slice(0, MAX_BYTES));
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

/* ---------------- Outils texte ---------------- */

const clean = (value: unknown, max = 600) => String(value ?? "").replace(/\s+/g, " ").replace(/ /g, " ").trim().slice(0, max);
const BOILER_RE = /cookie|mentions l[ée]gales|tous droits|copyright|confidentialit|rgpd|newsletter|javascript|navigateur|cliquez|accepter|consentement|lorem ipsum|wordpress|elementor|site r[ée]alis[ée]|webmaster|plan du site|404|page introuvable/i;
const GENERIC_HEADING_RE = /^(accueil|home|menu|contact(ez[- ]nous)?|nous contacter|nos coordonn[ée]es|coordonn[ée]es|suivez[- ]nous|newsletter|horaires?|plan d'acc[eè]s|acc[eè]s|recherche|rechercher|actualit[ée]s?|blog|news|avis( clients)?|t[ée]moignages?|liens? utiles|navigation|informations?|infos? pratiques|mentions l[ée]gales|partenaires|nos partenaires|d[ée]couvrir|en savoir plus|bienvenue.*|qui sommes[- ]nous\s*\??|[àa] propos|demande de devis|devis gratuit|footer|r[ée]seaux sociaux|panier|mon compte|connexion)$/i;
const SECTION_RE = /^(retour.*|revenir.*|.*page d'accueil.*|(me|nous) contacter.*|contactez[- ]moi.*|savoir[- ]faire|professionnalisme|accompagnement|local|proximit[ée]|r[ée]activit[ée]|qualit[ée]|exp[ée]rience|expertise|confiance|engagement|garanties?|s[ée]rieux|transparence|[ée]coute|conseils?|disponibilit[ée]|efficacit[ée]|passion|valeurs|suivant|pr[ée]c[ée]dent|retour|lire la suite|voir plus|voir tout|en savoir plus|carri[eè]res?|nos m[ée]tiers|recrutement|emplois?|rejoignez[- ]nous.*|nous rejoindre|(notre|nos|l'|la|le|les)\s*(histoire|[ée]quipe|valeurs?|engagements?|entreprise|soci[ée]t[ée]|atelier|philosophie|mission|vision|chiffres?|clients?|partenaires|r[ée]f[ée]rences|r[ée]alisations|actualit[ée]s|avis)|venez nous.*|envoyez[- ]nous.*|appelez[- ]nous.*|[ée]crivez[- ]nous.*|contactez.*|trouvez[- ]nous.*|nous trouver|o[uù] nous trouver.*|demander? (un|votre) devis.*|obtenez.*devis.*|page\s?\d*|pourquoi nous choisir.*|pourquoi choisir.*|ils nous font confiance.*|faq|questions fr[ée]quentes)$/i;
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
  for (const h of doc.querySelectorAll("h1,h2,h3")) {
    if (inChrome(h)) continue;
    const title = clean(h.textContent, 120);
    if (title.length < 3 || BOILER_RE.test(title)) continue;
    headings.push({ level: Number(h.tagName[1]), title, text: sectionText(h) });
  }
  const paragraphs: string[] = [];
  for (const p of doc.querySelectorAll("p, .elementor-text-editor, .et_pb_text_inner")) {
    if (inChrome(p)) continue;
    const t = clean(p.textContent, 900);
    if (t.length >= 70 && !BOILER_RE.test(t) && !paragraphs.includes(t)) paragraphs.push(t);
  }
  const navItems: string[] = [];
  for (const a of doc.querySelectorAll("nav a, header a, .menu a")) {
    const t = clean(a.textContent, 60);
    if (t.length >= 3 && t.length <= 40 && !NAV_SKIP_RE.test(t) && !SOCIAL_RE.test(t) && !SECTION_RE.test(t) && !ACCOUNT_RE.test(t) && !navItems.includes(t)) navItems.push(t);
  }

  const images: { url: string; w: number; logo: boolean; header: boolean }[] = [];
  const pushImg = (u: string, w: number, logo: boolean, header: boolean) => {
    const url = absolute(u, base);
    if (!url || images.some((i) => i.url === url)) return;
    images.push({ url, w, logo, header });
  };
  for (const img of doc.querySelectorAll("img, source")) {
    const src = largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")) || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
    const hint = [src, img.getAttribute("alt"), img.getAttribute("class"), img.getAttribute("id"), img.parentElement?.getAttribute("class")].join(" ");
    const w = Number(img.getAttribute("width") || 0);
    pushImg(src, w, /logo/i.test(hint), !!img.closest?.("header, .header, #header, .site-header, .elementor-location-header"));
  }
  for (const m of raw.html.matchAll(/background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) pushImg(m[1], 0, false, false);
  const og = absolute(meta('meta[property="og:image"]'), base);

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
    org, headings, paragraphs, navItems, images, og, tels, bodyText, socials, stylesheets, links,
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
  const city = cm ? cm[2] : "";
  const trimmed = cm ? address.slice(0, address.indexOf(cm[0]) + cm[0].length) : address;
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
  if (team && Number(team[1]) >= 2 && Number(team[1]) < 5000) out.push({ value: team[1], label: team[2].toLowerCase() });
  const done = t.match(/\b(plus de\s+)?(\d{2,5}|\d{1,3}(?:[\s.]\d{3}))\s+(chantiers|r[ée]alisations|projets|clients|interventions)\b/i);
  // Compteurs animés laissés à leur valeur d'exemple (99, 999) : ignorés.
  if (done && !/^9+$/.test(done[2].replace(/[\s.]/g, ""))) out.push({ value: (done[1] ? "+" : "") + done[2].replace(/[\s.]/g, " "), label: done[3].toLowerCase() });
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
    const label = clean(a.textContent, 60);
    if (!label || label.length < 2 || !/[a-zà-ÿ]{3}/i.test(label) || SOCIAL_RE.test(label) || ACCOUNT_RE.test(label) || /^(accueil|home)$/i.test(label) || /g[ée]rer|cookie|consentement|param[eè]tres/i.test(label)) continue;
    seen.add(norm);
    out.push({ url: norm, label });
  }
  return out;
}

const IMG_SKIP = /logo|icon|favicon|sprite|pixel|avatar|gravatar|emoji|flag|drapeau|badge|payment|paiement|visa|mastercard|loader|spinner|placeholder|blank|arrow|fleche|picto|qualibat|label|certif|partenaire|\.svg|\.gif|google|facebook|instagram|linkedin|youtube|tripadvisor|pagesjaunes|laur[ée]at|troph[ée]e|award|r[ée]seau[-_]entreprendre|prix[-_]|medaille|m[ée]daille|banniere|banner-ad/i;

// Contenu d'une page dans l'ordre de lecture : titres, paragraphes, listes,
// images (hors menu, en-tête, pied de page et bandeaux).
function contentBlocks(doc: Doc, base: string) {
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const el of doc.querySelectorAll("h1,h2,h3,h4,p,li,img")) {
    if (blocks.length >= 60 || chars > 7000) break;
    if (inChrome(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const src = absolute(largestFromSrcset(el.getAttribute("srcset") || el.getAttribute("data-srcset")) || el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || el.getAttribute("src") || "", base);
      const w = Number(el.getAttribute("width") || 0);
      if (!src || seen.has(src) || IMG_SKIP.test(src + " " + (el.getAttribute("alt") || "") + " " + (el.getAttribute("class") || "")) || (w && w < 300)) continue;
      seen.add(src); blocks.push({ t: "img", v: src });
      continue;
    }
    if (tag === "li" && el.querySelector("p,li")) continue;
    const text = clean(el.textContent, 900);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || BOILER_RE.test(text)) continue;
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
  const doc = parseHTML(home.html).document;
  const c = collect(doc, home);

  // Toutes les pages du menu du site actuel (huit au plus), plus une page
  // services et une page à propos si le menu ne les contient pas.
  const SERVICES_RE = /prestation|services?|savoir-faire|activit|nos-metiers|expertise|competence/i, ABOUT_RE = /propos|qui-sommes|about|entreprise|histoire|presentation|soci[ée]t[ée]/i;
  const GALLERY_RE = /r[ée]alisation|galerie|gallery|portfolio|photos|chantiers|projets|r[ée]f[ée]rences/i, CONTACT_RE = /contact|devis|nous-trouver|acc[eè]s|nous-joindre|rendez-vous/i;
  const menu = menuLinks(doc, home);
  const pick = (re: RegExp) => c.links.find((l) => re.test(l.url + " " + l.text) && l.url.replace(/\/$/, "") !== home.url.replace(/\/$/, "") && !SKIP_PAGE_RE.test(l.url));
  for (const re of [SERVICES_RE, ABOUT_RE]) {
    const l = pick(re);
    const label = clean(l?.text, 60);
    if (!l || !label || /g[ée]rer|cookie|consent|param[eè]tres/i.test(label) || SOCIAL_RE.test(label) || ACCOUNT_RE.test(label)) continue;
    const norm = l.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (norm !== home.url.replace(/[#?].*$/, "").replace(/\/$/, "") && !menu.some((m) => m.url === norm)) menu.push({ url: norm, label });
  }
  const crawl = menu.slice(0, 8);
  const fetched = await mapLimit(crawl, 4, (l) => fetchRaw(l.url, 6000));
  const subs = crawl.map((link, i) => ({ link, raw: fetched[i] })).filter((x) => x.raw).map((x) => {
    const sdoc = parseHTML(x.raw!.html).document;
    return { link: x.link, raw: x.raw!, c: collect(sdoc, x.raw!), blocks: contentBlocks(sdoc, x.raw!.url) };
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
  if (!c.themeColor) for (const sheet of c.stylesheets.slice(0, 3)) css += "\n" + await fetchText(sheet);
  const accent = pickAccent(css, c.themeColor);

  // Logo et photos (photos vérifiées : vraies images, assez lourdes).
  const ldLogo = (c.org as Record<string, unknown>).logo;
  const logoLd = absolute(typeof ldLogo === "string" ? ldLogo : (ldLogo as Record<string, unknown> | undefined)?.url as string, home.url);
  // Pas de favicon ni d'icône d'application : trop petits, souvent blancs.
  const LOGO_SKIP = /favicon|apple-touch|site-icon|\/icon[-_.]|[-_]icon\.|cropped-[^/]*-(32|150|180|192|270|512)x/i;
  let logo = [logoLd, c.images.find((i) => i.logo && i.header)?.url, c.images.find((i) => i.logo)?.url].find((u) => u && !LOGO_SKIP.test(u)) || "";
  // Photos de toutes les pages : accueil d'abord, puis une à trois par page.
  const pageImgs = subs.flatMap((x) => x.blocks.filter((b) => b.t === "img").slice(0, 3).map((b) => b.v));
  const candidates = [...c.images.filter((i) => !i.logo && (!i.w || i.w >= 300)).map((i) => i.url), ...pageImgs, ...extraCollected.flatMap((x) => x.images.filter((i) => !i.logo && (!i.w || i.w >= 300)).map((i) => i.url))]
    .filter((u) => !IMG_SKIP.test(u) && u !== logo)
    .filter((u, i, a) => a.indexOf(u) === i).slice(0, 26);
  if (c.og && !IMG_SKIP.test(c.og) && c.og !== logo && !candidates.includes(c.og)) candidates.unshift(c.og);
  const sizes = await Promise.all(candidates.map((u) => imageSize(u)));
  // Les PNG sont le plus souvent des logos, badges ou visuels graphiques : sans
  // logo déclaré, un petit PNG en tête de page sert de logo ; sinon les PNG
  // ne passent qu'après les photos (JPEG, WebP).
  const isPng = (u: string) => /\.png(\?|$)|format=png/i.test(u);
  const measured = candidates.map((u, i) => ({ u, s: sizes[i] }));
  if (!logo) {
    const first = measured.slice(0, 3).find((x) => isPng(x.u) && x.s > 1 && x.s < 150_000);
    if (first) logo = first.u;
  }
  const photos = measured.filter((x) => x.u !== logo && (x.s === 1 || x.s >= 30_000));
  const real = photos.filter((x) => !isPng(x.u)), graphic = photos.filter((x) => isPng(x.u));
  const hero = [...real].sort((a, b) => b.s - a.s)[0]?.u || [...graphic].sort((a, b) => b.s - a.s)[0]?.u || "";
  const ordered = [...real, ...(real.length >= 4 ? [] : graphic.filter((x) => x.s >= 150_000))].map((x) => x.u);
  const images = [hero, ...ordered.filter((u) => u !== hero)].filter(Boolean).slice(0, 18);
  const goodImages = new Set(photos.map((x) => x.u));

  // Une page par entrée du menu qui a du contenu (sauf contact, repris partout).
  const pages: PageModel[] = [];
  const usedPaths = new Set<string>(["contact"]);
  for (const x of subs) {
    const where = x.link.url + " " + x.link.label;
    if (CONTACT_RE.test(where) && !GALLERY_RE.test(where)) continue;
    const blocks = x.blocks.filter((b) => b.t !== "img" || goodImages.has(b.v));
    const textLen = blocks.filter((b) => b.t !== "img").reduce((n, b) => n + b.v.length, 0);
    const imgs = blocks.filter((b) => b.t === "img").map((b) => b.v);
    // Recrutement, avis, qualité, actualités, page d'ensemble des prestations : des pages, pas des services.
    const notService = /recrut|emploi|carri[eè]re|rejoindre|avis|t[ée]moignage|qse|qualit[ée]|s[ée]curit[ée]-environnement|actualit|blog|news|partenaire|faq|presse|^(les |nos )?(prestations|services|activit[ée]s|m[ée]tiers|savoir-faire)$/i.test(clean(x.link.label, 60)) || /recrut|emploi|avis|temoignage|actualit|blog|faq/i.test(x.link.url);
    const kind: PageModel["kind"] = GALLERY_RE.test(where) ? "gallery" : ABOUT_RE.test(where) ? "about" : !notService && x.link.label.split(/\s+/).length <= 5 ? "service" : "page";
    if (kind === "gallery" ? imgs.length < 2 : textLen < 220) continue;
    // Libellé du menu, sauf s'il est tronqué (« Notre », « Nos ») : alors le titre de la page.
    const rawLabel = clean(x.link.label, 40);
    const h1Short = clean(x.c.headings.find((h) => h.level === 1)?.title || x.c.headings[0]?.title || "", 40);
    const label = sentenceCase(/^(notre|nos|nous|le|la|les|l'|mon|ma|mes|plus|autres?)$/i.test(rawLabel) || rawLabel.length < 3 ? h1Short : rawLabel);
    if (!label || !/[a-zà-ÿ]{3}/i.test(label)) continue;
    // Adresse lisible tirée du libellé (« La société » → /la-societe).
    let path = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " et ").replace(/['’]/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "page";
    for (let k = 2; usedPaths.has(path); k++) path = `${path.replace(/-\d+$/, "")}-${k}`;
    usedPaths.add(path);
    const h1 = x.c.headings.find((h) => h.level === 1)?.title || "";
    const title = sentenceCase(dropName(h1 && h1.length <= 90 && compact(h1) !== compact(name) ? h1 : label));
    const intro = sentence(blocks.find((b) => b.t === "p" && b.v.length >= 60)?.v || "", 220);
    pages.push({ path: "/" + path, label, title, intro, image: imgs[0] || "", kind, blocks: tidyBlocks(blocks.filter((b) => !(b.t === "h" && compact(b.v) === compact(title))), intro).slice(0, 50) });
    if (pages.length >= 7) break;
  }
  // Les pages de prestations deviennent les services de l'accueil, avec un lien.
  const servicePages = pages.filter((x) => x.kind === "service");
  if (servicePages.length >= 2) {
    services.splice(0, services.length, ...servicePages.slice(0, 6).map((x) => ({ title: x.label, text: x.intro, link: x.path })));
  }

  const data: SiteData = {
    source: home.url, host: ownDomain, name, logo, eyebrow, tagline, intro, about, services: services.slice(0, 6), images,
    phone, email, address: found.address, city, hours, accent, socials: c.socials.slice(0, 4),
    facts: pickFacts(textAll), theme: pickTheme([name, tagline, intro, ...services.map((x) => x.title), hints.metier || ""].join(" ")),
    pages,
  };
  data.quality = assessQuality(data, hints.company || "");
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
const THEME_STYLE: Record<Theme, { fonts: string; head: string; body: string; weight: number; upper: boolean; tracking: string; bg: string; soft: string; ink: string; r: string }> = {
  atelier: {
    fonts: "family=Fraunces:opsz,wght@9..144,500;9..144,650;9..144,750&family=Inter:wght@400;500;600;700",
    head: '"Fraunces",Georgia,"Times New Roman",serif', body: '"Inter",system-ui,-apple-system,sans-serif',
    weight: 650, upper: false, tracking: "-.015em", bg: "#fbf8f3", soft: "#f2ebe1", ink: "#211b16", r: "16px",
  },
  chantier: {
    fonts: "family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700",
    head: '"Barlow Condensed","Arial Narrow",Arial,sans-serif', body: '"Barlow",system-ui,-apple-system,sans-serif',
    weight: 800, upper: true, tracking: ".005em", bg: "#ffffff", soft: "#f1f2f4", ink: "#101217", r: "8px",
  },
  moderne: {
    fonts: "family=Plus+Jakarta+Sans:wght@400;500;600;700;800",
    head: '"Plus Jakarta Sans",system-ui,-apple-system,sans-serif', body: '"Plus Jakarta Sans",system-ui,-apple-system,sans-serif',
    weight: 800, upper: false, tracking: "-.03em", bg: "#ffffff", soft: "#f4f5f8", ink: "#14161c", r: "20px",
  },
};

const ICON: Record<string, string> = {
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  route: '<path d="M3 11l19-9-9 19-2-8-8-2z"/>',
};
const icon = (name: string, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`;

// Images servies par img.yontech.fr (Worker Cloudflare, mises en cache) :
// pas de blocage par le site d'origine, pas d'image http sur une page https.
export const IMG_PROXY = "https://img.yontech.fr/_img?u=";
export const px = (u: string) => (u && /^https?:\/\//i.test(u) ? IMG_PROXY + encodeURIComponent(u) : u);

function rgba(hex: string, alpha: number) {
  const rgb = hexToRgb(hex) || [30, 90, 168];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

export function renderSite(input: SiteData) {
  return renderAll(input).home;
}

export function renderAll(input: SiteData): { home: string; pages: { path: string; html: string }[] } {
  let d: SiteData = {
    ...input, logo: px(input.logo), images: input.images.map(px),
    pages: (input.pages || []).map((pg) => ({ ...pg, image: px(pg.image), blocks: pg.blocks.map((b) => b.t === "img" ? { ...b, v: px(b.v) } : b) })),
  };
  const e = htmlEscape;
  const theme: Theme = d.theme && THEME_STYLE[d.theme] ? d.theme : "moderne";
  const T = THEME_STYLE[theme];
  const accent = /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : FALLBACK_ACCENT;
  const ink = inkOf(accent);
  const tel = d.phone ? "tel:" + d.phone.replace(/\s/g, "") : "";
  const year = new Date().getFullYear();
  const hero = d.images[0] || "";
  const pool = d.images.slice(1);
  const aboutImage = pool.length >= 2 ? pool.shift() || "" : (pool[0] || hero);
  const gallery = pool.slice(0, 6);
  const initials = d.name.split(/\s+/).filter((w) => /[A-Za-zÀ-ÿ0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const facts = (d.facts || []).length >= 2 ? (d.facts || []).slice(0, 4) : [];
  // Cartes détaillées si la moitié des services au moins a une description, sinon simples tuiles.
  const withText = d.services.filter((x) => x.text).length * 2 >= d.services.length;
  if (d.services.length < 2) d = { ...d, services: [] };
  const quick = [d.city ? { k: "pin", v: d.city } : null, d.phone ? { k: "phone", v: d.phone } : null, d.hours[0] ? { k: "clock", v: d.hours[0] } : null].filter(Boolean) as { k: string; v: string }[];
  // Site sur plusieurs pages : le menu reprend les pages ; sinon des ancres.
  const sitePages = (d.pages || []).slice(0, 7);
  const multi = sitePages.length > 0;
  const nav = (multi
    ? [...(sitePages.length <= 3 ? [["/", "Accueil"]] : []), ...sitePages.slice(0, 4).map((pg) => [pg.path, pg.label]), ["#contact", "Contact"]]
    : [d.services.length ? ["#services", "Services"] : null, d.about.length ? ["#apropos", "L'entreprise"] : null, gallery.length >= 2 ? ["#realisations", "Réalisations"] : null, ["#contact", "Contact"]].filter(Boolean)) as string[][];
  const place = d.address || [d.name, d.city].filter(Boolean).join(" ");
  const mapQuery = encodeURIComponent(place);
  const brand = d.logo
    ? `<img onerror="yf(this)" crossorigin="anonymous" src="${e(d.logo)}" alt="${e(d.name)}" data-logo><span class="mono" hidden>${e(initials)}</span><span class="bname" hidden>${e(d.name)}</span>`
    : `<span class="mono">${e(initials)}</span><span class="bname">${e(d.name)}</span>`;
  const H = (tag: string, text: string, cls = "") => `<${tag}${cls ? ` class="${cls}"` : ""}>${e(text)}</${tag}>`;

  const head = (title: string, desc: string, current: string) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="${ink}">
<script>function yf(i){var p=i.closest('.bento a,.galp a');if(p){p.remove();return}if(i.classList.contains('hero-bg')){var h=i.closest('.hero');i.remove();h.classList.add('flat');return}if(i.closest('.phero')){var q=i.closest('.phero');i.remove();q.classList.add('flat');return}var f=i.closest('figure');if(f){f.remove();return}i.style.display='none';if(i.hasAttribute('data-logo')){[].forEach.call(i.parentNode.querySelectorAll('[hidden]'),function(x){x.hidden=false})}}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${T.fonts}&display=swap" rel="stylesheet">
${hero ? `<link rel="preload" as="image" href="${e(hero)}">` : ""}
<style>
:root{--a:${accent};--ai:${ink};--a10:${rgba(accent, .1)};--a18:${rgba(accent, .18)};--ink:${T.ink};--txt:#41454f;--mut:#6b6f7b;--line:${rgba(T.ink, .1)};--bg:${T.bg};--soft:${T.soft};--r:${T.r};--hf:${T.head};--bf:${T.body}}
[hidden]{display:none!important}
*{box-sizing:border-box}html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;font-family:var(--bf);color:var(--txt);background:var(--bg);line-height:1.65;font-size:16.5px;-webkit-font-smoothing:antialiased;overflow-x:clip}
img{max-width:100%;display:block}a{color:inherit}
h1,h2,h3{font-family:var(--hf);font-weight:${T.weight};color:var(--ink);letter-spacing:${T.tracking};line-height:1.05;margin:0;text-wrap:balance;overflow-wrap:break-word${T.upper ? ";text-transform:uppercase" : ""}}
p{overflow-wrap:break-word}
.wrap{width:min(1180px,100% - 40px);margin:0 auto}
.wrap>*,.grid>*,.split>*,.ct>*{min-width:0}
.yt-bar{background:#0d0f14;color:#c9ccd6;font:500 12.5px/1.45 system-ui,sans-serif;padding:8px 16px;text-align:center}
.yt-bar b{color:#fff}.yt-bar a{color:#fff;font-weight:700;margin-left:8px}

.hd{position:sticky;top:0;z-index:30;background:${rgba(T.bg === "#ffffff" ? "#ffffff" : T.bg, .94)};backdrop-filter:saturate(1.5) blur(12px);transition:box-shadow .25s}
.hd.sc{box-shadow:0 10px 30px -18px rgba(0,0,0,.35)}
.hd-in{display:flex;align-items:center;gap:28px;height:84px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;min-width:0}
.brand img{height:60px;width:auto;max-width:240px;object-fit:contain}
.brand.dark img{background:#14161c;border-radius:10px;padding:6px 12px;height:58px}
.mono{width:46px;height:46px;border-radius:calc(var(--r) * .6);background:var(--ai);color:#fff;display:grid;place-items:center;font:800 17px var(--bf);flex:none}
.bname{font-family:var(--hf);font-weight:${T.weight};font-size:20px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis${T.upper ? ";text-transform:uppercase" : ""}}
.hd nav{margin-left:auto;display:flex;gap:24px;font-weight:600;font-size:15px}
.hd nav a{text-decoration:none;color:var(--ink);opacity:.8;position:relative;white-space:nowrap}
.btn{white-space:nowrap}
.hd nav a:after{content:"";position:absolute;left:0;right:100%;bottom:-6px;height:2px;background:var(--a);transition:right .25s}
.hd nav a:hover{opacity:1}.hd nav a:hover:after{right:0}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:var(--ai);color:#fff;text-decoration:none;font:700 15.5px var(--bf);padding:16px 26px;border-radius:${theme === "chantier" ? "6px" : "999px"};border:0;cursor:pointer;transition:transform .18s,box-shadow .18s,background .18s;box-shadow:0 14px 28px -14px var(--ai)${theme === "chantier" ? ";text-transform:uppercase;letter-spacing:.04em;font-size:14.5px" : ""}}
.btn:hover{transform:translateY(-2px);box-shadow:0 18px 34px -14px var(--ai)}
.btn svg{transition:transform .18s}.btn:hover svg{transform:translateX(3px)}
.btn-glass{background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.45);backdrop-filter:blur(6px)}
.btn-line{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--line)}
.btn-sm{padding:12px 20px;font-size:14.5px}
.btn-light{background:#fff;color:var(--ai);box-shadow:none}

/* Accroche sur photo */
.hero{position:relative;color:#fff;min-height:min(86vh,780px);display:flex;align-items:flex-end;overflow:hidden;background:#0d0f14}
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:kb 22s ease-out both}
@keyframes kb{from{transform:scale(1.12)}to{transform:scale(1)}}
.hero:before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(90deg,rgba(10,12,16,.9) 0%,rgba(10,12,16,.68) 45%,rgba(10,12,16,.2) 100%),linear-gradient(0deg,rgba(10,12,16,.7) 0%,transparent 45%)}
.hero .wrap{position:relative;z-index:2;padding:120px 0 ${facts.length ? "150px" : "90px"}}
.hero .eyebrow{display:inline-flex;align-items:center;gap:10px;font:700 13px var(--bf);letter-spacing:.14em;text-transform:uppercase;color:#fff;margin:0 0 22px}
.hero .eyebrow:before{content:"";width:34px;height:3px;background:var(--a);border-radius:2px}
.hero h1{color:#fff;font-size:clamp(38px,6.2vw,82px);max-width:15ch;margin-bottom:22px}
.hero .lead{font-size:clamp(17px,1.6vw,20px);color:rgba(255,255,255,.86);max-width:54ch;margin:0 0 34px}
.cta{display:flex;gap:12px;flex-wrap:wrap}
.quick{list-style:none;display:flex;gap:26px;flex-wrap:wrap;padding:0;margin:38px 0 0;font-size:15px;color:rgba(255,255,255,.9)}
.quick li{display:flex;gap:9px;align-items:center}.quick svg{color:var(--a);filter:brightness(1.4)}
/* Accroche sans photo */
.hero.flat{color:var(--ink);background:radial-gradient(900px 480px at 85% 0%,var(--a18),transparent 70%),var(--bg);align-items:center;min-height:auto}
.hero.flat:before{display:none}.hero.flat h1{color:var(--ink)}.hero.flat .lead{color:var(--txt)}.hero.flat .eyebrow{color:var(--ai)}.hero.flat .quick{color:var(--ink)}
.hero.flat .wrap{padding:90px 0 ${facts.length ? "140px" : "90px"}}

/* Chiffres */
.facts{position:relative;z-index:5;margin-top:-78px}
.facts-in{background:#fff;border-radius:var(--r);box-shadow:0 30px 60px -30px rgba(10,12,16,.35);display:grid;grid-template-columns:repeat(${Math.max(facts.length, 1)},1fr);overflow:hidden}
.fact{padding:28px 30px;border-left:1px solid var(--line)}.fact:first-child{border-left:0}
.fact b{display:block;font-family:var(--hf);font-weight:${T.weight};font-size:clamp(28px,3vw,40px);line-height:1;color:var(--ai);letter-spacing:${T.tracking}}
.fact span{display:block;margin-top:8px;font-size:14px;color:var(--mut);font-weight:600${theme === "chantier" ? ";text-transform:uppercase;letter-spacing:.06em;font-size:13px" : ""}}

.sec{padding:110px 0}.sec.soft{background:var(--soft)}
.kicker{display:inline-flex;align-items:center;gap:10px;font:800 12.5px var(--bf);letter-spacing:.16em;text-transform:uppercase;color:var(--ai);margin:0 0 16px}
.kicker:before{content:"";width:26px;height:2px;background:var(--a)}
h2{font-size:clamp(32px,4vw,54px);margin-bottom:18px}
.head{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:end;margin-bottom:54px}
.head p{margin:0;font-size:17px;max-width:52ch}

/* Services */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px}
.tiles{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.tiles li{display:flex;align-items:center;gap:14px;background:${T.bg === "#ffffff" ? "#fff" : "#fffdf9"};border:1px solid var(--line);border-radius:calc(var(--r) * .7);padding:18px 20px;font-family:var(--hf);font-weight:${T.weight};font-size:${theme === "chantier" ? "21px" : "18px"};color:var(--ink);line-height:1.2;transition:transform .2s,border-color .2s${T.upper ? ";text-transform:uppercase" : ""}}
.tiles li:hover{transform:translateY(-3px);border-color:var(--a)}
.tiles li:before{content:"";width:12px;height:12px;border-radius:3px;background:var(--a);flex:none;transform:rotate(45deg)}
.card{position:relative;background:${T.bg === "#ffffff" ? "#fff" : "#fffdf9"};border:1px solid var(--line);border-radius:var(--r);padding:34px 30px 32px;overflow:hidden;transition:transform .25s,box-shadow .25s,border-color .25s}
.card:after{content:"";position:absolute;left:0;bottom:0;height:4px;width:0;background:var(--a);transition:width .35s}
.card:hover{transform:translateY(-6px);box-shadow:0 30px 60px -36px rgba(10,12,16,.45);border-color:transparent}
.card:hover:after{width:100%}
.card .n{font-family:var(--hf);font-weight:${T.weight};font-size:46px;line-height:1;color:var(--a18);-webkit-text-stroke:1.5px var(--a);color:transparent;margin-bottom:22px;display:block}
.card h3{font-size:${theme === "chantier" ? "26px" : "22px"};line-height:1.15;margin-bottom:10px}
.card p{margin:0;font-size:15.5px}

/* Entreprise */
.split{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center}
.ph{position:relative}
.ph img,.ph .ph-box{width:100%;aspect-ratio:4/4.4;object-fit:cover;border-radius:var(--r);position:relative;z-index:1}
.ph:before{content:"";position:absolute;inset:26px -26px -26px 26px;border:2px solid var(--a);border-radius:var(--r)}
.ph-box{background:linear-gradient(135deg,var(--a),var(--ai));display:grid;place-items:center;color:#fff;font:800 90px var(--hf)}
.about p{font-size:17.5px;margin:0 0 18px}
.checks{list-style:none;padding:0;margin:26px 0 30px;display:grid;gap:12px}
.checks li{display:flex;gap:12px;align-items:center;font-weight:600;color:var(--ink)}
.checks li:before{content:"";width:22px;height:22px;border-radius:50%;flex:none;background:var(--a10) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23${ink.slice(1)}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/13px no-repeat}

/* Réalisations */
.bento{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:230px;gap:14px}
.bento a{position:relative;display:block;overflow:hidden;border-radius:calc(var(--r) * .8);background:var(--soft)}
.bento a:first-child{grid-column:span 2;grid-row:span 2}
.bento img{width:100%;height:100%;object-fit:cover;transition:transform .7s cubic-bezier(.2,.7,.2,1)}
.bento a:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(10,12,16,.35),transparent 50%);opacity:0;transition:opacity .3s}
.bento a:hover img{transform:scale(1.07)}.bento a:hover:after{opacity:1}

/* Bandeau projet */
.band{background:var(--ai);color:#fff;position:relative;overflow:hidden}
.band:before{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:rgba(255,255,255,.08)}
.band:after{content:"";position:absolute;right:120px;bottom:-160px;width:300px;height:300px;border-radius:50%;background:rgba(255,255,255,.06)}
.band-in{position:relative;z-index:1;display:flex;gap:30px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:70px 0}
.band h2{color:#fff;margin:0;font-size:clamp(30px,3.6vw,46px)}
.band p{margin:10px 0 0;color:rgba(255,255,255,.85);font-size:17px}

/* Contact */
.ct{display:grid;grid-template-columns:1.05fr .95fr;gap:28px;align-items:stretch}
.box{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.info{list-style:none;margin:0;padding:10px 30px}
.info li{display:flex;gap:16px;align-items:flex-start;padding:18px 0;border-bottom:1px solid var(--line)}
.info li:last-child{border-bottom:0}
.info .ic{width:44px;height:44px;border-radius:12px;background:var(--a10);color:var(--ai);display:grid;place-items:center;flex:none}
.info b{display:block;font:700 12px var(--bf);letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin-bottom:3px}
.info a,.info span{color:var(--ink);text-decoration:none;font-weight:600;font-size:16.5px}
.map{position:relative;height:300px;border-top:1px solid var(--line)}
.map iframe{display:block;width:100%;height:100%;border:0}
.map .go{position:absolute;left:16px;bottom:16px}
.form{padding:34px 32px;display:grid;gap:16px;align-content:start;height:100%}
.form h3{font-size:${theme === "chantier" ? "30px" : "26px"};margin-bottom:2px}
.form .sub{margin:0 0 6px;color:var(--mut);font-size:15px}
.form label{display:grid;gap:7px;font-size:13.5px;font-weight:700;color:var(--ink)}
.form input,.form textarea,.form select{font:inherit;font-size:15.5px;border:1.5px solid var(--line);border-radius:calc(var(--r) * .55);padding:14px 15px;color:var(--ink);background:var(--bg);transition:border-color .15s,box-shadow .15s}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 4px var(--a18);background:#fff}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form .ok{display:none;background:var(--a10);color:var(--ink);border-radius:12px;padding:13px 15px;font-size:14.5px;margin:0}

footer{background:#0d0f14;color:#9a9eab;font-size:15px}
.ft{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:50px;padding:70px 0 50px}
.ft h4{color:#fff;font:700 13px var(--bf);letter-spacing:.14em;text-transform:uppercase;margin:0 0 18px}
.ft a{color:#d6d8df;text-decoration:none}.ft a:hover{color:#fff}
.ft ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.ft .fl img{height:54px;width:auto;max-width:220px;object-fit:contain;background:#fff;border-radius:10px;padding:8px 12px;margin-bottom:18px}
.ft .fl .bname{color:#fff;display:block;margin-bottom:14px}
.fb{border-top:1px solid rgba(255,255,255,.1);padding:22px 0;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:13.5px}
.fb a{color:#fff;font-weight:700}
.fab{display:none;position:fixed;right:16px;bottom:16px;z-index:40;align-items:center;gap:8px;background:var(--ai);color:#fff;text-decoration:none;font:800 15px var(--bf);padding:15px 22px;border-radius:999px;box-shadow:0 16px 30px -10px rgba(0,0,0,.5)}

.rv{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}
.rv.in{opacity:1;transform:none}
.d1{transition-delay:.08s}.d2{transition-delay:.16s}.d3{transition-delay:.24s}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}.hero-bg{animation:none}html{scroll-behavior:auto}}
@media (max-width:980px){
  .hd nav{display:none}.hd .btn-sm{margin-left:auto}
  .head,.split,.ct,.ft{grid-template-columns:1fr}.head{gap:14px}.split{gap:56px}
  .bento{grid-template-columns:repeat(2,1fr);grid-auto-rows:170px}
  .facts-in{grid-template-columns:repeat(2,1fr)}.fact:nth-child(3){border-left:0}.fact:nth-child(n+3){border-top:1px solid var(--line)}
  .sec{padding:80px 0}
}
@media (max-width:600px){
  .hd-in{height:70px}.brand img{height:46px;max-width:170px}.hd .btn-sm{display:none}
  .hero{min-height:auto}.hero .wrap{padding:90px 0 ${facts.length ? "120px" : "70px"}}
  .hero:before{background:linear-gradient(0deg,rgba(10,12,16,.92) 10%,rgba(10,12,16,.55) 100%)}
  .fact{padding:20px 18px}.row2{grid-template-columns:1fr}
  .info{padding:4px 20px}.form{padding:26px 20px}
  .ph:before{inset:16px -10px -16px 16px}
  .fab{display:inline-flex}
  .yt-bar{font-size:11.5px}
}

.hd nav a.on{opacity:1}.hd nav a.on:after{right:0}
.burger{display:none;margin-left:12px;width:44px;height:44px;border:1px solid var(--line);border-radius:12px;background:transparent;cursor:pointer;flex-direction:column;justify-content:center;align-items:center;gap:5px}
.burger span{display:block;width:20px;height:2px;background:var(--ink);border-radius:2px;transition:transform .2s,opacity .2s}
.hd.open .burger span:nth-child(1){transform:translateY(7px) rotate(45deg)}.hd.open .burger span:nth-child(2){opacity:0}.hd.open .burger span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
/* Pages intérieures */
.phero{position:relative;color:#fff;background:#0d0f14;overflow:hidden}
.phero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.45}
.phero .wrap{position:relative;padding:110px 0 80px}
.phero.flat{background:linear-gradient(135deg,var(--ai),#0d0f14)}
.crumb{font-size:13.5px;color:rgba(255,255,255,.75);margin:0 0 16px}.crumb a{color:#fff;text-decoration:none;font-weight:600}
.phero h1{color:#fff;font-size:clamp(34px,5vw,64px);max-width:18ch;margin-bottom:16px}
.phero .lead{color:rgba(255,255,255,.86);font-size:18px;max-width:58ch;margin:0}
.art{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:60px;align-items:start}
.prose{font-size:17.5px;max-width:72ch}
.prose h2{font-size:clamp(26px,2.6vw,36px);margin:44px 0 16px}.prose h2:first-child{margin-top:0}
.prose h3{font-size:22px;margin:30px 0 10px}
.prose p{margin:0 0 18px}
.prose ul{padding:0;margin:0 0 22px;list-style:none;display:grid;gap:10px}
.prose li{position:relative;padding-left:30px}.prose li:before{content:"";position:absolute;left:4px;top:.55em;width:10px;height:10px;border-radius:3px;background:var(--a);transform:rotate(45deg)}
.prose figure{margin:28px 0;border-radius:var(--r);overflow:hidden}.prose figure img{width:100%;max-height:520px;object-fit:cover}
.aside{position:sticky;top:110px;display:grid;gap:16px}
.aside .box{padding:26px}
.aside h3{font-size:22px;margin-bottom:10px}
.aside p{margin:0 0 16px;color:var(--mut);font-size:15px}
.aside .btn{width:100%}
.aside ul{list-style:none;padding:0;margin:0;display:grid;gap:2px}
.aside ul a{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink);font-weight:600}
.aside ul a.on{color:var(--ai)}
.more{display:inline-flex;align-items:center;gap:8px;margin-top:16px;font-weight:700;color:var(--ai);text-decoration:none}
.galp{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.galp a{display:block;border-radius:calc(var(--r) * .8);overflow:hidden;aspect-ratio:4/3;background:var(--soft)}
.galp img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.galp a:hover img{transform:scale(1.06)}
@media (max-width:980px){
  .burger{display:flex}.hd .btn-sm{margin-left:auto}
  .hd.open nav{display:flex;position:absolute;left:0;right:0;top:100%;flex-direction:column;gap:0;background:var(--bg);border-top:1px solid var(--line);box-shadow:0 20px 40px -20px rgba(0,0,0,.35);padding:8px 20px 16px}
  .hd.open nav a{padding:14px 0;border-bottom:1px solid var(--line);opacity:1}.hd.open nav a:after{display:none}
  .art{grid-template-columns:1fr;gap:36px}.aside{position:static}.galp{grid-template-columns:repeat(2,1fr)}
}
@media (max-width:600px){.burger{margin-left:auto}.phero .wrap{padding:80px 0 56px}}
</style>
</head>
<body>
<div class="yt-bar">Proposition de nouveau site pour <b>${e(d.name)}</b>, réalisée par Yontech à partir du site actuel. Ce n'est pas le site officiel.<a href="${e(d.source)}" target="_blank" rel="noopener nofollow">Voir le site actuel</a></div>

<header class="hd" id="hd"><div class="wrap hd-in">
<a class="brand" href="${multi ? "/" : "#top"}" aria-label="${e(d.name)}">${brand}</a>
<nav id="nav">${nav.map(([h, l]) => `<a href="${e(h)}"${h === current ? ' class="on"' : ""}>${e(l)}</a>`).join("")}</nav>
<button class="burger" type="button" aria-label="Menu" aria-controls="nav" onclick="document.getElementById('hd').classList.toggle('open')"><span></span><span></span><span></span></button>
${tel ? `<a class="btn btn-sm" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : `<a class="btn btn-sm" href="#contact">Nous écrire</a>`}
</div></header>

`;
  const homeMain = `<section class="hero${hero ? "" : " flat"}" id="top">
${hero ? `<img onerror="yf(this)" class="hero-bg" src="${e(hero)}" alt="" fetchpriority="high">` : ""}
<div class="wrap">
${d.eyebrow ? `<p class="eyebrow rv">${e(d.eyebrow)}</p>` : ""}
<h1 class="rv d1">${e(d.tagline)}</h1>
${d.intro ? `<p class="lead rv d2">${e(d.intro)}</p>` : ""}
<div class="cta rv d3"><a class="btn" href="#contact">Demander un devis ${icon("arrow", 18)}</a>${tel ? `<a class="btn ${hero ? "btn-glass" : "btn-line"}" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : ""}</div>
${!facts.length && quick.length ? `<ul class="quick rv d3">${quick.map((q) => `<li>${icon(q.k, 18)}${e(q.v)}</li>`).join("")}</ul>` : ""}
</div>
</section>
${facts.length ? `<div class="facts"><div class="wrap"><div class="facts-in rv">${facts.map((f) => `<div class="fact"><b>${e(f.value)}</b><span>${e(f.label)}</span></div>`).join("")}</div></div></div>` : ""}

${d.services.length ? `<section class="sec" id="services"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">Nos services</p>${H("h2", "Ce que nous faisons pour vous")}</div></div>
${withText ? `<div class="grid">${d.services.map((s, i) => `<article class="card rv d${i % 3 + 1}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${H("h3", s.title)}${s.text ? `<p>${e(s.text)}</p>` : ""}${s.link ? `<a class="more" href="${e(s.link)}">En savoir plus ${icon("arrow", 16)}</a>` : ""}</article>`).join("")}</div>`
  : `<ul class="tiles">${d.services.map((s, i) => `<li class="rv d${i % 3 + 1}">${s.link ? `<a href="${e(s.link)}" style="color:inherit;text-decoration:none">${e(s.title)}</a>` : e(s.title)}</li>`).join("")}</ul>`}
</div></section>` : ""}

${d.about.length ? `<section class="sec soft" id="apropos"><div class="wrap split">
<div class="ph rv">${aboutImage ? `<img onerror="yf(this)" src="${e(aboutImage)}" alt="${e(d.name)}" loading="lazy">` : `<div class="ph-box">${e(initials)}</div>`}</div>
<div class="about rv d1"><p class="kicker">L'entreprise</p>${H("h2", d.name)}${d.about.map((p) => `<p>${e(p)}</p>`).join("")}
${d.services.length >= 3 ? `<ul class="checks">${d.services.slice(0, 3).map((s) => `<li>${e(s.title)}</li>`).join("")}</ul>` : ""}
<a class="btn" href="#contact">Parler de votre projet ${icon("arrow", 18)}</a></div>
</div></section>` : ""}

${gallery.length >= 2 ? `<section class="sec" id="realisations"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">Réalisations</p>${H("h2", "Notre travail en images")}</div></div>
<div class="bento">${gallery.map((g, i) => `<a class="rv d${i % 3 + 1}" href="${e(g)}" target="_blank" rel="noopener"><img onerror="yf(this)" src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div>
</div></section>` : ""}

`;
  const band = `<section class="band"><div class="wrap band-in">
<div class="rv">${H("h2", "Un projet ? Parlons-en.")}<p>${d.city ? `${e(d.name)}, à ${e(d.city)}. ` : ""}Décrivez-nous votre besoin, nous revenons vers vous.</p></div>
<div class="cta rv d1">${tel ? `<a class="btn btn-light" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : ""}<a class="btn btn-glass" href="#contact">Demander un devis ${icon("arrow", 18)}</a></div>
</div></section>

`;
  const contact = `<section class="sec soft" id="contact"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">Contact</p>${H("h2", "Nous trouver, nous joindre")}</div></div>
<div class="ct">
<div class="box rv">
<ul class="info">
${d.address ? `<li><span class="ic">${icon("pin")}</span><div><b>Adresse</b><span>${e(d.address)}</span></div></li>` : d.city ? `<li><span class="ic">${icon("pin")}</span><div><b>Ville</b><span>${e(d.city)}</span></div></li>` : ""}
${d.phone ? `<li><span class="ic">${icon("phone")}</span><div><b>Téléphone</b><a href="${e(tel)}">${e(d.phone)}</a></div></li>` : ""}
${d.email ? `<li><span class="ic">${icon("mail")}</span><div><b>E-mail</b><a href="mailto:${e(d.email)}">${e(d.email)}</a></div></li>` : ""}
${d.hours.length ? `<li><span class="ic">${icon("clock")}</span><div><b>Horaires</b><span>${d.hours.map((h) => e(h)).join("<br>")}</span></div></li>` : ""}
</ul>
${place ? `<div class="map"><iframe title="Plan d'accès ${e(d.name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${mapQuery}&z=14&output=embed"></iframe><a class="btn btn-sm go" href="https://www.google.com/maps/dir/?api=1&destination=${mapQuery}" target="_blank" rel="noopener">${icon("route", 16)}Itinéraire</a></div>` : ""}
</div>
<form class="box form rv d1" onsubmit="event.preventDefault();this.querySelector('.ok').style.display='block';this.querySelector('button').disabled=true">
${H("h3", "Demande de devis")}
<p class="sub">Réponse rapide, sans engagement.</p>
<div class="row2"><label>Nom<input name="nom" autocomplete="name" required></label><label>Téléphone<input name="tel" type="tel" autocomplete="tel" required></label></div>
<label>E-mail<input name="email" type="email" autocomplete="email"></label>
${d.services.length ? `<label>Votre besoin<select name="service"><option value="">Choisir…</option>${d.services.map((s) => `<option>${e(s.title)}</option>`).join("")}<option>Autre</option></select></label>` : ""}
<label>Votre projet<textarea name="msg" rows="4" placeholder="Quelques mots sur votre projet, le lieu, les délais…"></textarea></label>
<button class="btn" type="submit">Envoyer ma demande ${icon("arrow", 18)}</button>
<p class="ok">Formulaire de démonstration : sur le site en ligne, votre demande arrivera directement chez ${e(d.name)}.</p>
</form>
</div>
</div></section>

`;
  const tail = `<footer><div class="wrap">
<div class="ft">
<div class="fl">${d.logo ? `<img onerror="yf(this)" src="${e(d.logo)}" alt="${e(d.name)}" loading="lazy">` : `<span class="bname">${e(d.name)}</span>`}${d.intro ? `<p style="margin:0;max-width:40ch">${e(sentence(d.intro, 150))}</p>` : ""}</div>
<div><h4>Contact</h4><ul>${d.address ? `<li>${e(d.address)}</li>` : d.city ? `<li>${e(d.city)}</li>` : ""}${d.phone ? `<li><a href="${e(tel)}">${e(d.phone)}</a></li>` : ""}${d.email ? `<li><a href="mailto:${e(d.email)}">${e(d.email)}</a></li>` : ""}</ul></div>
<div><h4>Navigation</h4><ul>${nav.map(([h, l]) => `<li><a href="${e(h)}">${e(l)}</a></li>`).join("")}${d.socials.map((s) => `<li><a href="${e(s.url)}" target="_blank" rel="noopener">${e(s.label)}</a></li>`).join("")}</ul></div>
</div>
<div class="fb"><span>© ${year} ${e(d.name)}</span><span>Maquette réalisée par <a href="https://yontech.fr" target="_blank" rel="noopener">Yontech</a></span></div>
</div></footer>
${tel ? `<a class="fab" href="${e(tel)}">${icon("phone", 18)}Appeler</a>` : ""}
<script>
(function(){
var hd=document.getElementById('hd');addEventListener('scroll',function(){hd.classList.toggle('sc',scrollY>20)},{passive:true});
var els=document.querySelectorAll('.rv');
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}})},{threshold:.12,rootMargin:'0px 0px -40px 0px'});els.forEach(function(x){io.observe(x)})}else{els.forEach(function(x){x.classList.add('in')})}
var lg=document.querySelector('[data-logo]');
// Logo trop petit : initiales. Logo clair (blanc sur transparent) : posé sur un fond sombre.
function chk(){if(!lg||!lg.naturalWidth)return;if(lg.naturalWidth<40){yf(lg);return}try{var c=document.createElement('canvas'),w=c.width=Math.min(120,lg.naturalWidth),h=c.height=Math.max(1,Math.round(w*lg.naturalHeight/lg.naturalWidth)),x=c.getContext('2d');x.drawImage(lg,0,0,w,h);var d=x.getImageData(0,0,w,h).data,n=0,l=0;for(var k=0;k<d.length;k+=4){if(d[k+3]>60){n++;l+=(.2126*d[k]+.7152*d[k+1]+.0722*d[k+2])/255}}if(n>20&&l/n>.86)lg.parentNode.classList.add('dark')}catch(e){}}
if(lg){if(lg.complete)chk();else lg.addEventListener('load',chk)}
})();
</script>
</body>
</html>`;
  const titleOf = (t: string) => e(t) + " · " + e(d.name);
  const block = (b: Block) => b.t === "h" ? `<h2 class="rv">${e(b.v)}</h2>` : b.t === "p" ? `<p class="rv">${e(b.v)}</p>` : b.t === "img" ? `<figure class="rv"><img onerror="yf(this)" src="${e(b.v)}" alt="${e(d.name)}" loading="lazy"></figure>` : "";
  const prose = (blocks: Block[]) => {
    let out = "", list: string[] = [];
    const flush = () => { if (list.length) { out += `<ul class="rv">${list.join("")}</ul>`; list = []; } };
    for (const b of blocks) { if (b.t === "li") { list.push(`<li>${e(b.v)}</li>`); continue; } flush(); out += block(b); }
    flush();
    return out;
  };
  const pageMain = (pg: PageModel) => {
    const imgs = pg.blocks.filter((b) => b.t === "img").map((b) => b.v);
    const body = pg.kind === "gallery"
      ? `${prose(pg.blocks.filter((b) => b.t !== "img"))}<div class="galp">${imgs.map((g, i) => `<a class="rv d${i % 3 + 1}" href="${e(g)}" target="_blank" rel="noopener"><img onerror="yf(this)" src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div>`
      : prose(pg.blocks.filter((b, i) => !(b.t === "img" && b.v === pg.image && i < 3)));
    return `<section class="phero${pg.image ? "" : " flat"}">${pg.image ? `<img onerror="yf(this)" src="${e(pg.image)}" alt="">` : ""}<div class="wrap">
<p class="crumb rv"><a href="/">Accueil</a> &nbsp;/&nbsp; ${e(pg.label)}</p>
<h1 class="rv d1">${e(pg.title)}</h1>${pg.intro && pg.kind !== "gallery" ? `<p class="lead rv d2">${e(pg.intro)}</p>` : ""}
</div></section>
<section class="sec"><div class="wrap art">
<article class="prose">${body}</article>
<aside class="aside">
<div class="box rv"><h3>Un projet ?</h3><p>${e(d.name)} vous répond${d.city ? " à " + e(d.city) + " et alentours" : ""}.</p>${tel ? `<a class="btn" href="${e(tel)}" style="margin-bottom:10px">${icon("phone", 17)}${e(d.phone)}</a>` : ""}<a class="btn btn-line" href="#contact">Demander un devis</a></div>
${sitePages.length > 1 ? `<div class="box rv"><h3>Nos pages</h3><ul>${sitePages.map((x) => `<li><a href="${e(x.path)}"${x.path === pg.path ? ' class="on"' : ""}>${e(x.label)} ${icon("arrow", 15)}</a></li>`).join("")}</ul></div>` : ""}
</aside>
</div></section>
`;
  };
  const home = head(e(d.name) + (d.eyebrow ? " · " + e(d.eyebrow) : ""), e(d.intro), "/") + homeMain + band + contact + tail;
  const pages = sitePages.map((pg) => ({ path: pg.path, html: head(titleOf(pg.title), e(pg.intro || d.intro), pg.path) + pageMain(pg) + band + contact + tail }));
  return { home, pages };
}

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
    const hero = px(d.images[0] || "");
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
export function assessQuality(d: SiteData, company = "") {
  const blocking: string[] = [], warnings: string[] = [];
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
