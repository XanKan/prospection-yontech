-- Prospection par maquette : 20 prospects « avec site » préparés chaque jour
-- (maquette + e-mail), envoyés seulement après validation dans l'outil.
begin;

-- Nouveau statut « maquette » : prospect réservé, l'automate classique l'ignore.
alter table public.yontech_prospection_messages drop constraint if exists yontech_prospection_messages_status_check;
alter table public.yontech_prospection_messages add constraint yontech_prospection_messages_status_check
  check (status in ('queued','sending','sent','failed','skipped','maquette'));

alter table public.yontech_maquettes
  add column if not exists review text check (review in ('a_valider','envoye','rejete')),
  add column if not exists prepared_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists mail_subject text,
  add column if not exists mail_body text;
create index if not exists yontech_maquettes_review on public.yontech_maquettes(review, prepared_at);

alter table public.yontech_prospection_settings
  add column if not exists maquette_enabled boolean not null default true,
  add column if not exists maquette_daily integer not null default 20 check (maquette_daily between 0 and 100),
  add column if not exists maquette_subject text,
  add column if not exists maquette_body text;

do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='yontech-maquettes-batch') then perform cron.unschedule('yontech-maquettes-batch'); end if;
    perform cron.schedule('yontech-maquettes-batch','*/10 * * * *',
      $cron$select net.http_post(
        url:=replace(r.sender_url,'yontech-prospection-sender','yontech-maquettes-batch'),
        headers:=jsonb_build_object('Content-Type','application/json','x-prospection-cron',r.cron_secret),
        body:='{"job":"maquettes"}'::jsonb,
        timeout_milliseconds:=150000
      ) from public.yontech_prospection_runtime r, public.yontech_prospection_settings s where r.id=1 and s.id=1 and s.maquette_enabled;$cron$);
  end if;
end $$;

commit;
