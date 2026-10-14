/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { parseHTML } from "npm:linkedom@0.18.5";
import { extractEmails, htmlEscape, niceCompany } from "./yontech-core.ts";

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

export type Service = { title: string; text: string };
export type SiteData = {
  source: string; host: string; name: string; logo: string; eyebrow: string; tagline: string; intro: string;
  about: string[]; services: Service[]; images: string[]; phone: string; email: string; address: string;
  city: string; hours: string[]; accent: string; socials: { label: string; url: string }[];
};
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
    const html = source.replace(/<script\b(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->|<noscript[\s\S]*?<\/noscript>/gi, " ");
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
const SECTION_RE = /^(suivant|pr[ée]c[ée]dent|retour|lire la suite|voir plus|voir tout|en savoir plus|carri[eè]res?|nos m[ée]tiers|recrutement|emplois?|rejoignez[- ]nous.*|nous rejoindre|(notre|nos|l'|la|le|les)\s*(histoire|[ée]quipe|valeurs?|engagements?|entreprise|soci[ée]t[ée]|atelier|philosophie|mission|vision|chiffres?|clients?|partenaires|r[ée]f[ée]rences|r[ée]alisations|actualit[ée]s|avis)|venez nous.*|envoyez[- ]nous.*|appelez[- ]nous.*|[ée]crivez[- ]nous.*|contactez.*|trouvez[- ]nous.*|nous trouver|o[uù] nous trouver.*|demander? (un|votre) devis.*|obtenez.*devis.*|page\s?\d*|pourquoi nous choisir.*|pourquoi choisir.*|ils nous font confiance.*|faq|questions fr[ée]quentes)$/i;
const SOCIAL_RE = /^(insta(gram)?|facebook|fb|linkedin|youtube|tiktok|twitter|x|pinterest|google|avis google)$/i;
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
  const t = clean(text, 2000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" ! "), cut.lastIndexOf(" ? "));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

// « TOITURE ACCESSIBLE » → « Toiture accessible » (titres saisis en capitales).
function sentenceCase(text: string) {
  const t = clean(text, 200);
  if (!t || t !== t.toUpperCase() || !/[A-ZÀ-Ý]/.test(t)) return t;
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
    if (t.length >= 3 && t.length <= 40 && !NAV_SKIP_RE.test(t) && !SOCIAL_RE.test(t) && !SECTION_RE.test(t) && !navItems.includes(t)) navItems.push(t);
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

/* ---------------- Assemblage ---------------- */

export async function buildSite(url: string, hints: Hints = {}): Promise<{ data: SiteData; html: string } | { error: string }> {
  let start = String(url || "").trim();
  if (!/^https?:\/\//i.test(start)) start = "https://" + start.replace(/^\/+/, "");
  const home = await fetchRaw(start) || (start.startsWith("https://") ? await fetchRaw(start.replace("https://", "http://")) : null);
  if (!home) return { error: "Le site ne répond pas ou n'est pas une page HTML." };
  const doc = parseHTML(home.html).document;
  const c = collect(doc, home);

  // Pages complémentaires : services / prestations, puis à propos (deux au plus).
  const pick = (re: RegExp) => c.links.find((l) => re.test(l.url + " " + l.text) && l.url.replace(/\/$/, "") !== home.url.replace(/\/$/, ""))?.url || "";
  const extraUrls = [pick(/prestation|services?|savoir-faire|activit|nos-metiers|expertise|competence/i), pick(/propos|qui-sommes|about|entreprise|histoire|presentation/i)].filter((u, i, a) => u && a.indexOf(u) === i);
  const extras = (await Promise.all(extraUrls.map((u) => fetchRaw(u, 6000)))).filter(Boolean) as Raw[];
  const extraCollected = extras.map((r) => collect(parseHTML(r.html).document, r));

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
    if (!key || seen.has(key) || GENERIC_HEADING_RE.test(title) || SECTION_RE.test(title) || SOCIAL_RE.test(title) || /^[\d\s.+()-]{6,}$/.test(title) || /@|https?:|www\./i.test(title) || title.toLowerCase() === lowerName || title.length > 70 || /[?!]$/.test(title) && title.length > 50) return;
    seen.add(key);
    services.push({ title: sentenceCase(title.replace(/[.:]+$/, "")), text: sentenceCase(text) });
  };
  for (const h of [...(extraCollected[0]?.headings || []), ...c.headings].filter((h) => h.level >= 2)) {
    if (services.length >= 6) break;
    if (h.text.length >= 25) addService(h.title, h.text);
  }
  if (services.length < 3) for (const t of c.navItems) { if (services.length >= 6) break; addService(t, ""); }

  // Textes : présentation et à propos, sans répéter ceux des services.
  const used = new Set(services.map((s) => s.text));
  const allParagraphs = [...(extraCollected[1]?.paragraphs || []), ...c.paragraphs, ...(extraCollected[0]?.paragraphs || [])].filter((p) => !used.has(sentence(p, 230)));
  const scoreAbout = (p: string) => (/\b(nous|notre|nos|depuis|cr[ée]{1,2}e?|fond[ée]e?|entreprise|[ée]quipe|exp[ée]rience|ann[ée]es|famil|savoir-faire|passion|qualit)/i.test(p) ? 10 : 0) + Math.min(p.length, 400) / 100;
  const about = [...new Set(allParagraphs)].sort((a, b) => scoreAbout(b) - scoreAbout(a)).slice(0, 2).map((p) => sentence(p, 420));

  const h1 = c.headings.find((h) => h.level === 1 && h.title.length >= 8 && h.title.length <= 90 && h.title.toLowerCase() !== lowerName && !/^bienvenue/i.test(h.title))?.title || "";
  const titleRest = c.title.split(/\s+[|\-–—·:»]\s+/).map((p) => clean(p, 90)).find((p) => p.length >= 12 && !p.toLowerCase().includes(lowerName) && !/^(accueil|home|bienvenue)/i.test(p)) || "";
  const intro = sentence(c.description && c.description.length >= 40 ? c.description : (about[0] || allParagraphs[0] || ""), 220);

  const ldAddr = ldAddress(c.org as Record<string, unknown>);
  const textAll = [c.bodyText, ...extraCollected.map((x) => x.bodyText)].join(" ");
  const found = ldAddr.address ? ldAddr : pickAddress(textAll);
  const city = titleCase(found.city || ldAddr.city || hints.ville || "");
  if (found.address && found.city === "" && hints.ville) found.address = found.address;
  const welcome = (t: string) => clean(t, 400).replace(/^bienvenue\s+(chez|sur le site d[eu']|à|au|aux|dans)\s*[^,.!:–—-]{2,60}[,.!:–—-]\s*/i, "");
  const clause = (t: string) => { const first = welcome(t).split(/(?<=[.!?;])\s|\s[–—]\s/)[0].replace(/[.;]$/, "").trim(); return first.length >= 15 && first.length <= 85 ? first[0].toUpperCase() + first.slice(1) : ""; };
  const tagline = sentenceCase(h1 || (titleRest && titleRest.length <= 80 ? titleRest : "") || clause(c.description) || clause(intro) || name);
  let activity = titleRest && titleRest.length <= 60 ? titleRest : clean(hints.metier, 60);
  if (compact(activity) === compact(tagline)) activity = clean(hints.metier, 60);
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
  const logo = logoLd || c.images.find((i) => i.logo && i.header)?.url || c.images.find((i) => i.logo)?.url || "";
  const IMG_SKIP = /logo|icon|favicon|sprite|pixel|avatar|gravatar|emoji|flag|drapeau|badge|payment|paiement|visa|mastercard|loader|spinner|placeholder|blank|arrow|fleche|picto|qualibat|label|certif|partenaire|\.svg|\.gif|google|facebook|instagram|linkedin|youtube|tripadvisor|pagesjaunes/i;
  const candidates = [...c.images, ...extraCollected.flatMap((x) => x.images)]
    .filter((i) => !i.logo && !IMG_SKIP.test(i.url) && i.url !== logo && (!i.w || i.w >= 300))
    .map((i) => i.url).filter((u, i, a) => a.indexOf(u) === i).slice(0, 14);
  if (c.og && !IMG_SKIP.test(c.og) && c.og !== logo && !candidates.includes(c.og)) candidates.unshift(c.og);
  const sizes = await Promise.all(candidates.map((u) => imageSize(u)));
  const photos = candidates.map((u, i) => ({ u, s: sizes[i] })).filter((x) => x.s === 1 || x.s >= 30_000);
  const hero = [...photos].sort((a, b) => b.s - a.s)[0]?.u || "";
  const images = [hero, ...photos.map((x) => x.u).filter((u) => u !== hero)].filter(Boolean).slice(0, 7);

  const data: SiteData = {
    source: home.url, host: ownDomain, name, logo, eyebrow, tagline, intro, about, services: services.slice(0, 6), images,
    phone, email, address: found.address, city, hours, accent, socials: c.socials.slice(0, 4),
  };
  return { data, html: renderSite(data) };
}

/* ---------------- Rendu ---------------- */

const SLUG_STOP = /\b(sarl|sas|sasu|eurl|sa|snc|sci|scop|ei|eirl|selarl|ets|etablissements?|entreprise|societe|soci[ée]t[ée]|groupe|the|le|la|les|l|et|de|du|des)\b/g;
export const RESERVED_SLUGS = new Set(["www", "prospection", "mail", "webmail", "smtp", "imap", "pop", "ftp", "autodiscover", "autoconfig", "api", "app", "admin", "go", "cdn", "static", "dev", "test", "staging", "blog", "shop", "support", "aide", "contact", "yontech", "piloz", "netozia", "querax", "verif-maquette"]);
export function slugify(name: string) {
  const base = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " et ").replace(/['’]/g, " ")
    .replace(SLUG_STOP, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return base.length >= 2 ? base : "site-" + crypto.randomUUID().slice(0, 6);
}

const SERVICE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export function renderSite(d: SiteData) {
  const e = htmlEscape;
  const accent = /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : FALLBACK_ACCENT;
  const ink = inkOf(accent);
  const tel = d.phone ? "tel:" + d.phone.replace(/\s/g, "") : "";
  const year = new Date().getFullYear();
  const hero = d.images[0] || "";
  const gallery = d.images.slice(1, 7);
  const aboutImage = gallery.length >= 4 ? gallery.pop() : "";
  const initials = d.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const nav = [d.services.length ? ["#services", "Services"] : null, d.about.length ? ["#apropos", "À propos"] : null, gallery.length ? ["#realisations", "Réalisations"] : null, ["#contact", "Contact"]].filter(Boolean) as string[][];
  const facts = [d.city ? `<li><b>Basé à</b><span>${e(d.city)}</span></li>` : "", d.phone ? `<li><b>Téléphone</b><span>${e(d.phone)}</span></li>` : "", d.hours[0] ? `<li><b>Horaires</b><span>${e(d.hours[0])}</span></li>` : ""].filter(Boolean).join("");
  const mapQuery = encodeURIComponent(d.address || [d.name, d.city].filter(Boolean).join(" "));

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${e(d.name)}${d.eyebrow ? " · " + e(d.eyebrow) : ""}</title>
<meta name="description" content="${e(d.intro)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--a:${accent};--ai:${ink};--ink:#14161c;--txt:#3d4250;--mut:#6b7080;--line:#e6e8ee;--bg:#ffffff;--soft:#f5f6f9;--r:18px}
*{box-sizing:border-box}html{scroll-behavior:smooth;overflow-x:clip}body{overflow-x:clip}
body{margin:0;font-family:"Plus Jakarta Sans",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--txt);background:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit}
.hero-in>*,.split>*,.grid>*,.ft>*{min-width:0}h1,h2,h3,p{overflow-wrap:break-word}
.wrap{width:min(1160px,100% - 40px);margin:0 auto}
.yt-bar{background:#14161c;color:#d9dbe4;font-size:13px;padding:9px 20px;text-align:center}
.yt-bar b{color:#fff}.yt-bar a{color:#fff;font-weight:700;margin-left:6px}
.hd{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.hd-in{display:flex;align-items:center;gap:24px;height:74px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-weight:800;color:var(--ink);font-size:18px;letter-spacing:-.01em;min-width:0}
.brand img{max-height:48px;max-width:190px;width:auto;object-fit:contain}
.mono{width:42px;height:42px;border-radius:12px;background:var(--ai);color:#fff;display:grid;place-items:center;font-weight:800;font-size:16px;flex:none}
.hd nav{margin-left:auto;display:flex;gap:28px;font-weight:600;font-size:15px}
.hd nav a{text-decoration:none;color:var(--txt)}.hd nav a:hover{color:var(--ai)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;background:var(--ai);color:#fff;text-decoration:none;font-weight:700;padding:15px 24px;border-radius:999px;font-size:15px;border:0;cursor:pointer;transition:transform .15s,box-shadow .15s;box-shadow:0 10px 24px -12px var(--ai)}
.btn:hover{transform:translateY(-2px)}
.btn-ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--line)}
.btn-sm{padding:11px 18px;font-size:14px}
.hero{padding:72px 0 64px;background:radial-gradient(1200px 500px at 85% -10%,color-mix(in srgb,var(--a) 14%,transparent),transparent 70%)}
.hero-in{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.eyebrow{display:inline-block;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ai);background:color-mix(in srgb,var(--a) 12%,#fff);padding:7px 14px;border-radius:999px;margin:0 0 20px}
h1{font-size:clamp(30px,4.6vw,58px);line-height:1.06;letter-spacing:-.03em;color:var(--ink);margin:0 0 20px;font-weight:800;text-wrap:balance}
.lead{font-size:18px;color:var(--txt);margin:0 0 30px;max-width:56ch}
.cta{display:flex;gap:12px;flex-wrap:wrap}
.facts{list-style:none;padding:0;margin:36px 0 0;display:flex;gap:30px;flex-wrap:wrap}
.facts li{display:flex;flex-direction:column;font-size:15px;color:var(--ink);font-weight:600}
.facts b{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);font-weight:700}
.hero-media{position:relative}
.hero-media img,.hero-ph{width:100%;aspect-ratio:4/3.4;object-fit:cover;border-radius:28px;box-shadow:0 40px 80px -40px rgba(20,22,28,.45)}
.hero-ph{background:linear-gradient(135deg,var(--a),var(--ai));display:grid;place-items:center;color:#fff;font-size:96px;font-weight:800;letter-spacing:-.04em}
.hero-media:after{content:"";position:absolute;inset:auto -14px -14px auto;width:42%;height:42%;border-radius:28px;background:color-mix(in srgb,var(--a) 22%,transparent);z-index:-1}
.sec{padding:96px 0}.sec.alt{background:var(--soft)}
.kicker{font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ai);margin:0 0 12px}
h2{font-size:clamp(28px,3.2vw,42px);line-height:1.12;letter-spacing:-.025em;color:var(--ink);margin:0 0 18px;font-weight:800;text-wrap:balance}
.sec-head{max-width:640px;margin-bottom:46px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:28px;transition:transform .2s,box-shadow .2s,border-color .2s}
.card:hover{transform:translateY(-4px);box-shadow:0 24px 50px -30px rgba(20,22,28,.35);border-color:color-mix(in srgb,var(--a) 40%,var(--line))}
.card .ic{width:46px;height:46px;border-radius:14px;background:color-mix(in srgb,var(--a) 13%,#fff);color:var(--ai);display:grid;place-items:center;margin-bottom:18px}
.card h3{font-size:19px;color:var(--ink);margin:0 0 8px;letter-spacing:-.01em}
.card p{margin:0;font-size:15px;color:var(--txt)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}
.split p{font-size:17px;margin:0 0 16px}
.about-img{border-radius:24px;width:100%;aspect-ratio:5/4;object-fit:cover}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.gal a{display:block;overflow:hidden;border-radius:16px;aspect-ratio:4/3;background:var(--soft)}
.gal img{width:100%;height:100%;object-fit:cover;transition:transform .5s}
.gal a:hover img{transform:scale(1.06)}
.contact{background:#14161c;color:#c9ccd6}
.contact h2{color:#fff}.contact .kicker{color:color-mix(in srgb,var(--a) 70%,#fff)}
.info{list-style:none;padding:0;margin:26px 0 0;display:grid;gap:18px}
.info li{display:flex;gap:14px;align-items:flex-start;font-size:16px}
.info .k{width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,.08);display:grid;place-items:center;flex:none;color:#fff;font-size:17px}
.info b{display:block;color:#fff;font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}
.info a{color:#fff;text-decoration:none}
.form{background:#fff;border-radius:24px;padding:30px;display:grid;gap:14px;color:var(--txt)}
.form h3{margin:0 0 4px;color:var(--ink);font-size:21px}
.form label{display:grid;gap:6px;font-size:13px;font-weight:700;color:var(--ink)}
.form input,.form textarea{font:inherit;font-size:15px;border:1.5px solid var(--line);border-radius:12px;padding:13px 14px;color:var(--ink);background:#fff}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 4px color-mix(in srgb,var(--a) 18%,transparent)}
.form .ok{display:none;background:color-mix(in srgb,var(--a) 12%,#fff);color:var(--ink);border-radius:12px;padding:12px 14px;font-size:14px}
.map iframe{display:block;width:100%;height:340px;border:0;filter:grayscale(.2)}
footer{background:#0e1015;color:#8d91a0;font-size:14px;padding:34px 0}
.ft{display:flex;gap:18px;justify-content:space-between;flex-wrap:wrap;align-items:center}
.ft a{color:#c9ccd6;text-decoration:none;margin-right:14px}
.ft .yt{color:#8d91a0}.ft .yt a{color:#fff;font-weight:700}
.fab{display:none;position:fixed;right:16px;bottom:16px;z-index:30;background:var(--ai);color:#fff;text-decoration:none;font-weight:800;padding:15px 20px;border-radius:999px;box-shadow:0 16px 30px -12px rgba(0,0,0,.5)}
.rv{opacity:0;transform:translateY(22px);transition:opacity .7s ease,transform .7s ease}.rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}
@media (max-width:900px){.hero-in,.split{grid-template-columns:1fr;gap:36px}.hd nav{display:none}.hd .btn-sm{margin-left:auto}.gal{grid-template-columns:repeat(2,1fr)}.sec{padding:70px 0}.hero{padding:44px 0 50px}}
@media (max-width:560px){.fab{display:inline-flex}.hd .btn-sm{display:none}.brand img{max-width:150px}.facts{gap:20px}.yt-bar{font-size:12px}}
</style>
</head>
<body>
<div class="yt-bar">Proposition de nouveau site pour <b>${e(d.name)}</b>, réalisée par Yontech à partir du site actuel. Ce n'est pas le site officiel.<a href="${e(d.source)}" target="_blank" rel="noopener nofollow">Voir le site actuel</a></div>
<header class="hd"><div class="wrap hd-in">
<a class="brand" href="#top">${d.logo ? `<img src="${e(d.logo)}" alt="${e(d.name)}">` : `<span class="mono">${e(initials)}</span><span>${e(d.name)}</span>`}</a>
<nav>${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join("")}</nav>
${tel ? `<a class="btn btn-sm" href="${e(tel)}">Appeler</a>` : `<a class="btn btn-sm" href="#contact">Nous écrire</a>`}
</div></header>

<section class="hero" id="top"><div class="wrap hero-in">
<div class="rv">
${d.eyebrow ? `<p class="eyebrow">${e(d.eyebrow)}</p>` : ""}
<h1>${e(d.tagline)}</h1>
${d.intro ? `<p class="lead">${e(d.intro)}</p>` : ""}
<div class="cta"><a class="btn" href="#contact">Demander un devis</a>${tel ? `<a class="btn btn-ghost" href="${e(tel)}">${e(d.phone)}</a>` : ""}</div>
${facts ? `<ul class="facts">${facts}</ul>` : ""}
</div>
<div class="hero-media rv">${hero ? `<img src="${e(hero)}" alt="${e(d.name)}" fetchpriority="high">` : `<div class="hero-ph">${e(initials)}</div>`}</div>
</div></section>

${d.services.length ? `<section class="sec alt" id="services"><div class="wrap">
<div class="sec-head rv"><p class="kicker">Services</p><h2>Ce que ${e(d.name)} fait pour vous</h2></div>
<div class="grid">${d.services.map((s) => `<article class="card rv"><div class="ic">${SERVICE_ICON}</div><h3>${e(s.title)}</h3>${s.text ? `<p>${e(s.text)}</p>` : ""}</article>`).join("")}</div>
</div></section>` : ""}

${d.about.length ? `<section class="sec" id="apropos"><div class="wrap split">
<div class="rv"><p class="kicker">À propos</p><h2>${e(d.name)}</h2>${d.about.map((p) => `<p>${e(p)}</p>`).join("")}<a class="btn" href="#contact" style="margin-top:10px">Parler de votre projet</a></div>
<div class="rv">${aboutImage ? `<img class="about-img" src="${e(aboutImage)}" alt="${e(d.name)}" loading="lazy">` : (hero ? `<img class="about-img" src="${e(hero)}" alt="${e(d.name)}" loading="lazy">` : `<div class="hero-ph" style="aspect-ratio:5/4">${e(initials)}</div>`)}</div>
</div></section>` : ""}

${gallery.length ? `<section class="sec${d.about.length ? " alt" : ""}" id="realisations"><div class="wrap">
<div class="sec-head rv"><p class="kicker">Réalisations</p><h2>En images</h2></div>
<div class="gal">${gallery.map((g) => `<a class="rv" href="${e(g)}" target="_blank" rel="noopener"><img src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div>
</div></section>` : ""}

<section class="sec contact" id="contact"><div class="wrap split">
<div class="rv"><p class="kicker">Contact</p><h2>Parlons de votre projet</h2>
<ul class="info">
${d.address ? `<li><span class="k">⌖</span><div><b>Adresse</b>${e(d.address)}</div></li>` : d.city ? `<li><span class="k">⌖</span><div><b>Ville</b>${e(d.city)}</div></li>` : ""}
${d.phone ? `<li><span class="k">☎</span><div><b>Téléphone</b><a href="${e(tel)}">${e(d.phone)}</a></div></li>` : ""}
${d.email ? `<li><span class="k">@</span><div><b>E-mail</b><a href="mailto:${e(d.email)}">${e(d.email)}</a></div></li>` : ""}
${d.hours.length ? `<li><span class="k">◷</span><div><b>Horaires</b>${d.hours.map((h) => e(h)).join("<br>")}</div></li>` : ""}
</ul></div>
<form class="form rv" onsubmit="event.preventDefault();this.querySelector('.ok').style.display='block'">
<h3>Demande de devis</h3>
<label>Votre nom<input name="nom" autocomplete="name" required></label>
<label>Téléphone<input name="tel" type="tel" autocomplete="tel" required></label>
<label>Votre projet<textarea name="msg" rows="4"></textarea></label>
<button class="btn" type="submit">Envoyer ma demande</button>
<p class="ok">Formulaire de démonstration : dans la version en ligne, votre demande arrivera directement chez ${e(d.name)}.</p>
</form>
</div></section>
${d.address || d.city ? `<div class="map"><iframe title="Plan d'accès" loading="lazy" src="https://www.google.com/maps?q=${mapQuery}&output=embed"></iframe></div>` : ""}

<footer><div class="wrap ft">
<div>© ${year} ${e(d.name)}${d.address ? " · " + e(d.address) : ""}</div>
<div>${d.socials.map((s) => `<a href="${e(s.url)}" target="_blank" rel="noopener">${e(s.label)}</a>`).join("")}<span class="yt">Maquette réalisée par <a href="https://yontech.fr" target="_blank" rel="noopener">Yontech</a></span></div>
</div></footer>
${tel ? `<a class="fab" href="${e(tel)}">☎ Appeler</a>` : ""}
<script>
(function(){var els=document.querySelectorAll('.rv');if(!('IntersectionObserver' in window)){els.forEach(function(x){x.classList.add('in')});return}
var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}})},{threshold:.12});
els.forEach(function(x){io.observe(x)});
document.querySelectorAll('img').forEach(function(i){i.addEventListener('error',function(){var p=i.closest('.gal a');if(p)p.remove();else i.style.display='none'})});})();
</script>
</body>
</html>`;
}
