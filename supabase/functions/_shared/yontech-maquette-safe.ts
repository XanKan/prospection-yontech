// Garde-fous de mise en page ajoutés à chaque site sur mesure (à la création
// et, pour les pages plus anciennes, au moment de les servir) : aucun
// défilement horizontal, aucun mot coupé en deux (le texte rapetisse à la place),
// médias à la largeur, et badge Yontech posé en bas de page sur téléphone au lieu
// de couvrir le texte. SAFE_VERSION change à chaque évolution : les pages déjà
// en ligne reçoivent la nouvelle version au moment où elles sont servies.
const SAFE_VERSION = "2";
const SAFE_CSS = `<style id="yt-safe">
html,body{overflow-x:clip!important;max-width:100%}
img,video,iframe,canvas{max-width:100%}
h1,h2,h3,h4,h5,h6,p,li,dd,dt,figcaption,blockquote,td,th,label,a,strong,em,small,button{overflow-wrap:break-word}
@media (max-width:760px){#yt-badge{position:static!important;margin:28px auto 18px!important;width:max-content!important;max-width:calc(100% - 32px)!important}
header,header nav{max-width:100vw}header a[href^="tel:"]{white-space:nowrap}}
</style><script id="yt-safe-js" data-v="${SAFE_VERSION}">(function(){
// Un titre ou un paragraphe écrasé dans une colonne trop étroite d'une grille
// (oubli de largeur dans la mise en page) : son bloc reprend toute la largeur.
function fix(){document.querySelectorAll("h1,h2,h3,h4,p,blockquote").forEach(function(t){if((t.textContent||"").trim().length<25)return;var w=t.getBoundingClientRect().width;if(!w||w>=140)return;var c=t;while(c.parentElement&&c.parentElement!==document.body&&getComputedStyle(c.parentElement).display.indexOf("grid")<0)c=c.parentElement;if(c.parentElement&&c.parentElement!==document.body)c.style.gridColumn="1 / -1"})}
// Un mot (4 lettres ou plus) coupé sur deux lignes, quel que soit l'élément
// (« Atelie / r Corai / l » dans un grand cartouche) : le texte rapetisse
// jusqu'à ce que chaque mot tienne entier sur sa ligne.
var WORD=/[A-Za-z\\u00C0-\\u024F0-9'\\u2019]{4,}/g;
function broken(el){var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n,m;while((n=w.nextNode())){WORD.lastIndex=0;while((m=WORD.exec(n.data))){var r=document.createRange();r.setStart(n,m.index);r.setEnd(n,m.index+m[0].length);var rs=r.getClientRects(),top=null;for(var i=0;i<rs.length;i++){if(rs[i].width<1)continue;if(top===null)top=rs[i].top;else if(Math.abs(rs[i].top-top)>3)return true}}}return false}
function words(){var done=[];document.querySelectorAll("body *").forEach(function(el){if(el.id==="yt-badge"||el.closest("#yt-badge")||/^(SCRIPT|STYLE|NOSCRIPT|svg|path|TEXTAREA|OPTION)$/i.test(el.tagName))return;var own=false;for(var c=el.firstChild;c;c=c.nextSibling)if(c.nodeType===3&&/\\S/.test(c.data)){own=true;break}if(!own||!el.getClientRects().length)return;if(parseFloat(getComputedStyle(el).fontSize)<14)return;if(done.indexOf(el)>=0)return;done.push(el);var n=0;while(n<16&&broken(el)){var fs=parseFloat(getComputedStyle(el).fontSize);if(fs<12)break;el.style.fontSize=(fs*0.92)+"px";n++}})}
// Une ligne qui ne doit pas passer à la ligne (bouton, petite étiquette) et qui
// déborde de son cadre : elle rapetisse aussi.
function fit(){document.querySelectorAll("h1,h2,h3,h4,strong,b,a,button,span,.big,[class*=title],[class*=metier],[class*=kicker],[class*=eyebrow]").forEach(function(t){if(t.offsetWidth<4||(t.textContent||"").trim().split(/\\s+/).length>8)return;var cs=getComputedStyle(t);if(parseFloat(cs.fontSize)<11||cs.display==="inline")return;if(cs.whiteSpace.indexOf("nowrap")<0&&t.tagName!=="H1"&&t.tagName!=="H2")return;var n=0;while(t.scrollWidth>t.clientWidth+1&&n<10){t.style.fontSize=(parseFloat(getComputedStyle(t).fontSize)*0.92)+"px";n++}})}
// Une case de hauteur fixe qui cache la fin de son texte (pas une image) : elle reprend la hauteur nécessaire.
function unclip(){document.querySelectorAll("div,p,li,article,aside,blockquote,dd,a").forEach(function(el){var cs=getComputedStyle(el);if(cs.display==="inline"||!/hidden|clip/.test(cs.overflow+cs.overflowY))return;if(el.scrollHeight<=el.clientHeight+4||el.querySelector("img,video,iframe,canvas,picture"))return;if((el.textContent||"").trim().length<20)return;el.style.height="auto";el.style.maxHeight="none";el.style.overflow="visible";if(cs.webkitLineClamp&&cs.webkitLineClamp!=="none"){el.style.webkitLineClamp="unset";el.style.display="block"}})}
// Sur téléphone, un en-tête plus large que l'écran (menu non replié) : les liens
// texte disparaissent un à un (le téléphone et les boutons restent), puis les rangées passent à la ligne.
function navfit(){if(innerWidth>760)return;document.querySelectorAll("header,[class*=header],[class*=navbar],body>nav").forEach(function(h){if(h.closest("#yt-badge"))return;var over=function(){return h.scrollWidth>h.clientWidth+1||h.getBoundingClientRect().right>innerWidth+1||[].some.call(h.querySelectorAll("a,button"),function(a){return a.getBoundingClientRect().right>innerWidth+1})};if(!over())return;var links=[].filter.call(h.querySelectorAll("a"),function(a){return !/^tel:|^mailto:/.test(a.getAttribute("href")||"")&&!/btn|button|cta|call/i.test(a.className)&&a.offsetWidth});while(over()&&links.length){links.pop().style.display="none"}if(over())h.querySelectorAll("*").forEach(function(c){if(getComputedStyle(c).display.indexOf("flex")>=0)c.style.flexWrap="wrap"})})}
// Sur téléphone, un bloc de texte qui dépasse à droite (colonne de largeur fixe) : ramené dans l'écran.
function squeeze(){if(innerWidth>760)return;var W=innerWidth,done=[];document.querySelectorAll("body *").forEach(function(el){if(el.closest("#yt-badge")||done.some(function(d){return d.contains(el)}))return;var cs=getComputedStyle(el);if(cs.position==="fixed"||cs.position==="absolute"||!(el.textContent||"").trim())return;var r=el.getBoundingClientRect();if(r.right<=W+1||r.width>W||r.left<0)return;for(var a=el.parentElement;a&&a!==document.body;a=a.parentElement){var ac=getComputedStyle(a);if(/hidden|clip/.test(ac.overflowX+ac.overflow)&&a.getBoundingClientRect().right<=W+1)return}el.style.maxWidth=Math.max(120,W-r.left-12)+"px";el.style.minWidth="0";done.push(el)})}
// Texte décoratif contouré (contour épais pensé pour un très grand titre) affiché en petit :
// le contour est réduit en proportion, sinon il écrase les lettres.
function strokes(){document.querySelectorAll("body *").forEach(function(el){var cs=getComputedStyle(el),sw=parseFloat(cs.webkitTextStrokeWidth)||0;if(!sw)return;var fs=parseFloat(cs.fontSize);if(sw>fs*0.04)el.style.webkitTextStrokeWidth=Math.max(0.5,fs*0.03)+"px"})}
function all(){try{fix();words();fit();unclip();navfit();squeeze();strokes()}catch(e){}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",all);else all();
addEventListener("load",all);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(all);
var tm;addEventListener("resize",function(){clearTimeout(tm);tm=setTimeout(all,200)});
})();</script>`;

export function hardenDesignHtml(html: string) {
  if (html.includes(`id="yt-safe-js" data-v="${SAFE_VERSION}"`)) return html;
  // Ancienne version des garde-fous : retirée avant de poser la nouvelle.
  html = html.replace(/<style id="yt-safe">[\s\S]*?<\/style>/, "").replace(/<script id="yt-safe-js"[^>]*>[\s\S]*?<\/script>/, "");
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${SAFE_CSS}</head>`) : SAFE_CSS + html;
  if (!/<html[^>]*\blang=/i.test(out)) out = out.replace(/<html\b/i, '<html lang="fr"');
  // Badge en fin de page (sur téléphone il devient un simple bandeau sous le contenu).
  const badge = out.match(/<div id="yt-badge"[\s\S]*?<\/div>/);
  if (badge && /<\/body>/i.test(out)) out = out.replace(badge[0], "").replace(/<\/body>/i, `${badge[0]}</body>`);
  return out;
}
