-- Récapitulatif du lundi matin : chiffres des 7 derniers jours, envoyé par
-- e-mail à la boîte principale (fonction yontech-prospection-recap).
begin;
create or replace function public.yontech_weekly_recap() returns jsonb
language sql stable security definer set search_path to 'public','pg_temp' as $$
  with p as (select now()-interval '7 days' as since)
  select jsonb_build_object(
    'premiers', (select count(*) from public.yontech_prospection_messages, p where status='sent' and sent_at>=p.since),
    'relances', (select count(*) from public.yontech_prospection_followups, p where status='sent' and sent_at>=p.since),
    'ecartes', (select count(*) from public.yontech_prospection_messages, p where status='failed' and claimed_at>=p.since),
    'clics', (select count(*) from public.yontech_prospection_messages, p where site_clicked_at>=p.since or video_clicked_at>=p.since),
    'desinscriptions', (select count(*) from public.yontech_prospection_suppressions, p where created_at>=p.since and reason<>'rebond'),
    'nb_reponses', (select count(*) from public.yontech_prospection_messages, p where replied_at>=p.since),
    'reponses', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select jsonb_build_object('company', company, 'email', email, 'tel', data->>'tel', 'at', replied_at) x
       from public.yontech_prospection_messages, p where replied_at>=p.since order by replied_at desc limit 15) q),
    'maquettes_refonte', (select count(*) from public.yontech_maquettes, p where review='envoye' and kind='refonte' and sent_at>=p.since),
    'maquettes_creation', (select count(*) from public.yontech_maquettes, p where review='envoye' and kind='creation' and sent_at>=p.since),
    'maquettes_vues', (select count(*) from public.yontech_maquettes, p where first_view_at>=p.since),
    'relances_vue', (select count(*) from public.yontech_maquettes, p where view_followup_at>=p.since and view_followup_error is null),
    'a_rappeler', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select jsonb_build_object('company', q.company, 'slug', q.slug, 'views', q.views, 'tel', m.data->>'tel', 'email', m.email) x
       from public.yontech_maquettes q join public.yontech_prospection_messages m on m.id=q.message_id, p
       where q.review='envoye' and q.views>=2 and q.last_view_at>=p.since and m.replied_at is null
       order by q.views desc, q.last_view_at desc limit 10) r),
    'modeles', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select jsonb_build_object('name', t.name, 'sent', s.sent, 'replied', s.replied) x
       from public.yontech_template_stats() s join public.yontech_prospection_templates t on t.id=s.template_id
       where s.sent>=20 order by s.replied::numeric/s.sent desc, s.sent desc limit 5) z)
  );
$$;
commit;

do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='yontech-prospection-recap') then perform cron.unschedule('yontech-prospection-recap'); end if;
    -- Lundi 5 h 30 UTC : 7 h 30 en été, 6 h 30 en hiver (heure de Paris).
    perform cron.schedule('yontech-prospection-recap','30 5 * * 1',
      $cron$select net.http_post(
        url:=replace(r.sender_url,'yontech-prospection-sender','yontech-prospection-recap'),
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"recap"}'::jsonb,
        timeout_milliseconds:=60000
      ) from public.yontech_prospection_runtime r where r.id=1;$cron$);
  end if;
end $$;
