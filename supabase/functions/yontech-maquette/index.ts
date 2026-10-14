import { createClient } from "npm:@supabase/supabase-js@2";

// Sert une maquette de refonte par son slug et sa page (GET ?slug=dupont-menuiserie&path=/volets).
// Public : appelée par le Worker Cloudflare de *.yontech.fr et par la page
// prospection.yontech.fr/maquette.html. Le Worker remet le bon type de contenu
// (text/html) ; une visite compte si elle ne vient ni d'un robot ni d'un aperçu.

const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|headless|lighthouse|scanner|proofpoint|mimecast|barracuda|hornet|safelinks|microsoft office|outlook/i;

function headers(type = "text/html; charset=utf-8") {
  return { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex, nofollow" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: { ...headers(), "Access-Control-Allow-Methods": "GET" } });
  if (req.method !== "GET") return new Response("Méthode non autorisée", { status: 405, headers: headers("text/plain; charset=utf-8") });
  const url = new URL(req.url);
  const slug = String(url.searchParams.get("slug") || "").toLowerCase().slice(0, 50);
  if (!/^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/.test(slug)) return new Response("Maquette introuvable", { status: 404, headers: headers("text/plain; charset=utf-8") });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const path = String(url.searchParams.get("path") || "/").toLowerCase();
  if (path !== "/" && !/^\/[a-z0-9-]{1,60}$/.test(path)) return new Response("Page introuvable", { status: 404, headers: headers("text/plain; charset=utf-8") });
  const { data: maq } = await db.from("yontech_maquettes").select("id,html").eq("slug", slug).eq("status", "en_ligne").maybeSingle();
  if (!maq?.html) return new Response("Maquette introuvable", { status: 404, headers: headers("text/plain; charset=utf-8") });
  let data = { html: maq.html as string };
  if (path !== "/") {
    const { data: pg } = await db.from("yontech_maquette_pages").select("html").eq("maquette_id", maq.id).eq("path", path).maybeSingle();
    if (!pg?.html) return new Response("Page introuvable", { status: 404, headers: headers("text/plain; charset=utf-8") });
    data = { html: pg.html as string };
  }
  const ua = req.headers.get("user-agent") || "";
  if (url.searchParams.get("preview") !== "1" && ua && !BOT_RE.test(ua)) await db.rpc("yontech_maquette_view", { target_slug: slug });
  return new Response(data.html, { headers: headers() });
});
