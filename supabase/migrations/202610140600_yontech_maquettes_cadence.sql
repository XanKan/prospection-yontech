-- Préparation des maquettes : une par passage, toutes les 5 minutes (chaque
-- site lit jusqu'à neuf pages et quarante images, une exécution entière).
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='yontech-maquettes-batch') then perform cron.unschedule('yontech-maquettes-batch'); end if;
    perform cron.schedule('yontech-maquettes-batch','*/5 * * * *',
      $cron$select net.http_post(
        url:=replace(r.sender_url,'yontech-prospection-sender','yontech-maquettes-batch'),
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"maquettes"}'::jsonb,
        timeout_milliseconds:=150000
      ) from public.yontech_prospection_runtime r, public.yontech_prospection_settings s where r.id=1 and s.id=1 and s.maquette_enabled;$cron$);
  end if;
end $$;
