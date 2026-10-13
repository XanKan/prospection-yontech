import { API_SIRENE, type Company, DEPARTEMENTS, MAIL_RE, normalizeCompany } from "./yontech-core.ts";

// Source « sans site internet » : l'annuaire RGE de l'ADEME (Licence Ouverte)
// est la seule base publique qui donne l'adresse e-mail d'entreprises et
// indique si elles ont un site internet. Les entreprises du bâtiment qui y
// figurent avec un e-mail mais sans site sont les cibles naturelles d'une
// offre de création de site (Querax). Deux jeux : qualifications actuelles
// (≈ 52 000 lignes avec e-mail sans site) et historique depuis 2014
// (≈ 119 000). Une ligne par qualification : plusieurs lignes par entreprise.
//
// L'API plafonne la pagination à 10 000 résultats par requête : le balayage
// se fait département par département (préfixe du code postal).

export const RGE_ACTIF = "https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines";
export const RGE_HISTO = "https://data.ademe.fr/data-fair/api/v1/datasets/historique-rge/lines";

export type RgeLine = { siret: string; siren: string; email: string; tel: string; nom: string; cp: string; commune: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Préfixes de code postal à balayer : un par département (la Corse partage
// le préfixe 20, les départements d'outre-mer ont trois chiffres).
export function postalPrefixes(deps: string[]) {
  const list = (deps.length ? deps : DEPARTEMENTS).map((d) => d === "2A" || d === "2B" ? "20" : d);
  return [...new Set(list)];
}

// Une page de lignes RGE d'un département, avec e-mail et sans site internet.
// `last` indique qu'il n'y a plus rien à lire pour ce préfixe.
export async function rgeSansSitePage(prefix: string, page: number, histo: boolean, size = 100): Promise<{ lines: RgeLine[]; total: number; last: boolean }> {
  if (page * size > 10_000) return { lines: [], total: 0, last: true };
  const p = new URLSearchParams({
    size: String(size), page: String(page), select: "siret,nom_entreprise,email,telephone,site_internet,code_postal,commune",
    qs: `_exists_:email AND code_postal:${prefix}*`,
  });
  const response = await fetch(`${histo ? RGE_HISTO : RGE_ACTIF}?${p}`, { headers: { Accept: "application/json" } });
  if (response.status === 429) { await sleep(2500); return rgeSansSitePage(prefix, page, histo, size); }
  if (!response.ok) throw new Error(`data.ademe.fr ${response.status}`);
  const data = await response.json();
  // deno-lint-ignore no-explicit-any
  const raw = (data?.results || []) as any[];
  const lines = raw.map((r) => {
    const siret = String(r?.siret || "").replace(/\D/g, "");
    return {
      siret, siren: siret.slice(0, 9), email: String(r?.email || "").trim().toLowerCase(), tel: String(r?.telephone || "").trim(),
      nom: String(r?.nom_entreprise || ""), cp: String(r?.code_postal || ""), commune: String(r?.commune || ""), site: String(r?.site_internet || "").trim(),
    };
  }).filter((l) => /^\d{14}$/.test(l.siret) && MAIL_RE.test(l.email) && !l.site)
    .map(({ site: _site, ...line }) => line as RgeLine);
  const total = Number(data?.total || 0);
  return { lines, total, last: raw.length < size || page * size >= total };
}

// Fiche entreprise (siège) par SIREN, pour la personnalisation (prénom du
// dirigeant, activité, effectif) et le score.
export async function companyForSiren(siren: string, now = Date.now()): Promise<Company | null> {
  const p = new URLSearchParams({ q: siren, per_page: "1", page: "1" });
  const response = await fetch(`${API_SIRENE}?${p}`, { headers: { Accept: "application/json" } });
  if (response.status === 429) { await sleep(2600); return companyForSiren(siren, now); }
  if (!response.ok) throw new Error(`recherche-entreprises ${response.status}`);
  const data = await response.json();
  // deno-lint-ignore no-explicit-any
  const hit = ((data?.results || []) as any[]).find((r) => String(r?.siren || "") === siren);
  if (!hit || String(hit?.etat_administratif || "A") !== "A") return null;
  return normalizeCompany(hit, now);
}
