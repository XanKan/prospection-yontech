-- Entreprises sans site internet (annuaire RGE de l'ADEME) : public des
-- modèles de messages.
--
-- Chaque modèle a un public : « tous », « sanssite » (réservé aux entreprises
-- trouvées sans site internet, qui portent data.sanssite = '1') ou
-- « avecsite ». Un prospect sans site ne reçoit que les modèles « sanssite »
-- s'il en existe, sinon « tous » ; les autres reçoivent « avecsite » s'il en
-- existe, sinon « tous ». Le modèle « Site internet » livré avec l'outil est
-- réécrit pour une entreprise qui n'a pas de site et réservé à ce public ;
-- un modèle « Refonte de site internet » s'adresse à celles qui en ont un.
begin;

alter table public.yontech_prospection_templates add column if not exists audience text not null default 'tous';
do $$ begin
  if not exists(select 1 from pg_constraint where conname='yontech_prospection_templates_audience') then
    alter table public.yontech_prospection_templates add constraint yontech_prospection_templates_audience
      check(audience in('tous','sanssite','avecsite'));
  end if;
end $$;

update public.yontech_prospection_templates set
  subject='{entreprise} sans site internet ?',
  body='{bonjour},

Quand un client cherche {entreprise} sur Google, il ne trouve pour l''instant ni site, ni horaires, ni photos de vos réalisations : juste un nom. Et souvent, il appelle le concurrent qui en a un.

Nous sommes Yontech, en Vendée. Avec Querax, nous créons des sites internet sur-mesure pour les artisans et entreprises de {metier|votre métier} : vos réalisations, vos zones d''intervention, un formulaire de demande de devis, et le référencement pour être trouvé dans votre secteur. Vous n''avez rien à écrire, nous nous en chargeons avec vous.

Vous recevez un devis sous 48 h ouvrées, sans engagement, et le site vous appartient.

Répondez simplement « ok » et nous vous rappelons.

Bien cordialement,',
  audience='sanssite', active=true, updated_at=now()
where name='Site internet';

insert into public.yontech_prospection_templates(name,subject,body,active,kind,audience)
select 'Refonte de site internet','le site internet de {entreprise}','{bonjour},

Quand un client cherche {entreprise} sur Google, que trouve-t-il ? Un site à jour qui donne envie d''appeler, ou une page qui n''a pas bougé depuis des années ?

Nous sommes Yontech, en Vendée. Avec Querax, nous refaisons les sites internet des entreprises de {metier|votre secteur} : conception sur-mesure, référencement et suivi après la mise en ligne, avec une intervention sous 48 h en cas de problème. Et si votre besoin va plus loin (espace client, prise de rendez-vous, outil interne), nous développons aussi des applications sur-mesure.

Vous recevez un devis sous 48 h ouvrées, sans engagement.

Répondez « ok » et nous regardons ensemble ce que votre site pourrait devenir.

Bien cordialement,',true,'initial','avecsite'
where not exists(select 1 from public.yontech_prospection_templates where name='Refonte de site internet');

commit;
