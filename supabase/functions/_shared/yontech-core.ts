// Logique pure de l'automate de prospection Yontech : marque, personnalisation
// des modèles, composition des messages, classement des erreurs SMTP,
// ciblage SIRENE (tous secteurs), normalisation des entreprises, score, et
// aide à la découverte des sites et adresses e-mail. Aucune dépendance Deno :
// le module est aussi exécuté sous Node par tests/core.test.mjs.
//
// Projet indépendant de l'outil Piloz : rien ici n'est partagé avec lui.

/* ===================== Marque ===================== */

export const BRAND = {
  name: "Yontech",
  site: "https://yontech.fr",
  // Logo PNG servi par l'outil lui-même (GitHub Pages) : les clients mail
  // n'affichent pas les SVG. Vide = signature sans logo.
  logo: "https://prospection.yontech.fr/assets/yontech-logo-112.png",
  tool: "https://prospection.yontech.fr/",
  unsubscribePage: "https://prospection.yontech.fr/desinscription.html",
  senderName: "Équipe Yontech",
  accent: "#4F46E5",
  // Domaines vers lesquels les liens suivis peuvent rediriger.
  linkDomains: ["yontech.fr", "piloz.fr", "netozia.fr", "querax.fr", "youtube.com", "youtu.be", "calendly.com"],
};

export type Vars = Record<string, string>;
export type ProspectData = {
  entreprise?: string; prenom?: string; nom?: string; ville?: string; cp?: string;
  metier?: string; departement?: string; effectif?: string; site?: string; tel?: string; constat?: string;
};

export const TEMPLATE_VARIABLES = ["bonjour", "prenom", "nom", "entreprise", "ville", "metier", "departement", "effectif", "site", "constat", "video"];

export function youtubeId(url: string) {
  const match = String(url || "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : "";
}

const UPPER_WORDS = new Set(["SARL", "SAS", "SASU", "EURL", "SA", "SNC", "SCI", "SCOP", "EI", "EIRL", "SC", "GIE", "SELARL", "SCP", "SCA", "BTP", "TP", "VRD", "CVC", "ETS", "RH", "IT", "ERP", "CRM"]);
const SMALL_WORDS = new Set(["de", "du", "des", "la", "le", "les", "et", "en", "d", "l", "a", "au", "aux", "sur"]);

function clean(value: unknown, max = 200) {
  // deno-lint-ignore no-control-regex
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// SIRENE publie les raisons sociales en capitales (« DUPONT MECANIQUE (DM) »).
// Dans un e-mail écrit à la main, on écrirait « Dupont Mecanique ».
export function niceCompany(raw: unknown) {
  const base = clean(raw).replace(/\s*\([^)]*\)/g, "").trim();
  if (!base) return "";
  if (base !== base.toUpperCase()) return base;
  return base.toLowerCase().split(" ").map((word, index) => {
    const upper = word.toUpperCase();
    if (UPPER_WORDS.has(upper.replace(/[^A-Z]/g, ""))) return upper;
    if (index > 0 && SMALL_WORDS.has(word)) return word;
    return word.replace(/(^|[-'’])([a-zà-ÿ])/g, (_m, sep, letter) => sep + letter.toUpperCase());
  }).join(" ");
}

export function capitalName(raw: unknown) {
  return clean(raw).toLowerCase().replace(/(^|[\s'\-])([a-zà-ÿ])/g, (_m, sep, letter) => sep + letter.toUpperCase());
}

export function templateVars(data: ProspectData): Vars {
  const prenom = capitalName(data.prenom).split(" ")[0] || "";
  return {
    bonjour: prenom ? `Bonjour ${prenom}` : "Bonjour",
    prenom,
    nom: capitalName(data.nom),
    entreprise: niceCompany(data.entreprise),
    ville: capitalName(data.ville),
    metier: clean(data.metier, 120),
    departement: clean(data.departement, 4),
    effectif: clean(data.effectif, 40),
    // Site internet de l'entreprise (celui où l'adresse a été trouvée), sans protocole.
    site: clean(data.site, 120).replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    // Constat mesuré sur le site existant (« ne s'affiche pas correctement sur téléphone »), vide sinon.
    constat: clean(data.constat, 160),
  };
}

/* ===================== Constat sur un site existant ===================== */

// Observations mesurables sur la page d'accueil d'un site, formulées pour
// suivre « le site de {entreprise} … ». Les plus parlantes d'abord. Les
// trois premières catégories (téléphone, sécurité, ancienneté) et la lenteur
// orientent vers la campagne « Sites internet » (refonte).
export function siteFindings(html: string, url: string, ms?: number, now = new Date()) {
  const out: string[] = [];
  const head = String(html || "").slice(0, 60_000);
  if (!/<meta[^>]+name=["']viewport["']/i.test(head)) out.push("ne s'affiche pas correctement sur téléphone");
  if (/^http:\/\//i.test(String(url || ""))) out.push("n'est pas sécurisé (pas de cadenas https)");
  const years = [...String(html || "").matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1])).filter((y) => y >= 1995 && y <= now.getFullYear());
  const last = years.length ? Math.max(...years) : 0;
  if (last && last <= now.getFullYear() - 3) out.push(`n'a pas été mis à jour depuis ${last}`);
  if (ms && ms > 4000) out.push("met plus de 4 secondes à s'afficher");
  if (/wixsite\.com|jimdosite\.com|jimdofree\.com|e-monsite\.com|sitew\.com|webnode\.|weebly\.com|site123\.me|\.wordpress\.com|business\.site|\.blogspot\.|\.free\.fr\/|pagesperso-orange\.fr|monsite-orange\.fr/i.test(String(url || "") + " " + head.slice(0, 3000))) out.push("est hébergé sur une plateforme gratuite");
  if (!/mentions?\s*l[ée]gales|mentions-legales|legal/i.test(String(html || ""))) out.push("n'affiche pas de mentions légales");
  return out;
}

// Les constats qui justifient une refonte (les mentions légales seules, non).
export function strongFindings(findings: string[]) {
  return findings.filter((f) => !/mentions légales/.test(f));
}

// {variable} ou {variable|texte si vide}. Les accolades inconnues restent
// telles quelles pour rester visibles dans l'aperçu. « de {metier} » devient
// « d'électricité » quand la valeur commence par une voyelle (pas devant h ni y).
export function renderTemplate(template: string, vars: Vars) {
  return String(template ?? "").replace(/(?:(?<!\p{L})(de) )?\{([a-z_]+)(?:\|([^{}]*))?\}/giu, (match, de: string | undefined, name: string, fallback?: string) => {
    const key = name.toLowerCase();
    if (!TEMPLATE_VARIABLES.includes(key)) return match;
    const value = vars[key] || fallback || "";
    if (!de) return value;
    return /^[aeiouàâäéèêëîïôöûüœ]/i.test(value) ? `${de[0]}'${value}` : `${de} ${value}`;
  });
}

export function unknownVariables(template: string) {
  const found = new Set<string>();
  for (const match of String(template ?? "").matchAll(/\{([a-z_]+)(?:\|[^{}]*)?\}/gi)) {
    if (!TEMPLATE_VARIABLES.includes(match[1].toLowerCase())) found.add(match[1]);
  }
  return [...found];
}

export function htmlEscape(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] || c));
}

/* ===================== Composition des messages ===================== */

// Suivi des messages : les liens de la version HTML passent par la fonction
// publique yontech-prospection-track (ouverture, clic vidéo, clic site) puis
// redirigent vers leur destination. La version texte garde les vraies
// adresses, et le lien de désinscription n'est jamais traqué.
export type Tracking = { base: string; token: string };

export function trackingKind(url: string) {
  return youtubeId(url) ? "video" : "site";
}

export function trackedUrl(url: string, tracking?: Tracking) {
  if (!tracking || /desinscription|unsubscribe/i.test(url)) return url;
  return `${tracking.base}?t=${encodeURIComponent(tracking.token)}&k=${trackingKind(url)}&u=${encodeURIComponent(url)}`;
}

function linkify(escaped: string, tracking?: Tracking) {
  return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) =>
    `<a href="${htmlEscape(trackedUrl(url, tracking))}" style="color:${BRAND.accent}">${url}</a>`);
}

// HTML volontairement sobre, lisible comme un e-mail personnel : il passe
// mieux les filtres et se lit mieux.
export function textToHtml(text: string, tracking?: Tracking) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim().split(/\n{2,}/).map((block) =>
    `<p style="margin:0 0 14px">${linkify(htmlEscape(block), tracking).replace(/\n/g, "<br>")}</p>`
  ).join("");
}

export type ComposeInput = {
  subject: string; body: string; signature?: string; footerIdentity?: string;
  unsubscribeUrl: string; vars: Vars; videoUrl?: string; videoThumb?: string; tracking?: Tracking; logoUrl?: string;
  // Bloc visuel (aperçu de maquette) placé à la ligne {maquette} ; remplace la vidéo.
  block?: (tracking?: Tracking) => { html: string; text: string };
  // Origine de la fiche (« sirene » ou « rge ») : change la mention légale.
  source?: string;
  // Premier contact : e-mail sobre (aucune image, aucun pixel, liens directs),
  // bien mieux reçu par les filtres anti-spam. Les relances gardent le suivi.
  plain?: boolean;
};

function plainVideo(url: string) {
  return {
    text: `▶ Regarder la vidéo (1 minute) : ${url}`,
    html: `<p style="margin:0 0 16px"><a href="${htmlEscape(url)}" style="color:${BRAND.accent};font-weight:bold">▶ Regarder la vidéo (1 minute)</a></p>`,
  };
}

export function youtubeThumb(url: string, size: "maxresdefault" | "hqdefault" = "hqdefault") {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/${size}.jpg` : "";
}

function videoBlock(url: string, tracking?: Tracking, thumbUrl?: string) {
  // Miniature : la version 16:9 (maxresdefault) quand l'expéditeur l'a
  // vérifiée, sinon hqdefault (4:3, toujours disponible). Un bouton « play »
  // blanc est posé au centre (fond de cellule, lu par Gmail, Apple Mail,
  // Outlook.com) ; Outlook de bureau reçoit l'image seule. Sous l'image, une
  // barre « Regarder la vidéo » cliquable dans tous les cas.
  const thumb = htmlEscape(thumbUrl || youtubeThumb(url));
  const href = htmlEscape(trackedUrl(url, tracking));
  const alt = `Vidéo : ${BRAND.name} en 1 minute`;
  const picture = thumb
    ? `<!--[if mso]><a href="${href}"><img src="${thumb}" width="480" alt="${alt}" style="display:block;border:0"></a><![endif]-->` +
      `<!--[if !mso]><!--><a href="${href}" style="text-decoration:none;display:block">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" background="${thumb}" style="background:#15161f url('${thumb}') center/cover no-repeat;border-radius:12px 12px 0 0">` +
      `<tr><td align="center" valign="middle" style="height:270px;padding:0">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" style="width:84px;height:84px;border-radius:42px;background:#ffffff;font:bold 34px Arial,sans-serif;color:#15161f;line-height:84px">&#9654;</td></tr></table>` +
      `</td></tr></table></a><!--<![endif]-->`
    : "";
  return {
    text: `▶ Regarder la vidéo (1 minute) : ${url}`,
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;width:100%;max-width:480px"><tr><td style="padding:0">` + picture +
      `<a href="${href}" style="display:block;background:${BRAND.accent};color:#ffffff;text-align:center;font:bold 15px Arial,sans-serif;padding:13px 16px;border-radius:${thumb ? "0 0 12px 12px" : "12px"};text-decoration:none">&#9654;&nbsp; Regarder la vidéo &middot; 1 minute</a>` +
      `</td></tr></table>`,
  };
}

// Signature graphique : logo à gauche (facultatif), lignes de la signature à
// droite. La première ligne est mise en avant (ex. « Équipe Yontech »).
function signatureHtml(signature: string, tracking?: Tracking, logoUrl?: string) {
  const lines = signature.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "";
  const rows = lines.map((line, index) => index === 0
    ? `<b style="color:#15161f;font-size:15px">${htmlEscape(line)}</b>`
    : linkify(htmlEscape(line), tracking)).join("<br>");
  const logo = logoUrl ? `<td style="padding:0 14px 0 0;vertical-align:top"><img src="${htmlEscape(logoUrl)}" width="56" height="56" alt="${BRAND.name}" style="display:block;border:0;border-radius:12px"></td>` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;border-collapse:collapse"><tr>${logo}` +
    `<td style="vertical-align:middle;font:14px/1.5 Arial,Helvetica,sans-serif;color:#5b5d72;border-left:3px solid ${BRAND.accent};padding:2px 0 2px 14px">${rows}</td>` +
    `</tr></table>`;
}

// Mention d'origine des données, obligatoire en prospection B2B : base
// SIRENE (INSEE) pour l'entreprise, puis site internet de l'entreprise pour
// l'adresse, ou annuaire RGE de l'ADEME pour les entreprises sans site.
export function dataNotice(company: string, source?: string) {
  if (source === "rge") return `Vous recevez ce message car ${company} figure dans l'annuaire public des entreprises qualifiées RGE (ADEME, Licence Ouverte) et dans le répertoire des entreprises (base SIRENE de l'INSEE).`;
  return `Vous recevez ce message car ${company} figure dans le répertoire public des entreprises (base SIRENE de l'INSEE) et publie ses coordonnées professionnelles sur son site internet.`;
}

export function composeEmail(input: ComposeInput) {
  const subject = clean(renderTemplate(input.subject, input.vars), 200);
  const tidy = (value: string) => renderTemplate(value, input.vars).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  // {video} seul sur sa ligne indique l'emplacement de la vidéo ; sans lui,
  // la vidéo se place après le message, avant la signature.
  const marker = input.block ? /^[ \t]*\{maquette\}[ \t]*$/m : /^[ \t]*\{video\}[ \t]*$/m;
  const parts = String(input.body ?? "").replace(/\r\n/g, "\n").split(marker);
  const before = tidy(parts[0] || ""), after = tidy(parts.slice(1).join("\n"));
  const body = [before, after].filter(Boolean).join("\n\n");
  const plain = input.plain === true && !input.block;
  const tracking = plain ? undefined : input.tracking;
  const video = input.block ? input.block(tracking) : input.videoUrl ? (plain ? plainVideo(input.videoUrl) : videoBlock(input.videoUrl, tracking, input.videoThumb)) : null;
  const signature = String(input.signature ?? "").replace(/\r\n/g, "\n").trim();
  const company = input.vars.entreprise || "votre entreprise";
  const notice = `${dataNotice(company, input.source)} Pour ne plus recevoir de message de notre part : ${input.unsubscribeUrl}`;
  const identity = clean(input.footerIdentity, 300);
  const text = [before, video?.text, after, signature, "--", notice + (identity ? `\n${identity}` : "")].filter(Boolean).join("\n\n");
  // Pixel d'ouverture, puis lien piège invisible : un filtre de sécurité qui
  // « clique » tous les liens le suit aussi, ce qui le démasque côté serveur.
  const pixel = tracking
    ? `<img src="${htmlEscape(`${tracking.base}?t=${encodeURIComponent(tracking.token)}&k=open`)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` +
      `<a href="${htmlEscape(`${tracking.base}?t=${encodeURIComponent(tracking.token)}&k=trap`)}" style="display:none;font-size:0;line-height:0;color:transparent" aria-hidden="true" tabindex="-1">&zwnj;</a>`
    : "";
  const logoUrl = plain ? "" : input.logoUrl === undefined ? BRAND.logo : input.logoUrl;
  const html = `<div style="font:15px/1.6 Arial,Helvetica,sans-serif;color:#1f2030;max-width:640px">${textToHtml(before, tracking)}` +
    (video ? video.html : "") + (after ? textToHtml(after, tracking) : "") + signatureHtml(signature, tracking, logoUrl) +
    `<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid #e5e5ef;font-size:12px;line-height:1.5;color:#8a8ca0">` +
    `${htmlEscape(dataNotice(company, input.source))} ` +
    `<a href="${htmlEscape(input.unsubscribeUrl)}" style="color:#8a8ca0">Ne plus recevoir de message</a>.` +
    (identity ? `<br>${htmlEscape(identity)}` : "") + `</p>${pixel}</div>`;
  return { subject, text, html, body };
}

/* ===================== Erreurs SMTP ===================== */

export type SmtpOutcome = "recipient_rejected" | "transient" | "throttled" | "fatal";

const QUOTA_RE = /quota|rate.?limit|too many|limit (?:exceeded|reached)|try (?:again )?later|throttl|sending limit/i;
const NETWORK_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENOTFOUND"]);

// Codes renvoyés par nodemailer. Un destinataire refusé ne remet pas
// l'automate en cause ; une boîte saturée (quota Hostinger) ou injoignable le
// fait patienter ; seul un refus d'authentification ou de politique d'envoi
// exige une intervention humaine, donc une pause.
export function classifySmtpError(error: unknown): SmtpOutcome {
  const e = (error ?? {}) as { code?: string; responseCode?: number; response?: string; message?: string; command?: string };
  const code = Number(e.responseCode || 0);
  const text = `${e.response || ""} ${e.message || ""}`;
  if (e.code === "EAUTH" || code === 535 || code === 534) return "fatal";
  if (QUOTA_RE.test(text) || code === 421) return "throttled";
  if (e.code === "EENVELOPE" || (e.command === "RCPT TO" && code >= 400)) return code >= 400 && code < 500 ? "transient" : "recipient_rejected";
  if (NETWORK_CODES.has(String(e.code || "")) && !code) return "throttled";
  if (code >= 400 && code < 500) return "transient";
  if (code >= 500) return "fatal";
  return "transient";
}

// Attente avant le prochain essai quand la boîte est saturée ou injoignable.
export function retryDelaySeconds(error: unknown) {
  const e = (error ?? {}) as { response?: string; message?: string; responseCode?: number };
  return QUOTA_RE.test(`${e.response || ""} ${e.message || ""}`) ? 3600 : 900;
}

export function maskEmail(email: string) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
}

/* ===================== Référentiels SIRENE ===================== */

export const API_SIRENE = "https://recherche-entreprises.api.gouv.fr/search";

export const EFF: Record<string, string> = {
  "00": "0 salarié", "01": "1 à 2", "02": "3 à 5", "03": "6 à 9", "11": "10 à 19", "12": "20 à 49",
  "21": "50 à 99", "22": "100 à 199", "31": "200 à 249", "32": "250 à 499", "41": "500 à 999",
  "42": "1 000 à 1 999", "51": "2 000 à 4 999", "52": "5 000 à 9 999", "53": "10 000 et +",
};

// Tranches d'effectif INSEE, « NN » = non renseigné.
export const ALL_EFFS = ["NN", "00", "01", "02", "03", "11", "12", "21", "22", "31", "32", "41", "42", "51", "52", "53"];

export const DEPARTEMENTS = (() => {
  const list: string[] = [];
  for (let i = 1; i <= 19; i++) list.push(String(i).padStart(2, "0"));
  list.push("2A", "2B");
  for (let i = 21; i <= 95; i++) list.push(String(i).padStart(2, "0"));
  return list.concat(["971", "972", "973", "974", "976"]);
})();

// Sections NAF (nomenclature d'activités française, rév. 2).
export const SECTIONS: Record<string, string> = {
  A: "agriculture, sylviculture et pêche", B: "industries extractives", C: "industrie manufacturière",
  D: "énergie", E: "eau, déchets et dépollution", F: "construction", G: "commerce et réparation automobile",
  H: "transports et entreposage", I: "hébergement et restauration", J: "information et communication",
  K: "finance et assurance", L: "immobilier", M: "activités spécialisées, scientifiques et techniques",
  N: "services administratifs et de soutien", O: "administration publique", P: "enseignement",
  Q: "santé humaine et action sociale", R: "arts, spectacles et loisirs", S: "autres services",
  T: "ménages employeurs", U: "activités extraterritoriales",
};
export const ALL_SECTIONS = Object.keys(SECTIONS);
// Sections exclues du « volume maximum » : administrations, particuliers
// employeurs et organismes extraterritoriaux ne sont pas des entreprises à prospecter.
export const DEFAULT_SECTIONS = ALL_SECTIONS.filter((s) => !["O", "T", "U"].includes(s));
export const DEFAULT_EFFS = ["03", "11", "12", "21", "22", "31", "32"];

// Libellés courts des divisions NAF (deux premiers chiffres du code), au
// format « intervient en … » pour la personnalisation ({metier}).
export const NAF_DIVISION: Record<string, string> = {
  "01": "agriculture", "02": "sylviculture", "03": "pêche et aquaculture", "05": "extraction de charbon", "06": "extraction d'hydrocarbures",
  "07": "extraction de minerais", "08": "carrières", "09": "services aux industries extractives", "10": "industrie alimentaire",
  "11": "boissons", "12": "tabac", "13": "textile", "14": "habillement", "15": "cuir et chaussure", "16": "travail du bois",
  "17": "papier et carton", "18": "imprimerie", "19": "raffinage", "20": "chimie", "21": "industrie pharmaceutique",
  "22": "plasturgie et caoutchouc", "23": "matériaux de construction", "24": "métallurgie", "25": "fabrication de produits métalliques",
  "26": "électronique et informatique", "27": "équipements électriques", "28": "fabrication de machines", "29": "industrie automobile",
  "30": "autres matériels de transport", "31": "fabrication de meubles", "32": "industries diverses", "33": "réparation et installation de machines",
  "35": "énergie", "36": "distribution d'eau", "37": "assainissement", "38": "collecte et traitement des déchets", "39": "dépollution",
  "41": "construction de bâtiments", "42": "génie civil", "43": "travaux de construction spécialisés",
  "45": "commerce et réparation automobile", "46": "commerce de gros", "47": "commerce de détail",
  "49": "transport terrestre", "50": "transport par eau", "51": "transport aérien", "52": "entreposage et logistique", "53": "poste et courrier",
  "55": "hébergement", "56": "restauration", "58": "édition", "59": "production audiovisuelle", "60": "radio et télévision",
  "61": "télécommunications", "62": "services informatiques", "63": "services d'information",
  "64": "services financiers", "65": "assurance", "66": "services financiers auxiliaires", "68": "immobilier",
  "69": "activités juridiques et comptables", "70": "conseil de gestion", "71": "architecture et ingénierie", "72": "recherche et développement",
  "73": "publicité et études de marché", "74": "activités spécialisées (design, photo, traduction)", "75": "activités vétérinaires",
  "77": "location", "78": "intérim et recrutement", "79": "agences de voyage", "80": "sécurité", "81": "nettoyage et services aux bâtiments",
  "82": "services administratifs aux entreprises", "84": "administration publique", "85": "enseignement", "86": "santé",
  "87": "hébergement médico-social", "88": "action sociale", "90": "spectacle vivant", "91": "bibliothèques, musées et patrimoine",
  "92": "jeux de hasard", "93": "sport et loisirs", "94": "organisations associatives", "95": "réparation d'ordinateurs et de biens personnels",
  "96": "services personnels", "97": "ménages employeurs", "98": "ménages producteurs", "99": "organismes extraterritoriaux",
};

export function metierFor(naf: string) {
  return NAF_DIVISION[String(naf || "").slice(0, 2)] || "";
}

export type Target = { sect?: string[]; nafs?: string[]; effs?: string[]; deps?: string[]; guess?: boolean; search?: boolean; sansSite?: boolean; sansSiteHisto?: boolean };

export function normalizeTarget(raw: unknown): Required<Target> {
  const t = (raw && typeof raw === "object" ? raw : {}) as Target;
  const list = (value: unknown, pattern: RegExp, max: number) =>
    Array.isArray(value) ? [...new Set(value.map((v) => String(v).trim().toUpperCase()).filter((v) => pattern.test(v)))].slice(0, max) : [];
  const sect = list(t.sect, /^[A-U]$/, 21);
  // Codes NAF précis : division (« 56 ») ou code complet (« 56.10A »).
  const nafs = list(t.nafs, /^(\d{2}|\d{2}\.\d{2}[A-Z])$/, 80);
  const effs = list(t.effs, /^(\d{2}|NN)$/, 20);
  const deps = list(t.deps, /^(\d{2}|2A|2B|97\d)$/, 101);
  return {
    sect: sect.length || nafs.length ? sect : DEFAULT_SECTIONS, nafs,
    effs: effs.length ? effs : DEFAULT_EFFS, deps,
    // Découverte des adresses : site deviné depuis le nom (toujours) et
    // moteur de recherche quand une clé est configurée côté serveur.
    guess: t.guess === undefined ? true : !!t.guess, search: t.search === undefined ? true : !!t.search,
    // Source « sans site internet » (annuaire RGE, bâtiment) : entreprises avec
    // e-mail mais sans site, qualifications actuelles et anciennes.
    sansSite: t.sansSite === undefined ? true : !!t.sansSite, sansSiteHisto: t.sansSiteHisto === undefined ? true : !!t.sansSiteHisto,
  };
}

export function targetKey(target: Required<Target>) {
  return JSON.stringify(["y2", target.sect, target.nafs, target.effs, target.deps, target.sansSite, target.sansSiteHisto]);
}

// Choix des modèles : d'abord ceux de la campagne du prospect (« logiciel »
// ou « site » ; à défaut, toutes campagnes), puis le public : un prospect
// sans site internet ne reçoit que les modèles « sanssite » s'il en existe
// (sinon « tous ») ; les autres reçoivent « avecsite » s'il en existe (sinon « tous »).
export function pickTemplates<T extends { audience?: string | null; campagne?: string | null }>(templates: T[], data: Record<string, unknown> | null | undefined) {
  const campagne = String((data || {}).campagne || "logiciel");
  const own = templates.filter((t) => (t.campagne || "logiciel") === campagne);
  const pool = own.length ? own : templates;
  const wanted = String((data || {}).sanssite || "") === "1" ? "sanssite" : "avecsite";
  const dedicated = pool.filter((t) => (t.audience || "tous") === wanted);
  return dedicated.length ? dedicated : pool.filter((t) => (t.audience || "tous") === "tous");
}

// Paramètres de l'API Recherche d'entreprises pour une unité de balayage.
// Une division NAF (« 56 ») couvre tous ses codes (56.10A, 56.10B…).
export function sireneParams(target: Required<Target>, dep?: string, eff?: string, sect?: string) {
  const p: Record<string, string> = {};
  if (target.nafs.length) {
    const full = target.nafs.filter((n) => n.length === 6), divisions = target.nafs.filter((n) => n.length === 2);
    if (full.length && !divisions.length) p.activite_principale = full.join(",");
    else p.activite_principale = [...full, ...divisions.flatMap((d) => NAF_CODES_BY_DIVISION[d] || [])].join(",");
  } else if (sect) p.section_activite_principale = sect;
  else p.section_activite_principale = target.sect.join(",");
  p.tranche_effectif_salarie = eff || target.effs.join(",");
  p.etat_administratif = "A";
  if (dep) p.departement = dep;
  return p;
}

// Pour qu'une division NAF (« 56 ») devienne une liste de codes précis, l'API
// n'acceptant que des codes complets ou des sections entières. Seules les
// divisions les plus demandées sont détaillées ; les autres passent par la
// section entière de leur division (filtrage côté outil ensuite).
export const NAF_CODES_BY_DIVISION: Record<string, string[]> = {
  "10": ["10.11Z", "10.12Z", "10.13A", "10.13B", "10.20Z", "10.31Z", "10.32Z", "10.39A", "10.39B", "10.41A", "10.41B", "10.42Z", "10.51A", "10.51B", "10.51C", "10.51D", "10.52Z", "10.61A", "10.61B", "10.62Z", "10.71A", "10.71B", "10.71C", "10.71D", "10.72Z", "10.73Z", "10.81Z", "10.82Z", "10.83Z", "10.84Z", "10.85Z", "10.86Z", "10.89Z", "10.91Z", "10.92Z"],
  "25": ["25.11Z", "25.12Z", "25.21Z", "25.29Z", "25.30Z", "25.40Z", "25.50A", "25.50B", "25.61Z", "25.62A", "25.62B", "25.71Z", "25.72Z", "25.73A", "25.73B", "25.91Z", "25.92Z", "25.93Z", "25.94Z", "25.99A", "25.99B"],
  "41": ["41.10A", "41.10B", "41.10C", "41.10D", "41.20A", "41.20B"],
  "43": ["43.11Z", "43.12A", "43.12B", "43.13Z", "43.21A", "43.21B", "43.22A", "43.22B", "43.29A", "43.29B", "43.31Z", "43.32A", "43.32B", "43.32C", "43.33Z", "43.34Z", "43.39Z", "43.91A", "43.91B", "43.99A", "43.99B", "43.99C", "43.99D", "43.99E"],
  "45": ["45.11Z", "45.19Z", "45.20A", "45.20B", "45.31Z", "45.32Z", "45.40Z"],
  "46": ["46.11Z", "46.12A", "46.12B", "46.13Z", "46.14Z", "46.15Z", "46.16Z", "46.17A", "46.17B", "46.18Z", "46.19A", "46.19B", "46.21Z", "46.22Z", "46.23Z", "46.24Z", "46.31Z", "46.32A", "46.32B", "46.32C", "46.33Z", "46.34Z", "46.35Z", "46.36Z", "46.37Z", "46.38A", "46.38B", "46.39A", "46.39B", "46.41Z", "46.42Z", "46.43Z", "46.44Z", "46.45Z", "46.46Z", "46.47Z", "46.48Z", "46.49Z", "46.51Z", "46.52Z", "46.61Z", "46.62Z", "46.63Z", "46.64Z", "46.65Z", "46.66Z", "46.69A", "46.69B", "46.69C", "46.71Z", "46.72Z", "46.73A", "46.73B", "46.74A", "46.74B", "46.75Z", "46.76Z", "46.77Z", "46.90Z"],
  "49": ["49.10Z", "49.20Z", "49.31Z", "49.32Z", "49.39A", "49.39B", "49.39C", "49.41A", "49.41B", "49.41C", "49.42Z", "49.50Z"],
  "52": ["52.10A", "52.10B", "52.21Z", "52.22Z", "52.23Z", "52.24A", "52.24B", "52.29A", "52.29B"],
  "55": ["55.10Z", "55.20Z", "55.30Z", "55.90Z"],
  "56": ["56.10A", "56.10B", "56.10C", "56.21Z", "56.29A", "56.29B", "56.30Z"],
  "62": ["62.01Z", "62.02A", "62.02B", "62.03Z", "62.09Z"],
  "68": ["68.10Z", "68.20A", "68.20B", "68.31Z", "68.32A", "68.32B"],
  "69": ["69.10Z", "69.20Z"],
  "70": ["70.10Z", "70.21Z", "70.22Z"],
  "71": ["71.11Z", "71.12A", "71.12B", "71.20A", "71.20B"],
  "73": ["73.11Z", "73.12Z", "73.20Z"],
  "78": ["78.10Z", "78.20Z", "78.30Z"],
  "80": ["80.10Z", "80.20Z", "80.30Z"],
  "81": ["81.10Z", "81.21Z", "81.22Z", "81.29A", "81.29B", "81.30Z"],
  "82": ["82.11Z", "82.19Z", "82.20Z", "82.30Z", "82.91Z", "82.92Z", "82.99Z"],
  "85": ["85.10Z", "85.20Z", "85.31Z", "85.32Z", "85.41Z", "85.42Z", "85.51Z", "85.52Z", "85.53Z", "85.59A", "85.59B", "85.60Z"],
  "86": ["86.10Z", "86.21Z", "86.22A", "86.22B", "86.22C", "86.23Z", "86.90A", "86.90B", "86.90C", "86.90D", "86.90E", "86.90F"],
  "93": ["93.11Z", "93.12Z", "93.13Z", "93.19Z", "93.21Z", "93.29Z"],
  "96": ["96.01A", "96.01B", "96.02A", "96.02B", "96.03Z", "96.04Z", "96.09Z"],
};

/* ===================== Normalisation et score ===================== */

type Finances = Record<string, { ca?: number }>;
function caSerie(finances?: Finances) {
  if (!finances) return { ca: null as number | null, annee: null as string | null, growth: null as number | null };
  const years = Object.keys(finances).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
  if (!years.length) return { ca: null, annee: null, growth: null };
  const ca = typeof finances[years[0]].ca === "number" ? finances[years[0]].ca as number : null;
  const prev = years[1] && typeof finances[years[1]].ca === "number" ? finances[years[1]].ca as number : null;
  return { ca, annee: years[0], growth: ca != null && prev != null && prev > 0 ? (ca - prev) / prev : null };
}

export type Company = {
  siren: string; siret: string; nom: string; enseigne: string; sigle: string; naf: string; section: string; metier: string;
  effCode: string; effectif: string; commune: string; cp: string; dep: string; prenom: string; nomDir: string;
  sitesOuverts: number | null; ca: number | null; growth: number | null; age: number | null;
  // Découverte web : site vérifié, adresse retenue, méthode (guess, search), adresse sur le domaine du site.
  email: string; site: string; how: string; ownDomain: boolean; tel: string;
  // Association, syndicat, parti, organisme public : pas une entreprise à prospecter.
  association: boolean;
  // Entreprise sans site internet (annuaire RGE) et origine de la fiche (sirene, rge).
  sansSite: boolean; source: string;
  // Campagne (« logiciel » ou « site ») et constats mesurés sur le site existant.
  campagne: string; constats: string[];
};

// deno-lint-ignore no-explicit-any
export function normalizeCompany(r: any, now = Date.now()): Company {
  const s = r?.siege || {};
  // deno-lint-ignore no-explicit-any
  const first = (r?.dirigeants || []).find((d: any) => d?.type_dirigeant === "personne physique") || {};
  const fin = caSerie(r?.finances);
  const created = r?.date_creation ? new Date(r.date_creation).getTime() : NaN;
  const naf = String(r?.activite_principale || "");
  return {
    siren: String(r?.siren || ""), siret: String(s.siret || ""), nom: String(r?.nom_complet || r?.nom_raison_sociale || ""),
    enseigne: String((s.liste_enseignes || [])[0] || s.nom_commercial || ""), sigle: String(r?.sigle || ""),
    naf, section: String(r?.section_activite_principale || ""), metier: metierFor(naf),
    effCode: String(r?.tranche_effectif_salarie || ""), effectif: EFF[r?.tranche_effectif_salarie] || "",
    commune: capitalName(s.libelle_commune || ""), cp: String(s.code_postal || ""), dep: String(s.departement || ""),
    prenom: capitalName(String(first.prenoms || "").replace(/\s*\([^)]*\)/g, "").split(" ")[0] || ""),
    nomDir: capitalName(String(first.nom || "").replace(/\s*\([^)]*\)/g, "")),
    sitesOuverts: r?.nombre_etablissements_ouverts ?? null, ca: fin.ca, growth: fin.growth,
    age: Number.isFinite(created) ? (now - created) / (365.25 * 864e5) : null,
    email: "", site: "", how: "", ownDomain: false, tel: "",
    // NAF 94 (organisations associatives, syndicats, partis), 84 (administration),
    // nature juridique 7xxx (personnes morales de droit public) ou 92xx (associations).
    association: /^(94|84)/.test(naf) || !!r?.complements?.est_association || /^(7|92)/.test(String(r?.nature_juridique || "")),
    sansSite: false, source: "sirene", campagne: "logiciel", constats: [],
  };
}

// Score Yontech (0-100) : profils où une application sur-mesure ou un
// logiciel métier a le plus de chances d'intéresser : 10 à 250 salariés,
// plusieurs établissements, chiffre d'affaires et croissance, ancienneté, et
// une adresse sur le domaine de l'entreprise (signe d'un site entretenu).
const sEff = (c: string) => ({ "00": 2, "01": 4, "02": 8, "03": 14, "11": 22, "12": 30, "21": 30, "22": 30, "31": 26, "32": 22, "41": 16, "42": 12, "51": 8, "52": 6, "53": 4 } as Record<string, number>)[c] ?? 10;
const sSites = (n: number | null) => n == null ? 7 : n <= 1 ? 5 : n <= 3 ? 12 : n <= 9 ? 18 : 20;
const sCa = (c: number | null) => c == null ? 7 : c < 1e5 ? 2 : c < 5e5 ? 6 : c < 2e6 ? 12 : c < 1e7 ? 16 : c < 5e7 ? 13 : 8;
const sGrow = (g: number | null) => g == null ? 5 : g >= .25 ? 12 : g >= .10 ? 10 : g >= .02 ? 8 : g >= -.05 ? 5 : 2;
const sAge = (y: number | null) => y == null ? 5 : y < 1 ? 3 : y < 2 ? 6 : y < 5 ? 9 : y < 15 ? 10 : y < 25 ? 8 : 6;
const sWeb = (c: Company) => c.ownDomain ? 10 : c.email ? 5 : 0;

export function scoreCompany(c: Company) {
  return Math.min(100, Math.round(sEff(c.effCode) + sSites(c.sitesOuverts) + sCa(c.ca) + sGrow(c.growth) + sAge(c.age) + sWeb(c)));
}

export function companyToQueueItem(c: Company, score: number) {
  return {
    siren: c.siren, email: c.email, company: c.enseigne || c.nom, score,
    data: {
      entreprise: c.enseigne || c.nom, prenom: c.prenom, nom: c.nomDir, ville: c.commune, cp: c.cp,
      metier: c.metier, departement: c.dep, effectif: c.effectif, site: c.site, tel: c.tel, how: c.how, naf: c.naf,
      // « 1 » pour une entreprise sans site internet (annuaire RGE) : modèles réservés, badge dans Envois.
      sanssite: c.sansSite ? "1" : "", source: c.source,
      // Campagne et constat sur le site existant (le premier, pour {constat} ; tous, pour la fiche).
      campagne: c.campagne || "logiciel", constat: c.constats[0] || "", constats: c.constats.join(" · "),
    },
  };
}

/* ===================== Découverte web : aides pures ===================== */

export const MAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const NAME_STOP = new Set(["sarl", "sas", "sasu", "eurl", "sa", "snc", "sci", "scop", "ei", "eirl", "sc", "gie", "selarl", "scp", "sca", "selas", "sarlu",
  "societe", "ste", "ets", "etablissements", "etablissement", "entreprise", "groupe", "holding", "compagnie", "cie", "et", "de", "du", "des", "la", "le", "les", "l", "d", "the", "and", "france"]);

// Mots significatifs d'une raison sociale, sans accents ni forme juridique.
export function nameWords(name: string) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !NAME_STOP.has(w));
}

// Noms de domaine plausibles pour une entreprise, à partir de sa raison
// sociale, de son sigle et de son enseigne (« dupont-mecanique.fr »…).
export function domainCandidates(c: Pick<Company, "nom" | "sigle" | "enseigne">) {
  const names = [c.nom, c.enseigne, c.sigle].filter(Boolean);
  const out: string[] = [];
  const push = (d: string) => { if (!out.includes(d)) out.push(d); };
  for (const name of names) {
    const w = nameWords(name);
    if (!w.length) continue;
    const joined = w.join(""), dashed = w.join("-");
    if (joined.length < 3 || joined.length > 40 || /^\d+$/.test(joined)) continue;
    for (const tld of ["fr", "com"]) { push(`${joined}.${tld}`); if (w.length > 1) push(`${dashed}.${tld}`); }
    if (w.length > 2) { const j2 = w.slice(0, 2).join(""); for (const tld of ["fr", "com"]) push(`${j2}.${tld}`); }
  }
  return out.slice(0, 8);
}

// Hôtes qui ne sont jamais le site de l'entreprise (annuaires, réseaux,
// presse) : ignorés dans les résultats d'un moteur de recherche.
const DIRECTORY_HOSTS = /(^|\.)(societe\.com|pappers\.fr|annuaire-entreprises\.data\.gouv\.fr|infogreffe\.fr|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|pagesjaunes\.fr|kompass\.com|verif\.com|manageo\.fr|google\.[a-z.]+|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|mappy\.com|lefigaro\.fr|bfmtv\.com|lesechos\.fr|ouest-france\.fr|leboncoin\.fr|indeed\.com|welcometothejungle\.com|glassdoor\.[a-z.]+|youtube\.com|wikipedia\.org|bodacc\.fr|data\.gouv\.fr|economie\.gouv\.fr|insee\.fr|entreprises\.lefigaro\.fr|score3\.fr|dirigeant\.com|b-reputation\.com|lannuaire\.service-public\.fr|hoodspot\.fr|cybo\.com|zoominfo\.com|dnb\.com|annuaire\.com|118712\.fr|justacote\.com|horaires\.[a-z.]+|petitfute\.com|lafourchette\.com|thefork\.[a-z.]+|ubereats\.com|deliveroo\.[a-z.]+|booking\.com|airbnb\.[a-z.]+|doctolib\.fr|amazon\.[a-z.]+|cdiscount\.com|fnac\.com|leroymerlin\.fr|houzz\.[a-z.]+|trustpilot\.com|avis-verifies\.com|societeinfo\.com|rubypayeur\.com|ellisphere\.com|creditsafe\.com|bilansgratuits\.fr|aef\.cci\.fr|entreprises\.lesechos\.fr|annuaire-mairie\.fr|fr\.kompass\.com|europages\.[a-z.]+|wiz\.io|cylex[a-z.-]*|infobel\.com|corporama\.com|datainfogreffe\.fr|francetravail\.fr|pole-emploi\.fr|hellowork\.com|jobijoba\.com|lentreprise\.lexpress\.fr|l-expert-comptable\.com|le-site-de\.com|siren-siret\.com|entreprises\.gouv\.fr|digitalreport\.fr|entreprise-identite\.fr|recherche-entreprises\.api\.gouv\.fr)$/i;

export function isDirectoryHost(host: string) {
  return DIRECTORY_HOSTS.test(String(host || "").toLowerCase());
}

// Domaine d'une adresse e-mail quand il s'agit d'un domaine d'entreprise
// (pas une messagerie grand public ni un fournisseur) : il désigne
// probablement le site de l'entreprise. Vide sinon.
const FREE_MAIL_RE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|orange|wanadoo|free|sfr|neuf|laposte|bbox|numericable|icloud|me|mac|aol|gmx|protonmail|proton|cegetel|club-internet|aliceadsl|nordnet|voila|skynet|tiscali|9online|libertysurf|mail|email)\.(fr|com|net|org|be|ch|eu)$/i;
export function companyDomainOf(email: string) {
  const domain = String(email || "").toLowerCase().split("@")[1] || "";
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || FREE_MAIL_RE.test(domain)) return "";
  return domain;
}

// Déchiffre les obfuscations courantes (« contact [at] exemple.fr », entités HTML).
function deobfuscate(html: string) {
  return String(html || "")
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, "@").replace(/&#0*46;|&#x0*2e;|&period;/gi, ".")
    .replace(/\s*[\[\(]\s*(at|arobase|@)\s*[\]\)]\s*/gi, "@").replace(/\s*[\[\(]\s*(dot|point)\s*[\]\)]\s*/gi, ".");
}

const EMAIL_SCAN_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Adresses techniques, et adresses des plateformes qui hébergent ou
// équipent le site (Shopify, Wix, hébergeurs, outils) : jamais celles de l'entreprise.
const BAD_EMAIL_RE = /\.(png|jpe?g|gif|svg|webp|css|js|pdf|woff2?)$|^(noreply|no-reply|nepasrepondre|ne-pas-repondre|mailer-daemon|postmaster|webmaster|abuse|dpo|rgpd|privacy|cnil|recrutement|candidature|rh|jobs?|carriere|careers|presse|press|stage|alternance|cv)@|@(example|exemple|domain|domaine|email|mail|yourmail|votremail|test|sentry|wixpress|wix|wordpress|squarespace|shopify|jimdo|weebly|webflow|godaddy|ionos|ovh|ovhcloud|o2switch|1and1|hostinger|gandi|infomaniak|cloudflare|google|googlemail|microsoft|apple|facebook|instagram|linkedin|youtube|paypal|stripe|mailchimp|sendinblue|brevo|hubspot|zendesk|freshdesk|intercom|typeform|calendly|doctolib|lafourchette|thefork|ubereats|deliveroo|placeholder)\b|^[0-9a-f]{20,}@|sentry\.io$|@.*\.(png|jpg)$/i;

// Adresses trouvées dans une page, classées : adresse du dirigeant
// (prénom.nom), adresses génériques de contact, puis les autres, les adresses
// du domaine du site d'abord.
export function extractEmails(html: string, host: string, dirigeant?: { prenom?: string; nom?: string }) {
  const text = deobfuscate(html);
  const found = new Set<string>();
  for (const m of text.matchAll(/mailto:([^"'?\s<>]+)/gi)) { const e = decodeURIComponent(m[1]).toLowerCase(); if (MAIL_RE.test(e)) found.add(e); }
  for (const m of text.matchAll(EMAIL_SCAN_RE)) found.add(m[0].toLowerCase().replace(/^[._-]+/, ""));
  const domain = String(host || "").toLowerCase().replace(/^www\./, "");
  const own = (e: string) => domain && e.endsWith("@" + domain);
  const prenom = nameWords(dirigeant?.prenom || "")[0] || "", nom = nameWords(dirigeant?.nom || "").join("");
  const rank = (e: string) => {
    const user = e.split("@")[0];
    if (BAD_EMAIL_RE.test(e)) return -1;
    let r = own(e) ? 50 : 0;
    if (prenom && nom && user.includes(prenom) && user.includes(nom)) r += 40;
    else if (/^(contact|info|infos|commercial|accueil|bonjour|direction|hello|secretariat|administration|admin|gerant|gerance|societe|entreprise|bureau|agence|compta|comptabilite|devis|sav|service|vente|ventes|sales|office|courrier|mail)@/.test(e)) r += 30;
    else if (/^[a-z]+\.[a-z]+@/.test(user + "@")) r += 20;
    else r += 10;
    // Une adresse personnelle (gmail, orange…) n'est retenue que si rien d'autre.
    if (!own(e) && /@(gmail|yahoo|hotmail|outlook|live|orange|wanadoo|free|sfr|laposte|bbox|icloud|me|aol|gmx|protonmail|proton)\./.test(e)) r -= 5;
    return r;
  };
  return [...found].filter((e) => MAIL_RE.test(e) && e.length <= 254).map((e) => ({ email: e, rank: rank(e), own: own(e) }))
    .filter((x) => x.rank >= 0).sort((a, b) => b.rank - a.rank);
}

// Le site est bien celui de l'entreprise : son SIREN ou SIRET y figure
// (mentions légales), ou son nom complet avec sa ville ou son code postal.
export function verifyPage(html: string, c: Pick<Company, "siren" | "siret" | "nom" | "enseigne" | "cp" | "commune">) {
  const flat = String(html || "").replace(/<[^>]+>/g, " ").replace(/[\s ]+/g, " ");
  const digits = flat.replace(/[\s.\-]/g, "");
  if (c.siren && digits.includes(c.siren)) return "siren";
  if (c.siret && digits.includes(c.siret)) return "siren";
  const low = flat.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const place = [c.cp, c.commune.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")].filter((x) => x && x.length >= 4);
  for (const name of [c.nom, c.enseigne].filter(Boolean)) {
    const w = nameWords(name);
    if (w.length && w.join("").length >= 4 && w.every((x) => low.includes(x)) && place.some((p) => low.includes(p))) return "nom+ville";
  }
  return "";
}

// Liens d'une page vers ses mentions légales (SIREN) et ses pages de contact
// (adresse), sur le même site, les plus utiles d'abord. Les fichiers (CSS,
// images, PDF) et les chemins techniques (wp-content…) sont écartés.
export function secondaryLinks(html: string, baseUrl: string, max = 4) {
  const found: { url: string; rank: number }[] = [];
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, "");
  const rankOf = (path: string) =>
    /mention|legal|impressum|cgv|cgu/i.test(path) ? 3 : /contact|coordonnees|nous-ecrire|nous-joindre|devis/i.test(path) ? 2 : /propos|about|qui-sommes|societe|entreprise|infos?-pratiques/i.test(path) ? 1 : 0;
  for (const m of String(html || "").matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = m[1].trim();
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
      const path = u.pathname + u.search;
      if (/\.(css|js|json|xml|png|jpe?g|gif|svg|webp|ico|pdf|zip|woff2?|ttf|mp4|mp3)(\?|$)/i.test(path) || /\/(wp-content|wp-includes|wp-json|wp-admin|cdn-cgi|assets?|static|media|uploads)\//i.test(path)) continue;
      const rank = rankOf(path);
      if (!rank) continue;
      u.hash = "";
      const s = u.toString();
      if (s !== baseUrl && !found.some((f) => f.url === s)) found.push({ url: s, rank });
    } catch { /* lien invalide */ }
  }
  return found.sort((a, b) => b.rank - a.rank).slice(0, max).map((f) => f.url);
}
