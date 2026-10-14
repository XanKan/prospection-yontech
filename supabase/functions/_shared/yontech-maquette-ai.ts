import type { Block, SiteData } from "./yontech-maquette.ts";

// Rédaction de la maquette par IA (facultative : secret YONTECH_ANTHROPIC_API_KEY).
// Le modèle relit tout ce qui a été extrait du site actuel et rend des textes
// courts et structurés (accroche, prestations avec étiquette et puces, étapes,
// légendes, atouts…). Règle absolue : aucun fait inventé — chiffres, labels,
// garanties, gratuité ou délais seulement s'ils figurent dans la source.

export type Copy = {
  kicker: string; title: string; lead: string; cta: string;
  highlights: { title: string; text: string }[];
  stats: { value: string; label: string }[];
  servicesTitle: string; servicesLead: string;
  services: { source: number; title: string; tag: string; text: string; bullets: string[] }[];
  extras: string[];
  band: { kicker: string; title: string; text: string; columns: { label: string; title: string; text: string }[] } | null;
  stepsTitle: string; steps: { title: string; text: string }[];
  galleryTitle: string; captions: string[];
  aboutTitle: string; aboutText: string; bigValue: string; bigLabel: string; points: { title: string; text: string }[];
  ctaTitle: string; ctaText: string;
};

const MODEL = "claude-sonnet-5-5";
const cut = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const arr = <T>(v: unknown, n: number, f: (x: Record<string, unknown>) => T | null): T[] =>
  (Array.isArray(v) ? v : []).slice(0, n).map((x) => (x && typeof x === "object" ? f(x as Record<string, unknown>) : null)).filter(Boolean) as T[];

function sourceText(d: SiteData, extra: { paragraphs: string[]; pages: { label: string; blocks: Block[] }[]; imageNames: string[] }) {
  const lines: string[] = [];
  lines.push(`ENTREPRISE : ${d.name}`, `VILLE : ${d.city} ${d.cp || ""}`, `ADRESSE : ${d.address}`, `TÉLÉPHONE : ${d.phone}`);
  if (d.hours.length) lines.push(`HORAIRES : ${d.hours.join(" ; ")}`);
  lines.push(`TITRE ACTUEL : ${d.tagline}`, `INTRODUCTION : ${d.intro}`);
  if (d.facts?.length) lines.push(`FAITS RELEVÉS : ${d.facts.map((f) => f.value + " " + f.label).join(" ; ")}`);
  lines.push("PRESTATIONS REPÉRÉES :");
  d.services.forEach((s, i) => lines.push(`  [${i}] ${s.title} — ${s.text}`));
  lines.push("TEXTES DE L'ENTREPRISE :", ...d.about.map((p) => "  " + p), ...extra.paragraphs.slice(0, 8).map((p) => "  " + cut(p, 500)));
  for (const pg of extra.pages.slice(0, 6)) {
    lines.push(`PAGE « ${pg.label} » :`);
    let n = 0;
    for (const b of pg.blocks) { if (b.t === "img") continue; lines.push("  " + (b.t === "h" ? "## " : b.t === "li" ? "- " : "") + cut(b.v, 300)); if (++n >= 18) break; }
  }
  lines.push("PHOTOS (nom de fichier, dans l'ordre de la galerie) :", ...extra.imageNames.map((n, i) => `  [${i}] ${n}`));
  return lines.join("\n").slice(0, 24_000);
}

export async function rewriteCopy(apiKey: string, d: SiteData, extra: { paragraphs: string[]; pages: { label: string; blocks: Block[] }[]; imageNames: string[] }): Promise<Copy | null> {
  const prompt = `Tu es concepteur-rédacteur web pour une agence française. À partir du contenu extrait du site actuel d'une entreprise, rédige les textes de la nouvelle page d'accueil, au ton professionnel, concret et chaleureux, en français.

RÈGLES ABSOLUES
- N'invente AUCUN fait : pas de chiffre, d'année, de nombre de clients, de label (RGE, Qualibat…), de garantie, de délai, de prix, de « gratuit », de zone d'intervention ou de prestation qui ne figure pas dans la source. Tu peux reformuler, résumer, regrouper.
- Si une information manque, laisse le champ vide ("" ou []), ne comble pas.
- Textes courts : titre 4 à 9 mots, sans le nom de l'entreprise ; phrases simples ; pas de majuscules partout ; pas d'emoji.
- Les étapes « comment ça se passe » peuvent être génériques et propres au métier (prise de contact, visite, devis, réalisation, suivi), sans promesse chiffrée.

Réponds UNIQUEMENT par un objet JSON valide, de cette forme :
{
 "kicker": "métier · ville (département) — court",
 "title": "accroche 4 à 9 mots",
 "lead": "1 à 2 phrases, 35 mots max, ce que fait l'entreprise et pour qui",
 "cta": "texte du bouton principal (ex. Demander un devis)",
 "highlights": [{"title":"3 à 4 mots","text":"1 phrase"}],      // 3 atouts tirés de la source (siège, zone, clientèle, spécialité…)
 "stats": [{"value":"court","label":"court"}],                  // 0 à 4, seulement des chiffres présents dans la source
 "servicesTitle": "titre de section 3 à 7 mots", "servicesLead": "1 phrase",
 "services": [{"source": index de la prestation repérée, "title":"2 à 4 mots","tag":"étiquette très courte en lien avec la source (cible, matériau, gamme…) ou vide","text":"1 phrase de 20 mots max","bullets":["3 puces courtes tirées de la source"]}],   // 3 à 6
 "extras": ["prestations secondaires citées dans la source, 2 à 4 mots chacune"],   // 0 à 6
 "band": {"kicker":"court","title":"titre","text":"1 phrase","columns":[{"label":"court","title":"2 à 4 mots","text":"1 à 2 phrases"}]} ou null,   // 3 colonnes qui expliquent un choix ou des spécialités, seulement si la source s'y prête
 "stepsTitle": "titre", "steps": [{"title":"2 à 4 mots","text":"1 phrase"}],   // exactement 4
 "galleryTitle": "titre", "captions": ["légende courte pour chaque photo, d'après son nom de fichier, ou vide si on ne peut pas savoir"],
 "aboutTitle": "titre", "aboutText": "60 mots max", "bigValue": "un chiffre fort de la source ou vide", "bigLabel": "ce qu'il mesure",
 "points": [{"title":"2 à 4 mots","text":"1 phrase"}],   // 3 à 5 atouts tirés de la source
 "ctaTitle": "question ou invitation courte", "ctaText": "1 phrase"
}

CONTENU EXTRAIT DU SITE ACTUEL :
${sourceText(d, extra)}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3500, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(75_000),
    });
    if (!response.ok) { console.error("[Maquette IA]", response.status, (await response.text()).slice(0, 300)); return null; }
    const out = await response.json();
    const text = String(out?.content?.[0]?.text || "");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const nServices = d.services.length;
    const copy: Copy = {
      kicker: cut(json.kicker, 90), title: cut(json.title, 90), lead: cut(json.lead, 260), cta: cut(json.cta, 40) || "Demander un devis",
      highlights: arr(json.highlights, 3, (x) => x.title ? { title: cut(x.title, 40), text: cut(x.text, 140) } : null),
      stats: arr(json.stats, 4, (x) => x.value ? { value: cut(x.value, 16), label: cut(x.label, 40) } : null),
      servicesTitle: cut(json.servicesTitle, 70), servicesLead: cut(json.servicesLead, 200),
      services: arr(json.services, 6, (x) => x.title ? { source: Number.isInteger(x.source) && Number(x.source) < nServices ? Number(x.source) : -1, title: cut(x.title, 50), tag: cut(x.tag, 30), text: cut(x.text, 170), bullets: Array.isArray(x.bullets) ? (x.bullets as unknown[]).slice(0, 3).map((b) => cut(b, 70)).filter(Boolean) : [] } : null),
      extras: (Array.isArray(json.extras) ? json.extras : []).slice(0, 6).map((x: unknown) => cut(x, 40)).filter(Boolean),
      band: json.band && json.band.title && Array.isArray(json.band.columns) && json.band.columns.length >= 2
        ? { kicker: cut(json.band.kicker, 60), title: cut(json.band.title, 80), text: cut(json.band.text, 200), columns: arr(json.band.columns, 3, (c) => c.title ? { label: cut(c.label, 40), title: cut(c.title, 50), text: cut(c.text, 220) } : null) }
        : null,
      stepsTitle: cut(json.stepsTitle, 70), steps: arr(json.steps, 4, (x) => x.title ? { title: cut(x.title, 40), text: cut(x.text, 160) } : null),
      galleryTitle: cut(json.galleryTitle, 70), captions: (Array.isArray(json.captions) ? json.captions : []).map((x: unknown) => cut(x, 50)),
      aboutTitle: cut(json.aboutTitle, 70), aboutText: cut(json.aboutText, 480), bigValue: cut(json.bigValue, 14), bigLabel: cut(json.bigLabel, 60),
      points: arr(json.points, 5, (x) => x.title ? { title: cut(x.title, 40), text: cut(x.text, 160) } : null),
      ctaTitle: cut(json.ctaTitle, 80), ctaText: cut(json.ctaText, 200),
    };
    return copy.title && copy.services.length ? copy : null;
  } catch (error) {
    console.error("[Maquette IA]", (error as Error).message);
    return null;
  }
}
