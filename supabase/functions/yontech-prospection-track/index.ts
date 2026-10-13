import { createClient } from "npm:@supabase/supabase-js@2";
import { BRAND } from "../_shared/yontech-core.ts";

// Suivi public des e-mails de prospection, sans aucune donnée personnelle
// dans l'URL : ?t=<jeton>&k=open|video|site|trap[&u=<destination>].
//   open  : pixel invisible, renvoie un GIF 1x1 ;
//   video : clic sur la vidéo, enregistre puis redirige ;
//   site  : clic sur un lien du message, enregistre puis redirige ;
//   trap  : lien piège invisible, qu'aucun humain ne voit : seul un filtre de
//           sécurité le suit. Le navigateur annoncé (User-Agent) est transmis à
//           la base, qui classe l'événement humain ou scanner.
// Un jeton inconnu n'enregistre rien mais redirige quand même.

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Les redirections sont limitées aux domaines des messages Yontech : jamais
// de redirection ouverte vers un site arbitraire.
function safeDestination(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    const allowed = BRAND.linkDomains.some((d) => host === d || host.endsWith("." + d));
    return allowed ? url.toString() : "";
  } catch {
    return "";
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  const kind = url.searchParams.get("k") || "";
  const destination = safeDestination(url.searchParams.get("u") || "") || BRAND.site;

  if (UUID_RE.test(token) && ["open", "video", "site", "trap"].includes(kind)) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && key) {
      const db = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const agent = (req.method === "HEAD" ? "head-request " : "") + (req.headers.get("user-agent") || "").slice(0, 300);
      await db.rpc("yontech_prospection_track", { target_token: token, kind, agent }).then(() => {}, () => {});
    }
  }

  if (kind === "open") {
    return new Response(GIF, {
      headers: { "Content-Type": "image/gif", "Content-Length": String(GIF.length), "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" },
    });
  }
  return new Response(null, { status: 302, headers: { Location: destination, "Cache-Control": "no-store" } });
});
