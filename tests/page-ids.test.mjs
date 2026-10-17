import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

// Chaque élément appelé par le script de la page ($("id")) doit exister :
// un élément manquant fait planter le script au chargement et l'outil reste vide.
test("les éléments appelés par le script existent dans la page", () => {
  const s = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const html = s.replace(/<script>[\s\S]*?<\/script>/g, "");
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const dynamic = new Set([...script.matchAll(/id=\\?["']([A-Za-z][\w-]*)\\?["']/g)].map((m) => m[1]));
  const missing = [...new Set([...script.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]))].filter((id) => !ids.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, []);
});
