-- Mail de la prospection par maquette : un modèle de type « maquette » dans
-- l'écran Messages (modifiable), au lieu d'un texte caché dans les réglages.
begin;

alter table public.yontech_prospection_templates drop constraint if exists yontech_prospection_templates_kind_check;
alter table public.yontech_prospection_templates add constraint yontech_prospection_templates_kind_check
  check (kind in ('initial','relance1','relance2','maquette'));

alter table public.yontech_maquettes add column if not exists template_id uuid references public.yontech_prospection_templates(id) on delete set null;

-- Modèle n° 5 « Une seule question », choisi le 14 octobre 2026.
insert into public.yontech_prospection_templates(name,subject,body,active,kind,audience,campagne)
select 'Maquette — une seule question',
  'Une question sur le site de {entreprise}',
  $body${bonjour},

Une seule question : si votre site ressemblait à celui-ci, vous rapporterait-il plus de demandes ?

{maquette}

Nous l'avons préparé à partir de vos textes et de vos photos, sans rien vous demander. Il ne vous engage à rien.

S'il vous plaît, il peut être en ligne sur votre adresse cette semaine, pour 39 € par mois tout compris. S'il ne vous plaît pas, dites-le-nous : votre avis nous intéresse tout autant, et nous retirons la page.

Bien cordialement,$body$,
  true,'maquette','avecsite','site'
where not exists(select 1 from public.yontech_prospection_templates where kind='maquette');

-- Les mails déjà préparés et pas encore validés passent au nouveau texte.
update public.yontech_maquettes m set template_id=t.id, mail_subject=t.subject, mail_body=t.body
from public.yontech_prospection_templates t
where t.kind='maquette' and t.name='Maquette — une seule question' and m.review='a_valider';

commit;
