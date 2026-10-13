import {
  type Company, domainCandidates, extractEmails, isDirectoryHost, secondaryLinks, verifyPage,
} from "./yontech-core.ts";

// Découverte du site internet et de l'adresse e-mail d'une entreprise de la
// base SIRENE, qui ne publie aucune coordonnée :
//   1. noms de domaine devinés à partir de la raison sociale, de l'enseigne et
//      du sigle (gratuit, sans clé) ;
//   2. facultatif : moteur de recherche (API Brave Search, clé
//      YONTECH_SEARCH_API_KEY) avec « raison sociale + ville », en ignorant
//      les annuaires et réseaux sociaux.
// Un site n'est retenu que s'il porte le SIREN ou le SIRET de l'entreprise
// (mentions légales, obligatoires en France) ou son nom complet avec sa ville.
// L'adresse e-mail vient de la page d'accueil, puis des pages contact et
// mentions légales, trois pages au plus. Au total, une entreprise coûte au
// plus une dizaine de requêtes et une dizaine de secondes.

const USER_AGENT = "Mozilla/5.0 (compatible; YontechBot/1.0; +https://yontech.fr) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const MAX_BYTES = 450_000;

export type Page = { url: string; host: string; html: string };

// Télécharge une page HTML avec un délai maximum et une taille plafonnée.
export async function fetchPage(url: string, timeoutMs = 6000): Promise<Page | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    if (!response.ok || !response.body) { try { await response.body?.cancel(); } catch { /* rien */ } return null; }
    const type = response.headers.get("content-type") || "";
    if (type && !/html|xml|text\/plain/i.test(type)) { try { await response.body.cancel(); } catch { /* rien */ } return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); size += value.byteLength; }
    }
    try { await reader.cancel(); } catch { /* flux déjà terminé */ }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    // Scripts, styles, SVG et commentaires sont retirés : ils font souvent les
    // deux tiers de la page et ne portent ni mentions légales ni adresse
    // (économie de CPU). Les données structurées (ld+json : adresse, e-mail,
    // raison sociale) sont conservées.
    const html = new TextDecoder("utf-8", { fatal: false }).decode(all.slice(0, MAX_BYTES))
      .replace(/<script\b(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->/gi, " ");
    const final = new URL(response.url || url);
    return { url: final.toString(), host: final.hostname.toLowerCase(), html };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type Discovery = { site: string; host: string; how: string; email: string; own: boolean; emails: string[] };

// Examine un site candidat : vérifie qu'il appartient bien à l'entreprise puis
// cherche une adresse. `how` est le mode de découverte (« guess » ou « search »).
async function inspectSite(url: string, c: Company, how: string, deadline: number): Promise<Discovery | null> {
  const home = await fetchPage(url);
  if (!home || isDirectoryHost(home.host)) return null;
  const host = home.host.replace(/^www\./, "");
  const pages: Page[] = [home];
  let verified = verifyPage(home.html, c);
  // Pages secondaires : contact et mentions légales portent le SIREN et l'adresse.
  for (const link of secondaryLinks(home.html, home.url, 3)) {
    if (Date.now() > deadline) break;
    const page = await fetchPage(link, 5000);
    if (!page) continue;
    pages.push(page);
    if (!verified) verified = verifyPage(page.html, c);
    // Dès qu'on a la preuve et une adresse sur le domaine, inutile d'aller plus loin.
    if (verified && extractEmails(page.html, host, { prenom: c.prenom, nom: c.nomDir }).some((e) => e.own)) break;
  }
  if (!verified) return null;
  const ranked = pages.flatMap((p) => extractEmails(p.html, host, { prenom: c.prenom, nom: c.nomDir }));
  const seen = new Set<string>();
  const unique = ranked.filter((e) => !seen.has(e.email) && seen.add(e.email)).sort((a, b) => b.rank - a.rank);
  return { site: `https://${host}`, host, how: `${how}:${verified}`, email: unique[0]?.email || "", own: !!unique[0]?.own, emails: unique.slice(0, 5).map((e) => e.email) };
}

type SearchHit = { url: string; title: string };

// API Brave Search (facultative). Les annuaires sont écartés ; le site de
// l'entreprise est en général dans les trois premiers résultats.
async function braveSearch(query: string, apiKey: string): Promise<SearchHit[]> {
  const p = new URLSearchParams({ q: query, count: "6", country: "FR", search_lang: "fr", safesearch: "off", text_decorations: "false" });
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${p}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (response.status === 429) throw Object.assign(new Error("brave_rate_limited"), { code: 429 });
  if (!response.ok) throw new Error(`brave ${response.status}`);
  const data = await response.json();
  // deno-lint-ignore no-explicit-any
  return ((data?.web?.results || []) as any[]).map((r) => ({ url: String(r?.url || ""), title: String(r?.title || "") })).filter((h) => /^https?:\/\//.test(h.url));
}

export type DiscoverOptions = { guess: boolean; search: boolean; searchApiKey?: string; budgetMs?: number; onSearch?: () => void };

// Site et adresse d'une entreprise : domaines devinés d'abord, moteur de
// recherche ensuite si une clé est disponible. Null si rien n'est vérifiable.
export async function discoverCompany(c: Company, options: DiscoverOptions): Promise<Discovery | null> {
  const deadline = Date.now() + (options.budgetMs || 14_000);
  const tried = new Set<string>();
  if (options.guess) {
    for (const domain of domainCandidates(c)) {
      if (Date.now() > deadline) return null;
      tried.add(domain);
      const found = await inspectSite(`https://${domain}/`, c, "guess", deadline) || (Date.now() < deadline ? await inspectSite(`https://www.${domain}/`, c, "guess", deadline) : null);
      if (found) return found;
    }
  }
  if (options.search && options.searchApiKey && Date.now() < deadline) {
    options.onSearch?.();
    const query = `"${(c.enseigne || c.nom).replace(/\s*\([^)]*\)/g, "").trim()}" ${c.commune}`;
    let hits: SearchHit[] = [];
    try { hits = await braveSearch(query, options.searchApiKey); } catch (error) { if ((error as { code?: number }).code === 429) throw error; return null; }
    let looked = 0;
    for (const hit of hits) {
      if (Date.now() > deadline || looked >= 3) break;
      let host = "";
      try { host = new URL(hit.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
      if (!host || isDirectoryHost(host) || tried.has(host)) continue;
      tried.add(host);
      looked++;
      const found = await inspectSite(`https://${host}/`, c, "search", deadline);
      if (found) return found;
    }
  }
  return null;
}

// Plusieurs entreprises en parallèle, avec un plafond de simultanéité pour
// rester courtois envers les sites visités et l'API de recherche.
export async function discoverMany(companies: Company[], options: DiscoverOptions, concurrency = 4, deadline = Date.now() + 60_000) {
  const results = new Map<string, Discovery | null>();
  let index = 0, searchBlocked = false;
  async function worker() {
    while (index < companies.length && Date.now() < deadline) {
      const c = companies[index++];
      try {
        const budget = Math.min(options.budgetMs || 14_000, Math.max(3_000, deadline - Date.now()));
        results.set(c.siren, await discoverCompany(c, { ...options, budgetMs: budget, search: options.search && !searchBlocked }));
      } catch (error) {
        if ((error as { code?: number }).code === 429) searchBlocked = true;
        results.set(c.siren, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));
  return { results, searchBlocked, processed: index };
}
