-- Deux campagnes dans le même automate : « logiciel » (développement
-- sur-mesure, logiciels métier) et « site » (création et refonte de sites
-- internet, offre Querax). Chaque prospect porte data.campagne, chaque
-- modèle une campagne ; le quota quotidien est partagé selon
-- settings.site_share (pourcentage réservé aux sites internet), et l'ordre
-- d'envoi alterne pour tenir ce partage au fil de la journée.
--
-- Offres de la campagne « site » : création offerte avec abonnement
-- (hébergement, nom de domaine, mises à jour), maquette sous 48 h sans
-- engagement, audit offert du site existant avec le constat mesuré
-- ({constat}), et moitié prix la première année pour les 25 premières
-- entreprises du département (relance 2). Les prix sont dans les modèles,
-- modifiables dans l'écran Messages.
begin;

alter table public.yontech_prospection_settings add column if not exists site_share integer not null default 33;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='yontech_prospection_settings_site_share') then
    alter table public.yontech_prospection_settings add constraint yontech_prospection_settings_site_share check(site_share between 0 and 100);
  end if;
end $$;

alter table public.yontech_prospection_templates add column if not exists campagne text not null default 'logiciel';
do $$ begin
  if not exists(select 1 from pg_constraint where conname='yontech_prospection_templates_campagne') then
    alter table public.yontech_prospection_templates add constraint yontech_prospection_templates_campagne check(campagne in('logiciel','site'));
  end if;
end $$;

-- Prospects déjà en réserve : campagne déduite de leur origine.
update public.yontech_prospection_messages set data=data||jsonb_build_object('campagne',
  case when data->>'sanssite'='1' or coalesce(data->>'how','') like 'rge:%' then 'site' else 'logiciel' end)
where data->>'campagne' is null;
create index if not exists yontech_prospection_messages_campagne_idx on public.yontech_prospection_messages((data->>'campagne'),status);

/* ===================== Modèles : campagne logiciel ===================== */
-- Objets plus accrocheurs, maquette sous 48 h en appel à l'action.

update public.yontech_prospection_templates set campagne='logiciel' where campagne='logiciel' and kind in('initial','relance1','relance2');

update public.yontech_prospection_templates set
  subject='{entreprise} : la maquette de votre application, offerte sous 48 h',
  body='{bonjour},

Chez {entreprise}, combien de tâches passent encore par des fichiers Excel, des carnets ou des messages éparpillés ? Dans {metier|votre secteur}, c''est souvent le planning, le suivi des clients ou les comptes rendus.

Nous sommes Yontech, une équipe de développement en Vendée. Nous créons des applications sur-mesure pour les entreprises de 5 à 200 personnes : un outil pensé pour votre métier, pas un logiciel générique à adapter. Nous avons déjà conçu Piloz (BTP), Nétozia (nettoyage) et des dizaines de sites internet avec Querax.

Notre façon de faire : vous nous décrivez votre fonctionnement en 15 minutes, et sous 48 h vous recevez une maquette cliquable de votre futur outil, offerte et sans engagement. Vous décidez ensuite.

Si le sujet vous parle, répondez simplement « ok » : nous vous rappelons.

Bien cordialement,', updated_at=now()
where name='Application sur-mesure';

update public.yontech_prospection_templates set
  subject='et si {entreprise} avait son propre logiciel ?', updated_at=now()
where name='Logiciel métier';

update public.yontech_prospection_templates set
  subject='{prenom|une question} : l''outil qui manque chez {entreprise}', updated_at=now()
where name='Version courte';

/* ===================== Modèles : campagne site ===================== */

-- Offre 1 : création offerte, abonnement seul (entreprises sans site).
update public.yontech_prospection_templates set
  name='Site offert (sans site)',
  subject='{entreprise} : votre site internet offert, vous ne payez que l''hébergement',
  body='{bonjour},

Quand un client cherche {entreprise} sur Google, il ne trouve ni site, ni horaires, ni photos de vos réalisations. Souvent, il appelle le concurrent qui en a un.

Nous sommes Yontech, en Vendée. Avec Querax, nous créons des sites internet pour les artisans et entreprises de {metier|votre métier}. Notre proposition : la création de votre site est offerte. Vous ne payez que l''hébergement et le nom de domaine, 39 € par mois, mises à jour comprises, sans engagement. Le site vous appartient.

Vos réalisations, vos zones d''intervention, un formulaire de demande de devis et le référencement pour être trouvé dans votre secteur : vous n''avez rien à écrire, nous nous en chargeons avec vous.

Première étape, sans engagement : répondez « ok » et vous recevez sous 48 h une première page de votre futur site, pour juger sur pièce.

Bien cordialement,',
  audience='sanssite', campagne='site', active=true, updated_at=now()
where name='Site internet';

-- Offre 4 + 1 : audit offert avec le constat mesuré, refonte offerte avec l'abonnement (entreprises avec site).
update public.yontech_prospection_templates set
  name='Refonte : audit offert (avec site)',
  subject='le site de {entreprise} {constat|peut faire mieux}',
  body='{bonjour},

Nous avons jeté un œil à {site|votre site internet} : il {constat|mérite une mise à jour}. Pour vous c''est un détail ; pour un client qui vous cherche depuis son téléphone, c''est souvent la différence entre un appel et un clic vers le concurrent.

Nous sommes Yontech, en Vendée. Avec Querax, nous refaisons les sites des entreprises de {metier|votre secteur}. Nous vous proposons un audit complet de votre site, offert : ce qui bloque, ce qu''il faut corriger, et ce que coûterait une refonte. La refonte elle-même est offerte si vous choisissez notre abonnement : 39 € par mois, hébergement, nom de domaine et mises à jour compris, sans engagement.

Répondez « ok » et vous recevez sous 48 h l''audit et une première page de votre site refait, sans engagement.

Bien cordialement,',
  audience='avecsite', campagne='site', active=true, updated_at=now()
where name='Refonte de site internet';

-- Offre 2 en relance : la maquette sous 48 h.
insert into public.yontech_prospection_templates(name,subject,body,active,kind,audience,campagne)
select 'Relance 1 sites (J+7)','Re : (objet du premier message)','{bonjour},

Je reviens vers vous au sujet du site internet de {entreprise} : mon message de la semaine dernière est peut-être passé sous la pile.

La proposition tient toujours : une première page de votre site sous 48 h, offerte et sans engagement, pour juger sur pièce. Répondez simplement « ok ». Sinon, pas de souci, je ne vous relancerai qu''une fois.

Bien cordialement,',true,'relance1','tous','site'
where not exists(select 1 from public.yontech_prospection_templates where name='Relance 1 sites (J+7)');

-- Offre 3 en dernière relance : moitié prix la première année pour les 25
-- premières entreprises du département. Le compte doit être tenu : à partir
-- du 26e client d'un département, désactivez ce modèle ou modifiez-le.
insert into public.yontech_prospection_templates(name,subject,body,active,kind,audience,campagne)
select 'Relance 2 sites (J+21, 25 premiers)','Re : (objet du premier message)','{bonjour},

Dernier message de ma part, promis.

Pour les 25 premières entreprises de votre département qui nous confient leur site cette année, l''abonnement est à moitié prix la première année : 19,50 € par mois au lieu de 39 €, hébergement et nom de domaine compris, la création ou la refonte restant offerte. Il suffit de répondre « ok » pour en faire partie.

Si un site internet n''est pas un sujet chez {entreprise} en ce moment, je comprends. Vous trouverez tout ce que nous faisons sur https://yontech.fr.

Bonne continuation,',true,'relance2','tous','site'
where not exists(select 1 from public.yontech_prospection_templates where name='Relance 2 sites (J+21, 25 premiers)');

/* ===================== Compteurs par campagne ===================== */

create or replace function public.yontech_prospection_campaign_stats(target_now timestamptz default now())
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_object_agg(c.campagne, c.stats), '{}'::jsonb) from (
    select coalesce(nullif(m.data->>'campagne',''),'logiciel') as campagne, jsonb_build_object(
      'queued', count(*) filter (where m.status in('queued','sending')),
      'sent', count(*) filter (where m.status='sent'),
      'sent_today', count(*) filter (where m.status in('sent','sending') and m.claimed_at>=(date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris')),
      'opened', count(*) filter (where m.opened_at is not null),
      'clicked', count(*) filter (where m.video_clicked_at is not null or m.site_clicked_at is not null),
      'replied', count(*) filter (where m.replied_at is not null),
      'failed', count(*) filter (where m.status='failed')
    ) as stats
    from public.yontech_prospection_messages m group by 1
  ) c
$$;
revoke all on function public.yontech_prospection_campaign_stats(timestamptz) from public,anon,authenticated;
grant execute on function public.yontech_prospection_campaign_stats(timestamptz) to service_role;

/* ===================== Réservation : partage du quota ===================== */
-- Ordre : 1. relances dues, 2. nouveau prospect de la campagne en retard sur
-- sa part du jour (sites internet : site_share %), 3. à défaut l'autre
-- campagne. Dans chaque campagne, meilleur score d'abord puis ancienneté.
create or replace function public.yontech_prospection_claim_next(target_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.yontech_prospection_settings%rowtype;
  m public.yontech_prospection_messages%rowtype;
  f public.yontech_prospection_followups%rowtype;
  due record;
  paris timestamp:=target_now at time zone 'Europe/Paris';
  day_start timestamptz:=date_trunc('day',target_now at time zone 'Europe/Paris') at time zone 'Europe/Paris';
  opening timestamptz;
  first_slot timestamptz;
  sent_today integer;
  cap integer;
  gap integer;
  initial_today integer;
  site_today integer;
  prefer text;
begin
  select * into s from public.yontech_prospection_settings where id=1 for update;
  if not found then return jsonb_build_object('state','unconfigured'); end if;
  update public.yontech_prospection_settings set last_run_at=target_now where id=1;

  update public.yontech_prospection_messages set status='failed',
    error='Envoi interrompu : statut inconnu, non renvoyé par sécurité.'
  where status='sending' and claimed_at<target_now-interval '10 minutes';
  update public.yontech_prospection_followups set status='failed',
    error='Envoi interrompu : statut inconnu, non renvoyé par sécurité.'
  where status='sending' and claimed_at<target_now-interval '10 minutes';

  if s.paused then return jsonb_build_object('state','paused'); end if;
  if s.sender_email is null then return jsonb_build_object('state','unconfigured'); end if;
  if not (extract(isodow from paris)::smallint=any(s.send_days)) then return jsonb_build_object('state','off_day'); end if;
  if paris::time<s.window_start or paris::time>=s.window_end then return jsonb_build_object('state','off_hours'); end if;

  opening:=(date_trunc('day',paris)+s.window_start) at time zone 'Europe/Paris';
  if s.next_send_at is null or s.next_send_at<opening then
    first_slot:=opening+make_interval(secs=>floor(random()*s.max_gap_seconds)::integer);
    if first_slot>target_now then
      update public.yontech_prospection_settings set next_send_at=first_slot where id=1;
      return jsonb_build_object('state','waiting','next_send_at',first_slot);
    end if;
  elsif s.next_send_at>target_now then
    return jsonb_build_object('state','waiting','next_send_at',s.next_send_at);
  end if;

  sent_today:=public.yontech_prospection_sent_today(target_now);
  cap:=public.yontech_prospection_daily_cap(target_now);
  if sent_today>=cap then return jsonb_build_object('state','cap_reached','cap',cap,'sent_today',sent_today); end if;

  gap:=s.min_gap_seconds+floor(random()*(s.max_gap_seconds-s.min_gap_seconds+1))::integer;

  -- 1. Relances dues.
  if s.followup_enabled then
    select * into f from public.yontech_prospection_followups where status='queued' order by created_at limit 1 for update skip locked;
    if not found then
      select * into due from public.yontech_prospection_followup_due(target_now) limit 1;
      if found then
        insert into public.yontech_prospection_followups(message_id,stage,status) values(due.message_id,due.stage,'queued')
        on conflict(message_id,stage) do nothing
        returning * into f;
      end if;
    end if;
    if f.id is not null then
      select * into m from public.yontech_prospection_messages where id=f.message_id for update;
      update public.yontech_prospection_followups set status='sending',claimed_at=target_now,attempts=attempts+1 where id=f.id
      returning * into f;
      update public.yontech_prospection_settings set next_send_at=target_now+make_interval(secs=>gap) where id=1;
      return jsonb_build_object('state','claimed','kind','followup','followup',to_jsonb(f),'message',to_jsonb(m),
        'settings',to_jsonb(s),'sent_today',sent_today+1,'cap',cap);
    end if;
  end if;

  -- 2. Nouveaux prospects : exclusions et prénom manquant écartés.
  update public.yontech_prospection_messages q set status='skipped',error='Adresse désinscrite avant l''envoi'
  where q.status='queued' and exists(select 1 from public.yontech_prospection_suppressions x where x.email=q.email);
  if s.require_first_name then
    update public.yontech_prospection_messages q set status='skipped',error='Prénom du dirigeant inconnu'
    where q.status='queued' and btrim(coalesce(q.data->>'prenom',''))='';
  end if;

  -- Campagne prioritaire : celle qui est en retard sur sa part du jour.
  select count(*) filter (where true), count(*) filter (where coalesce(data->>'campagne','logiciel')='site')
    into initial_today, site_today
  from public.yontech_prospection_messages where status in('sent','sending') and claimed_at>=day_start;
  prefer:=case when s.site_share>=100 then 'site' when s.site_share<=0 then 'logiciel'
    when site_today*100 < s.site_share*(initial_today+1) then 'site' else 'logiciel' end;

  select * into m from public.yontech_prospection_messages
  where status='queued' and coalesce(nullif(data->>'campagne',''),'logiciel')=prefer
  order by score desc nulls last,created_at limit 1 for update skip locked;
  if not found then
    -- 3. À défaut, l'autre campagne.
    select * into m from public.yontech_prospection_messages
    where status='queued' order by score desc nulls last,created_at limit 1 for update skip locked;
    if not found then return jsonb_build_object('state','empty'); end if;
  end if;

  update public.yontech_prospection_messages set status='sending',claimed_at=target_now,attempts=attempts+1 where id=m.id
  returning * into m;
  update public.yontech_prospection_settings set next_send_at=target_now+make_interval(secs=>gap) where id=1;
  return jsonb_build_object('state','claimed','kind','initial','message',to_jsonb(m),'settings',to_jsonb(s),
    'sent_today',sent_today+1,'cap',cap,'campagne',coalesce(m.data->>'campagne','logiciel'));
end $$;
revoke all on function public.yontech_prospection_claim_next(timestamptz) from public,anon,authenticated;
grant execute on function public.yontech_prospection_claim_next(timestamptz) to service_role;

commit;
