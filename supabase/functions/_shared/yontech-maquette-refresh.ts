import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { RENDER_VERSION } from "./yontech-maquette-pro.ts";
import { renderAll } from "./yontech-maquette-render.ts";
import type { SiteData } from "./yontech-maquette.ts";

// Redessine les maquettes enregistrées avec une ancienne version du gabarit,
// à partir des données déjà extraites (aucune relecture du site, aucun appel IA).
const MARK = `name="yt-render" content="${RENDER_VERSION}"`;
export const renderIsCurrent = (html: string) => html.includes(MARK);

export async function refreshRender(db: SupabaseClient, row: { id: string; data: SiteData }) {
  const all = renderAll(row.data);
  const { error } = await db.from("yontech_maquettes").update({ html: all.home }).eq("id", row.id);
  if (error) throw error;
  await db.from("yontech_maquette_pages").delete().eq("maquette_id", row.id);
  if (all.pages.length) {
    const { error: pageError } = await db.from("yontech_maquette_pages").insert(all.pages.map((pg) => ({ maquette_id: row.id, path: pg.path, html: pg.html })));
    if (pageError) throw pageError;
  }
  return all;
}

export async function refreshStale(db: SupabaseClient, limit = 15) {
  const { data, error } = await db.from("yontech_maquettes").select("id,data").not("data", "is", null).not("html", "like", `%${MARK}%`).limit(limit);
  if (error) throw error;
  let done = 0;
  for (const row of data || []) {
    try { await refreshRender(db, row as { id: string; data: SiteData }); done++; } catch (e) { console.error("[Maquette rendu]", row.id, (e as Error).message); }
  }
  return done;
}
