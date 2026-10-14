// Worker Cloudflare « yontech-maquettes » : sert les maquettes de refonte sur
// <slug>.yontech.fr (route *.yontech.fr/*, enregistrement DNS générique « * »).
// Les sous-domaines réservés et ceux qui ont leur propre enregistrement DNS
// non proxifié (prospection, www…) ne passent jamais par ici ; par prudence,
// les noms réservés sont renvoyés tels quels vers leur origine.
const ENDPOINT = "https://sdygujqnpsbnmmkjdjfz.supabase.co/functions/v1/yontech-maquette";
const RESERVED = new Set(["www", "prospection", "mail", "webmail", "smtp", "imap", "pop", "ftp", "autodiscover", "autoconfig", "api", "app", "admin", "go", "cdn", "static"]);

const page = (title, text) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;color:#14161c;background:#f5f6f9;text-align:center;padding:24px}a{color:#4F46E5;font-weight:700}</style></head><body><div><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="https://yontech.fr">yontech.fr</a></p></div></body></html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?)\.yontech\.fr$/);
    if (!match || RESERVED.has(match[1])) return fetch(request);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    if (url.pathname !== "/" && url.pathname !== "/index.html") return Response.redirect(`https://${host}/`, 302);
    const upstream = await fetch(`${ENDPOINT}?slug=${match[1]}`, {
      headers: { "user-agent": request.headers.get("user-agent") || "", "x-forwarded-for": request.headers.get("cf-connecting-ip") || "" },
    });
    const html = upstream.ok ? await upstream.text() : page("Page introuvable", "Cette proposition de site n'est pas, ou plus, en ligne.");
    return new Response(html, {
      status: upstream.ok ? 200 : 404,
      headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "public, max-age=60", "referrer-policy": "no-referrer" },
    });
  },
};
