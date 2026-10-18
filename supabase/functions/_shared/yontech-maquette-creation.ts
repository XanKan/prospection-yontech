import type { SiteData } from "./yontech-maquette.ts";

// Maquettes « création » : entreprises sans site internet. Rien à lire en ligne :
// la fiche est construite à partir des données publiques déjà connues (nom,
// activité NAF, ville, téléphone, dirigeant, qualification RGE), puis Claude
// dessine le site sans photo (typographie, couleurs, pictogrammes).

// Libellés des activités du bâtiment (nomenclature NAF), formulés comme un métier.
const NAF_METIERS: Record<string, string> = {
  "41.10A": "promotion immobilière", "41.10B": "promotion immobilière", "41.10C": "promotion immobilière", "41.10D": "promotion immobilière",
  "41.20A": "construction de maisons individuelles", "41.20B": "construction de bâtiments",
  "42.11Z": "travaux routiers", "42.12Z": "voies ferrées", "42.13A": "ouvrages d'art", "42.13B": "travaux souterrains",
  "42.21Z": "réseaux pour fluides", "42.22Z": "réseaux électriques et de télécommunications", "42.91Z": "ouvrages maritimes et fluviaux",
  "42.99Z": "travaux de génie civil",
  "43.11Z": "démolition", "43.12A": "terrassement", "43.12B": "terrassement spécialisé", "43.13Z": "forages et sondages",
  "43.21A": "électricité", "43.21B": "électricité sur la voie publique",
  "43.22A": "plomberie et installation de chauffage (eau, gaz)", "43.22B": "chauffage, climatisation et ventilation",
  "43.29A": "isolation", "43.29B": "installation d'équipements du bâtiment",
  "43.31Z": "plâtrerie", "43.32A": "menuiserie bois et PVC", "43.32B": "menuiserie métallique et serrurerie", "43.32C": "agencement de lieux de vente",
  "43.33Z": "revêtement des sols et des murs", "43.34Z": "peinture et vitrerie", "43.39Z": "finitions du bâtiment",
  "43.91A": "charpente", "43.91B": "couverture", "43.99A": "étanchéité", "43.99B": "montage de structures métalliques",
  "43.99C": "maçonnerie générale et gros œuvre", "43.99D": "travaux spécialisés de construction", "43.99E": "location de matériel avec opérateur",
  "71.12B": "ingénierie et études techniques", "81.30Z": "aménagement paysager",
};

// Liste des métiers distincts (jeux de textes des créations).
export const METIERS = [...new Set(Object.values(NAF_METIERS))];

export function metierOf(naf: string, fallback = "") {
  return NAF_METIERS[String(naf || "").toUpperCase()] || fallback || "bâtiment";
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s\-'’])([a-zà-ÿ])/g, (_m, a, b) => a + b.toUpperCase())
  .replace(/\b(Et|De|Du|Des|La|Le|Les|En|Sur|Sous|Aux?|D'|L')\b/g, (w) => w.toLowerCase());

// Nom d'affichage : « SOC PROVENCALE MENUISERIE DE POSE » → « Soc Provencale Menuiserie de Pose ».
export function displayName(company: string) {
  const s = String(company || "").trim();
  return /[a-z]/.test(s) ? s : title(s);
}

export function creationData(msg: { company: string; email: string; data: Record<string, unknown> }): SiteData {
  const d = msg.data || {};
  const str = (k: string) => String(d[k] ?? "").trim();
  const metier = metierOf(str("naf"), str("metier"));
  const ville = str("ville") ? title(str("ville")) : "";
  const name = displayName(msg.company);
  const facts: { value: string; label: string }[] = [];
  if (str("source") === "rge") facts.push({ value: "RGE", label: "entreprise qualifiée RGE (annuaire public de l'ADEME)" });
  const dirigeant = [str("prenom"), str("nom")].filter(Boolean).join(" ");
  const about = [
    `${name} est une entreprise de ${metier}${ville ? ` installée à ${ville}${str("cp") ? ` (${str("cp").slice(0, 2)})` : ""}` : ""}.`,
    ...(dirigeant ? [`Dirigeant : ${title(dirigeant)}.`] : []),
    ...(str("effectif") ? [`Effectif déclaré : ${str("effectif")} salarié(s).`] : []),
  ];
  return {
    source: "", host: "", name, logo: "", eyebrow: [metier, ville].filter(Boolean).join(" · "),
    tagline: `${metier.charAt(0).toUpperCase() + metier.slice(1)}${ville ? ` à ${ville}` : ""}`, intro: about[0],
    about, services: [{ title: metier.charAt(0).toUpperCase() + metier.slice(1), text: "" }], images: [],
    phone: str("tel"), email: msg.email || "", address: [str("cp"), ville].filter(Boolean).join(" "), city: ville, cp: str("cp"),
    hours: [], accent: "#1e5aa8", socials: [], facts, quality: { ok: true, blocking: [], warnings: ["création : textes proposés à partir de l'activité, à faire valider"] },
    pages: [],
  };
}

// Brief propre à la création, ajouté à la demande faite à Claude.
export function creationBrief(d: SiteData) {
  return `CRÉATION D'UN PREMIER SITE : cette entreprise n'a aucun site internet, aucune photo et aucun texte en ligne. Tu ne disposes que des données publiques ci-dessus.

- Rédige des textes sobres et crédibles sur le métier (${d.eyebrow}) : ce que fait en général une entreprise de ce métier, formulé comme une proposition (le dirigeant validera). Reste général sur les prestations typiques de ce métier, sans détail invérifiable.
- Interdits absolus : années, ancienneté, nombre de chantiers ou de clients, avis, témoignages, garanties, délais, prix, zone d'intervention précise, marques, labels autres que ceux fournis.
- Aucune photo n'est disponible : n'utilise aucune image. Compose avec la typographie, la couleur, des aplats, des motifs et des pictogrammes en SVG en ligne liés au métier. Le site doit rester beau et complet sans photo.
- Choisis une couleur principale adaptée au métier (pas de violet générique).
- Le nom de l'entreprise en logotype typographique soigné dans l'en-tête.
- Sections utiles : accueil fort, prestations du métier, l'entreprise (avec les seules informations fournies), qualification si fournie, contact avec le téléphone fourni et un formulaire de demande de devis.`;
}
