-- Prospection par maquette : les prospects « avec site » sont laissés à la
-- préparation des maquettes tant que l'objectif du jour n'est pas atteint
-- (sinon l'automate classique, qui envoie chaque minute, les prend avant).
-- Objectif ramené à 20 par jour, comme demandé.
begin;
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

  -- Prospects « avec site » jamais essayés : réservés à la prospection par maquette
  -- tant que les maquettes du jour ne sont pas toutes préparées.
  reserve:=coalesce(s.maquette_enabled,false) and (select count(*) from public.yontech_maquettes
    where review is not null and prepared_at>=day_start) < coalesce(s.maquette_daily,0);

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
end $function$;
update public.yontech_prospection_settings set maquette_daily=20 where id=1;
commit;
