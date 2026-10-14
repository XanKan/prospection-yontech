-- Prospection maquette : les prospects de la campagne « sites » qui ont ouvert
-- le mail classique (vraie ouverture, sans réponse, depuis 24 h) peuvent
-- recevoir une maquette. Dès qu'une maquette existe pour un prospect, ses
-- relances classiques s'arrêtent (elles reprennent si la maquette est supprimée).
create or replace function public.yontech_prospection_followup_due(target_now timestamptz default now())
returns table(message_id uuid, stage smallint) language sql stable security definer set search_path=public,pg_temp as $$
  select m.id,
    case when exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1 and f.status='sent') then 2 else 1 end::smallint
  from public.yontech_prospection_messages m, public.yontech_prospection_settings s
  where s.id=1 and s.followup_enabled
    and m.status='sent' and m.sent_at is not null and m.replied_at is null
    and (s.followup_since is null or m.sent_at>=s.followup_since)
    and not exists(select 1 from public.yontech_prospection_suppressions x where x.email=m.email)
    and not exists(select 1 from public.yontech_maquettes q where q.message_id=m.id)
    and (not s.followup_opened_only or m.opened_at is not null)
    and (
      (not exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1)
        and m.sent_at<=target_now-make_interval(days=>s.followup1_days)
        and exists(select 1 from public.yontech_prospection_templates t where t.active and t.kind='relance1'))
      or
      (exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=1 and f.status='sent')
        and not exists(select 1 from public.yontech_prospection_followups f where f.message_id=m.id and f.stage=2)
        and m.sent_at<=target_now-make_interval(days=>s.followup2_days)
        and exists(select 1 from public.yontech_prospection_templates t where t.active and t.kind='relance2'))
    )
  order by m.sent_at
$$;
