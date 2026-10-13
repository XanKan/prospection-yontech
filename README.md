# Yontech Prospection

Outil interne publié sur https://prospection.yontech.fr (GitHub Pages). Il trouve des entreprises de **tous secteurs** dans la base SIRENE de l'INSEE, cherche leur site internet et leur adresse e-mail sur le web, puis **envoie automatiquement un e-mail de prospection personnalisé à chacune** depuis la boîte Hostinger de Yontech, au rythme réglé, avec jusqu'à deux relances. Les messages présentent tout ce que fait Yontech : applications sur-mesure, Piloz (BTP), Nétozia (nettoyage), Querax (sites internet).

Projet **indépendant** de l'outil de prospection Piloz : dépôt séparé, backend séparé (tables, fonctions SQL et tâches planifiées préfixées `yontech_prospection_` / `yontech-prospection-`), déployable sur un projet Supabase dédié. Rien n'est partagé avec Piloz.

La page est statique ; tout ce qui touche à la recherche et à l'envoi tourne côté serveur Supabase. L'ordinateur peut rester éteint.

## Accès

Connexion avec un compte Supabase Auth (e-mail + mot de passe) du projet qui héberge l'automate, dont l'adresse figure dans le secret `YONTECH_ADMIN_EMAILS`. Aucun mot de passe n'est stocké dans la page.

## Écrans

| Écran | Rôle |
|---|---|
| Automate | État en direct, envois du jour, réserve, historique par jour, derniers envois, recherche d'entreprises et d'adresses (progression, dernier passage, compteurs depuis le début) |
| Ciblage | Zone (départements), secteurs NAF (A à U) ou activités précises (divisions ou codes NAF), effectif, méthodes de découverte des adresses, score minimum, « Bonjour Prénom » obligatoire ou non |
| Messages | Modèles d'e-mail avec variables (`{bonjour}`, `{prenom}`, `{entreprise}`, `{ville}`, `{metier}`, `{site}`, `{video}`…), aperçu en direct, test envoyable à une adresse au choix, « comme un vrai envoi » |
| Envois | File d'attente et historique (tous, en file, envoyés, relances, échecs, ignorés), filtres de suivi et de découverte, fiche de chaque message avec son site internet et la preuve de vérification |
| Exclusions | Désinscriptions, adresses refusées, ajouts manuels |
| Réglages | Expéditeur, signature, vidéo, relances, boîte d'envoi, cadence (quota, montée en charge, créneau, jours, intervalle) |

## Comment les adresses sont trouvées

La base SIRENE ne publie aucune coordonnée. Pour chaque entreprise du ciblage (API Recherche d'entreprises, siège actif), l'automate :

1. **devine le site** à partir de la raison sociale, de l'enseigne et du sigle (`dupont-mecanique.fr`, `dupontmecanique.com`…), gratuit et sans clé ;
2. **interroge un moteur de recherche** (API Brave Search, secret `YONTECH_SEARCH_API_KEY`, facultatif) avec « nom + ville », en ignorant annuaires et réseaux sociaux ;
3. ne retient un site que s'il porte le **SIREN ou le SIRET** de l'entreprise (mentions légales) ou son **nom complet avec sa ville** ;
4. lit l'adresse sur la page d'accueil, la page contact ou les mentions légales (3 pages au plus) : celle du dirigeant d'abord, sinon `contact@`, `info@`…, sur le domaine de l'entreprise de préférence ; les adresses techniques (noreply, dpo, recrutement…) sont ignorées.

Rendement observé : environ une adresse pour quatre à six entreprises de plus de 10 salariés dans l'industrie et le commerce de gros, beaucoup moins pour les très petites entreprises et la restauration. La recherche tourne **jour et nuit** (tâche toutes les deux minutes tant que la réserve est sous deux jours d'envoi), l'envoi aux heures de bureau. Les entreprises examinées sans adresse sont mémorisées (`yontech_prospection_scanned`) et ne sont pas refaites.

## Deux campagnes dans le même automate

Chaque prospect appartient à une campagne : **Logiciel et applications** (entreprises dont le site est en bon état) ou **Sites internet** (entreprises sans site, ou dont le site est visiblement dépassé : pas de version téléphone, pas de https, pas mis à jour depuis plus de trois ans, plus de 4 secondes à s'afficher, hébergé sur une plateforme gratuite). Ce constat est mesuré sur la page d'accueil pendant la découverte et disponible dans les modèles avec `{constat}` (« le site de {entreprise} {constat|peut faire mieux} »). Chaque modèle porte une campagne ; un prospect ne reçoit que les modèles de la sienne. Le quota du jour est partagé selon le réglage « Part des envois pour la campagne Sites internet » (33 % par défaut) et l'ordre d'envoi alterne pour tenir ce partage ; l'écran Automate compte envois, ouvertures, clics et réponses par campagne.

Offres de la campagne Sites internet, livrées dans les modèles (prix modifiables dans Messages) : création offerte avec abonnement à 39 € par mois (hébergement, nom de domaine, mises à jour), première page du site sous 48 h sans engagement, audit offert du site existant avec le constat mesuré, et moitié prix la première année pour les 25 premières entreprises du département (relance 2 : désactiver ou modifier le modèle à partir du 26e client d'un département).

## Entreprises sans site internet (offre Querax)

La base SIRENE ne dit pas si une entreprise a un site. L'annuaire **RGE de l'ADEME** (bâtiment, Licence Ouverte) donne l'e-mail déclaré par chaque entreprise qualifiée et son site quand elle en a un : celles qui n'en ont pas (≈ 52 000 lignes actuelles et 119 000 anciennes, surtout des artisans) sont ajoutées à la réserve avec le badge « Sans site », quelle que soit leur taille, département par département, jusqu'à 40 secondes par passage. Elles reçoivent uniquement les modèles dont le **public** est « Sans site internet » (modèle « Site internet », offre de création de site), les autres prospects reçoivent « Avec site internet » (modèle « Refonte de site internet ») ou « Toutes les entreprises ». La mention légale d'origine des données s'adapte (annuaire RGE + SIRENE). Réglable dans Ciblage.

## Fonctionnement de l'automate

- Chaque entreprise (SIREN) et chaque adresse ne reçoivent **qu'un seul premier message, pour toujours**. Si les relances sont activées (Réglages), jusqu'à deux relances suivent, dans le même fil (« Re : », en-tête `In-Reply-To`), après 7 puis 21 jours par défaut, aux destinataires qui n'ont pas répondu (et, au choix, qui ont ouvert). Le bouton « A répondu » d'un envoi arrête ses relances.
- Un message à la fois, espacé au hasard, du lundi au vendredi, heure de Paris. Réglage en production au 13 octobre 2026 : 1 500 messages par jour, de 6 h 30 à 18 h, 15 à 35 secondes entre deux messages, sans montée en charge (plafond Hostinger 3 000 ; la boîte Piloz a renvoyé « 454 Try again later » à 1 500 par jour, l'automate patiente alors une heure).
- **Pause automatique** si la boîte refuse la connexion, avec alerte e-mail depuis la même boîte. Une adresse refusée est exclue automatiquement. Les rebonds reçus après coup sont lus dans la boîte si l'API mail Hostinger est configurée.
- Messages au nom de l'**Équipe Yontech**, signature graphique avec le logo, vidéo facultative à l'emplacement `{video}`.
- Score Yontech (0-100) : effectif (30, de 20 à 199 salariés), établissements ouverts (20), chiffre d'affaires (16), croissance (12), ancienneté (10), adresse sur le domaine de l'entreprise (10). La file part par score décroissant.
- **Suivi** : pixel d'ouverture et liens réécrits dans la version HTML uniquement ; lien de désinscription jamais suivi ; clics automatiques des filtres de sécurité comptés à part (« scanner », mêmes règles que l'outil Piloz).

## Cadre légal (prospection B2B)

Chaque message identifie l'expéditeur, indique l'origine des données (base SIRENE de l'INSEE, site internet de l'entreprise) et contient un lien de désinscription vers https://prospection.yontech.fr/desinscription.html. Les en-têtes `List-Unsubscribe` et `List-Unsubscribe-Post` permettent la désinscription en un clic depuis Gmail et Outlook. Une adresse désinscrite n'est plus jamais contactée.

## Architecture

| Élément | Emplacement (ce dépôt) |
|---|---|
| Interface | `index.html` |
| Page de désinscription | `desinscription.html` |
| Tables, file, quota, planificateur pg_cron | `supabase/migrations/202610130100_yontech_prospection.sql` |
| API de l'outil | `supabase/functions/yontech-prospection-api` |
| Envoi SMTP (réveillé chaque minute) | `supabase/functions/yontech-prospection-sender` |
| Recherche d'entreprises et d'adresses (toutes les 2 minutes) | `supabase/functions/yontech-prospection-sourcer` |
| Suivi, désinscription, rebonds | `yontech-prospection-track`, `yontech-prospection-unsubscribe`, `yontech-prospection-bounces` |
| Logique partagée | `supabase/functions/_shared/yontech-core.ts` (pure), `yontech-web.ts` (découverte), `yontech-sourcing.ts`, `yontech-mail.ts`, `yontech-jobs.ts` |
| Tests de la logique pure | `node --experimental-strip-types tests/core.test.mjs` |

## Mise en production

Prérequis : un projet Supabase (dédié de préférence), un jeton d'accès personnel Supabase (`sbp_…`), le CLI GitHub pour la page. Rien de tout cela n'est stocké dans le dépôt.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_xxx PROJECT_REF=abcdefghijklmnop
./deploy.sh configure    # relie index.html et desinscription.html au projet (URL + clé anon)
./deploy.sh migrate      # tables, fonctions SQL, tâches pg_cron (rejouable)
./deploy.sh functions    # les six fonctions
YONTECH_ADMIN_EMAILS=vous@yontech.fr YONTECH_SMTP_PASSWORD='mot de passe de contact@yontech.fr' ./deploy.sh secrets
git commit -am "Projet Supabase" && git push   # publie la page sur GitHub Pages
```

Puis, dans l'outil : Réglages → vérifier l'adresse d'envoi (contact@yontech.fr, pré-remplie), Messages → « Envoyer un test », Ciblage → « Volume maximum » → Enregistrer, et « Démarrer l'automate ».

Secrets des fonctions : `YONTECH_ADMIN_EMAILS` (obligatoire), `YONTECH_SMTP_PASSWORD` (obligatoire pour envoyer), facultatifs `YONTECH_SMTP_USER`, `YONTECH_SMTP_HOST` (défaut `smtp.hostinger.com`), `YONTECH_SMTP_PORT` (défaut `465`), `YONTECH_SEARCH_API_KEY` (Brave Search), `YONTECH_HOSTINGER_MAIL_TOKEN` et `YONTECH_HOSTINGER_MAILBOX_ID` (rebonds), `YONTECH_TRACKING_BASE`, `YONTECH_UNSUBSCRIBE_PAGE`, `YONTECH_LOGO_URL`.

Le compte de connexion est un utilisateur Supabase Auth du projet (Authentication → Users → Add user), dont l'adresse est dans `YONTECH_ADMIN_EMAILS`.

DNS : un enregistrement `CNAME prospection.yontech.fr → xankan.github.io` chez le registrar de yontech.fr. Les fonctions Supabase embarquent leur copie de `_shared/` : quand un fichier partagé change, redéployer les fonctions qui l'utilisent.

## Sources de données

- **API Recherche d'entreprises** (SIRENE + RNE, sans clé, 7 requêtes/s) : raison sociale, enseigne, sigle, NAF, effectif, chiffre d'affaires, dirigeants, établissements, siège.
- **Sites internet des entreprises** : adresse e-mail, vérification par SIREN/SIRET ou nom + ville.
- **API Brave Search** (facultative, clé côté serveur) : localisation du site quand le domaine deviné ne suffit pas.
