// Logique pure de l'automate Yontech (supabase/functions/_shared/yontech-core.ts).
// Node exécute le module TypeScript directement grâce au retrait des types :
//   node --experimental-strip-types tests/core.test.mjs   (Node 22.6+ ; natif en Node 23+)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BRAND, niceCompany, templateVars, renderTemplate, unknownVariables, composeEmail, classifySmtpError, retryDelaySeconds,
  normalizeTarget, sireneParams, normalizeCompany, scoreCompany, companyToQueueItem, maskEmail, youtubeId, metierFor,
  nameWords, domainCandidates, extractEmails, verifyPage, secondaryLinks, isDirectoryHost, DEFAULT_SECTIONS, SECTIONS,
} from '../supabase/functions/_shared/yontech-core.ts';

// Raisons sociales SIRENE en capitales : écrites comme à la main.
assert.equal(niceCompany('DUPONT MECANIQUE (DM)'), 'Dupont Mecanique');
assert.equal(niceCompany('SARL MARTIN ET FILS'), 'SARL Martin et Fils');
assert.equal(niceCompany('Déjà Bien Écrit'), 'Déjà Bien Écrit');

// Personnalisation et texte de repli.
const vars = templateVars({ entreprise: 'DUPONT MECANIQUE', prenom: 'JEAN PIERRE', ville: 'LA ROCHE-SUR-YON', metier: 'fabrication de produits métalliques', site: 'https://dupont-mecanique.fr/' });
assert.equal(vars.bonjour, 'Bonjour Jean');
assert.equal(vars.site, 'dupont-mecanique.fr');
assert.equal(templateVars({}).bonjour, 'Bonjour');
assert.equal(renderTemplate('{bonjour}, {entreprise} à {ville} ({metier|votre secteur})', vars), 'Bonjour Jean, Dupont Mecanique à La Roche-Sur-Yon (fabrication de produits métalliques)');
assert.equal(renderTemplate('{metier|votre secteur}', templateVars({})), 'votre secteur');
assert.equal(renderTemplate('Reste visible : {inconnue}', vars), 'Reste visible : {inconnue}');
assert.deepEqual(unknownVariables('{bonjour} {foo} {bar|x} {site}'), ['foo', 'bar']);
assert.equal(metierFor('56.10A'), 'restauration');
assert.equal(metierFor('99.99Z'), 'organismes extraterritoriaux');
assert.equal(metierFor(''), '');

// Chaque message porte la source des données (SIRENE, site de l'entreprise)
// et le lien de désinscription, en texte comme en HTML ; le HTML échappe le contenu.
const mail = composeEmail({
  subject: '{entreprise} : une application ?', body: '{bonjour},\n\n<b>Test</b> https://yontech.fr/#sur-mesure',
  signature: 'Équipe Yontech', footerIdentity: 'Yontech · https://yontech.fr', unsubscribeUrl: 'https://prospection.yontech.fr/desinscription.html?t=abc', vars,
});
assert.equal(mail.subject, 'Dupont Mecanique : une application ?');
assert.match(mail.text, /base SIRENE de l'INSEE/);
assert.match(mail.text, /site internet/);
assert.doesNotMatch(mail.text, /RGE|ADEME|Piloz/);
assert.match(mail.text, /desinscription\.html\?t=abc/);
assert.match(mail.html, /desinscription\.html\?t=abc/);
assert.match(mail.html, /&lt;b&gt;Test&lt;\/b&gt;/);
assert.doesNotMatch(mail.html, /width="1"|height="1"/i, 'aucun pixel sans jeton de suivi');
assert.match(mail.html, /yontech-logo-112\.png/);
assert.match(mail.html, /<b style="color:#15161f;font-size:15px">Équipe Yontech<\/b>/);
assert.doesNotMatch(composeEmail({ subject: 's', body: 'x', unsubscribeUrl: 'u', vars, logoUrl: '' }).html, /<img/, 'signature sans logo possible');

// Suivi : pixel, lien piège et liens réécrits uniquement avec un jeton ; la
// désinscription n'est jamais traquée.
const tracked = composeEmail({ subject: 's', body: 'Voir https://yontech.fr et https://www.youtube.com/watch?v=UycAnUQzzYg', unsubscribeUrl: 'https://prospection.yontech.fr/desinscription.html?t=abc', vars, tracking: { base: 'https://x.supabase.co/functions/v1/yontech-prospection-track', token: 'tok' } });
assert.match(tracked.html, /k=open/);
assert.match(tracked.html, /k=trap/);
assert.match(tracked.html, /k=site&amp;u=https%3A%2F%2Fyontech\.fr/);
assert.match(tracked.html, /k=video&amp;u=/);
assert.match(tracked.html, /href="https:\/\/prospection\.yontech\.fr\/desinscription\.html\?t=abc"/);
assert.match(tracked.text, /https:\/\/yontech\.fr/, 'la version texte garde les vraies adresses');

// Vidéo facultative, à l'emplacement {video}.
const mail2 = composeEmail({ subject: 's', body: 'Avant.\n\n{video}\n\nAprès.', unsubscribeUrl: 'u', vars, videoUrl: 'https://youtu.be/Fn_3DmBmxR4' });
assert.ok(mail2.html.indexOf('Avant') < mail2.html.indexOf('i.ytimg.com/vi/Fn_3DmBmxR4') && mail2.html.indexOf('i.ytimg.com') < mail2.html.indexOf('Après'));
assert.doesNotMatch(composeEmail({ subject: 's', body: 'x', unsubscribeUrl: 'u', vars }).html, /youtube|ytimg/);
assert.equal(youtubeId('https://www.youtube.com/watch?v=UycAnUQzzYg&feature=youtu.be'), 'UycAnUQzzYg');

// Classement des erreurs SMTP (codes nodemailer).
assert.equal(classifySmtpError({ code: 'EAUTH', responseCode: 535 }), 'fatal');
assert.equal(classifySmtpError({ code: 'EENVELOPE', responseCode: 550 }), 'recipient_rejected');
assert.equal(classifySmtpError({ code: 'EENVELOPE', responseCode: 450 }), 'transient');
assert.equal(classifySmtpError({ code: 'ECONNECTION' }), 'throttled');
assert.equal(classifySmtpError({ responseCode: 550, response: '550 5.4.6 Daily sending quota exceeded' }), 'throttled');
assert.equal(retryDelaySeconds({ response: '550 5.4.6 Daily sending quota exceeded' }), 3600);
assert.equal(retryDelaySeconds({ code: 'ETIMEDOUT' }), 900);
assert.equal(maskEmail('jean.dupont@exemple.fr'), 'je••••••@exemple.fr');

// Ciblage : tous secteurs par défaut sauf administrations, ménages et
// organismes extraterritoriaux ; à partir de 6 salariés ; codes filtrés.
assert.deepEqual(normalizeTarget({}).sect, DEFAULT_SECTIONS);
assert.ok(!DEFAULT_SECTIONS.includes('O') && !DEFAULT_SECTIONS.includes('T') && !DEFAULT_SECTIONS.includes('U'));
assert.equal(Object.keys(SECTIONS).length, 21);
assert.deepEqual(normalizeTarget({}).effs, ['03', '11', '12', '21', '22', '31', '32']);
const target = normalizeTarget({ sect: ['c', 'zz'], nafs: ['56', '62.01Z', 'nope'], effs: ['02', 'x'], deps: ['69', '2a', '999'], guess: false });
assert.deepEqual(target.sect, ['C']);
assert.deepEqual(target.nafs, ['56', '62.01Z']);
assert.deepEqual(target.effs, ['02']);
assert.deepEqual(target.deps, ['69', '2A']);
assert.equal(target.guess, false);
assert.equal(target.search, true);
assert.equal(sireneParams(normalizeTarget({}), '85', '11').section_activite_principale, DEFAULT_SECTIONS.join(','));
assert.equal(sireneParams(normalizeTarget({}), '85', '11', 'C').section_activite_principale, 'C');
assert.equal(sireneParams(normalizeTarget({}), '85', '11').tranche_effectif_salarie, '11');
assert.equal(sireneParams(normalizeTarget({}), '85', '11').etat_administratif, 'A');
assert.match(sireneParams(normalizeTarget({ nafs: ['56'] }), '85').activite_principale, /^56\.10A,56\.10B/);
assert.equal(sireneParams(normalizeTarget({ nafs: ['62.01Z'] }), '85').activite_principale, '62.01Z');
assert.equal(sireneParams(normalizeTarget({ nafs: ['62.01Z'] }), '85').section_activite_principale, undefined);

// Normalisation et score (aucune composante RGE).
const company = normalizeCompany({
  siren: '123456789', nom_complet: 'DUPONT MECANIQUE', sigle: 'DM', activite_principale: '25.62B', section_activite_principale: 'C', tranche_effectif_salarie: '12',
  siege: { siret: '12345678900012', libelle_commune: 'LA ROCHE-SUR-YON', code_postal: '85000', departement: '85', liste_enseignes: ['DUPONT MECA'] }, nombre_etablissements_ouverts: 2,
  dirigeants: [{ type_dirigeant: 'personne morale' }, { type_dirigeant: 'personne physique', prenoms: 'JEAN (JJ) PAUL', nom: 'DUPONT' }],
  finances: { 2023: { ca: 800000 }, 2024: { ca: 1000000 } }, date_creation: '2015-01-01',
}, Date.parse('2026-10-01'));
assert.equal(company.metier, 'fabrication de produits métalliques');
assert.equal(company.prenom, 'Jean');
assert.equal(company.siret, '12345678900012');
assert.equal(scoreCompany(company), 30 + 12 + 12 + 12 + 10 + 0);
company.email = 'contact@dupont-mecanique.fr'; company.ownDomain = true; company.site = 'https://dupont-mecanique.fr';
assert.equal(scoreCompany(company), 30 + 12 + 12 + 12 + 10 + 10, 'une adresse sur le domaine de l\'entreprise vaut 10 points');
const item = companyToQueueItem(company, 86);
assert.equal(item.email, 'contact@dupont-mecanique.fr');
assert.equal(item.data.site, 'https://dupont-mecanique.fr');
assert.equal(item.data.ville, 'La Roche-Sur-Yon');

// Découverte web : domaines devinés, vérification du site, choix de l'adresse.
assert.deepEqual(nameWords('SARL DUPONT MÉCANIQUE (DM)'), ['dupont', 'mecanique']);
const candidates = domainCandidates({ nom: 'SARL DUPONT MECANIQUE', sigle: 'DM', enseigne: 'DUPONT MECA' });
assert.equal(candidates[0], 'dupontmecanique.fr');
assert.ok(candidates.includes('dupont-mecanique.fr') && candidates.includes('dupontmeca.fr'));
assert.ok(!candidates.includes('dm.fr'), 'un sigle de deux lettres n\'est pas un domaine plausible');
assert.ok(candidates.length <= 8);
assert.equal(verifyPage('<p>Mentions légales : SIRET 123 456 789 00012</p>', company), 'siren');
assert.equal(verifyPage('<footer>Dupont Mécanique · 85000 La Roche-sur-Yon</footer>', company), 'nom+ville');
assert.equal(verifyPage('<p>Une autre société Dupont à Nantes</p>', company), '');
const page = '<a href="mailto:Contact@Dupont-Mecanique.fr">nous écrire</a> jean.dupont@dupont-mecanique.fr <img src="logo@2x.png"> noreply@dupont-mecanique.fr webmaster@agence.com direction [at] dupont-mecanique [dot] fr perso@gmail.com';
const emails = extractEmails(page, 'www.dupont-mecanique.fr', { prenom: 'Jean', nom: 'Dupont' });
assert.equal(emails[0].email, 'jean.dupont@dupont-mecanique.fr', 'le dirigeant d\'abord');
assert.equal(emails[0].own, true);
assert.ok(emails.some((e) => e.email === 'contact@dupont-mecanique.fr'));
assert.ok(emails.some((e) => e.email === 'direction@dupont-mecanique.fr'), 'obfuscation [at] [dot] décodée');
assert.ok(!emails.some((e) => /noreply|webmaster|logo@2x/.test(e.email)));
assert.ok(emails.findIndex((e) => e.email === 'perso@gmail.com') > emails.findIndex((e) => e.email === 'contact@dupont-mecanique.fr'));
assert.deepEqual(secondaryLinks('<a href="/contact">c</a><a href="https://www.dupont-mecanique.fr/mentions-legales">m</a><a href="https://autre.fr/contact">x</a><a href="/produits">p</a>', 'https://dupont-mecanique.fr/'),
  ['https://www.dupont-mecanique.fr/mentions-legales', 'https://dupont-mecanique.fr/contact'], 'mentions légales d\'abord');
assert.deepEqual(secondaryLinks('<a href="/wp-content/plugins/contact-form-7/styles.css">x</a><a href="/contact.pdf">p</a><a href="mailto:contact@dupont-mecanique.fr">m</a>', 'https://dupont-mecanique.fr/'), [], 'fichiers et chemins techniques écartés');
assert.equal(isDirectoryHost('www.societe.com'), true);
assert.equal(isDirectoryHost('fr.linkedin.com'), true);
assert.equal(isDirectoryHost('dupont-mecanique.fr'), false);

// Marque : rien ne renvoie vers l'outil Piloz.
assert.equal(BRAND.name, 'Yontech');
assert.doesNotMatch(JSON.stringify(BRAND), /piloz\.fr\/(desinscription|t\b)/);

// L'automate n'envoie jamais deux fois à la même entreprise, les tables sont
// préfixées et la désinscription reste possible sans compte.
const sql = readFileSync(new URL('../supabase/migrations/202610130100_yontech_prospection.sql', import.meta.url), 'utf8');
assert.match(sql, /unique index if not exists yontech_prospection_messages_email_key/);
assert.match(sql, /unique index if not exists yontech_prospection_messages_siren_key/);
assert.match(sql, /for update skip locked/);
assert.match(sql, /enable row level security/);
assert.doesNotMatch(sql, /public\.prospection_|'piloz-prospection/, 'aucune table ni tâche de l\'outil Piloz');
assert.match(sql, /cron\.schedule\('yontech-prospection-sourcer'/);
const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
assert.match(config, /\[functions\.yontech-prospection-unsubscribe\]\s*\nverify_jwt = false/);
assert.match(config, /\[functions\.yontech-prospection-api\]\s*\nverify_jwt = true/);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.doesNotMatch(html, /"\/functions\/v1\/prospection-api"|reseau\.|RGE|ADEME|piloz\.fr/, 'la page ne parle ni de Piloz, ni du RGE, ni de LinkedIn');
assert.match(html, /yontech-prospection-api/);

console.log('Automate Yontech : personnalisation, mentions légales, suivi, erreurs SMTP, ciblage, score et découverte web vérifiés.');
