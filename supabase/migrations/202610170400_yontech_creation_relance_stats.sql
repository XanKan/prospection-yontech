-- Prospection maquette : maquettes « création » (entreprises sans site),
-- relance automatique après la première visite d'une maquette, statistiques
-- par modèle, deuxième créneau d'envoi (matin et fin de journée).
begin;
alter table public.yontech_maquettes
  add column if not exists kind text not null default 'refonte' check (kind in ('refonte','creation')),
  add column if not exists mail_message_id text,
  add column if not exists first_view_at timestamptz,
  add column if not exists view_followup_at timestamptz,
  add column if not exists view_followup_error text;
alter table public.yontech_prospection_settings
  add column if not exists maquette_daily_creation integer not null default 20 check (maquette_daily_creation between 0 and 200),
  add column if not exists window2_start time,
  add column if not exists window2_end time;
update public.yontech_prospection_settings set window_start='07:00', window_end='09:00', window2_start='17:00', window2_end='19:00' where id=1;

alter table public.yontech_prospection_templates drop constraint if exists yontech_prospection_templates_kind_check;
alter table public.yontech_prospection_templates add constraint yontech_prospection_templates_kind_check
  check (kind in ('initial','relance1','relance2','maquette','maquette_creation','relance_vue'));
insert into public.yontech_prospection_templates(name, kind, subject, body, active, audience, campagne)
select 'Création — site offert', 'maquette_creation', '{entreprise} : nous avons créé votre site internet', $t${bonjour},

Quand un client cherche {entreprise} sur internet, il ne trouve aujourd'hui aucun site. Nous avons donc pris les devants et créé le vôtre :

{maquette}

Les textes sont une première proposition, à ajuster avec vous. Le site s'affiche parfaitement sur téléphone et met en avant votre numéro et la demande de devis.

La création est offerte : vous ne payez que 39 € par mois (hébergement, nom de domaine et mises à jour compris), sans engagement.

Répondez simplement « ok » et nous le mettons en ligne avec vos corrections.

Bien cordialement,$t$, true, 'sanssite', 'site'
where not exists(select 1 from public.yontech_prospection_templates where kind='maquette_creation');
insert into public.yontech_prospection_templates(name, kind, subject, body, active, audience, campagne)
select 'Relance après visite de la maquette', 'relance_vue', 'Re : (objet du mail de la maquette)', $t${bonjour},

Je me permets de revenir vers vous au sujet du site que nous avons préparé pour {entreprise} : {lien}

Qu'en avez-vous pensé ? S'il vous convient, nous le mettons en ligne cette semaine sur votre adresse, avec vos corrections, pour 39 € par mois tout compris, sans engagement.

Un simple « ok » en réponse suffit : nous vous appelons pour l'ajuster avec vous.

Bien cordialement,$t$, true, 'tous', 'site'
where not exists(select 1 from public.yontech_prospection_templates where kind='relance_vue');

create or replace function public.yontech_maquette_view(target_slug text, target_path text DEFAULT '/'::text, target_visitor text DEFAULT ''::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare m public.yontech_maquettes%rowtype;
begin
  select * into m from public.yontech_maquettes where slug=target_slug and status='en_ligne';
  if not found or m.review is distinct from 'envoye' or m.sent_at is null or now() < m.sent_at + interval '2 minutes' then return; end if;
  if target_visitor<>'' then
    if exists(select 1 from public.yontech_maquette_visiteurs_exclus x where x.visitor=target_visitor) then return; end if;
    -- Déjà vu sur une autre maquette : équipe ou robot.
    if exists(select 1 from public.yontech_maquette_vues v where v.visitor=target_visitor and v.maquette_id<>m.id) then
      perform public.yontech_maquette_forget_visitor(target_visitor);
      return;
    end if;
  end if;
  -- Une même personne qui parcourt plusieurs pages dans l'heure compte pour une vue.
  if target_visitor<>'' and exists(select 1 from public.yontech_maquette_vues v where v.maquette_id=m.id and v.visitor=target_visitor and v.at > now()-interval '1 hour') then
    insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(target_visitor,32));
    return;
  end if;
  insert into public.yontech_maquette_vues(maquette_id,path,visitor) values(m.id,left(coalesce(target_path,'/'),80),left(coalesce(target_visitor,''),32));
  update public.yontech_maquettes set views=views+1, last_view_at=now(), first_view_at=coalesce(first_view_at, now()) where id=m.id;
end $function$;;

create or replace function public.yontech_prospection_claim_next(target_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  reserve boolean;
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
  -- Deux créneaux possibles (matin et fin de journée).
  if not ((paris::time>=s.window_start and paris::time<s.window_end)
      or (s.window2_start is not null and s.window2_end is not null and paris::time>=s.window2_start and paris::time<s.window2_end)) then
    return jsonb_build_object('state','off_hours');
  end if;

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

  -- Prospects « avec site » jamais essayés : réservés à la prospection par maquette
  -- tant que les maquettes du jour ne sont pas toutes préparées.
  reserve:=coalesce(s.maquette_enabled,false) and (select count(*) from public.yontech_maquettes
    where kind='refonte' and review is not null and prepared_at>=day_start) < coalesce(s.maquette_daily,0);

  -- Campagne prioritaire : celle qui est en retard sur sa part du jour.
  select count(*) filter (where true), count(*) filter (where coalesce(data->>'campagne','logiciel')='site')
    into initial_today, site_today
  from public.yontech_prospection_messages where status in('sent','sending') and claimed_at>=day_start;
  prefer:=case when s.site_share>=100 then 'site' when s.site_share<=0 then 'logiciel'
    when site_today*100 < s.site_share*(initial_today+1) then 'site' else 'logiciel' end;

  select * into m from public.yontech_prospection_messages
  where status='queued' and coalesce(nullif(data->>'campagne',''),'logiciel')=prefer
  and not (reserve and coalesce(data->>'campagne','')='site' and coalesce(data->>'site','')<>''
    and coalesce(data->>'sanssite','')<>'true' and data->>'maquette_essai' is null)
  order by score desc nulls last,created_at limit 1 for update skip locked;
  if not found then
    -- 3. À défaut, l'autre campagne.
    select * into m from public.yontech_prospection_messages
    where status='queued'
    and not (reserve and coalesce(data->>'campagne','')='site' and coalesce(data->>'site','')<>''
      and coalesce(data->>'sanssite','')<>'true' and data->>'maquette_essai' is null)
    order by score desc nulls last,created_at limit 1 for update skip locked;
    if not found then return jsonb_build_object('state','empty'); end if;
  end if;

  update public.yontech_prospection_messages set status='sending',claimed_at=target_now,attempts=attempts+1 where id=m.id
  returning * into m;
  update public.yontech_prospection_settings set next_send_at=target_now+make_interval(secs=>gap) where id=1;
  return jsonb_build_object('state','claimed','kind','initial','message',to_jsonb(m),'settings',to_jsonb(s),
    'sent_today',sent_today+1,'cap',cap,'campagne',coalesce(m.data->>'campagne','logiciel'));
end $function$;;

-- Envois et réponses par modèle (premiers mails, relances, mails de maquette).
create or replace function public.yontech_template_stats() returns table(template_id uuid, sent bigint, replied bigint)
language sql stable security definer set search_path to 'public','pg_temp' as $$
  select template_id, sum(sent)::bigint, sum(replied)::bigint from (
    select m.template_id, count(*) sent, count(*) filter (where m.replied_at is not null) replied
      from public.yontech_prospection_messages m where m.status='sent' and m.template_id is not null group by 1
    union all
    select f.template_id, count(*), count(*) filter (where m.replied_at is not null and m.replied_at>f.sent_at)
      from public.yontech_prospection_followups f join public.yontech_prospection_messages m on m.id=f.message_id
      where f.status='sent' and f.template_id is not null group by 1
    union all
    select q.template_id, count(*), count(*) filter (where m.replied_at is not null and m.replied_at>q.sent_at)
      from public.yontech_maquettes q join public.yontech_prospection_messages m on m.id=q.message_id
      where q.review='envoye' and q.template_id is not null group by 1
  ) x group by template_id;
$$;
commit;
