import { htmlEscape } from "./yontech-core.ts";
import type { Block, PageModel, SiteData, Theme } from "./yontech-maquette.ts";

// Rendu des maquettes de refonte. Chaque maquette tire une combinaison de
// variantes (polices, accroche, en-tête, services, galerie, bandeau, arrondis,
// titres) à partir de son nom : deux prospects n'ont presque jamais le même
// site, et une même maquette garde le sien d'un affichage à l'autre. Le bouton
// « Changer de style » de l'outil tire une nouvelle combinaison.

export const FALLBACK_ACCENT = "#1e5aa8";

export type Layout = "classic" | "studio" | "nuit" | "bento";
export const LAYOUTS: Layout[] = ["studio", "nuit", "bento", "classic"];
export type Variant = {
  layout?: Layout; font: number; hero: "overlay" | "split" | "card" | "center"; header: "light" | "dark" | "topbar";
  services: "cards" | "images" | "rows"; gallery: "bento" | "grid" | "strip"; band: "accent" | "dark" | "photo";
  radius: "base" | "sharp" | "round"; about: "frame" | "plain"; titles: number;
};

/* ---------------- Couleurs ---------------- */

function hexToRgb(hex: string) {
  let h = String(hex || "").replace("#", "").toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (rgb: number[]) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function luminance([r, g, b]: number[]) {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
// Version de la couleur assez foncée pour porter un texte blanc.
export function inkOf(accent: string) {
  let rgb = hexToRgb(accent) || hexToRgb(FALLBACK_ACCENT)!;
  for (let i = 0; i < 12 && 1.05 / (luminance(rgb) + 0.05) < 4.2; i++) rgb = rgb.map((v) => v * 0.86);
  return toHex(rgb);
}
function rgba(hex: string, alpha: number) {
  const rgb = hexToRgb(hex) || [30, 90, 168];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/* ---------------- Images ---------------- */

// Images servies par img.yontech.fr (Worker Cloudflare, mises en cache) :
// pas de blocage par le site d'origine, pas d'image http sur une page https.
export const IMG_PROXY = "https://img.yontech.fr/_img?u=";
export const px = (u: string) => (u && /^https?:\/\//i.test(u) ? IMG_PROXY + encodeURIComponent(u) : u || "");

/* ---------------- Variantes ---------------- */

function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
export function pickVariant(seed: string): Variant {
  const r = seeded(seed || String(Math.random()));
  const one = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  return {
    layout: one(LAYOUTS), font: Math.floor(r() * 3), hero: one(["overlay", "split", "card", "center"]), header: one(["light", "dark", "topbar"]),
    services: one(["cards", "images", "rows"]), gallery: one(["bento", "grid", "strip"]), band: one(["accent", "dark", "photo"]),
    radius: one(["base", "sharp", "round"]), about: one(["frame", "plain"]), titles: Math.floor(r() * 4),
  };
}

type FontSet = { fonts: string; head: string; body: string; weight: number; upper: boolean; tracking: string };
const FONTS: Record<Theme, FontSet[]> = {
  atelier: [
    { fonts: "family=Fraunces:opsz,wght@9..144,500;9..144,650;9..144,750&family=Inter:wght@400;500;600;700", head: '"Fraunces",Georgia,serif', body: '"Inter",system-ui,sans-serif', weight: 650, upper: false, tracking: "-.015em" },
    { fonts: "family=Playfair+Display:wght@600;700;800&family=Source+Sans+3:wght@400;500;600;700", head: '"Playfair Display",Georgia,serif', body: '"Source Sans 3",system-ui,sans-serif', weight: 700, upper: false, tracking: "-.01em" },
    { fonts: "family=Cormorant+Garamond:wght@600;700&family=Manrope:wght@400;500;600;700", head: '"Cormorant Garamond",Georgia,serif', body: '"Manrope",system-ui,sans-serif', weight: 700, upper: false, tracking: "-.005em" },
  ],
  chantier: [
    { fonts: "family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700", head: '"Barlow Condensed","Arial Narrow",Arial,sans-serif', body: '"Barlow",system-ui,sans-serif', weight: 800, upper: true, tracking: ".005em" },
    { fonts: "family=Oswald:wght@500;600;700&family=Roboto:wght@400;500;700", head: '"Oswald","Arial Narrow",Arial,sans-serif', body: '"Roboto",system-ui,sans-serif', weight: 600, upper: true, tracking: ".01em" },
    { fonts: "family=Archivo:wdth,wght@62..125,700..900&family=Archivo:wght@400;500;600", head: '"Archivo",Arial,sans-serif', body: '"Archivo",system-ui,sans-serif', weight: 850, upper: false, tracking: "-.02em" },
  ],
  moderne: [
    { fonts: "family=Plus+Jakarta+Sans:wght@400;500;600;700;800", head: '"Plus Jakarta Sans",system-ui,sans-serif', body: '"Plus Jakarta Sans",system-ui,sans-serif', weight: 800, upper: false, tracking: "-.03em" },
    { fonts: "family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700", head: '"Sora",system-ui,sans-serif', body: '"Inter",system-ui,sans-serif', weight: 700, upper: false, tracking: "-.03em" },
    { fonts: "family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700;9..40,800", head: '"DM Sans",system-ui,sans-serif', body: '"DM Sans",system-ui,sans-serif', weight: 800, upper: false, tracking: "-.035em" },
  ],
};
const PALETTE: Record<Theme, { bg: string; soft: string; ink: string; r: string }> = {
  atelier: { bg: "#fbf8f3", soft: "#f2ebe1", ink: "#211b16", r: "16px" },
  chantier: { bg: "#ffffff", soft: "#f1f2f4", ink: "#101217", r: "8px" },
  moderne: { bg: "#ffffff", soft: "#f4f5f8", ink: "#14161c", r: "20px" },
};
const TITLES = {
  services: ["Ce que nous faisons pour vous", "Nos prestations", "Nos savoir-faire", "Nos domaines d'intervention"],
  servicesK: ["Nos services", "Prestations", "Savoir-faire", "Expertises"],
  gallery: ["Notre travail en images", "Nos réalisations", "Quelques chantiers", "En images"],
  band: ["Un projet ? Parlons-en.", "Parlons de votre projet", "Besoin d'un devis ?", "Votre projet commence ici"],
  contact: ["Nous trouver, nous joindre", "Nous contacter", "Où nous trouver", "Contact"],
  about: ["L'entreprise", "Qui sommes-nous", "Notre histoire", "À propos"],
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
const short = (t: string, n: number) => { const s = String(t || "").trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…"; };

/* ---------------- Rendu ---------------- */

export function renderSite(input: SiteData) {
  return renderAll(input).home;
}

export function renderAll(input: SiteData): { home: string; pages: { path: string; html: string }[] } {
  const e = htmlEscape;
  const theme: Theme = input.theme && FONTS[input.theme] ? input.theme : "moderne";
  const V: Variant = input.variant || pickVariant(input.host || input.name);
  // Mise en page : studio (éditorial), nuit (immersif sombre), bento (tuiles), classique.
  const layout: Layout = V.layout || LAYOUTS[Math.floor(seeded("mise-en-page:" + (input.host || input.name))() * LAYOUTS.length)];
  const dark = layout === "nuit";
  const F = FONTS[theme][V.font % 3], P = PALETTE[theme];
  const R = V.radius === "sharp" ? "4px" : V.radius === "round" ? "26px" : P.r;
  const pill = V.radius === "round" || (V.radius === "base" && theme !== "chantier");
  const accent = /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent : FALLBACK_ACCENT;
  const ink = inkOf(accent);

  // Images : chacune n'apparaît qu'une fois (répartition faite à la génération ;
  // repli pour les anciennes maquettes).
  const heroImg = px(input.heroImage ?? input.images[0] ?? "");
  const aboutImg = px(input.aboutImage ?? input.images[1] ?? "");
  const galleryImgs = (input.gallery ?? input.images.slice(2, 8)).map(px).filter(Boolean);
  const bandImg = px(input.bandImage || "");
  const services = (input.services.length >= 2 ? input.services : []).map((s) => ({ ...s, image: px(s.image || "") }));
  const withImages = services.filter((s) => s.image).length >= Math.min(3, services.length) && services.length >= 2;
  const servicesMode = V.services !== "cards" && withImages ? V.services : "cards";
  const withText = services.filter((x) => x.text).length * 2 >= services.length;
  const pages = (input.pages || []).slice(0, 7).map((pg) => ({ ...pg, image: px(pg.image), blocks: pg.blocks.map((b) => (b.t === "img" ? { ...b, v: px(b.v) } : b)) }));
  const d = { ...input, logo: px(input.logo) };
  const tel = d.phone ? "tel:" + d.phone.replace(/\s/g, "") : "";
  const year = new Date().getFullYear();
  const initials = d.name.split(/\s+/).filter((w) => /[A-Za-zÀ-ÿ0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const facts = (d.facts || []).length >= 2 ? (d.facts || []).slice(0, 4) : [];
  const quick = [d.city ? { k: "pin", v: d.city } : null, d.phone ? { k: "phone", v: d.phone } : null, d.hours[0] ? { k: "clock", v: d.hours[0] } : null].filter(Boolean) as { k: string; v: string }[];
  const multi = pages.length > 0;
  const gallery = galleryImgs.length >= 3 ? galleryImgs.slice(0, 6) : [];
  const nav = (multi
    ? [...(pages.length <= 3 ? [["/", "Accueil"]] : []), ...pages.slice(0, 4).map((pg) => [pg.path, pg.label]), ["#contact", "Contact"]]
    : [services.length ? ["#services", "Services"] : null, d.about.length ? ["#apropos", "L'entreprise"] : null, gallery.length ? ["#realisations", "Réalisations"] : null, ["#contact", "Contact"]].filter(Boolean)) as string[][];

  // Carte : seulement avec une vraie adresse (code postal) ou une ville connue, toujours en France.
  const cp = (d.address.match(/\b\d{5}\b/) || [])[0] || d.cp || "";
  const mapQ = /\b\d{5}\b/.test(d.address) ? `${d.address}, France` : d.city ? `${[cp, d.city].filter(Boolean).join(" ")}, France` : "";
  const mapZoom = /\b\d{5}\b/.test(d.address) ? 15 : 12;
  const mapEnc = encodeURIComponent(mapQ);

  const brand = d.logo
    ? `<img onerror="yf(this)" crossorigin="anonymous" src="${e(d.logo)}" alt="${e(d.name)}" data-logo><span class="mono" hidden>${e(initials)}</span><span class="bname" hidden>${e(d.name)}</span>`
    : `<span class="mono">${e(initials)}</span><span class="bname">${e(d.name)}</span>`;
  const H = (tag: string, text: string, cls = "") => `<${tag}${cls ? ` class="${cls}"` : ""}>${e(text)}</${tag}>`;
  const t = V.titles % 4;
  const darkHeader = V.header === "dark" || dark;
  const heroMode = heroImg ? V.hero : "flat";
  const factsOverlap = heroMode === "overlay" || heroMode === "center";

  const css = `
:root{--a:${accent};--ai:${ink};--a10:${rgba(accent, .1)};--a18:${rgba(accent, .18)};--ink:${dark ? "#f3f4f7" : P.ink};--txt:${dark ? "#b8bdcb" : "#41454f"};--mut:${dark ? "#8a8fa0" : "#6b6f7b"};--line:${dark ? "rgba(255,255,255,.1)" : rgba(P.ink, .1)};--bg:${dark ? "#0a0b0f" : layout === "bento" ? "#f3f4f6" : P.bg};--soft:${dark ? "#101219" : layout === "bento" ? "#eceef2" : P.soft};--card:${dark ? "#151821" : "#ffffff"};--r:${R};--hf:${F.head};--bf:${F.body}}
[hidden]{display:none!important}
*{box-sizing:border-box}html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;font-family:var(--bf);color:var(--txt);background:var(--bg);line-height:1.65;font-size:16.5px;-webkit-font-smoothing:antialiased;overflow-x:clip}
img{max-width:100%;display:block}a{color:inherit}
img[data-ph]{opacity:0;transition:opacity .5s}img[data-ph].ok{opacity:1}
.phero img[data-ph].ok{opacity:.45}
h1,h2,h3{font-family:var(--hf);font-weight:${F.weight};color:var(--ink);letter-spacing:${F.tracking};line-height:1.06;margin:0;text-wrap:balance;overflow-wrap:break-word${F.upper ? ";text-transform:uppercase" : ""}}
p{overflow-wrap:break-word}
.wrap{width:min(1180px,100% - 40px);margin:0 auto}
.wrap>*,.grid>*,.split>*,.ct>*,.hsplit>*{min-width:0}
.yt-bar{background:#0d0f14;color:#c9ccd6;font:500 12.5px/1.45 system-ui,sans-serif;padding:8px 16px;text-align:center}
.yt-bar b{color:#fff}.yt-bar a{color:#fff;font-weight:700;margin-left:8px}
.topbar{background:var(--ai);color:rgba(255,255,255,.92);font-size:13.5px}
.topbar .wrap{display:flex;gap:26px;justify-content:flex-end;align-items:center;flex-wrap:wrap;padding:8px 0}
.topbar span{display:inline-flex;gap:8px;align-items:center}.topbar a{color:#fff;text-decoration:none;font-weight:600}
.hd{position:sticky;top:0;z-index:30;background:${darkHeader ? "rgba(13,15,20,.96)" : rgba(P.bg, .95)};backdrop-filter:saturate(1.5) blur(12px);transition:box-shadow .25s}
.hd.sc{box-shadow:0 10px 30px -18px rgba(0,0,0,.35)}
.hd-in{display:flex;align-items:center;gap:28px;height:84px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;min-width:0}
.brand img{height:60px;width:auto;max-width:240px;object-fit:contain${darkHeader ? ";background:#fff;border-radius:10px;padding:6px 12px;height:56px" : ""}}
.brand.dark img{background:#14161c;border-radius:10px;padding:6px 12px;height:58px}
.mono{width:46px;height:46px;border-radius:calc(var(--r) * .6);background:var(--ai);color:#fff;display:grid;place-items:center;font:800 17px var(--bf);flex:none}
.bname{font-family:var(--hf);font-weight:${F.weight};font-size:20px;color:${darkHeader ? "#fff" : "var(--ink)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis${F.upper ? ";text-transform:uppercase" : ""}}
.hd nav{margin-left:auto;display:flex;gap:24px;font-weight:600;font-size:15px}
.hd nav a{text-decoration:none;color:${darkHeader ? "#fff" : "var(--ink)"};opacity:.8;position:relative;white-space:nowrap}
.hd nav a:after{content:"";position:absolute;left:0;right:100%;bottom:-6px;height:2px;background:var(--a);transition:right .25s}
.hd nav a:hover,.hd nav a.on{opacity:1}.hd nav a:hover:after,.hd nav a.on:after{right:0}
.burger{display:none;margin-left:12px;width:44px;height:44px;border:1px solid ${darkHeader ? "rgba(255,255,255,.25)" : "var(--line)"};border-radius:12px;background:transparent;cursor:pointer;flex-direction:column;justify-content:center;align-items:center;gap:5px}
.burger span{display:block;width:20px;height:2px;background:${darkHeader ? "#fff" : "var(--ink)"};border-radius:2px;transition:transform .2s,opacity .2s}
.hd.open .burger span:nth-child(1){transform:translateY(7px) rotate(45deg)}.hd.open .burger span:nth-child(2){opacity:0}.hd.open .burger span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:var(--ai);color:#fff;text-decoration:none;font:700 15.5px var(--bf);padding:16px 26px;border-radius:${pill ? "999px" : `calc(var(--r) * .5)`};border:0;cursor:pointer;white-space:nowrap;transition:transform .18s,box-shadow .18s,background .18s;box-shadow:0 14px 28px -14px var(--ai)${F.upper ? ";text-transform:uppercase;letter-spacing:.04em;font-size:14.5px" : ""}}
.btn:hover{transform:translateY(-2px);box-shadow:0 18px 34px -14px var(--ai)}
.btn svg{transition:transform .18s}.btn:hover svg{transform:translateX(3px)}
.btn-glass{background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.45);backdrop-filter:blur(6px)}
.btn-line{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--line)}
.btn-sm{padding:12px 20px;font-size:14.5px}
.btn-light{background:#fff;color:var(--ai);box-shadow:none}
.cta{display:flex;gap:12px;flex-wrap:wrap}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:700 13px var(--bf);letter-spacing:.14em;text-transform:uppercase;margin:0 0 22px}
.eyebrow:before{content:"";width:34px;height:3px;background:var(--a);border-radius:2px}
.lead{font-size:clamp(17px,1.6vw,20px);max-width:54ch;margin:0 0 34px}
.quick{list-style:none;display:flex;gap:26px;flex-wrap:wrap;padding:0;margin:38px 0 0;font-size:15px}
.quick li{display:flex;gap:9px;align-items:center}.quick svg{color:var(--a)}
@keyframes kb{from{transform:scale(1.12)}to{transform:scale(1)}}

/* Accroche : photo plein écran */
.hero{position:relative;overflow:hidden}
.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:kb 22s ease-out both}
.h-overlay,.h-center,.h-card{color:#fff;min-height:min(86vh,780px);display:flex;background:#0d0f14}
.h-overlay{align-items:flex-end}
.h-overlay:before,.h-center:before{content:"";position:absolute;inset:0;z-index:1}
.h-overlay:before{background:linear-gradient(90deg,rgba(10,12,16,.9) 0%,rgba(10,12,16,.68) 45%,rgba(10,12,16,.2) 100%),linear-gradient(0deg,rgba(10,12,16,.7) 0%,transparent 45%)}
.h-overlay .wrap,.h-center .wrap{position:relative;z-index:2;padding:120px 0 ${facts.length ? "150px" : "90px"}}
.h-overlay h1,.h-center h1{color:#fff;font-size:clamp(38px,6.2vw,82px);max-width:15ch;margin-bottom:22px}
.h-overlay .lead,.h-center .lead{color:rgba(255,255,255,.86)}
.h-overlay .eyebrow,.h-center .eyebrow{color:#fff}.h-overlay .quick,.h-center .quick{color:rgba(255,255,255,.9)}
/* Accroche : centrée */
.h-center{align-items:center;text-align:center}
.h-center:before{background:rgba(10,12,16,.62)}
.h-center h1{margin-left:auto;margin-right:auto;max-width:18ch}.h-center .lead{margin-left:auto;margin-right:auto}
.h-center .cta,.h-center .quick{justify-content:center}.h-center .eyebrow{justify-content:center}
/* Accroche : carte posée sur la photo */
.h-card{align-items:flex-end;min-height:min(82vh,740px)}
.h-card .wrap{position:relative;z-index:2;padding:160px 0 0}
.h-card .panel{background:var(--bg);color:var(--txt);max-width:640px;padding:44px 44px 40px;border-radius:var(--r) var(--r) 0 0;box-shadow:0 -10px 40px -20px rgba(0,0,0,.4)}
.h-card h1{font-size:clamp(34px,4.6vw,62px);margin-bottom:18px}.h-card .eyebrow{color:var(--ai)}
/* Accroche : deux colonnes */
.h-split{background:radial-gradient(900px 480px at 0% 0%,var(--a10),transparent 70%),var(--bg);padding:70px 0 ${facts.length ? "40px" : "80px"}}
.hsplit{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.h-split h1{font-size:clamp(36px,5vw,68px);margin-bottom:20px}.h-split .eyebrow{color:var(--ai)}
.h-split .media{position:relative}
.h-split .media img{width:100%;aspect-ratio:4/4.3;object-fit:cover;border-radius:var(--r);box-shadow:0 40px 80px -40px rgba(10,12,16,.5)}
.h-split .media .badge{position:absolute;left:-22px;bottom:28px;background:var(--card);border-radius:calc(var(--r) * .7);padding:14px 18px;box-shadow:0 20px 40px -20px rgba(10,12,16,.45);display:flex;gap:10px;align-items:center;font-weight:700;color:var(--ink)}
.h-split .media .badge svg{color:var(--ai)}
/* Accroche sans photo */
.h-flat{background:radial-gradient(900px 480px at 85% 0%,var(--a18),transparent 70%),var(--bg);padding:90px 0 ${facts.length ? "140px" : "90px"}}
.h-flat h1{font-size:clamp(38px,6vw,76px);max-width:16ch;margin-bottom:22px}.h-flat .eyebrow{color:var(--ai)}

/* Chiffres */
.facts{position:relative;z-index:5;margin-top:${factsOverlap ? "-78px" : "0"}${!factsOverlap ? ";padding-top:36px" : ""}}
.facts-in{background:var(--card);border-radius:var(--r);box-shadow:0 30px 60px -30px rgba(10,12,16,.35);display:grid;grid-template-columns:repeat(${Math.max(facts.length, 1)},1fr);overflow:hidden;border:1px solid var(--line)}
.fact{padding:28px 30px;border-left:1px solid var(--line)}.fact:first-child{border-left:0}
.fact b{display:block;font-family:var(--hf);font-weight:${F.weight};font-size:clamp(28px,3vw,40px);line-height:1;color:var(--ai);letter-spacing:${F.tracking}}
.fact span{display:block;margin-top:8px;font-size:14px;color:var(--mut);font-weight:600${F.upper ? ";text-transform:uppercase;letter-spacing:.06em;font-size:13px" : ""}}

.sec{padding:110px 0}.sec.soft{background:var(--soft)}
.kicker{display:inline-flex;align-items:center;gap:10px;font:800 12.5px var(--bf);letter-spacing:.16em;text-transform:uppercase;color:var(--ai);margin:0 0 16px}
.kicker:before{content:"";width:26px;height:2px;background:var(--a)}
h2{font-size:clamp(32px,4vw,54px);margin-bottom:18px}
.head{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:end;margin-bottom:54px}

/* Services */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px}
.tiles{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.tiles li{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r) * .7);padding:18px 20px;font-family:var(--hf);font-weight:${F.weight};font-size:${F.upper ? "21px" : "18px"};color:var(--ink);line-height:1.2;transition:transform .2s,border-color .2s${F.upper ? ";text-transform:uppercase" : ""}}
.tiles li:hover{transform:translateY(-3px);border-color:var(--a)}
.tiles li:before{content:"";width:12px;height:12px;border-radius:3px;background:var(--a);flex:none;transform:rotate(45deg)}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:34px 30px 32px;overflow:hidden;transition:transform .25s,box-shadow .25s,border-color .25s}
.card:after{content:"";position:absolute;left:0;bottom:0;height:4px;width:0;background:var(--a);transition:width .35s}
.card:hover{transform:translateY(-6px);box-shadow:0 30px 60px -36px rgba(10,12,16,.45);border-color:transparent}
.card:hover:after{width:100%}
.card .n{font-family:var(--hf);font-weight:${F.weight};font-size:46px;line-height:1;-webkit-text-stroke:1.5px var(--a);color:transparent;margin-bottom:22px;display:block}
.card h3{font-size:${F.upper ? "26px" : "22px"};line-height:1.15;margin-bottom:10px}
.card p{margin:0;font-size:15.5px}
.icard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;transition:transform .25s,box-shadow .25s;display:flex;flex-direction:column}
.icard:hover{transform:translateY(-6px);box-shadow:0 30px 60px -36px rgba(10,12,16,.45)}
.icard .im{aspect-ratio:4/3;overflow:hidden;background:var(--soft)}.icard .im img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.icard:hover .im img{transform:scale(1.06)}
.icard .bd{padding:24px 24px 26px}.icard h3{font-size:${F.upper ? "24px" : "21px"};margin-bottom:8px}.icard p{margin:0;font-size:15px}
.rows{display:grid;gap:70px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}
.row:nth-child(even) .rim{order:2}
.rim img{width:100%;aspect-ratio:5/4;object-fit:cover;border-radius:var(--r)}
.row h3{font-size:clamp(26px,2.8vw,38px);margin-bottom:14px}.row p{font-size:17px;margin:0 0 10px}
.more{display:inline-flex;align-items:center;gap:8px;margin-top:16px;font-weight:700;color:var(--ai);text-decoration:none}

/* Entreprise */
.split{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center}
.ph{position:relative}
.ph img,.ph .ph-box{width:100%;aspect-ratio:4/4.4;object-fit:cover;border-radius:var(--r);position:relative;z-index:1}
.ph.frame:before{content:"";position:absolute;inset:26px -26px -26px 26px;border:2px solid var(--a);border-radius:var(--r)}
.ph.plain img{aspect-ratio:4/5}
.ph-box{background:linear-gradient(135deg,var(--a),var(--ai));display:grid;place-items:center;color:#fff;font:800 90px var(--hf)}
.about p{font-size:17.5px;margin:0 0 18px}
.solo .about{max-width:760px}
.checks{list-style:none;padding:0;margin:26px 0 30px;display:grid;gap:12px}
.checks li{display:flex;gap:12px;align-items:center;font-weight:600;color:var(--ink)}
.checks li:before{content:"";width:22px;height:22px;border-radius:50%;flex:none;background:var(--a10) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23${ink.slice(1)}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/13px no-repeat}

/* Réalisations */
.bento{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:230px;gap:14px}
.bento a,.ggrid a,.strip a{position:relative;display:block;overflow:hidden;border-radius:calc(var(--r) * .8);background:var(--soft)}
.bento a:first-child{grid-column:span 2;grid-row:span 2}
.bento img,.ggrid img,.strip img{width:100%;height:100%;object-fit:cover;transition:transform .7s cubic-bezier(.2,.7,.2,1)}
.bento a:hover img,.ggrid a:hover img,.strip a:hover img{transform:scale(1.06)}
.ggrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.ggrid a{aspect-ratio:4/3}.ggrid.g4{grid-template-columns:repeat(4,1fr)}
.strip{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:10px}
.strip a{flex:0 0 min(420px,80%);height:380px;scroll-snap-align:start}

/* Bandeau projet */
.band{position:relative;overflow:hidden;color:#fff;background:${V.band === "dark" ? "#111318" : "var(--ai)"}}
.band.photo{background:#0d0f14}.band.photo img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35}
.band:not(.photo):before{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:rgba(255,255,255,.07)}
.band-in{position:relative;z-index:1;display:flex;gap:30px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:70px 0}
.band h2{color:#fff;margin:0;font-size:clamp(30px,3.6vw,46px)}
.band p{margin:10px 0 0;color:rgba(255,255,255,.85);font-size:17px}
.band.dark .btn-light{background:var(--a);color:#fff}

/* Contact */
.ct{display:grid;grid-template-columns:1.05fr .95fr;gap:28px;align-items:stretch}
.box{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
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
.form h3{font-size:${F.upper ? "30px" : "26px"};margin-bottom:2px}
.form .sub{margin:0 0 6px;color:var(--mut);font-size:15px}
.form label{display:grid;gap:7px;font-size:13.5px;font-weight:700;color:var(--ink)}
.form input,.form textarea,.form select{font:inherit;font-size:15.5px;border:1.5px solid var(--line);border-radius:calc(var(--r) * .55);padding:14px 15px;color:var(--ink);background:var(--bg);transition:border-color .15s,box-shadow .15s}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 4px var(--a18);background:var(--card)}
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
.prose p{margin:0 0 18px}
.prose ul{padding:0;margin:0 0 22px;list-style:none;display:grid;gap:10px}
.prose li{position:relative;padding-left:30px}.prose li:before{content:"";position:absolute;left:4px;top:.55em;width:10px;height:10px;border-radius:3px;background:var(--a);transform:rotate(45deg)}
.prose figure{margin:28px 0;border-radius:var(--r);overflow:hidden}.prose figure img{width:100%;max-height:520px;object-fit:cover}
.aside{position:sticky;top:110px;display:grid;gap:16px}
.aside .box{padding:26px}.aside h3{font-size:22px;margin-bottom:10px}
.aside p{margin:0 0 16px;color:var(--mut);font-size:15px}.aside .btn{width:100%}
.aside ul{list-style:none;padding:0;margin:0;display:grid;gap:2px}
.aside ul a{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink);font-weight:600}
.aside ul a.on{color:var(--ai)}
.galp{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.galp a{display:block;border-radius:calc(var(--r) * .8);overflow:hidden;aspect-ratio:4/3;background:var(--soft)}
.galp img{width:100%;height:100%;object-fit:cover}

.rv{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}
.rv.in{opacity:1;transform:none}
.d1{transition-delay:.08s}.d2{transition-delay:.16s}.d3{transition-delay:.24s}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}.hero-bg{animation:none}html{scroll-behavior:auto}}
@media (max-width:980px){
  .hd nav{display:none}.burger{display:flex}.hd .btn-sm{margin-left:auto}
  .hd.open nav{display:flex;position:absolute;left:0;right:0;top:100%;flex-direction:column;gap:0;background:${darkHeader ? "#0d0f14" : "var(--bg)"};border-top:1px solid var(--line);box-shadow:0 20px 40px -20px rgba(0,0,0,.35);padding:8px 20px 16px}
  .hd.open nav a{padding:14px 0;border-bottom:1px solid ${darkHeader ? "rgba(255,255,255,.12)" : "var(--line)"};opacity:1}.hd.open nav a:after{display:none}
  .head,.split,.ct,.ft,.hsplit,.row,.art{grid-template-columns:1fr}.head{gap:14px}.split,.hsplit{gap:44px}.row{gap:26px}.row:nth-child(even) .rim{order:0}
  .bento{grid-template-columns:repeat(2,1fr);grid-auto-rows:170px}.ggrid,.ggrid.g4,.galp{grid-template-columns:repeat(2,1fr)}
  .facts-in{grid-template-columns:repeat(2,1fr)}.fact:nth-child(3){border-left:0}.fact:nth-child(n+3){border-top:1px solid var(--line)}
  .sec{padding:80px 0}.aside{position:static}
  .topbar .wrap{justify-content:center;gap:16px}
}
@media (max-width:600px){
  .hd-in{height:70px}.brand img{height:46px;max-width:170px}.hd .btn-sm{display:none}.burger{margin-left:auto}
  .h-overlay,.h-center,.h-card{min-height:auto}.h-overlay .wrap,.h-center .wrap{padding:90px 0 ${facts.length ? "120px" : "70px"}}
  .h-overlay:before{background:linear-gradient(0deg,rgba(10,12,16,.92) 10%,rgba(10,12,16,.55) 100%)}
  .h-card .wrap{padding-top:220px}.h-card .panel{padding:30px 22px}
  .h-split .media .badge{left:12px}
  .fact{padding:20px 18px}.row2{grid-template-columns:1fr}
  .info{padding:4px 20px}.form{padding:26px 20px}
  .ph.frame:before{inset:16px -10px -16px 16px}
  .strip a{height:300px}
  .fab{display:inline-flex}.yt-bar{font-size:11.5px}.topbar{display:none}
  .phero .wrap{padding:80px 0 56px}
}`;

  const head = (title: string, desc: string, current: string) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="${ink}">
<script>function yf(i){var p=i.closest('.bento a,.ggrid a,.strip a,.galp a');if(p){p.remove();return}if(i.classList.contains('hero-bg')||i.closest('.h-split .media')){var h=i.closest('.hero');if(h){h.className='hero h-flat';i.remove();var m=h.querySelector('.media');if(m)m.remove();return}}if(i.closest('.phero')){var q=i.closest('.phero');i.remove();q.classList.add('flat');return}var c=i.closest('.icard .im,.rim,figure');if(c){c.remove();return}var b=i.closest('.band.photo');if(b){i.remove();b.className='band accent';return}var a=i.closest('.ph');if(a){a.remove();var s=document.querySelector('#apropos .split');if(s)s.style.gridTemplateColumns='1fr';return}i.style.display='none';if(i.hasAttribute('data-logo')){[].forEach.call(i.parentNode.querySelectorAll('[hidden]'),function(x){x.hidden=false})}}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${F.fonts}&display=swap" rel="stylesheet">
${heroImg ? `<link rel="preload" as="image" href="${e(heroImg)}">` : ""}
<style>${css}${layoutCss}${layout === "studio" || layout === "nuit" ? marqueeCss : ""}</style>
</head>
<body>
<div class="yt-bar">Proposition de nouveau site pour <b>${e(d.name)}</b>, réalisée par Yontech à partir du site actuel. Ce n'est pas le site officiel.<a href="${e(d.source)}" target="_blank" rel="noopener nofollow">Voir le site actuel</a></div>
${V.header === "topbar" && (d.phone || d.email || d.city) ? `<div class="topbar"><div class="wrap">${d.city ? `<span>${icon("pin", 15)}${e(d.city)}</span>` : ""}${d.hours[0] ? `<span>${icon("clock", 15)}${e(d.hours[0])}</span>` : ""}${d.email ? `<span>${icon("mail", 15)}<a href="mailto:${e(d.email)}">${e(d.email)}</a></span>` : ""}${d.phone ? `<span>${icon("phone", 15)}<a href="${e(tel)}">${e(d.phone)}</a></span>` : ""}</div></div>` : ""}
<header class="hd" id="hd"><div class="wrap hd-in">
<a class="brand" href="${multi ? "/" : "#top"}" aria-label="${e(d.name)}">${brand}</a>
<nav id="nav">${nav.map(([h, l]) => `<a href="${e(h)}"${h === current ? ' class="on"' : ""}>${e(l)}</a>`).join("")}</nav>
<button class="burger" type="button" aria-label="Menu" aria-controls="nav" onclick="document.getElementById('hd').classList.toggle('open')"><span></span><span></span><span></span></button>
${tel ? `<a class="btn btn-sm" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : `<a class="btn btn-sm" href="#contact">Nous écrire</a>`}
</div></header>
`;

  const heroText = (onPhoto: boolean) => `${d.eyebrow ? `<p class="eyebrow rv">${e(d.eyebrow)}</p>` : ""}
<h1 class="rv d1">${e(d.tagline)}</h1>
${d.intro ? `<p class="lead rv d2">${e(d.intro)}</p>` : ""}
<div class="cta rv d3"><a class="btn" href="#contact">Demander un devis ${icon("arrow", 18)}</a>${tel ? `<a class="btn ${onPhoto ? "btn-glass" : "btn-line"}" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : ""}</div>
${!facts.length && quick.length ? `<ul class="quick rv d3">${quick.map((q) => `<li>${icon(q.k, 18)}${e(q.v)}</li>`).join("")}</ul>` : ""}`;

  const heroHtml = heroMode === "flat"
    ? `<section class="hero h-flat" id="top"><div class="wrap">${heroText(false)}</div></section>`
    : heroMode === "split"
    ? `<section class="hero h-split" id="top"><div class="wrap hsplit"><div>${heroText(false)}</div><div class="media rv d2"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(heroImg)}" alt="${e(d.name)}" fetchpriority="high">${d.city || d.phone ? `<div class="badge">${icon(d.city ? "pin" : "phone", 18)}${e(d.city || d.phone)}</div>` : ""}</div></div></section>`
    : heroMode === "card"
    ? `<section class="hero h-card" id="top"><img onerror="yf(this)" data-ph crossorigin="anonymous" class="hero-bg" src="${e(heroImg)}" alt="" fetchpriority="high"><div class="wrap"><div class="panel">${heroText(false)}</div></div></section>`
    : `<section class="hero h-${heroMode}" id="top"><img onerror="yf(this)" data-ph crossorigin="anonymous" class="hero-bg" src="${e(heroImg)}" alt="" fetchpriority="high"><div class="wrap">${heroText(true)}</div></section>`;

  const more = (link?: string) => (link ? `<a class="more" href="${e(link)}">En savoir plus ${icon("arrow", 16)}</a>` : "");
  const servicesBody = servicesMode === "images"
    ? `<div class="grid">${services.map((s, i) => `<article class="icard rv d${i % 3 + 1}">${s.image ? `<div class="im"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(s.image)}" alt="${e(s.title)}" loading="lazy"></div>` : ""}<div class="bd">${H("h3", s.title)}${s.text ? `<p>${e(s.text)}</p>` : ""}${more(s.link)}</div></article>`).join("")}</div>`
    : servicesMode === "rows"
    ? `<div class="rows">${services.filter((s) => s.image).slice(0, 4).map((s) => `<div class="row rv"><div class="rim"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(s.image)}" alt="${e(s.title)}" loading="lazy"></div><div>${H("h3", s.title)}${s.text ? `<p>${e(s.text)}</p>` : ""}${more(s.link)}</div></div>`).join("")}</div>${services.filter((s) => !s.image).length ? `<ul class="tiles" style="margin-top:50px">${services.filter((s) => !s.image).map((s) => `<li>${s.link ? `<a href="${e(s.link)}" style="color:inherit;text-decoration:none">${e(s.title)}</a>` : e(s.title)}</li>`).join("")}</ul>` : ""}`
    : withText
    ? `<div class="grid">${services.map((s, i) => `<article class="card rv d${i % 3 + 1}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${H("h3", s.title)}${s.text ? `<p>${e(s.text)}</p>` : ""}${more(s.link)}</article>`).join("")}</div>`
    : `<ul class="tiles">${services.map((s, i) => `<li class="rv d${i % 3 + 1}">${s.link ? `<a href="${e(s.link)}" style="color:inherit;text-decoration:none">${e(s.title)}</a>` : e(s.title)}</li>`).join("")}</ul>`;

  const galleryMode = V.gallery === "bento" && gallery.length < 5 ? "grid" : V.gallery === "grid" && gallery.length === 5 ? "bento" : V.gallery;
  const galleryHtml = gallery.length
    ? `<section class="sec${d.about.length ? "" : " soft"}" id="realisations"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">Réalisations</p>${H("h2", TITLES.gallery[t])}</div></div>
<div class="${galleryMode === "bento" ? "bento" : galleryMode === "strip" ? "strip" : gallery.length === 4 ? "ggrid g4" : "ggrid"}">${(galleryMode === "bento" ? gallery.slice(0, 5) : galleryMode === "grid" ? gallery.slice(0, gallery.length >= 6 ? 6 : gallery.length === 4 ? 4 : 3) : gallery).map((g, i) => `<a class="rv d${i % 3 + 1}" href="${e(g)}" target="_blank" rel="noopener"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div>
</div></section>`
    : "";


  /* ---------- Mises en page complètes : studio, nuit, bento ---------- */
  // Titre avec les derniers mots mis en avant (couleur, italique ou dégradé selon la mise en page).
  const emph = (text: string) => {
    const w = String(text || "").split(/\s+/).filter(Boolean);
    if (w.length < 3) return e(text);
    const n = w.length >= 6 ? 2 : 1;
    return e(w.slice(0, -n).join(" ")) + " <em>" + e(w.slice(-n).join(" ")) + "</em>";
  };
  const marquee = services.length >= 2 ? `<div class="mq" aria-hidden="true"><div class="mq-in">${[...services, ...services, ...services, ...services].map((s) => `<span>${e(s.title)}</span>`).join("")}</div></div>` : "";
  const call = tel ? `<a class="btn ${dark ? "btn-glass" : "btn-line"}" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : "";
  const firstSentence = (t2: string) => { const m = String(t2 || "").match(/^.{30,220}?[.!?](\s|$)/); return m ? m[0].trim() : short(t2, 200); };
  const galleryAs = (cls: string) => gallery.length ? `<section class="sec" id="realisations"><div class="wrap"><div class="head"><div class="rv"><p class="kicker">Réalisations</p>${H("h2", TITLES.gallery[t])}</div></div><div class="${cls}">${gallery.map((g, i) => `<a class="rv d${i % 3 + 1}" href="${e(g)}" target="_blank" rel="noopener"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div></div></section>` : "";
  const aboutImgTag = aboutImg ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(aboutImg)}" alt="${e(d.name)}" loading="lazy">` : "";

  const studioHome = () => `<section class="st-hero" id="top"><div class="wrap">
${d.eyebrow ? `<p class="eyebrow rv">${e(d.eyebrow)}</p>` : ""}
<h1 class="st-title rv d1">${emph(d.tagline)}</h1>
<div class="st-sub rv d2">${d.intro ? `<p class="lead">${e(d.intro)}</p>` : "<span></span>"}<div class="cta"><a class="btn" href="#contact">Demander un devis ${icon("arrow", 18)}</a>${call}</div></div>
</div>
${heroImg ? `<div class="wrap st-pano rv d2"><img onerror="yf(this)" data-ph crossorigin="anonymous" class="pano" src="${e(heroImg)}" alt="${e(d.name)}" fetchpriority="high">${facts.length || quick.length ? `<div class="st-chips">${(facts.length ? facts.map((f) => `<span><b>${e(f.value)}</b> ${e(f.label)}</span>`) : quick.map((q) => `<span>${icon(q.k, 16)} ${e(q.v)}</span>`)).join("")}</div>` : ""}</div>` : ""}
</section>
${marquee}
${services.length ? `<section class="sec" id="services"><div class="wrap"><div class="head"><div class="rv"><p class="kicker">${TITLES.servicesK[t]}</p>${H("h2", TITLES.services[t])}</div></div>
<ol class="st-list">${services.map((s, i) => `<li class="rv"><a href="${e(s.link || "#contact")}"><span class="no">${String(i + 1).padStart(2, "0")}</span><span class="tt">${e(s.title)}</span><span class="tx">${e(short(s.text || "", 140))}</span>${s.image ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" class="pv" src="${e(s.image)}" alt="" loading="lazy">` : ""}<span class="go">${icon("arrow", 22)}</span></a></li>`).join("")}</ol>
</div></section>` : ""}
${d.about.length ? `<section class="sec soft" id="apropos"><div class="wrap"><p class="kicker rv">${TITLES.about[t]}</p><blockquote class="st-quote rv d1">${e(firstSentence(d.about[0]))}</blockquote>
<div class="${aboutImgTag ? "split" : "solo"} st-ab">${aboutImgTag ? `<div class="ph plain rv">${aboutImgTag}</div>` : ""}<div class="about rv d1">${d.about.map((x) => `<p>${e(x)}</p>`).join("")}<a class="btn" href="#contact">Parler de votre projet ${icon("arrow", 18)}</a></div></div></div></section>` : ""}
${galleryAs("strip")}
`;

  const nuitHome = () => `<section class="nt-hero" id="top">${heroImg ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" class="hero-bg" src="${e(heroImg)}" alt="" fetchpriority="high">` : ""}<div class="nt-glow"></div>
<div class="wrap">${d.eyebrow ? `<p class="eyebrow rv">${e(d.eyebrow)}</p>` : ""}<h1 class="rv d1">${emph(d.tagline)}</h1>${d.intro ? `<p class="lead rv d2">${e(d.intro)}</p>` : ""}<div class="cta rv d3"><a class="btn" href="#contact">Demander un devis ${icon("arrow", 18)}</a>${call}</div></div>
<a class="nt-down" href="#services" aria-label="Défiler"><span></span></a></section>
${marquee}
${facts.length ? `<section class="nt-facts"><div class="wrap nt-fgrid">${facts.map((f, i) => `<div class="rv d${i % 3 + 1}"><b>${e(f.value)}</b><span>${e(f.label)}</span></div>`).join("")}</div></section>` : ""}
${services.length ? `<section class="sec" id="services"><div class="wrap"><div class="head"><div class="rv"><p class="kicker">${TITLES.servicesK[t]}</p>${H("h2", TITLES.services[t])}</div></div>
<div class="nt-cards">${services.map((s, i) => `<a class="nt-card rv d${i % 3 + 1}${s.image ? " im" : ""}" href="${e(s.link || "#contact")}">${s.image ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(s.image)}" alt="" loading="lazy">` : ""}<div class="in"><span class="no">${String(i + 1).padStart(2, "0")}</span>${H("h3", s.title)}${s.text ? `<p>${e(short(s.text, 150))}</p>` : ""}<span class="go">${icon("arrow", 18)}</span></div></a>`).join("")}</div>
</div></section>` : ""}
${d.about.length ? `<section class="sec soft" id="apropos"><div class="wrap${aboutImgTag ? " split" : " solo"}">${aboutImgTag ? `<div class="ph plain rv">${aboutImgTag}</div>` : ""}<div class="about rv d1"><p class="kicker">${TITLES.about[t]}</p>${H("h2", d.name)}${d.about.map((x) => `<p>${e(x)}</p>`).join("")}<a class="btn" href="#contact">Parler de votre projet ${icon("arrow", 18)}</a></div></div></section>` : ""}
${galleryAs("nt-masonry")}
`;

  const bentoHome = () => `<section class="bt-hero" id="top"><div class="wrap bt-grid">
<div class="bt bt-main rv">${d.eyebrow ? `<p class="eyebrow">${e(d.eyebrow)}</p>` : ""}<h1>${emph(d.tagline)}</h1>${d.intro ? `<p class="lead">${e(d.intro)}</p>` : ""}<div class="cta"><a class="btn" href="#contact">Demander un devis ${icon("arrow", 18)}</a></div></div>
<div class="bt bt-img rv d1">${heroImg ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" class="hero-bg" src="${e(heroImg)}" alt="${e(d.name)}" fetchpriority="high">` : `<div class="ph-box">${e(initials)}</div>`}</div>
${facts[0] ? `<div class="bt bt-stat rv d1"><b>${e(facts[0].value)}</b><span>${e(facts[0].label)}</span></div>` : ""}
${tel ? `<a class="bt bt-call rv d2" href="${e(tel)}"><span>${icon("phone", 22)}</span><b>${e(d.phone)}</b><small>Appelez-nous</small></a>` : ""}
${d.city ? `<div class="bt bt-city rv d2">${icon("pin", 22)}<b>${e(d.city)}</b>${d.hours[0] ? `<small>${e(d.hours[0])}</small>` : ""}</div>` : ""}
${services.length ? `<div class="bt bt-chips rv d3">${services.slice(0, 6).map((s) => `<a href="${e(s.link || "#services")}">${e(s.title)}</a>`).join("")}</div>` : ""}
</div></section>
${services.length ? `<section class="sec" id="services"><div class="wrap"><div class="head"><div class="rv"><p class="kicker">${TITLES.servicesK[t]}</p>${H("h2", TITLES.services[t])}</div></div>
<div class="bt-services">${services.map((s, i) => `<a class="bt-s rv d${i % 3 + 1}${i === 0 && s.image ? " big" : ""}" href="${e(s.link || "#contact")}">${s.image ? `<div class="im"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(s.image)}" alt="" loading="lazy"></div>` : ""}<div class="bd">${H("h3", s.title)}${s.text ? `<p>${e(short(s.text, 140))}</p>` : ""}<span class="more">En savoir plus ${icon("arrow", 16)}</span></div></a>`).join("")}</div>
</div></section>` : ""}
${d.about.length ? `<section class="sec" id="apropos"><div class="wrap bt-about"><div class="bt bt-text rv"><p class="kicker">${TITLES.about[t]}</p>${H("h2", d.name)}${d.about.map((x) => `<p>${e(x)}</p>`).join("")}<a class="btn" href="#contact">Parler de votre projet ${icon("arrow", 18)}</a></div>${aboutImgTag ? `<div class="bt bt-img2${facts.slice(1, 3).length ? "" : " tall"} rv d1">${aboutImgTag}</div>` : ""}${facts.slice(1, 3).map((f, _i, all) => `<div class="bt bt-stat${all.length === 1 ? " wide" : ""} rv d2"><b>${e(f.value)}</b><span>${e(f.label)}</span></div>`).join("")}</div></section>` : ""}
${galleryAs(gallery.length === 5 ? "bento" : gallery.length === 4 ? "ggrid g4" : "ggrid")}
`;

  const layoutCss = layout === "studio" ? `
.st-hero{padding:70px 0 0}
.st-title{font-size:clamp(44px,8.4vw,128px);line-height:.96;letter-spacing:-.045em;max-width:16ch;margin:0 0 34px}
.st-title em,.nt-hero h1 em,.bt-main h1 em{font-style:${F.upper ? "normal" : "italic"};color:var(--ai)}
.st-sub{display:grid;grid-template-columns:1fr auto;gap:40px;align-items:end;border-top:1px solid var(--line);padding-top:26px}
.st-sub .lead{margin:0;max-width:60ch}
.st-pano{position:relative;margin-top:56px}
.st-pano img{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:var(--r);animation:none}
.st-chips{position:absolute;left:24px;bottom:24px;display:flex;gap:10px;flex-wrap:wrap}
.st-chips span{background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-radius:999px;padding:10px 16px;font-size:14px;color:#14161c;display:inline-flex;gap:6px;align-items:center}
.st-chips b{font-family:var(--hf);color:var(--ai);font-size:17px}
.st-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.st-list li a{position:relative;display:grid;grid-template-columns:70px minmax(0,1.1fr) minmax(0,1fr) 40px;gap:24px;align-items:center;padding:30px 0;border-bottom:1px solid var(--line);text-decoration:none;transition:padding .3s,background .3s}
.st-list .no{font-family:var(--hf);font-size:18px;color:var(--mut)}
.st-list .tt{font-family:var(--hf);font-weight:${F.weight};font-size:clamp(24px,3vw,40px);line-height:1.05;color:var(--ink);letter-spacing:${F.tracking}${F.upper ? ";text-transform:uppercase" : ""}}
.st-list .tx{color:var(--mut);font-size:15px}
.st-list .go{color:var(--ai);transition:transform .3s}
.st-list .pv{position:absolute;right:90px;top:50%;width:220px;height:150px;object-fit:cover;border-radius:12px;transform:translateY(-50%) rotate(-3deg) scale(.85);opacity:0!important;pointer-events:none;transition:opacity .3s,transform .3s;z-index:2;box-shadow:0 20px 40px -20px rgba(0,0,0,.5)}
.st-list li a:hover{padding-left:16px}.st-list li a:hover .go{transform:translateX(6px)}
.st-list li a:hover .pv.ok{opacity:1!important;transform:translateY(-50%) rotate(-3deg) scale(1)}
.st-quote{font-family:var(--hf);font-weight:${F.weight};font-size:clamp(26px,3.4vw,46px);line-height:1.15;color:var(--ink);margin:0 0 60px;max-width:26ch;letter-spacing:${F.tracking}}
.st-quote:before{content:"«\\00a0";color:var(--ai)}.st-quote:after{content:"\\00a0»";color:var(--ai)}
.st-cta{padding:110px 0;border-top:1px solid var(--line)}
.st-big{display:inline-flex;align-items:center;gap:20px;font-family:var(--hf);font-weight:${F.weight};font-size:clamp(40px,7vw,104px);line-height:1;color:var(--ink);text-decoration:none;letter-spacing:-.04em${F.upper ? ";text-transform:uppercase" : ""}}
.st-big svg{width:.7em;height:.7em;color:var(--ai);transition:transform .3s}.st-big:hover svg{transform:translate(8px,-8px) rotate(-45deg)}
.st-cta p{margin:22px 0 0;font-size:18px;color:var(--mut)}.st-cta p a{color:var(--ai);font-weight:700;text-decoration:none}
@media (max-width:980px){.st-sub{grid-template-columns:1fr}.st-list li a{grid-template-columns:44px 1fr 28px}.st-list .tx,.st-list .pv{display:none}.st-pano img{aspect-ratio:4/3}}
` : layout === "nuit" ? `
.hd{background:rgba(10,11,15,.82)}
.nt-hero{position:relative;min-height:min(100vh,920px);display:flex;align-items:center;overflow:hidden;background:#0a0b0f;text-align:center}
.nt-hero .hero-bg{opacity:.38}.nt-hero .hero-bg.ok{opacity:.38}
.nt-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,11,15,.2),#0a0b0f 92%)}
.nt-glow{position:absolute;left:50%;top:38%;width:70vw;height:70vw;max-width:900px;max-height:900px;transform:translate(-50%,-50%);background:radial-gradient(circle,${rgba(accent, .35)},transparent 62%);filter:blur(20px);z-index:1;animation:glow 8s ease-in-out infinite alternate}
@keyframes glow{to{transform:translate(-46%,-54%) scale(1.15)}}
.nt-hero .wrap{position:relative;z-index:2;padding:140px 0}
.nt-hero h1{color:#fff;font-size:clamp(42px,7.6vw,112px);line-height:.98;max-width:17ch;margin:0 auto 26px;letter-spacing:-.04em}
.nt-hero h1 em{font-style:normal;background:linear-gradient(90deg,${accent},#fff);-webkit-background-clip:text;background-clip:text;color:transparent}
.nt-hero .lead{color:rgba(255,255,255,.75);margin:0 auto 36px}.nt-hero .eyebrow{color:#fff;justify-content:center}.nt-hero .cta{justify-content:center}
.nt-down{position:absolute;left:50%;bottom:34px;z-index:2;width:26px;height:42px;border:2px solid rgba(255,255,255,.5);border-radius:14px;transform:translateX(-50%)}
.nt-down span{position:absolute;left:50%;top:8px;width:4px;height:8px;margin-left:-2px;border-radius:2px;background:#fff;animation:dn 1.6s infinite}
@keyframes dn{0%{opacity:0;transform:translateY(0)}40%{opacity:1}100%{opacity:0;transform:translateY(12px)}}
.nt-facts{padding:70px 0 10px}
.nt-fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:30px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:40px 0}
.nt-fgrid b{display:block;font-family:var(--hf);font-weight:${F.weight};font-size:clamp(44px,5vw,72px);line-height:1;background:linear-gradient(90deg,#fff,${accent});-webkit-background-clip:text;background-clip:text;color:transparent}
.nt-fgrid span{color:var(--mut);font-size:14px;text-transform:uppercase;letter-spacing:.1em}
.nt-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.nt-card{position:relative;display:block;min-height:340px;border-radius:var(--r);overflow:hidden;background:linear-gradient(160deg,#1a1d27,#111319);border:1px solid var(--line);text-decoration:none;transition:transform .35s,border-color .35s}
.nt-card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .8s}
.nt-card.im:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(10,11,15,.95) 15%,rgba(10,11,15,.15) 75%)}
.nt-card .in{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:28px}
.nt-card .no{color:var(--a);font-weight:700;font-size:13px;letter-spacing:.1em}
.nt-card:not(.im){min-height:0;background:linear-gradient(160deg,#171a24,#101219)}.nt-card:not(.im) .in{position:relative;padding:30px 28px 34px}.nt-card:not(.im) h3{margin-top:14px}
.nt-card:not(.im):before{content:"";position:absolute;right:-60px;top:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,${rgba(accent, .28)},transparent 65%)}
.nt-card:not(.im) .in{padding-bottom:84px}.nt-card:not(.im) .go{top:auto;bottom:24px;right:24px;transform:none;opacity:.6}.nt-card:not(.im):hover .go{opacity:1;transform:none}
.nt-card h3{color:#fff;font-size:26px;margin:8px 0 8px}.nt-card p{margin:0;color:rgba(255,255,255,.72);font-size:15px}
.nt-card .go{position:absolute;right:24px;top:-6px;width:44px;height:44px;border-radius:50%;background:var(--a);color:#fff;display:grid;place-items:center;transform:translateY(-100%) scale(.6);opacity:0;transition:all .35s}
.nt-card:hover{transform:translateY(-6px);border-color:${rgba(accent, .6)}}.nt-card:hover img{transform:scale(1.07)}.nt-card:hover .go{opacity:1;transform:translateY(-100%) scale(1)}
.nt-masonry{columns:3 260px;column-gap:14px}.nt-masonry a{display:block;margin:0 0 14px;border-radius:calc(var(--r) * .8);overflow:hidden;break-inside:avoid}.nt-masonry img{width:100%;height:auto;transition:transform .7s}.nt-masonry a:hover img{transform:scale(1.05)}
.band{background:linear-gradient(120deg,${ink},#0a0b0f)}
.ft,footer{background:#06070a}
` : layout === "bento" ? `
.bt{background:var(--card);border-radius:calc(var(--r) * 1.2);border:1px solid var(--line);overflow:hidden;position:relative}
.bt-hero{padding:30px 0 20px}
.bt-grid{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:minmax(130px,auto);gap:14px;grid-template-areas:"main main img img" "main main img img" "stat call city chips"}
.bt-main{grid-area:main;padding:46px 44px;display:flex;flex-direction:column;justify-content:center}
.bt-main h1{font-size:clamp(34px,4.4vw,62px);margin-bottom:18px}.bt-main .eyebrow{color:var(--ai)}.bt-main .lead{margin-bottom:26px}
.bt-img{grid-area:img;min-height:420px}.bt-img img,.bt-img .ph-box{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:none}
.bt-stat{grid-area:stat;padding:26px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--ai);border:0}
.bt-stat b{font-family:var(--hf);font-weight:${F.weight};font-size:46px;line-height:1;color:#fff}.bt-stat span{color:rgba(255,255,255,.8);font-size:14px;margin-top:6px}
.bt-call{grid-area:call;padding:26px;display:flex;flex-direction:column;justify-content:space-between;text-decoration:none;transition:transform .2s}
.bt-call span{width:46px;height:46px;border-radius:14px;background:var(--a10);color:var(--ai);display:grid;place-items:center}.bt-call b{font-size:20px;color:var(--ink)}.bt-call small{color:var(--mut)}
.bt-call:hover{transform:translateY(-3px)}
.bt-city{grid-area:city;padding:26px;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;color:var(--ai)}.bt-city b{color:var(--ink);font-size:20px}.bt-city small{color:var(--mut)}
.bt-chips{grid-area:chips;padding:20px;display:flex;flex-wrap:wrap;gap:8px;align-content:center}
.bt-chips a{border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:13.5px;font-weight:600;color:var(--ink);text-decoration:none;transition:background .2s,color .2s}.bt-chips a:hover{background:var(--ai);color:#fff}
.bt-services{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.bt-s{background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r) * 1.2);overflow:hidden;text-decoration:none;display:flex;flex-direction:column;transition:transform .25s,box-shadow .25s}
.bt-s:hover{transform:translateY(-5px);box-shadow:0 26px 50px -30px rgba(10,12,16,.45)}
.bt-s .im{aspect-ratio:16/10;overflow:hidden}.bt-s .im img{width:100%;height:100%;object-fit:cover}
.bt-s .bd{padding:24px}.bt-s h3{font-size:21px;margin-bottom:8px}.bt-s p{margin:0 0 12px;font-size:15px}
.bt-s.big{grid-column:span 2;grid-row:span 2}.bt-s.big .im{aspect-ratio:auto;flex:1;min-height:260px}.bt-s.big h3{font-size:30px}
.bt-about{display:grid;grid-template-columns:1.3fr 1fr 1fr;grid-auto-rows:minmax(170px,auto);gap:14px}
.bt-text{grid-row:span 2;padding:44px}.bt-text p{font-size:17px}
.bt-img2{grid-column:span 2;min-height:320px}.bt-img2.tall{grid-row:span 2}.bt-img2 img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bt-about .bt-stat{grid-area:auto}.bt-about .bt-stat.wide{grid-column:span 2}
@media (max-width:980px){.bt-grid{grid-template-columns:1fr 1fr;grid-template-areas:"main main" "img img" "stat call" "city chips"}.bt-img{min-height:300px}.bt-services{grid-template-columns:1fr 1fr}.bt-s.big{grid-column:span 2;grid-row:auto}.bt-about{grid-template-columns:1fr 1fr}.bt-text{grid-column:span 2;grid-row:auto}.bt-main{padding:32px 26px}}
@media (max-width:600px){.bt-grid{grid-template-columns:1fr;grid-template-areas:"main" "img" "stat" "call" "city" "chips"}.bt-services,.bt-about{grid-template-columns:1fr}.bt-s.big,.bt-text,.bt-img2{grid-column:auto}}
` : "";
  // Bandeau défilant (studio, nuit) : la liste des prestations en continu.
  const marqueeCss = `
.mq{overflow:hidden;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:22px 0;background:${dark ? "#0d0f15" : "var(--bg)"};margin-top:${layout === "studio" ? "70px" : "0"}}
.mq-in{display:flex;gap:46px;width:max-content;animation:mq 38s linear infinite}
.mq span{font-family:var(--hf);font-weight:${F.weight};font-size:clamp(22px,2.6vw,34px);color:var(--ink);white-space:nowrap;display:inline-flex;align-items:center;gap:46px;letter-spacing:${F.tracking}${F.upper ? ";text-transform:uppercase" : ""}}
.mq span:after{content:"✦";color:var(--a);font-size:.6em}
@keyframes mq{to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.mq-in{animation:none}}`;
  const classicHome = `${heroHtml}
${facts.length ? `<div class="facts"><div class="wrap"><div class="facts-in rv">${facts.map((f) => `<div class="fact"><b>${e(f.value)}</b><span>${e(f.label)}</span></div>`).join("")}</div></div></div>` : ""}
${services.length ? `<section class="sec" id="services"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">${TITLES.servicesK[t]}</p>${H("h2", TITLES.services[t])}</div></div>
${servicesBody}
</div></section>` : ""}
${d.about.length ? `<section class="sec soft" id="apropos"><div class="wrap split">
<div class="ph ${V.about} rv">${aboutImg ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(aboutImg)}" alt="${e(d.name)}" loading="lazy">` : `<div class="ph-box">${e(initials)}</div>`}</div>
<div class="about rv d1"><p class="kicker">${TITLES.about[t]}</p>${H("h2", d.name)}${d.about.map((p) => `<p>${e(p)}</p>`).join("")}
${services.length >= 3 && servicesMode === "cards" ? `<ul class="checks">${services.slice(0, 3).map((s) => `<li>${e(s.title)}</li>`).join("")}</ul>` : ""}
<a class="btn" href="#contact">Parler de votre projet ${icon("arrow", 18)}</a></div>
</div></section>` : ""}
${galleryHtml}
`;
  const homeMain = layout === "studio" ? studioHome() : layout === "nuit" ? nuitHome() : layout === "bento" ? bentoHome() : classicHome;

  const bandMode = V.band === "photo" && !bandImg ? "accent" : V.band;
  const band = layout === "studio" ? `<section class="st-cta"><div class="wrap"><a class="st-big rv" href="#contact">${e(TITLES.band[t].replace(/[.?]$/, ""))} ${icon("arrow", 60)}</a><p class="rv d1">${tel ? `Ou appelez directement le <a href="${e(tel)}">${e(d.phone)}</a>` : "Décrivez-nous votre besoin, nous revenons vers vous."}</p></div></section>
` : `<section class="band ${bandMode}">${bandMode === "photo" ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(bandImg)}" alt="" loading="lazy">` : ""}<div class="wrap band-in">
<div class="rv">${H("h2", TITLES.band[t])}<p>${d.city ? `${e(d.name)}, à ${e(d.city)}. ` : ""}Décrivez-nous votre besoin, nous revenons vers vous.</p></div>
<div class="cta rv d1">${tel ? `<a class="btn btn-light" href="${e(tel)}">${icon("phone", 17)}${e(d.phone)}</a>` : ""}<a class="btn btn-glass" href="#contact">Demander un devis ${icon("arrow", 18)}</a></div>
</div></section>
`;

  const contact = `<section class="sec soft" id="contact"><div class="wrap">
<div class="head"><div class="rv"><p class="kicker">Contact</p>${H("h2", TITLES.contact[t])}</div></div>
<div class="ct">
<div class="box rv">
<ul class="info">
${d.address ? `<li><span class="ic">${icon("pin")}</span><div><b>Adresse</b><span>${e(d.address)}</span></div></li>` : d.city ? `<li><span class="ic">${icon("pin")}</span><div><b>Ville</b><span>${e([cp, d.city].filter(Boolean).join(" "))}</span></div></li>` : ""}
${d.phone ? `<li><span class="ic">${icon("phone")}</span><div><b>Téléphone</b><a href="${e(tel)}">${e(d.phone)}</a></div></li>` : ""}
${d.email ? `<li><span class="ic">${icon("mail")}</span><div><b>E-mail</b><a href="mailto:${e(d.email)}">${e(d.email)}</a></div></li>` : ""}
${d.hours.length ? `<li><span class="ic">${icon("clock")}</span><div><b>Horaires</b><span>${d.hours.map((h) => e(h)).join("<br>")}</span></div></li>` : ""}
</ul>
${mapQ ? `<div class="map"><iframe title="Plan d'accès ${e(d.name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${mapEnc}&z=${mapZoom}&hl=fr&output=embed"></iframe><a class="btn btn-sm go" href="https://www.google.com/maps/dir/?api=1&destination=${mapEnc}" target="_blank" rel="noopener">${icon("route", 16)}Itinéraire</a></div>` : ""}
</div>
<form class="box form rv d1" onsubmit="event.preventDefault();this.querySelector('.ok').style.display='block';this.querySelector('button').disabled=true">
${H("h3", "Demande de devis")}
<p class="sub">Réponse rapide, sans engagement.</p>
<div class="row2"><label>Nom<input name="nom" autocomplete="name" required></label><label>Téléphone<input name="tel" type="tel" autocomplete="tel" required></label></div>
<label>E-mail<input name="email" type="email" autocomplete="email"></label>
${services.length ? `<label>Votre besoin<select name="service"><option value="">Choisir…</option>${services.map((s) => `<option>${e(s.title)}</option>`).join("")}<option>Autre</option></select></label>` : ""}
<label>Votre projet<textarea name="msg" rows="4" placeholder="Quelques mots sur votre projet, le lieu, les délais…"></textarea></label>
<button class="btn" type="submit">Envoyer ma demande ${icon("arrow", 18)}</button>
<p class="ok">Formulaire de démonstration : sur le site en ligne, votre demande arrivera directement chez ${e(d.name)}.</p>
</form>
</div>
</div></section>
`;

  const tail = `<footer><div class="wrap">
<div class="ft">
<div class="fl">${d.logo ? `<img onerror="yf(this)" src="${e(d.logo)}" alt="${e(d.name)}" loading="lazy">` : `<span class="bname">${e(d.name)}</span>`}${d.intro ? `<p style="margin:0;max-width:40ch">${e(short(d.intro, 150))}</p>` : ""}</div>
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
// Illustrations, pictogrammes, schémas, produits détourés : de grands aplats de
// peu de couleurs. Mesuré sur une vignette 64×64 (couleurs à 5 bits) : si la
// couleur dominante couvre 40 % de l'image ou les trois premières 50 %, ce
// n'est pas une photo et l'image est retirée. Calibré sur de vraies maquettes.
function ph(i){if(i.dataset.done)return;i.dataset.done=1;try{var N=64,c=document.createElement('canvas');c.width=N;c.height=N;var x=c.getContext('2d');x.drawImage(i,0,0,N,N);var d=x.getImageData(0,0,N,N).data,h={},n=N*N;for(var k=0;k<d.length;k+=4){var q=(d[k]>>3)<<10|(d[k+1]>>3)<<5|(d[k+2]>>3);h[q]=(h[q]||0)+1}var b=Object.keys(h).map(function(z){return h[z]}).sort(function(p,q){return q-p});var t1=b[0]/n,t3=((b[0]||0)+(b[1]||0)+(b[2]||0))/n;if(t1>=.4||t3>=.5){yf(i);fixGal();return}}catch(e){}i.classList.add('ok')}
// Galerie recomposée après un retrait : 3 ou 6 photos sur 3 colonnes, 4 sur 4, 5 en mosaïque, jamais une photo seule.
function fixGal(){var g=document.querySelector('#realisations .bento,#realisations .ggrid,#realisations .strip');if(!g)return;var n=g.children.length;if(n<3){g.closest('section').remove();return}if(g.classList.contains('strip'))return;g.className=n===5?'bento':n===4?'ggrid g4':'ggrid';if(n>6||n%3){while(g.children.length>(n>=6?6:3)&&n!==4&&n!==5)g.lastElementChild.remove()}}
[].forEach.call(document.querySelectorAll('img[data-ph]'),function(i){if(i.complete&&i.naturalWidth)ph(i);else i.addEventListener('load',function(){ph(i)})});
setTimeout(function(){[].forEach.call(document.querySelectorAll('img[data-ph]'),function(i){i.classList.add('ok')})},6000);
var lg=document.querySelector('[data-logo]');
function chk(){if(!lg||!lg.naturalWidth)return;if(lg.naturalWidth<40){yf(lg);return}${darkHeader ? "" : "try{var c=document.createElement('canvas'),w=c.width=Math.min(120,lg.naturalWidth),h=c.height=Math.max(1,Math.round(w*lg.naturalHeight/lg.naturalWidth)),x=c.getContext('2d');x.drawImage(lg,0,0,w,h);var d=x.getImageData(0,0,w,h).data,n=0,l=0;for(var k=0;k<d.length;k+=4){if(d[k+3]>60){n++;l+=(.2126*d[k]+.7152*d[k+1]+.0722*d[k+2])/255}}if(n>20&&l/n>.86)lg.parentNode.classList.add('dark')}catch(e){}"}}
if(lg){if(lg.complete)chk();else lg.addEventListener('load',chk)}
})();
</script>
</body>
</html>`;

  const block = (b: Block) => b.t === "h" ? `<h2 class="rv">${e(b.v)}</h2>` : b.t === "p" ? `<p class="rv">${e(b.v)}</p>` : b.t === "img" ? `<figure class="rv"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(b.v)}" alt="${e(d.name)}" loading="lazy"></figure>` : "";
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
      ? `${prose(pg.blocks.filter((b) => b.t !== "img"))}<div class="galp">${imgs.map((g, i) => `<a class="rv d${i % 3 + 1}" href="${e(g)}" target="_blank" rel="noopener"><img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(g)}" alt="Réalisation ${e(d.name)}" loading="lazy"></a>`).join("")}</div>`
      : prose(pg.blocks);
    return `<section class="phero${pg.image ? "" : " flat"}">${pg.image ? `<img onerror="yf(this)" data-ph crossorigin="anonymous" src="${e(pg.image)}" alt="">` : ""}<div class="wrap">
<p class="crumb rv"><a href="/">Accueil</a> &nbsp;/&nbsp; ${e(pg.label)}</p>
<h1 class="rv d1">${e(pg.title)}</h1>${pg.intro && pg.kind !== "gallery" ? `<p class="lead rv d2">${e(pg.intro)}</p>` : ""}
</div></section>
<section class="sec"><div class="wrap art">
<article class="prose">${body}</article>
<aside class="aside">
<div class="box rv"><h3>Un projet ?</h3><p>${e(d.name)} vous répond${d.city ? " à " + e(d.city) + " et alentours" : ""}.</p>${tel ? `<a class="btn" href="${e(tel)}" style="margin-bottom:10px">${icon("phone", 17)}${e(d.phone)}</a>` : ""}<a class="btn btn-line" href="#contact">Demander un devis</a></div>
${pages.length > 1 ? `<div class="box rv"><h3>Nos pages</h3><ul>${pages.map((x) => `<li><a href="${e(x.path)}"${x.path === pg.path ? ' class="on"' : ""}>${e(x.label)} ${icon("arrow", 15)}</a></li>`).join("")}</ul></div>` : ""}
</aside>
</div></section>
`;
  };
  const titleOf = (x: string) => e(x) + " · " + e(d.name);
  const home = head(e(d.name) + (d.eyebrow ? " · " + e(d.eyebrow) : ""), e(d.intro), "/") + homeMain + band + contact + tail;
  const pageList = pages.map((pg) => ({ path: pg.path, html: head(titleOf(pg.title), e(pg.intro || d.intro), pg.path) + pageMain(pg) + band + contact + tail }));
  return { home, pages: pageList };
}
