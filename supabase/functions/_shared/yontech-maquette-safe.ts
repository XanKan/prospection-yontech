// Garde-fous de mise en page ajoutés à chaque site sur mesure (à la création
// et, pour les pages plus anciennes, au moment de les servir) : aucun
// défilement horizontal, un mot plus large que son bloc est coupé (jamais les autres), médias à la largeur,
// et badge Yontech posé en bas de page sur téléphone au lieu de couvrir le texte.
const SAFE_CSS = `<style id="yt-safe">
html,body{overflow-x:clip!important;max-width:100%}
img,video,iframe,canvas{max-width:100%}
h1,h2,h3,h4,h5,h6,p,li,dd,dt,figcaption,blockquote,td,th,label,a,strong,em,small,button{overflow-wrap:break-word}
@media (max-width:760px){#yt-badge{position:static!important;margin:28px auto 18px!important;width:max-content!important;max-width:calc(100% - 32px)!important}}
</style><script id="yt-safe-js">(function(){
// Un titre ou un paragraphe écrasé dans une colonne trop étroite d'une grille
// (oubli de largeur dans la mise en page) : son bloc reprend toute la largeur.
function fix(){document.querySelectorAll("h1,h2,h3,h4,p,blockquote").forEach(function(t){if((t.textContent||"").trim().length<25)return;var w=t.getBoundingClientRect().width;if(!w||w>=140)return;var c=t;while(c.parentElement&&c.parentElement!==document.body&&getComputedStyle(c.parentElement).display.indexOf("grid")<0)c=c.parentElement;if(c.parentElement&&c.parentElement!==document.body)c.style.gridColumn="1 / -1"})}
// Un mot de titre plus large que son bloc (« Menuiserie » en très gros dans une case
// étroite) : le titre rapetisse jusqu'à tenir, au lieu d'être coupé en morceaux.
function fit(){document.querySelectorAll("h1,h2,h3,h4,strong,b,.big,[class*=title],[class*=metier]").forEach(function(t){if(!t.offsetWidth||(t.textContent||"").trim().split(/\s+/).length>8)return;var cs=getComputedStyle(t);if(parseFloat(cs.fontSize)<20)return;t.style.overflowWrap="normal";var n=0;while(t.scrollWidth>t.clientWidth+1&&n<12){t.style.fontSize=(parseFloat(getComputedStyle(t).fontSize)*0.9)+"px";n++}t.style.overflowWrap=""})}
var _f=fix;fix=function(){_f();fit()};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",fix);else fix();
addEventListener("load",fix);var tm;addEventListener("resize",function(){clearTimeout(tm);tm=setTimeout(fix,200)});
})();</script>`;

export function hardenDesignHtml(html: string) {
  if (html.includes('id="yt-safe-js"')) return html;
  html = html.replace(/<style id="yt-safe">[\s\S]*?<\/style>/, "");
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${SAFE_CSS}</head>`) : SAFE_CSS + html;
  if (!/<html[^>]*\blang=/i.test(out)) out = out.replace(/<html\b/i, '<html lang="fr"');
  // Badge en fin de page (sur téléphone il devient un simple bandeau sous le contenu).
  const badge = out.match(/<div id="yt-badge"[\s\S]*?<\/div>/);
  if (badge && /<\/body>/i.test(out)) out = out.replace(badge[0], "").replace(/<\/body>/i, `${badge[0]}</body>`);
  return out;
}
