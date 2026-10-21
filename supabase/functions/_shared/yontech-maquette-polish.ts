import { parseHTML } from "npm:linkedom@0.18.5";

// Finition des maquettes « maison » (remplies depuis la bibliothèque de modèles),
// par règles générales, jamais maquette par maquette :
// - une case photo dont la photo manque disparaît (au lieu d'un grand bloc vide) ;
// - une légende vide, un lien ou un bouton vide disparaissent ;
// - un titre ou un paragraphe déjà présent plus haut n'est pas répété ;
// - un bloc de contenu resté vide disparaît, et sa section si elle n'a plus qu'un titre ;
// - une section restée sans texte ni image disparaît.

const MEDIA = "img,svg,iframe,video,canvas,picture,form,input,textarea,select,button";
const norm = (t: string | null | undefined) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();

// Sélecteurs CSS du modèle qui portent une photo en image de fond : url({{photoN}}).
export function photoSelectors(tpl: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const style of tpl.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}@]+)\{([^{}]*url\(\s*['"]?\{\{\s*photo(\d+)\s*\}\}['"]?\s*\)[^{}]*)\}/g)) {
      const n = Number(rule[3]);
      const sels = rule[1].split(",").map((s) => s.trim().replace(/::?(before|after)$/i, "")).filter((s) => s && !/[:]{1,2}(hover|focus|active)/.test(s));
      out.set(n, [...(out.get(n) || []), ...sels]);
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
const isEmptyBox = (el: any) => !norm(el.textContent) && !el.querySelector(MEDIA);
// En-tête et pied de page du site (pas l'en-tête <header> d'une section) : jamais modifiés.
// deno-lint-ignore no-explicit-any
const siteChrome = (el: any) => Boolean(el.closest("footer,nav")) || Boolean(el.closest("header") && !el.closest("header").closest("section,article,main"));

export function polishHtml(html: string, opts: { name?: string; missingPhotoSelectors?: string[] } = {}): string {
  // deno-lint-ignore no-explicit-any
  const document = (parseHTML(html) as any).document;
  const body = document.body;
  if (!body) return html;
  const keepTitle = norm(opts.name);
  // Sections qui ont perdu du contenu (doublon ou bloc vide retiré) : à vérifier à l'étape 5.
  const emptied = new Set<unknown>();

  // 1. Cases photo sans photo : en ligne (style="…url('')…") ou par une règle du modèle.
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("[style]").forEach((el: any) => {
    const st = String(el.getAttribute("style") || "");
    if (!/url\(\s*(['"]?)\s*\1\s*\)/i.test(st)) return;
    if (isEmptyBox(el)) el.remove();
    else el.setAttribute("style", st.replace(/background(-image)?\s*:[^;]*url\(\s*(['"]?)\s*\2\s*\)[^;]*;?/gi, ""));
  });
  for (const sel of opts.missingPhotoSelectors || []) {
    let found: unknown[] = [];
    try { found = [...body.querySelectorAll(sel)]; } catch { continue; }
    // deno-lint-ignore no-explicit-any
    for (const el of found as any[]) if (isEmptyBox(el)) el.remove();
  }

  // 2. Légendes vides, et liens ou boutons vides (téléphone inconnu…) ; un bouton de menu
  // (éléments internes ou libellé d'accessibilité) reste.
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("figcaption,[class*=caption],[class*=legende],[class*=legend]").forEach((el: any) => { if (isEmptyBox(el)) el.remove(); });
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("a,button").forEach((el: any) => { if (isEmptyBox(el) && !el.children.length && !el.getAttribute("aria-label") && !el.getAttribute("title")) el.remove(); });

  // 2 bis. Séparateurs restés seuls en début ou en fin de texte (« Rennes · » quand le téléphone manque).
  const SEP = /^[\s\u00a0]*[·•|–—\/,][\s\u00a0]*$/;
  // deno-lint-ignore no-explicit-any
  const walk = (node: any) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && !/^(SCRIPT|STYLE)$/i.test(c.tagName)) walk(c);
      if (c.nodeType !== 3) continue;
      let t = String(c.data);
      const prev = c.previousSibling, next = c.nextSibling;
      const prevGone = !prev || (prev.nodeType === 3 && !String(prev.data).trim());
      const nextGone = !next || (next.nodeType === 3 && !String(next.data).trim());
      if (nextGone) t = t.replace(/[\s\u00a0]*[·•|–—\/][\s\u00a0]*$/, "");
      if (prevGone) t = t.replace(/^[\s\u00a0]*[·•|–—\/][\s\u00a0]*/, "");
      t = t.replace(/([·•|])[\s\u00a0]*[·•|]/g, "$1");
      if (SEP.test(t)) t = "";
      if (t !== c.data) c.data = t;
    }
  };
  walk(body);

  // 2 ter. Étiquette sans valeur (« Téléphone » quand le numéro manque) : la ligne disparaît.
  const LABELS = new Set(["téléphone", "tél.", "tél", "tel", "e-mail", "email", "mail", "adresse", "horaires", "site", "fax", "portable", "mobile", "siret", "ville", "activité", "métier"]);
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("dt,span,small,strong,b,label,p,div").forEach((el: any) => {
    const t = norm(el.textContent).replace(/\s*:$/, "");
    if (!LABELS.has(t) || el.children.length > 1) return;
    const row = el.parentElement;
    if (!row || row === body || el.closest("form")) return;
    if (norm(row.textContent).replace(/\s*:$/, "") === t && !row.querySelector(MEDIA)) row.remove();
    else if (el.tagName === "DT" && el.nextElementSibling?.tagName === "DD" && !norm(el.nextElementSibling.textContent)) { el.nextElementSibling.remove(); el.remove(); }
  });

  // 3. Titres répétés (hors nom de l'entreprise, en-tête et pied de page) : le premier reste.
  const seenTitles = new Set<string>();
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("h1,h2,h3,h4").forEach((h: any) => {
    const t = norm(h.textContent);
    if (t.length < 6 || t === keepTitle || siteChrome(h)) return;
    if (seenTitles.has(t)) { emptied.add(h.closest("section,article,aside")); h.remove(); } else seenTitles.add(t);
  });

  // 4. Paragraphes répétés (50 caractères ou plus) : le premier reste.
  const seenText = new Set<string>();
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("p,blockquote,li").forEach((p: any) => {
    // Comparaison sans espaces : « Titre</h3><p>Texte » et « <strong>Titre</strong> Texte » sont le même contenu.
    const t = norm(p.textContent).replace(/\s+/g, "");
    if (t.length < 45 || siteChrome(p) || p.closest("form")) return;
    if (seenText.has(t)) { emptied.add(p.closest("section,article,aside")); p.remove(); } else seenText.add(t);
  });

  // 4 bis. Conteneurs de contenu restés vides (liste de questions, texte d'équipe, cartes,
  // case photo sans photo), y compris après le retrait des doublons : retirés ; leur
  // section, si elle n'a plus qu'un titre, est retirée à l'étape 5.
  const CONTENT = /(list|items|text|content|body|cards|faq|team|copy|desc|inner|entries|grid|^ph$|\bph\b|photo|media|visual|image|pic|thumb|cover)/i;
  // deno-lint-ignore no-explicit-any
  [...body.querySelectorAll("div,ul,ol,dl")].reverse().forEach((el: any) => {
    if (!CONTENT.test(String(el.getAttribute("class") || "")) || !isEmptyBox(el)) return;
    emptied.add(el.closest("section,article,aside"));
    el.remove();
  });

  // 5. Sections devenues vides (ni texte ni image), ou réduites à leur titre après
  // l'étape 1 bis : retirées, ainsi que les liens du menu vers elles.
  // deno-lint-ignore no-explicit-any
  const onlyTitle = (s: any) => { if (s.querySelector(MEDIA)) return false; const c = s.cloneNode(true); c.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*=eyebrow],[class*=kicker],[class*=label],[class*=num]").forEach((x: any) => x.remove()); return norm(c.textContent).length < 25; };
  // deno-lint-ignore no-explicit-any
  body.querySelectorAll("section,article,aside").forEach((s: any) => {
    if (!isEmptyBox(s) && !(emptied.has(s) && onlyTitle(s))) return;
    const id = s.getAttribute("id");
    s.remove();
    // deno-lint-ignore no-explicit-any
    if (id) body.querySelectorAll(`a[href="#${id}"]`).forEach((a: any) => (a.closest("li") || a).remove());
  });

  return document.toString();
}
