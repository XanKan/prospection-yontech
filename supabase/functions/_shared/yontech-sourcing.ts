import {
  API_SIRENE, DEPARTEMENTS, type Company, companyToQueueItem, normalizeCompany, normalizeTarget, scoreCompany, sireneParams, targetKey,
} from "./yontech-core.ts";
import { discoverMany, type Discovery } from "./yontech-web.ts";

// Pilote automatique : complète la file avec de nouvelles entreprises de la
// base SIRENE (API Recherche d'entreprises, tous secteurs) correspondant au
// ciblage, puis cherche leur site et leur adresse e-mail sur le web.
//
// Le balayage se fait par unité « département × tranche d'effectif », une
// page de 25 entreprises à la fois, à tour de rôle, et reprend là où il s'était
// arrêté au réveil suivant (curseur en base). L'API plafonne chaque requête à
// 10 000 résultats : une unité qui dépasse est découpée par section NAF.
// L'ordre des unités est tiré au sort une fois pour toutes à partir du
// ciblage (générateur déterministe), pour varier les secteurs et les régions
// d'un jour à l'autre sans stocker la liste.

export type Cursor = { key: string; n: number; extra: string[]; done: number[]; pages: Record<string, number>; i: number };
export type QueueItem = ReturnType<typeof companyToQueueItem>;
export type SourcingReport = {
  pages: number; scanned: number; known: number; sites: number; withEmail: number; lowScore: number; noFirstName: number;
  added: number; errors: number; searches: number; searchBlocked: boolean; exhausted: boolean; at?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mélange déterministe (même ciblage, même ordre) : Fisher-Yates avec un
// générateur mulberry32 initialisé par la clé du ciblage.
function seeded(key: string) {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) { h = Math.imul(h ^ key.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function unitsFor(target: ReturnType<typeof normalizeTarget>) {
  const key = targetKey(target);
  const list = (target.deps.length ? target.deps : DEPARTEMENTS).flatMap((dep) => target.effs.map((eff) => `${dep}|${eff}`));
  const rand = seeded(key);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

// deno-lint-ignore no-explicit-any
async function getJson(url: string, attempt = 0): Promise<any> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (response.status === 429 && attempt < 3) {
    await sleep(2600);
    return getJson(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
  return response.json();
}

export async function runSourcing(options: {
  target: unknown; cursor: unknown; batch: number; minScore: number; deadline: number; requireFirstName?: boolean;
  searchApiKey?: string;
  // Entreprises déjà connues (file, historique, exclusions, déjà examinées sans adresse).
  known: (sirens: string[], emails: string[]) => Promise<{ sirens: Set<string>; emails: Set<string> }>;
  enqueue: (items: QueueItem[]) => Promise<number>;
  // Mémorise les entreprises examinées (avec ou sans adresse) pour ne pas les refaire.
  scanned: (items: { siren: string; site: string; email: string; how: string }[]) => Promise<void>;
}) {
  const target = normalizeTarget(options.target);
  const key = targetKey(target);
  const base = unitsFor(target);
  const previous = options.cursor as Cursor | null;
  const cursor: Cursor = previous && previous.key === key && typeof previous.n === "number"
    ? { key, n: previous.n, extra: previous.extra || [], done: previous.done || [], pages: previous.pages || {}, i: previous.i || 0 }
    : { key, n: base.length, extra: [], done: [], pages: {}, i: 0 };
  const unitAt = (index: number) => index < base.length ? base[index] : cursor.extra[index - base.length];
  const total = () => base.length + cursor.extra.length;
  const report: SourcingReport = { pages: 0, scanned: 0, known: 0, sites: 0, withEmail: 0, lowScore: 0, noFirstName: 0, added: 0, errors: 0, searches: 0, searchBlocked: false, exhausted: false };
  const doneSet = new Set(cursor.done);

  while (report.added < options.batch && Date.now() < options.deadline - 12_000 && report.errors < 6) {
    const pending: number[] = [];
    for (let k = 0; k < total(); k++) if (!doneSet.has(k)) pending.push(k);
    if (!pending.length) { report.exhausted = true; break; }
    const index = pending[cursor.i % pending.length];
    cursor.i++;
    const [dep, eff, sect] = unitAt(index).split("|");
    const page = cursor.pages[String(index)] || 1;
    const params = new URLSearchParams({ ...sireneParams(target, dep, eff, sect), per_page: "25", page: String(page) });
    // deno-lint-ignore no-explicit-any
    let data: any;
    try { data = await getJson(API_SIRENE + "?" + params.toString()); } catch { report.errors++; await sleep(800); continue; }
    report.pages++;
    const totalResults = Number(data.total_results || 0);
    // Plus de 10 000 résultats : l'API n'en livrera que 10 000. L'unité est
    // découpée par section NAF (si plusieurs) et son reste est abandonné.
    if (page === 1 && totalResults > 10_000 && !sect && !target.nafs.length && target.sect.length > 1) {
      for (const s of target.sect) cursor.extra.push(`${dep}|${eff}|${s}`);
      doneSet.add(index); cursor.done.push(index);
      continue;
    }
    const lastPage = Math.min(Number(data.total_pages || 0), 400);
    cursor.pages[String(index)] = page + 1;
    if (!data.results?.length || page >= lastPage) { doneSet.add(index); cursor.done.push(index); delete cursor.pages[String(index)]; }

    // L'API filtre sur tous les établissements : seul le siège compte ici, et
    // seule l'activité demandée (une division NAF couvre tous ses codes).
    const companies = (data.results || []).map((r: unknown) => normalizeCompany(r))
      .filter((c: Company) => /^\d{9}$/.test(c.siren) && (!target.deps.length || target.deps.includes(c.dep)))
      .filter((c: Company) => !target.nafs.length || target.nafs.some((n) => n.length === 2 ? c.naf.startsWith(n) : c.naf === n)) as Company[];
    report.scanned += companies.length;
    if (!companies.length) continue;

    const knownSirens = await options.known(companies.map((c) => c.siren), []);
    const fresh = companies.filter((c) => !knownSirens.sirens.has(c.siren));
    report.known += companies.length - fresh.length;
    // « Bonjour Prénom » : sans prénom de dirigeant connu, pas la peine de chercher le site.
    const candidates = options.requireFirstName ? fresh.filter((c) => c.prenom) : fresh;
    report.noFirstName += fresh.length - candidates.length;
    if (!candidates.length) continue;

    const { results, searchBlocked } = await discoverMany(candidates, {
      guess: target.guess, search: target.search, searchApiKey: options.searchApiKey, budgetMs: 14_000, onSearch: () => { report.searches++; },
    }, 4, options.deadline - 4_000);
    if (searchBlocked) report.searchBlocked = true;
    const scannedRows: { siren: string; site: string; email: string; how: string }[] = [];
    const withEmail: Company[] = [];
    for (const c of candidates) {
      const d: Discovery | null | undefined = results.get(c.siren);
      if (d === undefined) continue; // non traité (délai) : il sera repris au prochain passage
      if (d) { report.sites++; c.site = d.site; c.how = d.how; c.ownDomain = d.own; if (d.email) { c.email = d.email; withEmail.push(c); } }
      scannedRows.push({ siren: c.siren, site: d?.site || "", email: d?.email || "", how: d?.how || "" });
    }
    report.withEmail += withEmail.length;
    const knownEmails = withEmail.length ? await options.known([], withEmail.map((c) => c.email)) : { sirens: new Set<string>(), emails: new Set<string>() };
    const seen = new Set<string>();
    const items: QueueItem[] = [];
    for (const c of withEmail) {
      if (knownEmails.emails.has(c.email) || seen.has(c.email)) { report.known++; continue; }
      seen.add(c.email);
      const score = scoreCompany(c);
      if (score < options.minScore) { report.lowScore++; continue; }
      items.push(companyToQueueItem(c, score));
    }
    if (items.length) report.added += await options.enqueue(items);
    if (scannedRows.length) await options.scanned(scannedRows);
    // Page non terminée (délai) : on y revient au prochain passage.
    if (results.size < candidates.length) { cursor.pages[String(index)] = page; if (doneSet.has(index)) { doneSet.delete(index); cursor.done = cursor.done.filter((k) => k !== index); } }
    await sleep(170);
  }
  return { cursor, report, total: total(), done: cursor.done.length };
}
