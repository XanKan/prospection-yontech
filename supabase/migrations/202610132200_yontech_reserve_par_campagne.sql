-- Réserve comptée par campagne. La source RGE (sites internet) ajoute une
-- centaine d'entreprises par passage, la découverte web (logiciel) quelques
-- unités : avec un plafond global, la réserve se remplissait de sites et la
-- recherche s'arrêtait avant d'avoir trouvé des prospects logiciel. Chaque
-- campagne a désormais sa part (site_share) de deux jours d'envoi, et la
-- recherche continue tant qu'une des deux est sous sa part.
begin;

create or replace function public.yontech_prospection_should_source(target_now timestamptz default now())
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((
    select not s.paused and s.autopilot
      and (s.last_sourcing_at is null or s.last_sourcing_at<target_now-interval '90 seconds')
      and (
        (select count(*) from public.yontech_prospection_messages m where m.status='queued' and coalesce(m.data->>'campagne','logiciel')<>'site')
          < greatest(round(s.daily_cap*2*(100-s.site_share)/100.0), s.autopilot_batch)
        or
        (select count(*) from public.yontech_prospection_messages m where m.status='queued' and m.data->>'campagne'='site')
          < greatest(round(s.daily_cap*2*s.site_share/100.0), s.autopilot_batch)
      )
    from public.yontech_prospection_settings s where s.id=1
  ),false)
$$;
revoke all on function public.yontech_prospection_should_source(timestamptz) from public,anon,authenticated;
grant execute on function public.yontech_prospection_should_source(timestamptz) to service_role;

commit;
