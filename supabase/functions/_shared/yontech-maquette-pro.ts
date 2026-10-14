import { htmlEscape } from "./yontech-core.ts";
import type { Block, PageModel, SiteData } from "./yontech-maquette.ts";

// Gabarit « pro » des maquettes, calqué sur les maquettes faites à la main
// (sebalyo.yontech.fr, maquette.yontech.fr) : en-tête avec téléphone et
// bouton, photo d'accroche, chiffres ou atouts, cartes de prestations avec
// étiquette et puces, bande sombre explicative, étapes, galerie légendée,
// chiffre fort, certifications, appel final, contact. Les textes viennent de
// la rédaction IA quand elle existe (data.copy), sinon du site, nettoyés.

const PX = "https://img.yontech.fr/_img?u=";
const px = (u?: string) => (u && /^https?:\/\//i.test(u) ? PX + encodeURIComponent(u) : u || "");

/* ---------- couleurs ---------- */
function rgb(hex: string) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : [30, 90, 168];
}
function hsl(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function lum(hex: string) {
  return rgb(hex).map((v) => { const c = v / 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }).reduce((a, c, i) => a + c * [.2126, .7152, .0722][i], 0);
}
function darker(hex: string, target = 4.5) {
  let c = rgb(hex);
  for (let i = 0; i < 14 && 1.05 / (lum("#" + c.map((v) => v.toString(16).padStart(2, "0")).join("")) + .05) < target; i++) c = c.map((v) => Math.round(v * .87));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

const ICON: Record<string, string> = {
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  route: '<path d="M3 11l19-9-9 19-2-8-8-2z"/>',
};
const icon = (n: string, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ""}</svg>`;
const short = (t: string, n: number) => { const s = String(t || "").trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…"; };
const words = (t: string, n: number) => { const w = String(t || "").split(/\s+/).filter(Boolean); return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…"; };

type Fonts = { link: string; display: string; body: string; weight: number; upper: boolean; track: string };
const FONTS: Fonts[] = [
  { link: "family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;600;700", display: '"Bricolage Grotesque","Avenir Next",system-ui,sans-serif', body: '"Figtree",system-ui,sans-serif', weight: 800, upper: false, track: "-.01em" },
  { link: "family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600;700", display: '"Barlow Condensed","Arial Narrow",sans-serif', body: '"Barlow",system-ui,sans-serif', weight: 700, upper: false, track: "0" },
  { link: "family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700", display: '"Fraunces",Georgia,serif', body: '"Inter",system-ui,sans-serif', weight: 700, upper: false, track: "-.01em" },
  { link: "family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700", display: '"Sora",system-ui,sans-serif', body: '"Inter",system-ui,sans-serif', weight: 700, upper: false, track: "-.02em" },
];
const GENERIC_STEPS = [
  { title: "On vous écoute", text: "Vous nous décrivez votre projet par téléphone ou via le formulaire." },
  { title: "Visite et conseils", text: "Nous venons voir sur place et vous conseillons la solution adaptée." },
  { title: "Devis détaillé", text: "Vous recevez une proposition claire, poste par poste." },
  { title: "Réalisation", text: "Nos équipes réalisent les travaux et vous livrent un chantier propre." },
];

export function renderPro(input: SiteData, opts: { hero: "a" | "b"; font: number }): { home: string; pages: { path: string; html: string }[] } {
  const e = htmlEscape;
  const d = input, c = input.copy || null;
  const accent = /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : "#1e5aa8";
  const { h, s } = hsl(accent);
  const accentInk = darker(accent, 4.6);              // accent lisible sur fond clair
  const onAccent = lum(accent) > .45 ? "#10141c" : "#ffffff";
  const inkCol = `hsl(${h} ${Math.min(45, s)}% 13%)`; // encre sombre teintée par la marque
  const inkSoft = `hsl(${h} ${Math.min(18, s)}% 32%)`;
  const sky = `hsl(${h} ${Math.min(45, s)}% 95%)`;
  const paper = d.theme === "atelier" ? "#fbf9f5" : `hsl(${h} 20% 99%)`;
  const line = `hsl(${h} ${Math.min(25, s)}% 88%)`;
  const F = FONTS[d.theme === "atelier" ? 2 : d.theme === "chantier" ? (opts.font % 2 ? 1 : 0) : (opts.font % 2 ? 3 : 0)];
  const tel = d.phone ? "tel:" + d.phone.replace(/\s/g, "") : "";
  const year = new Date().getFullYear();
  const initials = d.name.split(/\s+/).filter((w) => /[A-Za-zÀ-ÿ0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // ---------- contenus (IA sinon site) ----------
  const heroImg = px(d.heroImage ?? d.images[0]);
  const aboutImg = px(d.aboutImage ?? d.images[1]);
  const gallery = (d.gallery ?? d.images.slice(2, 8)).map(px).filter(Boolean).slice(0, 7);
  const pages = (d.pages || []).slice(0, 7).map((pg) => ({ ...pg, image: px(pg.image), blocks: pg.blocks.map((b) => (b.t === "img" ? { ...b, v: px(b.v) } : b)) }));
  const kicker = c?.kicker || d.eyebrow || [d.city].filter(Boolean).join(" · ");
  const title = c?.title || words(d.tagline, 12);
  const lead = c?.lead || short(d.intro, 230);
  const cta = c?.cta || "Demander un devis";
  const pageOf = (link?: string) => pages.find((pg) => pg.path === link);
  const bulletsFrom = (link?: string) => (pageOf(link)?.blocks || []).filter((b) => b.t === "li" && b.v.length <= 90).slice(0, 3).map((b) => b.v);
  const services = c?.services.length
    ? c.services.map((x) => { const src = x.source >= 0 ? d.services[x.source] : undefined; return { title: x.title, tag: x.tag, text: x.text, bullets: x.bullets, link: src?.link, image: px(src?.image) }; })
    : d.services.slice(0, 6).map((x) => ({ title: x.title, tag: "", text: short(x.text, 160), bullets: bulletsFrom(x.link), link: x.link, image: px(x.image) }));
  const stats = c?.stats.length ? c.stats : (d.facts || []).slice(0, 4);
  const highlights = c?.highlights.length ? c.highlights : [
    d.city ? { title: d.city, text: d.address || "Votre entreprise de proximité." } : null,
    d.hours[0] ? { title: "Horaires", text: d.hours.join(" · ") } : null,
    d.phone ? { title: "Un interlocuteur", text: `Joignable au ${d.phone}.` } : null,
  ].filter(Boolean) as { title: string; text: string }[];
  const steps = c?.steps.length === 4 ? c.steps : GENERIC_STEPS;
  const certs = (d.facts || []).filter((f) => /qualification|garantie/.test(f.label)).map((f) => f.value);
  const aboutText = c?.aboutText || d.about[0] || "";
  const points = c?.points.length ? c.points : (d.about[1] ? [{ title: "Notre approche", text: short(d.about[1], 200) }] : []);
  const bigValue = c?.bigValue || (d.facts || []).find((f) => /ans|salari|chantiers|clients|interventions/.test(f.label))?.value || "";
  const bigLabel = c?.bigLabel || (d.facts || []).find((f) => f.value === bigValue)?.label || "";
  const navLabel = (l: string) => { const w = l.split(/\s+/); return w.length > 3 || l.length > 22 ? w.slice(0, 2).join(" ").replace(/\s+(et|de|des|du|la|le|les|&)$/i, "") : l; };
  const nav = (pages.length ? [...pages.slice(0, 3).map((pg) => [pg.path, navLabel(pg.label)]), ["#contact", "Contact"]] : [services.length ? ["#prestations", "Prestations"] : null, gallery.length >= 3 ? ["#realisations", "Réalisations"] : null, aboutText ? ["#entreprise", "L'entreprise"] : null, ["#contact", "Contact"]].filter(Boolean)) as string[][];
  const cp = (d.address.match(/\b\d{5}\b/) || [])[0] || d.cp || "";
  const mapQ = /\b\d{5}\b/.test(d.address) ? `${d.address}, France` : d.city ? `${[cp, d.city].filter(Boolean).join(" ")}, France` : "";
  const mapEnc = encodeURIComponent(mapQ);
  const dark = opts.hero === "b";
  const brand = d.logo
    ? `<img onerror="yf(this)" crossorigin="anonymous" src="${e(px(d.logo))}" alt="${e(d.name)}" data-logo><span class="mono" hidden>${e(initials)}</span>`
    : `<span class="mono">${e(initials)}</span><span class="bname">${e(d.name)}</span>`;
  const img = (u: string, alt: string, cls = "", lazy = true) => `<img onerror="yf(this)" data-ph crossorigin="anonymous"${cls ? ` class="${cls}"` : ""} src="${e(u)}" alt="${e(alt)}"${lazy ? ' loading="lazy"' : ' fetchpriority="high"'}>`;
  const H2 = (t: string) => `<h2>${e(t)}</h2>`;

  const css = `
:root{--sun-light:hsl(${h} ${Math.max(60, s)}% 74%);--ink:${inkCol};--ink-soft:${inkSoft};--sky:${sky};--paper:${paper};--line:${line};--sun:${accent};--sun-ink:${accentInk};--on-sun:${onAccent};--card:#fff;--r:14px;--w:1180px;--fd:${F.display};--fb:${F.body}}
[hidden]{display:none!important}*{box-sizing:border-box}html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--fb);font-size:1.0625rem;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:clip}
body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:100;opacity:.05;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='220'%3E%3Ctext x='20' y='130' transform='rotate(-22 180 110)' font-family='Arial' font-weight='700' font-size='26' fill='%23000'%3EMAQUETTE · YonTech%3C/text%3E%3C/svg%3E")}
img{max-width:100%;display:block}a{color:inherit}p{margin:0}
img[data-ph]{opacity:0;transition:opacity .5s}img[data-ph].ok{opacity:1}
h1,h2,h3{font-family:var(--fd);line-height:1.08;text-wrap:balance;margin:0;letter-spacing:${F.track};color:var(--ink)}
h2{font-size:clamp(1.9rem,1.2rem + 2.4vw,3rem);font-weight:${F.weight}}h3{font-size:1.22rem;font-weight:700}
.wrap{max-width:var(--w);margin-inline:auto;padding-inline:20px}.wrap>*{min-width:0}
.eyebrow{font-weight:700;font-size:.82rem;letter-spacing:.09em;text-transform:uppercase;color:var(--sun-ink);margin-bottom:12px}
.btn{display:inline-flex;align-items:center;gap:9px;padding:13px 22px;border-radius:999px;font-weight:700;font-size:.98rem;text-decoration:none;border:0;cursor:pointer;white-space:nowrap;transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(-2px)}
.btn-sun{background:var(--sun);color:var(--on-sun);box-shadow:0 10px 24px -12px var(--sun)}
.btn-light{background:#fff;color:${inkCol}}.btn-line{background:transparent;color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.6)}
.btn-ink{background:var(--ink);color:#fff}
.mbar{background:var(--sun);color:var(--on-sun);text-align:center;font-size:.82rem;font-weight:600;padding:7px 16px}.mbar a{color:inherit;margin-left:8px}
header.top{position:sticky;top:0;z-index:30;background:${dark ? `hsl(${h} 30% 10% / .96)` : "color-mix(in srgb,var(--paper) 90%,transparent)"};backdrop-filter:blur(10px);border-bottom:1px solid ${dark ? "rgba(255,255,255,.08)" : "var(--line)"}}
.top .wrap{display:flex;align-items:center;gap:22px;height:78px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;min-width:0}
.logo img{height:54px;width:auto;max-width:200px;object-fit:contain${dark ? ";background:#fff;border-radius:8px;padding:5px 10px;height:50px" : ""}}
.logo.dark img{background:${inkCol};border-radius:8px;padding:5px 10px}
.mono{width:44px;height:44px;border-radius:12px;background:var(--sun);color:var(--on-sun);display:grid;place-items:center;font:800 16px var(--fb)}
.bname{font-family:var(--fd);font-weight:800;font-size:1.1rem;color:${dark ? "#fff" : "var(--ink)"}}
.menu{margin-left:auto;display:flex;gap:26px}
.menu a{white-space:nowrap;text-decoration:none;font-weight:500;font-size:.95rem;color:${dark ? "rgba(255,255,255,.85)" : "var(--ink)"};padding:6px 0;border-bottom:2px solid transparent}
.menu a:hover,.menu a.on{border-color:var(--sun)}
.phone-top{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:.95rem;color:${dark ? "#fff" : "var(--ink)"};text-decoration:none;white-space:nowrap}
.burger{display:none;margin-left:auto;width:42px;height:42px;border-radius:10px;border:1px solid ${dark ? "rgba(255,255,255,.25)" : "var(--line)"};background:transparent;flex-direction:column;justify-content:center;align-items:center;gap:5px;cursor:pointer}
.burger span{width:20px;height:2px;border-radius:2px;background:${dark ? "#fff" : "var(--ink)"}}
.hero{position:relative;min-height:min(640px,82vh);display:flex;align-items:flex-end;overflow:hidden;background:${inkCol}}
.hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 40%}
.hero-shade{position:absolute;inset:0;background:linear-gradient(90deg,hsl(${h} 45% 8% / .86) 0%,hsl(${h} 45% 8% / .58) 45%,hsl(${h} 45% 8% / .06) 80%),linear-gradient(0deg,hsl(${h} 45% 8% / .55),transparent 45%)}
.hero-in{position:relative;width:100%;padding-block:120px ${dark && highlights.length ? "120px" : "64px"};color:#fff}
.hero-kicker{font-weight:600;font-size:.95rem;color:var(--sun-light)}
.hero h1{font-size:clamp(2.2rem,1.3rem + 3.6vw,4.2rem);font-weight:${F.weight};max-width:14em;margin-top:12px;color:#fff}
.hero-lead{font-size:1.15rem;color:rgba(255,255,255,.88);max-width:36em;margin-top:18px}
.hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.hero.flat{background:linear-gradient(120deg,${inkCol},hsl(${h} 45% 22%))}
.stats{background:${inkCol};color:#fff}
.stats .wrap{display:grid;grid-template-columns:repeat(${Math.max(1, stats.length)},1fr);gap:20px;padding-block:24px}
.stats b{display:block;font-family:var(--fd);font-size:1.6rem;color:var(--sun-light);line-height:1.1}.stats span{font-size:.92rem;color:rgba(255,255,255,.75)}
.hl{position:relative;z-index:3;margin-top:-62px}
.hl .grid{display:grid;grid-template-columns:repeat(${Math.max(1, highlights.length)},1fr);background:#fff;border-radius:var(--r);box-shadow:0 24px 50px -28px rgba(0,0,0,.35);overflow:hidden}
.hl .it{padding:26px 26px;border-left:1px solid var(--line)}.hl .it:first-child{border-left:0}
.hl .it h3{display:flex;gap:10px;align-items:center;font-size:1.12rem}.hl .it h3 svg{color:var(--sun-ink);flex:none}.hl .it p{color:var(--ink-soft);font-size:.95rem;margin-top:8px}
section.sec{padding-block:96px}section.sky{background:var(--sky)}
.head{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:end;margin-bottom:44px}.head p{color:var(--ink-soft)}
.svcs{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.svc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;display:flex;flex-direction:column;gap:10px;padding-bottom:24px;text-decoration:none;transition:transform .2s,box-shadow .2s}
a.svc:hover{transform:translateY(-4px);box-shadow:0 24px 44px -28px rgba(0,0,0,.35)}
.svc>*:not(.svc-img){margin-inline:24px}
.svc-img{width:100%;aspect-ratio:16/10;object-fit:cover;background:var(--sky);margin-bottom:8px}
.svc .noimg{height:8px;background:var(--sun);margin:0 0 10px}
.svc .tag{font-size:.78rem;font-weight:700;color:var(--sun-ink);letter-spacing:.05em;text-transform:uppercase}
.svc p{color:var(--ink-soft);font-size:.98rem}.svc ul{margin:4px 0 0;padding-left:18px;color:var(--ink-soft);font-size:.95rem}.svc li{margin:2px 0}
.svc .more{margin-top:auto;padding-top:6px;color:var(--sun-ink);font-weight:700;font-size:.92rem;display:inline-flex;gap:6px;align-items:center}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}.chips span{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 14px;font-size:.88rem;color:var(--ink-soft)}
.band{background:${inkCol};color:#fff}.band h2,.band h3{color:#fff}.band .eyebrow{color:var(--sun-light)}.band .head p{color:rgba(255,255,255,.75)}
.cols{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid rgba(255,255,255,.12)}
.col{padding:28px 26px 10px 0;border-right:1px solid rgba(255,255,255,.12);margin-right:26px}.col:last-child{border-right:0;margin-right:0}
.col .lab{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;color:var(--sun-light);text-transform:uppercase;letter-spacing:.06em}
.col h3{margin:10px 0 10px}.col p{color:rgba(255,255,255,.75);font-size:.97rem}
.steps{display:grid;grid-template-columns:repeat(4,1fr);counter-reset:s}
.step{padding:0 22px 0 0;position:relative}
.step:before{counter-increment:s;content:counter(s);display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:var(--sun);color:var(--on-sun);font-family:var(--fd);font-weight:800;font-size:1.2rem;margin-bottom:18px;position:relative;z-index:1}
.step:after{content:"";position:absolute;top:23px;left:46px;right:0;height:2px;background:repeating-linear-gradient(90deg,var(--line) 0 8px,transparent 8px 14px)}
.step:last-child:after{display:none}.step h3{margin-bottom:8px}.step p{color:var(--ink-soft);font-size:.97rem}
.gal{display:grid;grid-template-columns:2fr 1fr 1fr;grid-auto-rows:210px;gap:12px}
.gal figure{margin:0;position:relative;border-radius:var(--r);overflow:hidden;background:var(--sky)}
.gal figure.wide{grid-row:span 2}.gal img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.gal figure:hover img{transform:scale(1.05)}
.gal figcaption{position:absolute;left:0;right:0;bottom:0;padding:26px 14px 12px;background:linear-gradient(0deg,rgba(0,0,0,.65),transparent);color:#fff;font-size:.85rem;font-weight:600}
.about{display:grid;grid-template-columns:.9fr 1.1fr;gap:56px;align-items:start}
.big{font-family:var(--fd);font-weight:800;font-size:clamp(3.6rem,2rem + 6vw,6.4rem);line-height:1;color:var(--sun-ink)}
.about .lbl{color:var(--ink-soft);margin-top:10px;max-width:24em}
.about .txt{color:var(--ink-soft);font-size:1.05rem}
.about .ph img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r);margin-top:26px}
.pts{list-style:none;padding:0;margin:26px 0 0;display:grid;gap:18px}
.pts li{display:grid;grid-template-columns:30px 1fr;gap:12px}.pts li svg{color:var(--sun-ink);margin-top:2px}.pts b{display:block;color:var(--ink)}.pts span{color:var(--ink-soft);font-size:.96rem}
.certs{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.cert{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:22px;display:flex;gap:12px;align-items:center;font-weight:700}.cert svg{color:var(--sun-ink)}
.cta{background:var(--sun);color:var(--on-sun)}.cta .wrap{display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;padding-block:56px}
.cta h2{color:var(--on-sun);font-size:clamp(1.6rem,1rem + 1.8vw,2.4rem)}.cta p{margin-top:8px;opacity:.85}.cta .acts{display:flex;gap:12px;flex-wrap:wrap}
.cta .btn-ghost{background:transparent;color:var(--on-sun);box-shadow:inset 0 0 0 1.5px currentColor}
.ct{display:grid;grid-template-columns:1fr 1fr;gap:26px}
.box{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.info{list-style:none;margin:0;padding:8px 26px}.info li{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line)}.info li:last-child{border-bottom:0}
.info .ic{width:40px;height:40px;border-radius:10px;background:var(--sky);color:var(--sun-ink);display:grid;place-items:center;flex:none}
.info b{display:block;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft)}.info a,.info span{color:var(--ink);text-decoration:none;font-weight:600}
.map{position:relative;height:270px;border-top:1px solid var(--line)}.map iframe{width:100%;height:100%;border:0;display:block}.map .btn{position:absolute;left:14px;bottom:14px;padding:9px 16px;font-size:.88rem}
.form{padding:30px;display:grid;gap:14px;align-content:start}.form h3{font-size:1.4rem}.form .sub{color:var(--ink-soft);font-size:.95rem}
.form label{display:grid;gap:6px;font-size:.85rem;font-weight:700}.form input,.form textarea,.form select{font:inherit;font-size:.97rem;border:1.5px solid var(--line);border-radius:10px;padding:12px 13px;background:var(--paper);color:var(--ink)}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--sun)}.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form .ok{display:none;background:var(--sky);border-radius:10px;padding:12px;font-size:.93rem}
footer{background:${inkCol};color:rgba(255,255,255,.7);font-size:.95rem}
.ft{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:40px;padding-block:56px 40px}.ft h4{color:#fff;font-size:.95rem;margin:0 0 14px}
.ft a{color:rgba(255,255,255,.8);text-decoration:none}.ft ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.ft .fl img{height:48px;width:auto;background:#fff;border-radius:8px;padding:6px 10px;margin-bottom:14px}
.fb{border-top:1px solid rgba(255,255,255,.1);padding-block:18px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:.85rem}
.fab{display:none;position:fixed;right:14px;bottom:14px;z-index:40;background:var(--sun);color:var(--on-sun);border-radius:999px;padding:13px 20px;font-weight:800;text-decoration:none;box-shadow:0 14px 30px -10px rgba(0,0,0,.45);gap:8px;align-items:center}
.phero{position:relative;background:${inkCol};color:#fff;overflow:hidden}.phero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.phero img.ok{opacity:.4}
.phero .wrap{position:relative;padding-block:100px 70px}.phero h1{color:#fff;font-size:clamp(2rem,1.2rem + 3vw,3.4rem);max-width:18em}.phero .lead{color:rgba(255,255,255,.85);margin-top:14px;max-width:40em}
.crumb{font-size:.88rem;color:rgba(255,255,255,.7);margin-bottom:14px}.crumb a{color:#fff;text-decoration:none}
.art{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:56px;align-items:start}
.prose{font-size:1.06rem;color:var(--ink-soft)}.prose h2{font-size:clamp(1.5rem,1.1rem + 1.2vw,2rem);margin:40px 0 14px}.prose h2:first-child{margin-top:0}
.prose p{margin:0 0 16px}.prose ul{padding-left:20px;margin:0 0 18px}.prose li{margin:4px 0}.prose figure{margin:26px 0;border-radius:var(--r);overflow:hidden}.prose figure img{width:100%;max-height:480px;object-fit:cover}
.aside{position:sticky;top:100px;display:grid;gap:16px}.aside .box{padding:24px}.aside h3{margin-bottom:8px}.aside p{color:var(--ink-soft);font-size:.95rem;margin-bottom:14px}
.aside ul{list-style:none;padding:0;margin:0}.aside li a{display:block;padding:9px 0;border-bottom:1px solid var(--line);text-decoration:none;font-weight:600}.aside li a.on{color:var(--sun-ink)}
.rv{opacity:0;transform:translateY(18px);transition:opacity .7s,transform .7s}.rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}}
@media (max-width:980px){.menu,.phone-top{display:none}.burger{display:flex}.top .btn-sun{display:none}
 .top.open .menu{display:flex;position:absolute;left:0;right:0;top:100%;flex-direction:column;gap:0;background:${dark ? `hsl(${h} 30% 10%)` : "var(--paper)"};padding:8px 20px 16px;border-bottom:1px solid var(--line)}
 .top.open .menu a{padding:12px 0}
 .head,.about,.ct,.ft,.art{grid-template-columns:1fr}.svcs,.cols{grid-template-columns:1fr 1fr}.steps{grid-template-columns:1fr 1fr;row-gap:36px}.step:after{display:none}
 .gal{grid-template-columns:1fr 1fr;grid-auto-rows:170px}.gal figure.wide{grid-column:span 2}.hl .grid{grid-template-columns:1fr}.hl .it{border-left:0;border-top:1px solid var(--line)}.hl .it:first-child{border-top:0}
 .stats .wrap{grid-template-columns:1fr 1fr}.col{border-right:0;margin-right:0;border-bottom:1px solid rgba(255,255,255,.12)}.aside{position:static}}
@media (max-width:600px){.svcs,.cols,.steps{grid-template-columns:1fr}.hero-in{padding-block:80px 40px}.row2{grid-template-columns:1fr}.fab{display:inline-flex}section.sec{padding-block:70px}}
`;

  const head = (pageTitle: string, desc: string, current: string) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${pageTitle}</title><meta name="description" content="${desc}"><meta name="theme-color" content="${inkCol}">
<script>function fixGal(){var g=document.querySelector('#realisations .gal');if(!g)return;var n=g.children.length;if(n<3){g.closest('section').remove();return}while(g.children.length%2===0||g.children.length>7)g.lastElementChild.remove();if(g.firstElementChild)g.firstElementChild.classList.add('wide')}
function yf(i){var f=i.closest('figure');if(f){f.remove();fixGal();return}if(i.classList.contains('hero-img')){var h=i.closest('.hero');i.remove();h.classList.add('flat');return}if(i.classList.contains('svc-img')){i.outerHTML='<div class="noimg"></div>';return}var p=i.closest('.phero');if(p){i.remove();return}i.style.display='none';if(i.hasAttribute('data-logo')){[].forEach.call(i.parentNode.querySelectorAll('[hidden]'),function(x){x.hidden=false})}}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${F.link}&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<div class="mbar">Maquette de refonte proposée par Yontech pour ${e(d.name)} — contenus et visuels à valider.<a href="${e(d.source)}" target="_blank" rel="noopener nofollow">Voir le site actuel</a></div>
<header class="top" id="hd"><div class="wrap">
<a class="logo" href="${pages.length ? "/" : "#accueil"}" aria-label="${e(d.name)}">${brand}</a>
<nav class="menu" id="nav">${nav.map(([hr, l]) => `<a href="${e(hr)}"${hr === current ? ' class="on"' : ""}>${e(l)}</a>`).join("")}</nav>
${d.phone ? `<a class="phone-top" href="${e(tel)}">${e(d.phone)}</a>` : ""}<a class="btn btn-sun" href="#contact">${e(cta)}</a>
<button class="burger" type="button" aria-label="Menu" onclick="document.getElementById('hd').classList.toggle('open')"><span></span><span></span><span></span></button>
</div></header>
`;

  const heroHtml = `<section class="hero${heroImg ? "" : " flat"}" id="accueil">${heroImg ? img(heroImg, d.name, "hero-img", false) : ""}<div class="hero-shade"></div>
<div class="wrap hero-in">${kicker ? `<p class="hero-kicker rv">${e(kicker)}</p>` : ""}<h1 class="rv">${e(title)}</h1>${lead ? `<p class="hero-lead rv">${e(lead)}</p>` : ""}
<div class="hero-cta rv"><a class="btn btn-sun" href="#contact">${e(cta)}</a>${gallery.length >= 3 ? `<a class="btn btn-light" href="#realisations">Voir nos réalisations</a>` : services.length ? `<a class="btn btn-light" href="#prestations">Nos prestations</a>` : ""}</div></div></section>
${dark && highlights.length ? `<div class="hl"><div class="wrap"><div class="grid">${highlights.map((x, i) => `<div class="it"><h3>${icon(["pin", "star", "shield"][i % 3], 18)}${e(x.title)}</h3><p>${e(x.text)}</p></div>`).join("")}</div></div></div>`
  : stats.length ? `<div class="stats"><div class="wrap">${stats.map((x) => `<div><b>${e(x.value)}</b><span>${e(x.label)}</span></div>`).join("")}</div></div>` : ""}
`;

  const servicesHtml = services.length ? `<section class="sec" id="prestations"><div class="wrap">
<div class="head"><div><p class="eyebrow">Nos prestations</p>${H2(c?.servicesTitle || "Ce que nous faisons pour vous")}</div>${c?.servicesLead ? `<p>${e(c.servicesLead)}</p>` : ""}</div>
<div class="svcs">${services.map((x) => `<${x.link ? `a href="${e(x.link)}"` : "article"} class="svc rv">${x.image ? img(x.image, x.title, "svc-img") : '<div class="noimg"></div>'}${x.tag ? `<span class="tag">${e(x.tag)}</span>` : ""}<h3>${e(x.title)}</h3>${x.text ? `<p>${e(x.text)}</p>` : ""}${x.bullets.length ? `<ul>${x.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}${x.link ? `<span class="more">En savoir plus ${icon("arrow", 15)}</span>` : ""}</${x.link ? "a" : "article"}>`).join("")}</div>
${c?.extras.length ? `<div class="chips">${c.extras.map((x) => `<span>${e(x)}</span>`).join("")}</div>` : ""}
</div></section>` : "";

  const bandHtml = c?.band && c.band.columns.length >= 2 ? `<section class="sec band"><div class="wrap">
<div class="head"><div>${c.band.kicker ? `<p class="eyebrow">${e(c.band.kicker)}</p>` : ""}${H2(c.band.title)}</div>${c.band.text ? `<p>${e(c.band.text)}</p>` : ""}</div>
<div class="cols">${c.band.columns.map((x) => `<div class="col rv">${x.label ? `<span class="lab">${e(x.label)}</span>` : ""}<h3>${e(x.title)}</h3><p>${e(x.text)}</p></div>`).join("")}</div>
</div></section>` : "";

  const stepsHtml = `<section class="sec sky"><div class="wrap">
<div class="head"><div><p class="eyebrow">Votre projet</p>${H2(c?.stepsTitle || "Comment ça se passe")}</div><p>Un seul interlocuteur, du premier appel à la fin du chantier.</p></div>
<div class="steps">${steps.map((x) => `<div class="step rv"><h3>${e(x.title)}</h3><p>${e(x.text)}</p></div>`).join("")}</div>
</div></section>`;

  const gal = gallery.slice(0, gallery.length >= 7 ? 7 : gallery.length >= 5 ? 5 : 3);
  const galleryHtml = gal.length >= 3 ? `<section class="sec" id="realisations"><div class="wrap">
<div class="head"><div><p class="eyebrow">Réalisations</p>${H2(c?.galleryTitle || "Nos réalisations")}</div></div>
<div class="gal">${gal.map((g, i) => `<figure class="${i === 0 ? "wide" : ""} rv">${img(g, c?.captions[i] || `Réalisation ${d.name}`)}${c?.captions[i] ? `<figcaption>${e(c.captions[i])}</figcaption>` : ""}</figure>`).join("")}</div>
</div></section>` : "";

  const aboutHtml = aboutText ? `<section class="sec sky" id="entreprise"><div class="wrap about">
<div class="rv"><p class="eyebrow">L'entreprise</p>${bigValue ? `<div class="big">${e(bigValue)}</div><p class="lbl">${e(bigLabel)}</p>` : H2(c?.aboutTitle || d.name)}${aboutImg ? `<div class="ph">${img(aboutImg, d.name)}</div>` : ""}</div>
<div class="rv">${bigValue ? H2(c?.aboutTitle || d.name) : ""}<p class="txt" style="margin-top:${bigValue ? "16px" : "0"}">${e(aboutText)}</p>
${points.length ? `<ul class="pts">${points.map((x) => `<li>${icon("check", 22)}<div><b>${e(x.title)}</b><span>${e(x.text)}</span></div></li>`).join("")}</ul>` : ""}</div>
</div></section>` : "";

  const certsHtml = certs.length ? `<section class="sec"><div class="wrap"><div class="head"><div><p class="eyebrow">Nos qualifications</p>${H2("Un savoir-faire reconnu")}</div></div>
<div class="certs">${certs.map((x) => `<div class="cert rv">${icon("shield", 26)}${e(x)}</div>`).join("")}</div></div></section>` : "";

  const ctaHtml = `<section class="cta"><div class="wrap"><div><h2>${e(c?.ctaTitle || "Un projet ? Parlons-en.")}</h2><p>${e(c?.ctaText || (d.city ? `${d.name}, à ${d.city}. Décrivez-nous votre besoin, nous revenons vers vous.` : "Décrivez-nous votre besoin, nous revenons vers vous."))}</p></div>
<div class="acts"><a class="btn btn-ink" href="#contact">${e(cta)}</a>${d.phone ? `<a class="btn btn-ghost" href="${e(tel)}">${icon("phone", 16)}${e(d.phone)}</a>` : ""}</div></div></section>`;

  const contactHtml = `<section class="sec" id="contact"><div class="wrap">
<div class="head"><div><p class="eyebrow">Contact</p>${H2("Parlons de votre projet")}</div></div>
<div class="ct"><div class="box rv"><ul class="info">
${d.address ? `<li><span class="ic">${icon("pin", 18)}</span><div><b>Adresse</b><span>${e(d.address)}</span></div></li>` : d.city ? `<li><span class="ic">${icon("pin", 18)}</span><div><b>Ville</b><span>${e([cp, d.city].filter(Boolean).join(" "))}</span></div></li>` : ""}
${d.phone ? `<li><span class="ic">${icon("phone", 18)}</span><div><b>Téléphone</b><a href="${e(tel)}">${e(d.phone)}</a></div></li>` : ""}
${d.email ? `<li><span class="ic">${icon("mail", 18)}</span><div><b>E-mail</b><a href="mailto:${e(d.email)}">${e(d.email)}</a></div></li>` : ""}
${d.hours.length ? `<li><span class="ic">${icon("clock", 18)}</span><div><b>Horaires</b><span>${d.hours.map((x) => e(x)).join("<br>")}</span></div></li>` : ""}
</ul>${mapQ ? `<div class="map"><iframe title="Plan d'accès" loading="lazy" src="https://maps.google.com/maps?q=${mapEnc}&z=${/\b\d{5}\b/.test(d.address) ? 15 : 12}&hl=fr&output=embed"></iframe><a class="btn btn-sun" href="https://www.google.com/maps/dir/?api=1&destination=${mapEnc}" target="_blank" rel="noopener">${icon("route", 15)}Itinéraire</a></div>` : ""}</div>
<form class="box form rv" onsubmit="event.preventDefault();this.querySelector('.ok').style.display='block';this.querySelector('button').disabled=true">
<h3>Demande de devis</h3><p class="sub">Réponse rapide, sans engagement.</p>
<div class="row2"><label>Nom<input required autocomplete="name"></label><label>Téléphone<input type="tel" required autocomplete="tel"></label></div>
<label>E-mail<input type="email" autocomplete="email"></label>
${services.length ? `<label>Votre besoin<select><option value="">Choisir…</option>${services.map((x) => `<option>${e(x.title)}</option>`).join("")}<option>Autre</option></select></label>` : ""}
<label>Votre projet<textarea rows="4" placeholder="Quelques mots sur votre projet, le lieu, les délais…"></textarea></label>
<button class="btn btn-sun" type="submit">Envoyer ma demande</button><p class="ok">Formulaire de démonstration : sur le site en ligne, votre demande arrivera directement chez ${e(d.name)}.</p>
</form></div></div></section>`;

  const tail = `<footer><div class="wrap"><div class="ft">
<div class="fl">${d.logo ? `<img onerror="this.remove()" src="${e(px(d.logo))}" alt="${e(d.name)}" loading="lazy">` : `<h4>${e(d.name)}</h4>`}<p>${e(short(lead || d.intro, 160))}</p></div>
<div><h4>Contact</h4><ul>${d.address ? `<li>${e(d.address)}</li>` : d.city ? `<li>${e(d.city)}</li>` : ""}${d.phone ? `<li><a href="${e(tel)}">${e(d.phone)}</a></li>` : ""}${d.email ? `<li><a href="mailto:${e(d.email)}">${e(d.email)}</a></li>` : ""}</ul></div>
<div><h4>Navigation</h4><ul>${nav.map(([hr, l]) => `<li><a href="${e(hr)}">${e(l)}</a></li>`).join("")}${d.socials.map((x) => `<li><a href="${e(x.url)}" target="_blank" rel="noopener">${e(x.label)}</a></li>`).join("")}</ul></div>
</div><div class="fb"><span>© ${year} ${e(d.name)}</span><span>Maquette de refonte réalisée par <a href="https://yontech.fr" target="_blank" rel="noopener">Yontech</a></span></div></div></footer>
${d.phone ? `<a class="fab" href="${e(tel)}">${icon("phone", 17)}Appeler</a>` : ""}
<script>(function(){
var els=document.querySelectorAll('.rv');if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}})},{threshold:.1});els.forEach(function(x){io.observe(x)})}else{els.forEach(function(x){x.classList.add('in')})}
function ph(i){if(i.dataset.done)return;i.dataset.done=1;try{var N=64,c=document.createElement('canvas');c.width=N;c.height=N;var x=c.getContext('2d');x.drawImage(i,0,0,N,N);var d=x.getImageData(0,0,N,N).data,h={},n=N*N;for(var k=0;k<d.length;k+=4){var q=(d[k]>>3)<<10|(d[k+1]>>3)<<5|(d[k+2]>>3);h[q]=(h[q]||0)+1}var b=Object.keys(h).map(function(z){return h[z]}).sort(function(p,q){return q-p});if(b[0]/n>=.4||((b[0]||0)+(b[1]||0)+(b[2]||0))/n>=.5){yf(i);return}}catch(e){}i.classList.add('ok')}
[].forEach.call(document.querySelectorAll('img[data-ph]'),function(i){if(i.complete&&i.naturalWidth)ph(i);else i.addEventListener('load',function(){ph(i)})});
setTimeout(function(){[].forEach.call(document.querySelectorAll('img[data-ph]'),function(i){i.classList.add('ok')})},6000);
var lg=document.querySelector('[data-logo]');function chk(){if(!lg||!lg.naturalWidth)return;if(lg.naturalWidth<40){yf(lg);return}${dark ? "" : "try{var c=document.createElement('canvas'),w=c.width=Math.min(120,lg.naturalWidth),hh=c.height=Math.max(1,Math.round(w*lg.naturalHeight/lg.naturalWidth)),x=c.getContext('2d');x.drawImage(lg,0,0,w,hh);var d=x.getImageData(0,0,w,hh).data,n=0,l=0;for(var k=0;k<d.length;k+=4){if(d[k+3]>60){n++;l+=(.2126*d[k]+.7152*d[k+1]+.0722*d[k+2])/255}}if(n>20&&l/n>.86)lg.parentNode.classList.add('dark')}catch(e){}"}}if(lg){if(lg.complete)chk();else lg.addEventListener('load',chk)}
})();</script></body></html>`;

  const home = head(e(d.name) + (kicker ? " · " + e(kicker) : ""), e(lead), "/") + heroHtml + servicesHtml + bandHtml + stepsHtml + galleryHtml + aboutHtml + certsHtml + ctaHtml + contactHtml + tail;

  const prose = (blocks: Block[]) => {
    let out = "", list: string[] = [];
    const flush = () => { if (list.length) { out += `<ul>${list.join("")}</ul>`; list = []; } };
    for (const b of blocks) {
      if (b.t === "li") { list.push(`<li>${e(b.v)}</li>`); continue; }
      flush();
      out += b.t === "h" ? `<h2>${e(b.v)}</h2>` : b.t === "p" ? `<p>${e(b.v)}</p>` : `<figure>${img(b.v, d.name)}</figure>`;
    }
    flush();
    return out;
  };
  const pageHtml = (pg: PageModel) => `<section class="phero">${pg.image ? img(pg.image, "", "", false) : ""}<div class="wrap"><p class="crumb"><a href="/">Accueil</a> / ${e(pg.label)}</p><h1>${e(pg.title)}</h1>${pg.intro && pg.kind !== "gallery" ? `<p class="lead">${e(pg.intro)}</p>` : ""}</div></section>
<section class="sec"><div class="wrap art"><article class="prose">${pg.kind === "gallery" ? `<div class="gal">${pg.blocks.filter((b) => b.t === "img").map((b, i) => `<figure class="${i === 0 ? "wide" : ""}">${img(b.v, d.name)}</figure>`).join("")}</div>` : prose(pg.blocks)}</article>
<aside class="aside"><div class="box"><h3>Un projet ?</h3><p>${e(d.name)} vous répond${d.city ? " à " + e(d.city) + " et alentours" : ""}.</p>${d.phone ? `<a class="btn btn-sun" href="${e(tel)}" style="margin-bottom:10px">${icon("phone", 16)}${e(d.phone)}</a>` : ""}<a class="btn btn-ink" href="#contact">${e(cta)}</a></div>
${pages.length > 1 ? `<div class="box"><h3>Nos pages</h3><ul>${pages.map((x) => `<li><a href="${e(x.path)}"${x.path === pg.path ? ' class="on"' : ""}>${e(x.label)}</a></li>`).join("")}</ul></div>` : ""}</aside></div></section>`;
  const pageList = pages.map((pg) => ({ path: pg.path, html: head(e(pg.title) + " · " + e(d.name), e(pg.intro || lead), pg.path) + pageHtml(pg) + ctaHtml + contactHtml + tail }));
  return { home, pages: pageList };
}
