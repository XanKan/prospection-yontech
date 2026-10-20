// Worker Cloudflare « yontech-maquettes » : sert les maquettes de refonte sur
// <slug>.yontech.fr (route *.yontech.fr/*, enregistrement DNS générique « * »),
// une page par adresse (/, /volets-roulants…), et les images des maquettes via
// /_img?u=… (récupérées sur le site d'origine puis mises en cache 7 jours).
// Les Workers en domaine personnalisé (yontech.fr, maquette, sebalyo) passent
// avant cette route ; par prudence, les noms réservés repartent vers l'origine.
// lien.yontech.fr relaie le suivi des mails (pixel, clics) : les liens des mails
// restent sur le domaine de l'expéditeur (réglage YONTECH_TRACKING_BASE).
const ENDPOINT = "https://sdygujqnpsbnmmkjdjfz.supabase.co/functions/v1/yontech-maquette";
const TRACK = "https://sdygujqnpsbnmmkjdjfz.supabase.co/functions/v1/yontech-prospection-track";
const RESERVED = new Set(["www", "prospection", "mail", "webmail", "smtp", "imap", "pop", "ftp", "autodiscover", "autoconfig", "api", "app", "admin", "go", "cdn", "static", "maquette", "maquettes", "sebalyo"]);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";

const page = (title, text) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;color:#14161c;background:#f5f6f9;text-align:center;padding:24px}a{color:#4F46E5;font-weight:700}</style></head><body><div><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="https://yontech.fr">yontech.fr</a></p></div></body></html>`;

async function proxyImage(url, ctx) {
  let target;
  try { target = new URL(url.searchParams.get("u") || ""); } catch { return new Response("Adresse invalide", { status: 400 }); }
  if (!/^https?:$/.test(target.protocol)) return new Response("Adresse invalide", { status: 400 });
  const cache = caches.default, key = new Request(url.toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let upstream;
  try {
    upstream = await fetch(target.toString(), { headers: { "user-agent": UA, referer: target.origin + "/", accept: "image/avif,image/webp,image/*,*/*;q=0.8" }, cf: { cacheTtl: 604800, cacheEverything: true } });
  } catch { return new Response("Image indisponible", { status: 502 }); }
  const type = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !/^image\//i.test(type) || Number(upstream.headers.get("content-length") || 0) > 12_000_000) return new Response("Image indisponible", { status: 404 });
  const response = new Response(upstream.body, { headers: { "content-type": type, "cache-control": "public, max-age=604800, immutable", "access-control-allow-origin": "*", "x-robots-tag": "noindex" } });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

// Suivi des mails : même requête (méthode, paramètres), réponse transmise telle
// quelle (redirection vers la destination, pixel, page de lien piège).
async function proxyTrack(request, url) {
  let upstream;
  try {
    upstream = await fetch(TRACK + url.search, {
      method: request.method === "HEAD" ? "HEAD" : "GET", redirect: "manual",
      headers: { "user-agent": request.headers.get("user-agent") || "", accept: request.headers.get("accept") || "*/*", "x-forwarded-for": request.headers.get("cf-connecting-ip") || "" },
    });
  } catch { return Response.redirect("https://yontech.fr", 302); }
  const headers = new Headers({ "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" });
  for (const k of ["content-type", "location", "cache-control"]) { const v = upstream.headers.get(k); if (v) headers.set(k, v); }
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?)\.yontech\.fr$/);
    if (!match) return fetch(request);
    if (match[1] === "lien") return proxyTrack(request, url);
    if (url.pathname === "/_img") return proxyImage(url, ctx);
    if (RESERVED.has(match[1]) || match[1] === "img") return RESERVED.has(match[1]) ? fetch(request) : new Response(page("Page introuvable", "Rien ici."), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    const path = url.pathname === "/index.html" ? "/" : (url.pathname.replace(/\/+$/, "") || "/");
    if (!/^\/[a-z0-9-]{0,60}$/.test(path)) return Response.redirect(`https://${host}/`, 302);
    // Visites de l'équipe Yontech (cookie posé par l'outil, ou lien « ?apercu ») : jamais comptées.
    const team = /(?:^|;\s*)yt_equipe=1(?:;|$)/.test(request.headers.get("cookie") || "") || url.searchParams.has("apercu");
    const upstream = await fetch(`${ENDPOINT}?slug=${match[1]}&path=${encodeURIComponent(path)}${team ? "&preview=1" : ""}`, {
      headers: { "user-agent": request.headers.get("user-agent") || "", "x-forwarded-for": request.headers.get("cf-connecting-ip") || "" },
    });
    const html = upstream.ok ? await upstream.text() : page("Page introuvable", "Cette proposition de site n'est pas, ou plus, en ligne.");
    return new Response(html, {
      status: upstream.ok ? 200 : 404,
      headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "public, max-age=60", "referrer-policy": "no-referrer" },
    });
  },
};
